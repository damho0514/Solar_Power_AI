// 무료 LLM(로컬 Ollama 또는 Gemini)에 관제 데이터를 넘겨 점검 보고서를 받아 스트리밍한다.

import { streamChat } from "@/lib/llm";

type ReportInput = {
  total: number;
  savingPct: number;
  savedWh: number;
  camera: {
    total: number;
    person: number;
    vehicle: number;
    avgSpeedKmh: number | null;
    predErrM: number | null;
    nextForecast: number | null;
    binSeconds: number;
    idleReason: string;
  };
  school?: {
    period: string;
    limit: number;
    counts: { speeding: number; conflict: number; parking: number; crossing: number };
    slowRate: number | null;
    warned: number;
    recent: string[];
  };
  solar: { date: string; source: string; totalWh: number; risky: { id: string; endPct: number }[] } | null;
  method: string;
  flagged: {
    id: string;
    health: number;
    verdict: string;
    issues: { label: string; detail: string }[];
    battery: number;
    solarWh: number;
  }[];
};

function buildPrompt(d: ReportInput) {
  const c = d.camera;
  const camera = [
    `- 카메라가 추적한 통행: ${c.total}건 (보행자 ${c.person}, 차량 ${c.vehicle})`,
    c.avgSpeedKmh !== null ? `- 평균 이동 속도: ${c.avgSpeedKmh.toFixed(1)}km/h` : null,
    c.predErrM !== null ? `- 1초 뒤 위치 예측 평균 오차: ${(c.predErrM * 100).toFixed(0)}cm` : null,
    c.nextForecast !== null ? `- 다음 ${c.binSeconds}초 예상 통행: ${c.nextForecast.toFixed(1)}건` : "- 통행량 예측: 데이터 수집 중",
    `- 대기 밝기 정책 (사람이 없을 때 가로등 기본 출력, 절감률과 다른 값): ${c.idleReason}`,
  ]
    .filter(Boolean)
    .join("\n");

  const lamps =
    d.flagged.length === 0
      ? "이상 징후가 있는 가로등 없음"
      : d.flagged
          .map(
            (l) =>
              `- ${l.id}: ${l.verdict} (건강도 ${l.health}점, 배터리 ${l.battery.toFixed(0)}%, 어제 발전량 ${l.solarWh.toFixed(0)}Wh)\n` +
              l.issues.map((i) => `  · ${i.label}: ${i.detail}`).join("\n"),
          )
          .join("\n");

  const solar = d.solar
    ? `- ${d.solar.date} 예상 발전량: 패널 1장 기준 ${Math.round(d.solar.totalWh)}Wh (${d.solar.source})\n` +
      (d.solar.risky.length
        ? `- 내일 밤 뒤 배터리 20% 미만 예상: ${d.solar.risky.map((r) => `${r.id}(${r.endPct.toFixed(0)}%)`).join(", ")}`
        : "- 내일 밤 뒤 배터리 20% 미만 예상 가로등 없음")
    : "- 태양광 예보를 받지 못함";

  const z = d.school;
  const school = z
    ? [
        `- 운영 시간대: ${z.period} · 제한속도 ${z.limit}km/h`,
        `- 오늘 기록: 과속 ${z.counts.speeding}건, 보행자 충돌 위험 ${z.counts.conflict}건, 불법 주정차 ${z.counts.parking}건, 보행자 횡단 ${z.counts.crossing}건`,
        z.slowRate === null ? "- 경고 후 감속: 과속 차량 없음" : `- 경고 후 감속: 과속 차량 ${z.warned}대 중 ${Math.round(z.slowRate * 100)}%가 전광판 경고 뒤 제한속도 아래로 감속`,
        z.recent.length ? `- 최근 사건:\n${z.recent.map((r) => `  · ${r}`).join("\n")}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "- 데이터 없음";

  return `당신은 지자체 스마트 가로등 관제센터의 유지보수 담당자입니다.
아래 데이터만 근거로 오늘의 점검 보고서를 한국어로 작성하세요. 데이터에 없는 사실은 지어내지 마세요.

[운영 현황]
- 관리 가로등: ${d.total}개
- 상황 인지형 디밍 절감률: ${d.savingPct.toFixed(1)}% (절감 전력 ${d.savedWh.toFixed(0)}Wh)

[카메라 AI (실측)]
${camera}

[어린이보호구역 (카메라 실측 + 시뮬레이션)]
${school}

[태양광 발전 예측 (ML)]
${solar}

[이상 징후 가로등 · 판정 방법: ${d.method}]
${lamps}

[형식]
## 요약
두세 문장.
## 우선 점검 대상
건강도가 낮은 순서로, 가로등 번호, 의심 원인, 권장 조치(현장 점검/부품 교체/모니터링 유지)를 표로.
## 어린이보호구역 안전
과속·충돌 위험·불법 주정차 건수와 경고 후 감속률, 필요한 조치(단속 요청, 시간대 집중 관리)를 두세 문장으로.
## 통행 및 조명 제어
카메라 통행량, 이동 예측, 대기 밝기 정책을 두세 문장으로.
## 태양광·배터리
내일 발전량과 배터리 위험 가로등, 필요한 조치(밝기 낮추기, 점검)를 두세 문장으로.
## 에너지 절감
한두 문장.`;
}

export async function POST(req: Request) {
  const data = (await req.json()) as ReportInput;
  return streamChat(buildPrompt(data));
}
