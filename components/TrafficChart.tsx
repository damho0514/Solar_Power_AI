"use client";

import { useState } from "react";
import { BIN_MS } from "@/lib/forecast";

type Props = { bins: number[]; current: number; forecast: number[] | null };

const W = 360;
const H = 130;
const PAD = { l: 26, r: 8, t: 12, b: 22 };

// 완료된 구간(막대) + 진행 중 구간(옅은 막대) + 예측(점선)
export default function TrafficChart({ bins, current, forecast }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const past = bins.slice(-11);
  const fc = forecast ?? [];
  const slots = past.length + 1 + fc.length;
  const max = Math.max(4, ...past, current, ...fc);
  const ticks = max <= 5 ? [0, Math.ceil(max / 2), Math.ceil(max)] : [0, Math.round(max / 2), Math.ceil(max)];
  const top = ticks[2];
  const slotW = (W - PAD.l - PAD.r) / Math.max(slots, 12);
  const barW = Math.max(6, slotW - 4);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  const x = (i: number) => PAD.l + i * slotW + (slotW - barW) / 2;
  const base = y(0);
  const sec = BIN_MS / 1000;

  // 막대 윗부분만 둥글게 (4px), 바닥은 기준선에 붙인다
  const bar = (i: number, v: number) => {
    const h = base - y(v);
    const r = Math.min(4, h, barW / 2);
    const x0 = x(i);
    return `M${x0},${base} V${base - h + r} Q${x0},${base - h} ${x0 + r},${base - h} H${x0 + barW - r} Q${x0 + barW},${base - h} ${x0 + barW},${base - h + r} V${base} Z`;
  };

  const nowIdx = past.length;
  const fcPts = fc.map((v, k) => `${x(nowIdx + 1 + k) + barW / 2},${y(v)}`);
  const lastPt = past.length ? [`${x(nowIdx - 1) + barW / 2},${y(past[past.length - 1])}`] : [];
  const fcLine = [...lastPt, ...fcPts].join(" ");

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="구간별 통행량과 예측">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="axis">
              {t}
            </text>
          </g>
        ))}

        {past.map((v, i) =>
          v > 0 ? (
            <path key={i} d={bar(i, v)} fill="var(--chart-1)" />
          ) : (
            <line key={i} x1={x(i)} x2={x(i) + barW} y1={base - 1} y2={base - 1} stroke="var(--chart-1)" strokeWidth={2} />
          ),
        )}
        {current > 0 && <path d={bar(nowIdx, current)} fill="var(--chart-1)" opacity={0.45} />}

        {fc.length > 0 && (
          <>
            <polyline points={fcLine} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeDasharray="5 4" />
            {fc.map((v, k) => (
              <circle key={k} cx={x(nowIdx + 1 + k) + barW / 2} cy={y(v)} r={4} fill="var(--panel)" stroke="var(--chart-1)" strokeWidth={2} />
            ))}
          </>
        )}

        <line x1={x(nowIdx) - 2} x2={x(nowIdx) - 2} y1={PAD.t} y2={base} stroke="var(--muted)" strokeDasharray="2 3" />
        <text x={x(nowIdx) - 6} y={H - 6} textAnchor="end" className="axis">
          지금
        </text>
        {fc.length > 0 && (
          <text x={W - PAD.r} y={H - 6} textAnchor="end" className="axis">
            +{sec * fc.length}초
          </text>
        )}

        {/* 마우스 감지 영역: 막대보다 넓게 */}
        {Array.from({ length: slots }, (_, i) => {
          const label =
            i < nowIdx
              ? `${(nowIdx - i) * sec}초 전 구간 · 실제 ${past[i]}건`
              : i === nowIdx
                ? `진행 중 구간 · 지금까지 ${current}건`
                : `${(i - nowIdx) * sec}초 뒤 구간 · 예측 ${fc[i - nowIdx - 1].toFixed(1)}건`;
          return (
            <rect
              key={i}
              x={PAD.l + i * slotW}
              y={PAD.t}
              width={slotW}
              height={base - PAD.t}
              fill="transparent"
              onMouseEnter={() => setHover(label)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>
      <p className="chart-note">
        {hover ?? (
          <>
            <span className="key solid" />
            실제 (1칸 = {sec}초) <span className="key dashed" />
            예측
          </>
        )}
      </p>
    </div>
  );
}
