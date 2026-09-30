// 주소 → 토지(지목·용도지역·구역) 조회 → 관할 지자체 조례 수집 → 이격거리 기준 추출.
// 판정(assess)은 화면에서 거리 입력에 따라 다시 계산하므로 원자료만 돌려준다.

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

export async function POST(req: Request) {
  const body = (await req.json()) as SitingInput;
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
    return new Response(e instanceof Error ? e.message : String(e), { status: 502 });
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
          warnings.push(`${o.name} 본문을 받지 못했습니다: ${e instanceof Error ? e.message : e}`);
          return [] as Article[];
        }),
      ),
    );
    ordinances = found.map((o, i) => ({ ...o, articles: perOrd[i].length }));
    articles = perOrd.flat();
  } catch (e) {
    warnings.push(`법제처 조례 조회 실패: ${e instanceof Error ? e.message : e}`);
  }

  const { setbacks, slopes } = extractSetbacks(articles);
  return Response.json({ land, ordinances, articles, setbacks, slopes, warnings } satisfies SitingResult);
}
