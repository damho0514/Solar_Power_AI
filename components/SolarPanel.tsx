"use client";

import { useEffect, useState, type RefObject } from "react";
import { BATTERY_WH, NIGHT_DUTY, NIGHT_HOURS, RISK_LEVEL, batteryOutlook } from "@/lib/solar";
import { RATED_WATT, type Lamp } from "@/lib/sim";

type Forecast = {
  date: string;
  source: string;
  panelWp: number;
  totalWh: number;
  hourly: { time: string; sky: 1 | 3 | 4; rain: 0 | 1; wh: number }[];
};

const SKY: Record<number, string> = { 1: "맑음", 3: "구름많음", 4: "흐림" };
const NOMINAL_SOLAR_WH = 1250; // 시뮬레이터의 "어제 발전량" 정상값. 이 비율을 패널 상태로 본다.


export type SolarSummary = { date: string; source: string; totalWh: number; risky: { id: string; endPct: number }[] };

type Props = { lamps: Lamp[]; onSelect: (id: string) => void; summaryRef: RefObject<SolarSummary | null> };

export default function SolarPanel({ lamps, onSelect, summaryRef }: Props) {
  const [fc, setFc] = useState<Forecast | null>(null);
  const [error, setError] = useState("");
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/solar")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? r.status);
        setFc(j);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const outlook = fc
    ? lamps
        .map((l) => {
          const factor = Math.min(1.1, Math.max(0.5, l.solarWh / NOMINAL_SOLAR_WH));
          return { lamp: l, gen: fc.totalWh * factor, factor, ...batteryOutlook(l.battery, RATED_WATT * NIGHT_DUTY, fc.totalWh * factor) };
        })
        .sort((a, b) => a.endPct - b.endPct)
    : [];
  const risky = outlook.filter((o) => o.risk);
  // 보고서 작성 버튼이 누를 때 읽어 가는 최신 요약
  summaryRef.current = fc
    ? { date: fc.date, source: fc.source, totalWh: fc.totalWh, risky: risky.map((o) => ({ id: o.lamp.id, endPct: o.endPct })) }
    : null;

  const W = 360, H = 120, L = 30, R = 8, T = 10, B = 22;
  const hours = fc?.hourly ?? [];
  const peak = Math.max(20, ...hours.map((h) => h.wh));
  const top = Math.ceil(peak / 20) * 20;
  const slot = (W - L - R) / Math.max(hours.length, 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const base = y(0);
  const skyHours = hours.filter((h) => h.wh > 1);
  const skyNote = [1, 3, 4]
    .map((s) => [SKY[s], skyHours.filter((h) => h.sky === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([n, c]) => `${n} ${c}시간`)
    .concat(skyHours.some((h) => h.rain) ? [`비 ${skyHours.filter((h) => h.rain).length}시간`] : [])
    .join(" · ");

  return (
    <section className="card">
      <header className="card-head">
        <h2>내일 태양광 충전 예보</h2>
        <span className="muted">{fc ? `${fc.date} · ${fc.source}` : "날씨 예보를 불러오는 중…"}</span>
      </header>
      {error && <p className="report-body error">날씨 예보를 받지 못했어요: {error}</p>}
      {fc && (
        <div className="grid-2">
          <div>
            <p className="solar-total">
              패널 1장({fc.panelWp}W)이 내일 충전할 양 <b>{Math.round(fc.totalWh)}Wh</b>
            </p>
            <div className="chart">
              <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="내일 시간별 예상 발전량">
                {[0, top / 2, top].map((t) => (
                  <g key={t}>
                    <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
                    <text x={L - 5} y={y(t) + 4} textAnchor="end" className="axis">
                      {t}
                    </text>
                  </g>
                ))}
                {hours.map((h, i) => {
                  const bw = Math.max(3, slot - 2);
                  const x = L + i * slot + (slot - bw) / 2;
                  const hh = base - y(h.wh);
                  const r = Math.min(3, hh, bw / 2);
                  const label = `${h.time.slice(11, 13)}시 · ${SKY[h.sky]}${h.rain ? "·비" : ""} · ${Math.round(h.wh)}Wh`;
                  return (
                    <g key={h.time} onMouseEnter={() => setHover(label)} onMouseLeave={() => setHover(null)}>
                      <rect x={L + i * slot} y={T} width={slot} height={base - T} fill="transparent" />
                      {h.wh > 0.5 && (
                        <path
                          d={`M${x},${base} V${base - hh + r} Q${x},${base - hh} ${x + r},${base - hh} H${x + bw - r} Q${x + bw},${base - hh} ${x + bw},${base - hh + r} V${base} Z`}
                          fill="var(--chart-3)"
                        />
                      )}
                      {i % 6 === 0 && (
                        <text x={L + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="axis">
                          {h.time.slice(11, 13)}시
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              <p className="chart-note">{hover ?? `시간별 예상 발전량 (Wh) · ${skyNote}`}</p>
            </div>
          </div>
          <div>
            <p className={`solar-total ${risky.length ? "warn" : "ok"}`}>
              배터리 부족 예상 <b>{risky.length}개</b> / {lamps.length}개
            </p>
            <p className="muted">
              오늘 밤 쓰고, 내일 충전하고, 내일 밤 쓴 뒤 {RISK_LEVEL * 100}% 아래로 떨어지면 부족으로 봐요 · 가정: 배터리 {BATTERY_WH / 1000}kWh, 밤{" "}
              {NIGHT_HOURS}시간, 평균 밝기 {NIGHT_DUTY * 100}% (밤 사용 {RATED_WATT * NIGHT_DUTY * NIGHT_HOURS}Wh)
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>가로등</th>
                  <th>지금</th>
                  <th>내일 충전</th>
                  <th>내일 밤 뒤 남는 양</th>
                </tr>
              </thead>
              <tbody>
                {outlook.slice(0, 5).map((o) => (
                  <tr key={o.lamp.id} onClick={() => onSelect(o.lamp.id)} className="clickable">
                    <td>{o.lamp.id}</td>
                    <td>{o.lamp.battery.toFixed(0)}%</td>
                    <td>
                      {Math.round(o.gen)}Wh{o.factor < 0.85 ? " (패널 저하)" : ""}
                    </td>
                    <td className={o.risk ? "bad-text" : ""}>{o.endPct.toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
