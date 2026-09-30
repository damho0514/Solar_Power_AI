// 태양광 입지 1차 판정. 지목·용도지역·토지이용계획 구역은 전국 공통 법령 기준으로,
// 이격거리·경사도는 지자체 조례에서 뽑은 기준으로 판정한다. 서버와 화면이 같이 쓴다.
// 인허가 확정이 아니라 사전 검토용이다. 최종 판단은 해당 지자체 허가 부서가 한다.

export type Level = "ok" | "cond" | "limit" | "no";

export const LEVEL_LABEL: Record<Level, string> = {
  ok: "가능",
  cond: "조건부 가능",
  limit: "제한적",
  no: "사실상 불가",
};
const RANK: Record<Level, number> = { ok: 0, cond: 1, limit: 2, no: 3 };

export type Finding = { topic: string; level: Level; reason: string; basis: string };

export type Land = {
  pnu: string | null;
  address: string;
  sido: string;
  sigungu: string; // 조례를 만드는 기초자치단체 (일반구는 시로 올린다). 세종·제주처럼 없으면 ""
  jimok: string; // 전, 답, 임야, 대 ...
  zones: string[]; // 용도지역 (자연녹지지역, 계획관리지역 ...)
  areas: string[]; // 토지이용계획상 그 밖의 지역·지구·구역 (농업진흥구역, 개발제한구역 ...)
  areaM2: number | null;
  terrain: string | null; // 지형높이 (평지, 완경사, 급경사 ...)
  point: { x: number; y: number } | null;
  source: "vworld" | "manual";
};

export const JIMOK_LIST = [
  "전", "답", "과수원", "목장용지", "임야", "광천지", "염전", "대", "공장용지", "학교용지", "주차장", "주유소용지",
  "창고용지", "도로", "철도용지", "제방", "하천", "구거", "유지", "양어장", "수도용지", "공원", "체육용지",
  "유원지", "종교용지", "사적지", "묘지", "잡종지",
];

// 지적도 지번 끝에 붙는 한 글자 부호 → 정식 지목
const JIMOK_ABBR: Record<string, string> = {
  전: "전", 답: "답", 과: "과수원", 목: "목장용지", 임: "임야", 광: "광천지", 염: "염전", 대: "대", 장: "공장용지",
  학: "학교용지", 차: "주차장", 주: "주유소용지", 창: "창고용지", 도: "도로", 철: "철도용지", 제: "제방", 천: "하천",
  구: "구거", 유: "유지", 양: "양어장", 수: "수도용지", 공: "공원", 체: "체육용지", 원: "유원지", 종: "종교용지",
  사: "사적지", 묘: "묘지", 잡: "잡종지",
};

export function jimokFromJibun(jibun: string): string | null {
  const m = jibun.trim().match(/([가-힣])$/);
  return m ? (JIMOK_ABBR[m[1]] ?? null) : null;
}

export const ZONE_LIST = [
  "제1종전용주거지역", "제2종전용주거지역", "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역", "준주거지역",
  "중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역", "전용공업지역", "일반공업지역", "준공업지역",
  "보전녹지지역", "생산녹지지역", "자연녹지지역", "보전관리지역", "생산관리지역", "계획관리지역", "농림지역",
  "자연환경보전지역",
];

const ZONE_RE = /(전용주거|일반주거|준주거|상업|공업|녹지|관리|농림|자연환경보전)지역/;
export const isZone = (name: string) => ZONE_RE.test(name) && !/지구|구역/.test(name);

