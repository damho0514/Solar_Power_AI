// 토지 정보·법령 판정·조례 조문을 로컬 LLM에 넘겨 태양광 입지 검토 의견서를 받아 스트리밍한다.
// 판정 결과는 규칙으로 이미 정해져 있고, LLM은 조례 조문을 읽고 예외·추가 조건을 풀어 설명하는 역할이다.

import { streamChat } from "@/lib/llm";
import { LEVEL_LABEL, TARGET_LABEL, type Distances, type Finding, type Land, type Level, type Setback } from "@/lib/siting";
import type { Article } from "@/lib/ordinance";

type Input = {
  land: Land;
  level: Level;
  findings: Finding[];
  permits: string[];
  setbacks: Setback[];
  articles: Article[];
  distances: Distances;
};

const ARTICLE_BUDGET = 6000; // 조문 발췌 글자 수 한도 (gemma3:4b 문맥 창에 맞춤)

function buildPrompt(d: Input) {
  const l = d.land;
  const land = [
    `- 주소: ${l.address}`,
    `- 관할: ${l.sido} ${l.sigungu}`.trim(),
    `- 지목: ${l.jimok || "모름"}`,
    `- 용도지역: ${l.zones.join(", ") || "모름"}`,
    `- 그 밖의 지역·지구·구역: ${l.areas.join(", ") || "없음"}`,
    l.areaM2 ? `- 면적: ${l.areaM2.toLocaleString()}㎡` : null,
    l.terrain ? `- 지형: ${l.terrain}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const findings = d.findings.map((f) => `- [${LEVEL_LABEL[f.level]}] ${f.topic}: ${f.reason} (근거: ${f.basis})`).join("\n");
  const dist = Object.entries(d.distances)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${TARGET_LABEL[k as Setback["target"]]} ${v}m`)
    .join(", ");

  // 발전시설 조 제목이 붙은 조문을 먼저, 한도 안에서만 넣는다
  const sorted = [...d.articles].sort((a, b) => Number(/발전|태양/.test(b.title)) - Number(/발전|태양/.test(a.title)));
  let used = 0;
  const excerpts: string[] = [];
  for (const a of sorted) {
    const text = `〈${a.ordinance} · ${a.title}〉\n${a.content}`;
    if (used + text.length > ARTICLE_BUDGET) {
      if (!excerpts.length) excerpts.push(text.slice(0, ARTICLE_BUDGET));
      break;
    }
    excerpts.push(text);
    used += text.length;
  }

  return `당신은 태양광 발전사업 인허가 컨설턴트입니다.
아래 [토지], [규칙 판정], [조례 조문]만 근거로 이 부지의 지상형 태양광 설치 가능성 검토 의견을 한국어로 쓰세요.
- [토지]에 없는 지역·지구·구역(농업진흥구역, 개발제한구역 등)을 이 부지에 해당한다고 쓰지 마세요.
- 조례 조문에 없는 거리·수치를 지어내지 마세요. 인용할 때는 〈조례명 · 조 제목〉을 밝히세요.
- 종합 판정은 규칙 판정의 결론 "${LEVEL_LABEL[d.level]}"을 따르되, 조문에 예외 조항(지형 차폐, 주민 동의, 공공사업, 지붕형 등)이 있으면 설명하세요.
- 확정 판단이 아니라 사전 검토라는 점을 한 번만 밝히세요.

[토지]
${land}

[규칙 판정 · 종합 ${LEVEL_LABEL[d.level]}]
${findings}
${dist ? `\n[사용자가 입력한 부지 주변 거리]\n${dist}\n` : ""}
[필요 인허가 (규칙으로 정함)]
${d.permits.map((p, i) => `${i + 1}. ${p}`).join("\n")}

[조례 조문]
${excerpts.join("\n\n") || "관련 조례 조문을 찾지 못함"}

[형식]
## 종합 의견
두세 문장. 가능 여부와 가장 큰 걸림돌.
## 조례 적용 결과
이격거리·경사도 등 조례 기준을 표로 (기준 | 조례 내용 | 이 부지 적용 | 근거 조문).
## 인허가 절차
[필요 인허가]를 그대로 순서대로 쓰고, 조례에 이 부지와 관련된 추가 조건(심의, 주민 동의 등)이 있으면 해당 항목 옆에 덧붙이세요. 목록에 없는 허가를 새로 넣지 마세요.
## 현장에서 확인할 것
목록으로 세 개 이내.`;
}

export async function POST(req: Request) {
  const data = (await req.json()) as Input;
  return streamChat(buildPrompt(data), { num_ctx: 12288 });
}
