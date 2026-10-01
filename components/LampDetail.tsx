"use client";

import { repairLamp, type FaultKind, type Lamp } from "@/lib/sim";
import { resetLamp } from "@/lib/ml";

export const KIND_LABEL: Record<FaultKind | "unknown", string> = {
  voltage: "전압 불안정",
  overheat: "과열",
  driver: "LED 드라이버 노후",
  unknown: "이상 (원인 확인 필요)",
};

// 선택한 가로등의 최근 30분 센서 값 추이
function Sparkline({ values, color, min, max }: { values: number[]; color: string; min?: number; max?: number }) {
  if (values.length < 2) return <svg className="spark" />;
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 26}`).join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const LIT: Record<NonNullable<Lamp["litBy"]>, string> = {
  camera: "카메라가 사람·차를 봐서 켬",
  predict: "다가오는 사람·차를 예측해 미리 켬",
  walker: "근처 통행으로 켬",
};

export default function LampDetail({ lamp, verdict }: { lamp: Lamp; verdict: FaultKind | "unknown" | null }) {
  const tone = lamp.health < 60 ? "bad" : lamp.health < 85 ? "warn" : "ok";
  return (
    <div className="lamp-detail">
      <div className="lamp-head">
        <div>
          <b className="lamp-id">{lamp.id}</b>
          <span className={`pill tone-${verdict ? tone : "ok"}`}>{verdict ? KIND_LABEL[verdict] : "정상"}</span>
        </div>
        <span className={`score tone-${tone}`}>
          상태 점수 <b>{lamp.health}</b>
        </span>
      </div>
      <div className="metrics">
        <div className="metric">
          <span>전압</span>
          <b>{lamp.voltage.toFixed(1)}V</b>
          <Sparkline values={lamp.history.voltage} color="var(--chart-1)" min={170} max={260} />
        </div>
        <div className="metric">
          <span>전류</span>
          <b>{lamp.current.toFixed(2)}A</b>
          <Sparkline values={lamp.history.current} color="var(--chart-2)" min={0} max={0.8} />
        </div>
        <div className="metric">
          <span>온도</span>
          <b>{lamp.temp.toFixed(0)}°C</b>
          <Sparkline values={lamp.history.temp} color="var(--chart-3)" min={10} max={85} />
        </div>
      </div>
      <p className="muted">
        밝기 {Math.round(lamp.brightness * 100)}%{lamp.litBy ? ` · ${LIT[lamp.litBy]}` : ""} · 배터리 {lamp.battery.toFixed(0)}% · 어제 태양광 충전{" "}
        {lamp.solarWh.toFixed(0)}Wh
      </p>
      {lamp.ml && (
        <p className="muted">
          고장 유형 AI: {lamp.ml.kind === "normal" ? "정상" : KIND_LABEL[lamp.ml.kind]} (확신 {(lamp.ml.prob * 100).toFixed(0)}%) · 이상 패턴 점수{" "}
          {lamp.ml.anomaly.toFixed(1)}
          {lamp.ml.anomalyFlag ? " (평소와 다름)" : ""}
        </p>
      )}
      {lamp.issues.map((i) => (
        <p key={i.kind} className="issue-detail">
          <b>{i.label}</b> {i.detail}
        </p>
      ))}
      {verdict && (
        <button
          className="btn"
          onClick={() => {
            repairLamp(lamp);
            resetLamp(lamp.id);
          }}
        >
          수리 완료로 처리
        </button>
      )}
    </div>
  );
}