// 소형 LLM이 "~이면 불가" 같은 가정문을 사실로 읽기 쉬워서, 이 필지에 해당하는 사실만 쓴다
function jimokRule(jimok: string, areas: string[]): Finding {
  const topic = `지목: ${jimok || "모름"}`;
  if (["전", "답", "과수원"].includes(jimok)) {
    const core = areas.some((a) => /농업진흥구역/.test(a));
    return {
      topic,
      level: core ? "no" : "cond",
      reason: core
        ? "농업진흥구역 안의 농지라 원칙적으로 설치할 수 없습니다."
        : "농지라 농지전용허가 또는 타용도 일시사용허가가 필요합니다. 토지이용계획상 농업진흥구역은 아닙니다.",
      basis: "농지법 제32조·제34조·제36조",
    };
  }
  if (jimok === "임야")
    return {
      topic,
      level: "cond",
      reason: "산지일시사용허가(사용 뒤 복구 의무)를 받아야 하고, 평균경사도·표고 기준을 충족해야 합니다.",
      basis: "산지관리법 제15조의2, 같은 법 시행령 별표 3의3",
    };
  if (jimok === "목장용지")
    return { topic, level: "cond", reason: "초지이면 초지전용허가가 필요합니다.", basis: "초지법 제23조" };
  if (["대", "공장용지", "잡종지", "창고용지", "주차장", "염전", "광천지"].includes(jimok))
    return { topic, level: "ok", reason: "지목상 큰 제약이 없습니다. 개발행위허가와 조례 기준을 확인하면 됩니다.", basis: "국토계획법 제56조" };
  if (["유지", "양어장"].includes(jimok))
    return { topic, level: "cond", reason: "수면을 쓰는 수상태양광 형태로 검토해야 하고, 관리자 점용 허가가 필요합니다.", basis: "공유수면법·농어촌정비법 등 관리 법령" };
  if (["도로", "철도용지", "하천", "구거", "제방", "수도용지"].includes(jimok))
    return { topic, level: "limit", reason: "공공시설 부지라 관리청의 점용 허가 없이는 설치할 수 없습니다.", basis: "도로법·하천법·공유재산법 등" };
  if (["묘지", "사적지", "종교용지", "학교용지", "공원", "체육용지", "유원지"].includes(jimok))
    return { topic, level: "limit", reason: "목적이 정해진 부지라 지상형 설치가 어렵습니다. 기존 건물 지붕형으로 검토하세요.", basis: "해당 시설 관리 법령" };
  return { topic, level: "cond", reason: "지목을 확인하지 못했습니다. 토지대장으로 확인하세요.", basis: "공간정보관리법" };
}

function zoneRule(zone: string): Finding {
  const topic = `용도지역: ${zone}`;
  const f = (level: Level, reason: string): Finding => ({ topic, level, reason, basis: "국토계획법 제56조·제76조, 같은 법 시행령 별표 1의2" });
  if (/전용주거/.test(zone)) return f("limit", "주거환경 보호가 우선인 지역이라 지상형 발전시설은 허가받기 어렵습니다. 건물 지붕형은 가능합니다.");
  if (/일반주거|준주거/.test(zone)) return f("cond", "개발행위허가를 받아 설치할 수 있으나 주변 주거지 민원·경관 심사가 까다롭습니다.");
  if (/상업|공업/.test(zone)) return f("ok", "발전시설 입지에 큰 제약이 없습니다.");
  if (/보전녹지/.test(zone)) return f("limit", "보전 목적 지역이라 허가 사례가 드뭅니다.");
  if (/녹지/.test(zone)) return f("cond", "개발행위허가(도시계획위원회 심의 포함 가능)를 받으면 설치할 수 있습니다.");
  if (/계획관리|생산관리/.test(zone)) return f("ok", "지상형 태양광이 가장 많이 들어서는 지역입니다. 조례 이격 기준을 확인하세요.");
  if (/보전관리/.test(zone)) return f("cond", "설치는 가능하나 개발행위허가 기준이 엄격하게 적용됩니다.");
  if (/농림/.test(zone)) return f("cond", "설치할 수 있으나 농지·산지 규제가 겹칩니다.");
  if (/자연환경보전/.test(zone)) return f("no", "자연환경 보전이 목적이라 발전시설 허가를 받기 어렵습니다.");
  return f("cond", "용도지역별 허가 기준을 지자체에 확인하세요.");
}

