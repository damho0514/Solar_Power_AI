// 법제처 국가법령정보 공동활용 API(무료)로 해당 지자체의 태양광 관련 조례 조문을 모은다.
// 발전시설 이격거리·경사도 기준은 대부분 "도시·군계획 조례"의 개발행위허가 기준에,
// 일부는 "태양광 ... 조례"라는 별도 조례에 들어 있다. 서버에서만 쓴다.

const LAW_URL = "https://www.law.go.kr/DRF";
// 발급받은 OC(가입 이메일 ID)를 넣으세요. "test"는 법제처 예시 계정이라 언제든 막힐 수 있습니다.
const OC = process.env.LAW_OC ?? "test";
const DAY = 24 * 60 * 60 * 1000;

export type Ordinance = { id: string; mst: string; name: string; org: string; enforced: string; url: string };
export type Article = { ordinance: string; title: string; content: string };

type SearchRow = {
  자치법규ID: string;
  자치법규일련번호: string;
  자치법규명: string;
  지자체기관명: string;
  시행일자: string;
  자치법규종류: string;
};
type ArticleRow = { 조제목?: string; 조내용?: string; 조문여부?: string };

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const list = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

async function search(query: string): Promise<SearchRow[]> {
  return cached(`s:${query}`, async () => {
    const url = `${LAW_URL}/lawSearch.do?OC=${OC}&target=ordin&type=JSON&display=100&query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`법제처 검색 오류 ${res.status}`);
    const json = (await res.json()) as { OrdinSearch?: { law?: SearchRow | SearchRow[] } };
    return list(json.OrdinSearch?.law);
  });
}

// "경상북도" → "경북", "전라남도" → "전남", "서울특별시" → "서울".
// 기관명이 "전남광주통합특별시 해남군"처럼 바뀌어도 약칭이 들어 있으면 같은 곳으로 본다.
function sidoShort(sido: string) {
  return /^(충청|전라|경상)/.test(sido) ? sido[0] + sido[2] : sido.slice(0, 2);
}
function sameSido(addrSido: string, orgSido: string) {
  return orgSido === addrSido || orgSido.includes(sidoShort(addrSido));
}
// 기관명 "경상북도 영양군"이 주소의 시도·시군구와 같은 곳인가. sigungu가 ""이면 광역 자체.
function sameOrg(org: string, sido: string, sigungu: string) {
  if (org.endsWith("교육청")) return false;
  const [orgSido, ...rest] = org.split(/\s+/);
  const orgLocal = rest.join(" ");
  return sameSido(sido, orgSido) && orgLocal === sigungu;
}

const toOrdinance = (r: SearchRow): Ordinance => ({
  id: r.자치법규ID,
  mst: r.자치법규일련번호,
  name: r.자치법규명,
  org: r.지자체기관명,
  enforced: r.시행일자,
  url: `https://www.law.go.kr/ordinInfoP.do?ordinSeq=${r.자치법규일련번호}`,
});

const PLAN_RE = /(도시|시|군)계획\s?조례$/;
const SOLAR_TITLE_RE = /태양광|발전시설/;

// 적용할 조례 목록: 기초 도시·군계획 조례(없으면 광역), 광역시·특별시의 도시계획 조례, 제목에 태양광이 든 조례
export async function findOrdinances(sido: string, sigungu: string): Promise<Ordinance[]> {
  const out: SearchRow[] = [];
  const add = (rows: SearchRow[]) => {
    for (const r of rows) if (r.자치법규종류 === "조례" && !out.some((o) => o.자치법규ID === r.자치법규ID)) out.push(r);
  };
  const plans = async (local: string) =>
    (await search(`${local || sido} 계획 조례`)).filter((r) => PLAN_RE.test(r.자치법규명) && sameOrg(r.지자체기관명, sido, local));

  if (sigungu) add(await plans(sigungu));
  // 자치구는 용도지역·개발행위 기준 상당 부분을 광역시 조례가 정한다. 기초 조례가 없을 때(제주시 등)도 광역으로.
  if (!sigungu || /(특별|광역)시$/.test(sido) || out.length === 0) add(await plans(""));

  const solar = await search("태양광");
  add(solar.filter((r) => SOLAR_TITLE_RE.test(r.자치법규명) && (sameOrg(r.지자체기관명, sido, sigungu) || sameOrg(r.지자체기관명, sido, ""))));
  return out.map(toOrdinance);
}

const KEY_RE = /태양광|발전시설|태양에너지/;

// 조례 본문에서 태양광·발전시설 관련 조문만 뽑는다. 조 제목이 관련 있으면 전문, 아니면 관련 항목만.
export async function solarArticles(o: Ordinance): Promise<Article[]> {
  const rows = await cached(`b:${o.mst}`, async () => {
    const res = await fetch(`${LAW_URL}/lawService.do?OC=${OC}&target=ordin&type=JSON&MST=${o.mst}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`법제처 본문 오류 ${res.status}`);
    const json = (await res.json()) as { LawService?: { 조문?: { 조?: ArticleRow | ArticleRow[] } } };
    return list(json.LawService?.조문?.조);
  });
  const whole = SOLAR_TITLE_RE.test(o.name);
  const out: Article[] = [];
  for (const r of rows) {
    if (r.조문여부 === "N" || !r.조내용) continue;
    const title = r.조제목 ?? "";
    const content = r.조내용.replace(/\s+/g, " ").trim();
    if (whole || KEY_RE.test(title)) out.push({ ordinance: o.name, title, content: content.slice(0, 3000) });
    else if (KEY_RE.test(content)) {
      // "제21조 ... 마. 광고탑, 철탑, 태양광발전시설 ..." 같은 긴 조문은 해당 문장 주변만
      const hits: string[] = [];
      let end = 0;
      for (const m of content.matchAll(new RegExp(KEY_RE, "g"))) {
        if (m.index < end) continue; // 앞 발췌와 겹치면 건너뜀
        end = m.index + 350;
        hits.push(content.slice(Math.max(0, m.index - 150), end));
        if (hits.length >= 2) break;
      }
      out.push({ ordinance: o.name, title, content: `… ${hits.join(" … ")} …` });
    }
  }
  return out;
}
