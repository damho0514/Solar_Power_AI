// 브이월드(국토교통부 공간정보 오픈플랫폼, 무료 인증키)로 주소 → 필지(PNU) → 지목·용도지역·토지이용계획을 조회한다.
// 서버에서만 쓴다. 인증키는 https://www.vworld.kr 에서 "오픈API 인증키 발급"으로 받는다.

import { isZone, jimokFromJibun, type Land } from "@/lib/siting";

const KEY = process.env.VWORLD_KEY ?? "";
// 인증키를 발급할 때 등록한 서비스 URL. 서버 호출이라도 이 값이 맞아야 응답한다.
const DOMAIN = process.env.VWORLD_DOMAIN ?? "http://localhost:3100";

export const hasVworldKey = () => KEY !== "";

type Json = Record<string, unknown>;

async function vworld(path: string, params: Record<string, string>): Promise<Json> {
  const qs = new URLSearchParams({ key: KEY, domain: DOMAIN, format: "json", ...params });
  const res = await fetch(`https://api.vworld.kr${path}?${qs}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`브이월드 오류 ${res.status}`);
  return (await res.json()) as Json;
}

// 검색·데이터 API 공통 응답 { response: { status, error?, result } }
function result(json: Json): Json | null {
  const r = json.response as { status?: string; error?: { text?: string }; result?: Json } | undefined;
  if (r?.status === "NOT_FOUND") return null;
  if (r?.status !== "OK") throw new Error(`브이월드: ${r?.error?.text ?? r?.status ?? "알 수 없는 응답"}`);
  return r.result ?? null;
}

// NED(토지) API 응답은 { landUses: { field: [...] } }처럼 최상위 이름이 API마다 다르다
function fields(json: Json): Json[] {
  for (const v of Object.values(json)) {
    const f = (v as { field?: Json | Json[] } | null)?.field;
    if (f) return Array.isArray(f) ? f : [f];
  }
  return [];
}

// "경기도 수원시 장안구 ..." → 수원시 (일반구는 조례가 없어서 시로 올린다). 세종은 "".
export function parseRegion(address: string) {
  const [sido = "", t1 = "", t2 = ""] = address.trim().split(/\s+/);
  let sigungu = /(시|군|구)$/.test(t1) ? t1 : "";
  if (sigungu.endsWith("시") && t2.endsWith("구")) sigungu = t1;
  if (/^세종/.test(sido)) sigungu = "";
  return { sido, sigungu };
}

type Hit = { pnu: string | null; address: string; point: { x: number; y: number } };

async function geocode(address: string): Promise<Hit | null> {
  for (const category of ["parcel", "road"] as const) {
    const r = result(
      await vworld("/req/search", { service: "search", request: "search", version: "2.0", size: "1", type: "address", category, query: address }),
    );
    const item = (r?.items as Json[] | undefined)?.[0] as
      | { id?: string; address?: { parcel?: string; road?: string }; point?: { x: string; y: string } }
      | undefined;
    if (!item?.point) continue;
    return {
      pnu: category === "parcel" && /^\d{19}$/.test(item.id ?? "") ? item.id! : null,
      address: (category === "parcel" ? item.address?.parcel : item.address?.road) ?? address,
      point: { x: Number(item.point.x), y: Number(item.point.y) },
    };
  }
  return null;
}

// 좌표 또는 PNU로 연속지적도 필지 한 개를 찾는다. 지번 끝 글자가 지목("123-4대")이다.
async function parcel(hit: Hit) {
  const params: Record<string, string> = {
    service: "data", request: "GetFeature", data: "LP_PA_CBND_BUBUN", geometry: "false", size: "1", crs: "EPSG:4326",
  };
  if (hit.pnu) params.attrFilter = `pnu:=:${hit.pnu}`;
  else params.geomFilter = `POINT(${hit.point.x} ${hit.point.y})`;
  const r = result(await vworld("/req/data", params));
  const f = (r?.featureCollection as { features?: { properties?: Json }[] } | undefined)?.features?.[0]?.properties;
  return f ? { pnu: String(f.pnu), jibun: String(f.jibun ?? ""), addr: String(f.addr ?? "") } : null;
}

async function characteristics(pnu: string) {
  const year = new Date().getFullYear();
  for (const stdrYear of [String(year), String(year - 1), String(year - 2)]) {
    const f = fields(await vworld("/ned/data/getLandCharacteristics", { pnu, stdrYear, numOfRows: "1", pageNo: "1" }))[0];
    if (f) return f as Record<string, string | undefined>;
  }
  return null;
}

async function landUses(pnu: string) {
  const rows = fields(await vworld("/ned/data/getLandUseAttr", { pnu, numOfRows: "200", pageNo: "1" })) as Record<string, string | undefined>[];
  // 저촉·접합(부지 일부만 걸침)도 인허가에 영향을 주므로 모두 담되 표시는 구분한다
  return rows
    .filter((r) => r.prposAreaDstrcCodeNm)
    .map((r) => ({ name: r.prposAreaDstrcCodeNm!, relation: r.cnflcAtNm ?? "" }));
}

export async function lookupLand(address: string): Promise<Land> {
  const hit = await geocode(address);
  if (!hit) throw new Error(`'${address}' 주소를 찾지 못했습니다. 지번 주소(예: 경상북도 영양군 영양읍 동부리 123)로 입력해 보세요.`);
  const p = await parcel(hit);
  const pnu = p?.pnu ?? hit.pnu;
  if (!pnu) throw new Error("주소 위치의 필지를 찾지 못했습니다.");

  const [ch, uses] = await Promise.all([characteristics(pnu), landUses(pnu)]);
  const addr = p?.addr || ch?.ldCodeNm || hit.address;
  const zones = new Set<string>();
  for (const z of [ch?.prposArea1Nm, ch?.prposArea2Nm]) if (z && isZone(z)) zones.add(z);
  for (const u of uses) if (isZone(u.name) && u.relation !== "접합") zones.add(u.name);
  const areas = uses
    .filter((u) => !isZone(u.name))
    .map((u) => (u.relation && u.relation !== "포함" ? `${u.name}(${u.relation})` : u.name));

  return {
    pnu,
    address: addr,
    ...parseRegion(addr || address),
    jimok: ch?.lndcgrCodeNm ?? (p ? jimokFromJibun(p.jibun) : null) ?? "",
    zones: [...zones],
    areas: [...new Set(areas)],
    areaM2: ch?.lndpclAr ? Number(ch.lndpclAr) : null,
    terrain: ch?.tpgrphHgCodeNm ?? null,
    point: hit.point,
    source: "vworld",
  };
}
