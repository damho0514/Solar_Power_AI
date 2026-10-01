// 현장 요구사항 체크리스트: 지금 이 순간 무엇을 분석하고 있고 결과가 어떤지.
// 어린이보호구역 · 시설·전기 안전 · 태양광·에너지 세 갈래. 항목마다 근거 데이터(카메라 실측 / 가상 센서 / 기상 예보)를 밝힌다.
// 요구사항 목록은 시장 조사(docs/market-and-plan.md)에서 지자체 입찰·사례에 반복된 기능을 따랐다.

import type { Snapshot } from "@/lib/monitor";

export type ReqStatus = "ok" | "watch" | "alert" | "idle";
export type ReqItem = { label: string; status: ReqStatus; value: string; basis: string };
export type ReqGroup = { id: "school" | "facility" | "energy"; title: string; items: ReqItem[] };

const KIND: Record<string, string> = { voltage: "전압 불안정", overheat: "과열", driver: "LED 드라이버 노후", unknown: "원인 확인 필요" };

export function evaluate(s: Snapshot | undefined): ReqGroup[] {
  if (!s) return [];
  const cam = s.cam;
  const z = s.zone;
  const camBasis = cam.on ? "웹캠 실측" : "웹캠 꺼짐 · 지도 시뮬레이션";
  const issues = (k: string) => s.lamps.issues.filter((i) => i.kind === k).map((i) => i.id);
  const lampItem = (label: string, k: string): ReqItem => {
    const ids = issues(k);
    return { label, status: ids.length ? "alert" : "ok", value: ids.length ? `${ids.join(", ")}` : "이상 없음", basis: "가로등 센서 (가상)" };
  };
  return [
    {
      id: "school",
      title: "어린이보호구역 안전",
      items: [
        {
          label: "보행자·어린이 감지",
          status: cam.on ? (cam.person ? "watch" : "ok") : "idle",
          value: cam.on ? (cam.person ? `${cam.person}명 보는 중` : "보행자 없음") : "웹캠을 켜면 감지해요",
          basis: camBasis,
        },
        {
          label: `과속 감시 (제한 ${z.limit}km/h · ${z.period})`,
          status: cam.maxKmh > z.limit ? "alert" : cam.on ? "ok" : "idle",
          value: cam.on ? (cam.maxKmh ? `지금 최고 ${cam.maxKmh.toFixed(0)}km/h` : "움직이는 차 없음") + ` · 누계 ${z.counts.speeding}건` : `누계 ${z.counts.speeding}건`,
          basis: camBasis,
        },
        { label: "보행자 충돌 위험", status: z.level === "danger" ? "alert" : z.counts.conflict ? "watch" : "ok", value: `누계 ${z.counts.conflict}건`, basis: camBasis },
        { label: "불법 주정차 (시야 가림)", status: z.counts.parking ? "watch" : "ok", value: `누계 ${z.counts.parking}건`, basis: camBasis },
        { label: "교차로 우회전 위험", status: z.counts.rightturn ? "watch" : "ok", value: `누계 ${z.counts.rightturn}건`, basis: camBasis },
        {
          label: "전광판 경고 표출",
          status: z.level === "danger" ? "alert" : z.level === "slow" ? "watch" : "ok",
          value: `"${z.text}"`,
          basis: "AI 판단 → 전광판",
        },
      ],
    },
    {
      id: "facility",
      title: "시설·전기 안전",
      items: [
        lampItem("전압 불안정 (누전·접촉 불량 의심)", "voltage"),
        lampItem("과열 (화재 위험)", "overheat"),
        lampItem("LED 드라이버 노후", "driver"),
        {
          label: "점검 필요 가로등",
          status: s.lamps.bad ? "alert" : s.lamps.flagged ? "watch" : "ok",
          value: `${s.lamps.flagged}개 / 전체 ${s.lamps.total}개 (긴급 ${s.lamps.bad}개)`,
          basis: "고장 예측 AI",
        },
      ],
    },
    {
      id: "energy",
      title: "태양광·에너지",
      items: [
        {
          label: "내일 태양광 충전 예보",
          status: s.solar.totalWh === null ? "idle" : "ok",
          value: s.solar.totalWh === null ? "예보 불러오는 중" : `패널 1장 ${Math.round(s.solar.totalWh)}Wh${s.solar.date ? ` (${s.solar.date})` : ""}`,
          basis: "기상 예보 + 발전량 예측 AI",
        },
        { label: "배터리 부족 예상 가로등", status: s.solar.risky ? "watch" : "ok", value: `${s.solar.risky}개`, basis: "충전 예보 × 밤 사용량" },
        { label: "상황 인지 절전", status: "ok", value: `절전율 ${s.energy.savingPct.toFixed(0)}% · 미리 켠 가로등 ${s.lamps.prelit}개`, basis: "카메라 + 통행량 예측" },
      ],
    },
  ];
}

export const kindLabel = (k: string) => KIND[k] ?? k;
