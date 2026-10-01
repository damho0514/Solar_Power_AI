// 주소 → 토지(지목·용도지역·구역) 조회 → 관할 지자체 조례 수집 → 이격거리 기준 추출.
// 판정(assess)은 화면에서 거리 입력에 따라 다시 계산하므로 원자료만 돌려준다.

import { fail, guardJson } from "@/lib/server/guard";
import { hasVworldKey, lookupLand, parseRegion } from "@/lib/land";
import { findOrdinances, solarArticles, type Article, type Ordinance } from "@/lib/ordinance";
import { extractSetbacks, type Land } from "@/lib/siting";

export type SitingInput =
  | { address: string }
  | { manual: { address: string; jimok: string; zones: string[]; areas: string[]; areaM2?: number | null } };

export type SitingResult = {
  land: Land;
  ordinances: (Ordinance & { articles: number })[];
  articles: Article[];
  setbacks: ReturnType<typeof extractSetbacks>["setbacks"];
  slopes: ReturnType<typeof extractSetbacks>["slopes"];
  warnings: string[];
};

export async function GET() {
  return Response.json({ vworld: hasVworldKey() });
}

// 한 번 조회에 브이월드·법제처를 여러 번 부르므로 횟수를 엄격히 제한한다 (무료 할당량 보호)
const LIMITS = { maxStr: 200, maxArr: 30, maxDepth: 4, maxKeys: 20 };

export async function POST(req: Request) {
  const g = await guardJson(req, { name: "siting", limit: 10, maxBytes: 8_000, clamp: LIMITS });
  if (!g.ok) return g.res;
  const body = g.body as SitingInput;
  if (!body || typeof body !== "object" || ("manual" in body ? typeof body.manual?.address !== "string" : typeof body.address !== "string"))
    return fail(400, "주소를 입력하세요");
  let land: Land;
  try {
    if ("manual" in body) {
      const m = body.manual;
      land = {
        pnu: null,
        address: m.address,
        ...parseRegion(m.address),
        jimok: m.jimok,
        zones: m.zones,
        areas: m.areas,
        areaM2: m.areaM2 ?? null,
        terrain: null,
        point: null,
        source: "manual",
      };
    } else {
      if (!hasVworldKey())
        return new Response("VWORLD_KEY가 없어 주소로 토지를 조회할 수 없습니다. '직접 입력'을 쓰거나 .env.local에 키를 넣으세요.", { status: 400 });
      land = await lookupLand(body.address);
    }
  } catch (e) {
    return fail(502, "토지 정보를 조회하지 못했어요. 주소를 확인하거나 '직접 입력'을 쓰세요.", e);
  }
  if (!land.sido) return new Response("주소에서 시·도를 알아내지 못했습니다. '경상북도 영양군 …'처럼 시·도부터 입력하세요.", { status: 400 });

  const warnings: string[] = [];
  let ordinances: SitingResult["ordinances"] = [];
  let articles: Article[] = [];
  try {
    const found = await findOrdinances(land.sido, land.sigungu);
    if (!found.length) warnings.push(`${land.sido} ${land.sigungu} 조례를 법제처에서 찾지 못했습니다.`);
    const perOrd = await Promise.all(
      found.map((o) =>
        solarArticles(o).catch((e) => {
          console.error(`[api siting] ${o.name} 본문 실패`, e);
          warnings.push(`${o.name} 본문을 받지 못했습니다.`);
          return [] as Article[];
        }),
      ),
    );
    ordinances = found.map((o, i) => ({ ...o, articles: perOrd[i].length }));
    articles = perOrd.flat();
  } catch (e) {
    console.error("[api siting] 법제처 조회 실패", e);
    warnings.push("법제처 조례 조회에 실패했습니다. 잠시 뒤 다시 시도하세요.");
  }

  const { setbacks, slopes } = extractSetbacks(articles);
  return Response.json({ land, ordinances, articles, setbacks, slopes, warnings } satisfies SitingResult);
}