// 토지이용계획에 나오는 구역 이름 → 판정. 먼저 걸리는 규칙을 쓴다.
const AREA_RULES: { re: RegExp; level: Level; reason: string; basis: string }[] = [
  { re: /농업진흥구역/, level: "no", reason: "농업진흥구역 농지에는 원칙적으로 태양광을 설치할 수 없습니다 (건축물 지붕 등 예외만 허용).", basis: "농지법 제32조, 같은 법 시행령 제29조" },
  { re: /농업보호구역/, level: "cond", reason: "태양에너지 발전설비 설치가 허용되지만 면적·요건을 확인해야 합니다.", basis: "농지법 제32조제2항, 같은 법 시행령 제30조" },
  { re: /개발제한구역/, level: "limit", reason: "주민 공동이용, 기존 건축물 지붕 등 법령이 정한 경우에만 허가됩니다.", basis: "개발제한구역법 제12조, 같은 법 시행령 별표 1" },
  { re: /공익용산지/, level: "no", reason: "공익용산지에서는 태양광 산지일시사용이 사실상 허용되지 않습니다.", basis: "산지관리법 제12조제2항" },
  { re: /임업용산지/, level: "limit", reason: "보전산지(임업용)라 허가 요건이 엄격합니다.", basis: "산지관리법 제12조제1항" },
  { re: /준보전산지/, level: "cond", reason: "산지일시사용허가 대상입니다. 경사도·표고 기준을 확인하세요.", basis: "산지관리법 제15조의2" },
  { re: /상수원보호구역/, level: "no", reason: "상수원보호구역에서는 발전시설을 새로 설치할 수 없습니다.", basis: "수도법 제7조" },
  { re: /수변구역/, level: "limit", reason: "수변구역 행위 제한을 확인해야 합니다.", basis: "4대강 수계법(한강·낙동강·금강·영산강)" },
  { re: /국립공원|도립공원|군립공원|자연공원|공원자연/, level: "no", reason: "자연공원 안에서는 발전시설 허가를 받기 어렵습니다.", basis: "자연공원법 제23조" },
  { re: /백두대간/, level: "no", reason: "백두대간 보호지역 핵심·완충구역은 개발 행위가 제한됩니다.", basis: "백두대간보호법 제7조" },
  { re: /생태.?경관보전|습지보호|야생생물.*보호구역|특정도서/, level: "no", reason: "자연환경 보호구역이라 발전시설 설치가 제한됩니다.", basis: "자연환경보전법·습지보전법 등" },
  { re: /문화유산|문화재|역사문화환경|보호구역\(문화|국가유산/, level: "limit", reason: "문화유산 주변 현상변경 허가가 필요합니다.", basis: "문화유산법 제35조" },
  { re: /군사기지|군사시설|비행안전구역|통제보호구역|제한보호구역/, level: "cond", reason: "관할 부대와 협의가 필요합니다. 비행안전구역은 눈부심(반사광) 검토가 추가됩니다.", basis: "군사기지법 제13조" },
  { re: /자연취락지구/, level: "limit", reason: "취락지구 자체와 그 경계로부터 이격거리를 두는 조례가 많습니다.", basis: "지자체 도시·군계획 조례" },
  { re: /경관지구/, level: "cond", reason: "경관 심의를 거쳐야 할 수 있습니다.", basis: "국토계획법 제37조" },
  { re: /급경사|산사태|재해위험|붕괴위험/, level: "limit", reason: "재해 위험 지역으로 지정돼 있어 안전성 검토가 필요합니다.", basis: "급경사지법·산림보호법" },
  { re: /하천구역|소하천구역|홍수관리구역/, level: "limit", reason: "하천 점용 허가가 필요합니다.", basis: "하천법 제33조" },
];

// ---------- 조례 이격거리 ----------

export type Setback = {
  target: "road" | "residential" | "tourism" | "public" | "heritage" | "water" | "other";
  meters: number;
  text: string; // 근거 문장
  article: string; // 조례명 + 조 제목
};

export type SlopeLimit = { degrees: number; text: string; article: string };

export const TARGET_LABEL: Record<Setback["target"], string> = {
  road: "도로",
  residential: "주거지·마을",
  tourism: "관광지",
  public: "공공시설",
  heritage: "문화유산",
  water: "저수지·하천",
  other: "기타",
};

function classify(text: string): Setback["target"] {
  if (/주거|주택|인가|취락|마을|가구|호\s?(이상|미만)/.test(text)) return "residential";
  if (/도로|국도|지방도|군도|시도|고속/.test(text)) return "road";
  if (/관광/.test(text)) return "tourism";
  if (/문화|유적|국가유산/.test(text)) return "heritage";
  if (/공공시설|학교|공원/.test(text)) return "public";
  if (/저수지|하천|호소|댐|수변/.test(text)) return "water";
  return "other";
}

// "①", "1.", "가." 단위로 쪼갠다. 조례 본문은 번호 사이에 줄바꿈 없이 붙어 온다.
export function splitItems(content: string): string[] {
  return content
    .split(/(?=[①-⑳])|(?<!\d|\d\.)(?=\d{1,2}\.(?!\d))|(?<=[다음것함터])(?=[가-하]\.\s?)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const SOLAR_RE = /태양광|발전시설|태양에너지|신재생|재생에너지/;

// 발전시설 관련 조문에서 "무엇으로부터 몇 미터" 기준을 뽑는다.
export function extractSetbacks(articles: { ordinance: string; title: string; content: string }[]) {
  const setbacks: Setback[] = [];
  const slopes: SlopeLimit[] = [];
  for (const a of articles) {
    const articleName = `${a.ordinance} ${a.title}`.trim();
    if (/^(용어\s?)?정의$/.test(a.title)) continue; // 호수 산정용 "50미터 이내로 연결" 같은 정의는 기준이 아니다
    const solarArticle = SOLAR_RE.test(a.title) || SOLAR_RE.test(a.ordinance);
    let windOnly = false; // "③ 풍력 발전시설은 …" 항 아래 호들은 태양광에 적용하지 않는다
    for (const item of splitItems(a.content)) {
      if (/^[①-⑳]/.test(item)) windOnly = /풍력/.test(item.slice(0, 40)) && !/태양/.test(item.slice(0, 40));
      if (windOnly || (!solarArticle && !SOLAR_RE.test(item))) continue;
      const clean = item.replace(/<[^>]+>/g, "").trim();
      let prevEnd = 0;
      for (const m of clean.matchAll(/(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?\s*(킬로미터|km|미터|m)(?![a-z²])/gi)) {
        const n = Number(m[1].replace(/,/g, ""));
        const meters = /킬로|km/i.test(m[2]) ? n * 1000 : n;
        // "국도에서 500미터, 지방도에서 300미터"처럼 한 호에 여럿이면 바로 앞 구간이 대상이다
        const before = clean.slice(Math.max(prevEnd, m.index - 80), m.index);
        const after = clean.slice(m.index + m[0].length, m.index + m[0].length + 15);
        prevEnd = m.index + m[0].length;
        // 지붕 높이·진입도로 폭·호수 산정용 연결 거리 같은 숫자는 이격거리가 아니다
        if (meters < 10 || /높이|너비|폭|진입도로|난간|센티/.test(before.slice(-25)) || /연결/.test(after)) continue;
        if (!/로부터|에서|부터|이격|거리|이내|안에/.test(clean)) continue;
        const target = classify(before.trim() ? before : clean.slice(0, 80));
        if (target === "other") continue; // 대상을 모르는 거리는 조문 목록과 AI 의견에 맡긴다
        if (setbacks.some((s) => s.target === target && s.meters === meters && s.article === articleName)) continue;
        setbacks.push({ target, meters, text: clean.slice(0, 260), article: articleName });
      }
      const s = clean.match(/경사도?가?\s*(\d+(?:\.\d+)?)\s*도\s*(초과|이상)/);
      if (s) slopes.push({ degrees: Number(s[1]), text: clean.slice(0, 200), article: articleName });
    }
  }
  return { setbacks, slopes };
}

// ---------- 종합 ----------

export type Distances = Partial<Record<Setback["target"], number>>;

export function assess(land: Land, setbacks: Setback[], slopes: SlopeLimit[], distances: Distances = {}) {
  const findings: Finding[] = [jimokRule(land.jimok, land.areas)];
  const zones = land.zones.length ? land.zones : [];
  for (const z of zones) findings.push(zoneRule(z));
  if (!zones.length) findings.push({ topic: "용도지역", level: "cond", reason: "용도지역을 확인하지 못했습니다.", basis: "토지이용계획확인서" });

  const seen = new Set<string>();
  for (const area of land.areas) {
    const r = AREA_RULES.find((x) => x.re.test(area));
    if (!r || seen.has(r.reason)) continue;
    seen.add(r.reason);
    findings.push({ topic: area, level: r.level, reason: r.reason, basis: r.basis });
  }

  // 조례 이격거리: 대상별로 가장 엄격한(긴) 기준을 적용
  const strictest = new Map<Setback["target"], Setback>();
  for (const s of setbacks) {
    if (s.target === "other") continue;
    const cur = strictest.get(s.target);
    if (!cur || s.meters > cur.meters) strictest.set(s.target, s);
  }
  for (const [target, s] of strictest) {
    const d = distances[target];
    const topic = `조례 이격: ${TARGET_LABEL[target]} ${s.meters.toLocaleString()}m`;
    if (d === undefined || Number.isNaN(d))
      findings.push({ topic, level: "cond", reason: `부지에서 가장 가까운 ${TARGET_LABEL[target]}까지 거리를 확인해야 합니다.`, basis: s.article });
    else if (d >= s.meters)
      findings.push({ topic, level: "ok", reason: `입력한 거리 ${d.toLocaleString()}m로 기준을 충족합니다.`, basis: s.article });
    else
      findings.push({ topic, level: "no", reason: `입력한 거리 ${d.toLocaleString()}m가 가장 엄격한 기준보다 ${(s.meters - d).toLocaleString()}m 짧습니다. 도로 종류·마을 규모별로 기준이 다르거나 예외(지형 차폐, 주민 동의, 공공사업 등)가 있는지 조문을 확인하세요.`, basis: s.article });
  }
  for (const sl of slopes.slice(0, 1)) {
    const steep = land.terrain && /급경사|고지/.test(land.terrain);
    findings.push({
      topic: `조례 경사도: ${sl.degrees}° 이하`,
      level: steep ? "limit" : "cond",
      reason: steep ? `지형이 '${land.terrain}'로 분류돼 경사도 기준을 넘길 가능성이 큽니다.` : `평균경사도 측정이 필요합니다${land.terrain ? ` (공시 지형: ${land.terrain})` : ""}.`,
      basis: sl.article,
    });
  }

  const level = findings.reduce<Level>((w, f) => (RANK[f.level] > RANK[w] ? f.level : w), "ok");
  return { level, findings, permits: permits(land) };
}

// 지상형 태양광에 필요한 인허가를 순서대로. LLM이 절차를 지어내지 않도록 규칙으로 정한다.
export function permits(land: Land): string[] {
  const has = (re: RegExp) => land.areas.some((a) => re.test(a));
  const out = ["발전사업허가 (전기사업법 제7조 · 3MW 이하는 시·도지사, 초과는 중앙정부)"];
  if (["전", "답", "과수원"].includes(land.jimok)) out.push("농지전용허가 또는 농지 타용도 일시사용허가 (농지법 제34조·제36조 · 시장·군수·구청장)");
  if (land.jimok === "임야" || has(/산지/)) out.push("산지일시사용허가 (산지관리법 제15조의2 · 시장·군수·구청장 또는 산림청)");
  if (land.jimok === "목장용지") out.push("초지전용허가 (초지법 제23조)");
  if (has(/개발제한구역/)) out.push("개발제한구역 행위허가 (개발제한구역법 제12조)");
  if (has(/문화유산|문화재|국가유산|역사문화환경/)) out.push("국가유산 현상변경 허가 (문화유산법 제35조)");
  if (has(/군사|비행안전/)) out.push("관할 부대 협의 (군사기지법 제13조)");
  out.push("개발행위허가 (국토계획법 제56조 · 도시·군계획 조례의 발전시설 기준 적용 · 다른 허가를 의제 처리하는 경우가 많음)");
  out.push("면적·용도지역에 따라 소규모 환경영향평가 협의 (환경영향평가법 제43조)");
  out.push("한전 계통연계 신청 (접속 가능 용량 확인)");
  out.push("공사 후 사용전검사 (전기안전관리법) → 상업운전");
  return out;
}
