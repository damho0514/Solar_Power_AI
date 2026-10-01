// 모니터링 기록 한 건(요약 + 분 단위 흐름)을 받아 요구사항별 분석 리포트를 LLM으로 써서 스트리밍한다.
// 숫자는 화면이 계산해 넘긴 것만 쓰게 하고, 웹캠 실측과 시뮬레이션·가상 센서를 구분해 쓰게 한다.

import { streamChat } from "@/lib/llm";
import type { Summary } from "@/lib/monitor";
import { DATA_RULE, cleanText, fail, guardJson } from "@/lib/server/guard";

type Minute = { t: string; person: number; vehicle: number; maxKmh: number; danger: number; flagged: number };
type Input = { name: string; start: string; end: string; summary: Summary; minutes: Minute[] };

const pct = (v: number | null) => (v === null ? "해당 없음" : `${Math.round(v * 100)}%`);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function buildPrompt(d: Input) {
  const s = d.summary;
  const e = s.school.events;
  const faults = s.facility.faults.map((f) => `${cleanText(String(f.id), 12)}(${f.kinds.map((k) => cleanText(String(k), 20)).join("·")})`).join(", ") || "없음";
  const flow = d.minutes
    .slice(0, 60)
    .map((m) => `${cleanText(String(m.t), 8)} 보행자최대 ${num(m.person)} · 차량최대 ${num(m.vehicle)} · 최고 ${num(m.maxKmh).toFixed(0)}km/h · 경고(멈추세요) ${num(m.danger)}초 · 이상가로등 ${num(m.flagged)}`)
    .join("\n");
  return `당신은 지자체 스마트 가로등·어린이보호구역 관제센터의 분석 담당자입니다.
아래 모니터링 기록만 근거로 요구사항별 분석 리포트를 한국어로 쓰세요. 기록에 없는 숫자나 사실은 지어내지 마세요.
웹캠 실측(카메라)과 지도 시뮬레이션·가상 센서 값을 구분해서 쓰세요. 속도는 화면 이동 거리로 환산한 추정값이라 단속 근거가 아니라는 점을 한 번만 밝히세요.
${DATA_RULE}

<자료>
[기록] ${cleanText(d.name, 60)} · ${cleanText(d.start, 30)} ~ ${cleanText(d.end, 30)} (${Math.round(num(s.seconds) / 60)}분 ${num(s.seconds) % 60}초) · 웹캠 켜짐 ${pct(s.camOnPct)}

[어린이보호구역]
- 새로 생긴 사건: 과속 ${num(e.speeding)}건, 보행자 충돌 위험 ${num(e.conflict)}건, 불법 주정차 ${num(e.parking)}건, 우회전 위험 ${num(e.rightturn)}건, 보행자 횡단 ${num(e.crossing)}건 (그중 웹캠 실측 위험 사건 ${num(s.school.cameraEvents)}건, 나머지는 시뮬레이션)
- 웹캠이 동시에 본 최대 인원: 보행자 ${num(s.school.peakPerson)}명, 차량 ${num(s.school.peakVehicle)}대, 최고 속도 ${num(s.school.maxKmh).toFixed(0)}km/h
- 전광판 "멈추세요" 경고 시간 ${num(s.school.dangerSec)}초, 경고 후 감속률 ${pct(s.school.slowRate)}, 우회전 일시정지율 ${pct(s.school.rtRate)}

[시설·전기 안전 (가로등 센서는 가상 데이터)]
- 동시에 이상 징후가 있던 가로등 최대 ${num(s.facility.peakFlagged)}개 / 전체 ${num(s.facility.total)}개, 긴급 점검 상태였던 시간 ${num(s.facility.badSec)}초
- 이상 가로등: ${faults}

[태양광·에너지]
- 절전율 ${num(s.energy.savingPct).toFixed(1)}%, 기록 동안 아낀 전기 ${num(s.energy.savedWh).toFixed(0)}Wh
- 내일 태양광 충전 예보 ${s.energy.solarWh === null ? "없음" : `패널 1장 ${Math.round(num(s.energy.solarWh))}Wh`}, 배터리 부족 예상 ${num(s.energy.risky)}개

[분 단위 흐름]
${flow || "없음"}
</자료>

[형식]
## 한눈에 보기
세 문장 이내. 가장 위험했던 점과 가장 잘 된 점.
## 어린이보호구역
표로 (요구사항 | 결과 | 판단). 과속·충돌 위험·불법 주정차·우회전 위험·전광판 경고 효과.
## 시설·전기 안전
이상 가로등과 의심 원인, 점검 우선순위.
## 태양광·에너지
절전 효과와 내일 배터리 위험.
## 시간대 흐름
분 단위 흐름에서 눈에 띄는 시각 두세 개.
## 권장 조치
번호 목록 세 개 이내 (단속 요청, 현장 점검, 운영 시간대 조정 등).`;
}

const LIMITS = { maxStr: 120, maxArr: 80, maxDepth: 6, maxKeys: 30 };

export async function POST(req: Request) {
  const g = await guardJson(req, { name: "monitor-report", limit: 6, maxBytes: 60_000, clamp: LIMITS });
  if (!g.ok) return g.res;
  const d = g.body as Input;
  if (!d || typeof d !== "object" || !d.summary?.school || !Array.isArray(d.minutes)) return fail(400, "기록 형식이 맞지 않아요");
  let prompt: string;
  try {
    prompt = buildPrompt(d);
  } catch (e) {
    return fail(400, "기록 형식이 맞지 않아요", e);
  }
  return streamChat(prompt, { num_ctx: 8192 });
}
