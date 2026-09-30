"use client";

import type { MapTarget } from "@/lib/predictive";
import { MAP_H, MAP_W, ROAD_H_Y, ROAD_V_X, camZone, walkerXY, type Lamp, type Walker } from "@/lib/sim";

type Props = {
  lamps: Lamp[];
  walkers: Walker[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  targets: MapTarget[];
  alert: (l: Lamp) => "bad" | "warn" | null;
};

export default function StreetMap({ lamps, walkers, selectedId, onSelect, targets, alert }: Props) {
  const statusColor = (l: Lamp) => {
    const a = alert(l);
    return a === "bad" ? "var(--bad)" : a === "warn" ? "var(--warn)" : "var(--ok)";
  };
  return (
    <svg className="map" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="가로등 관제 지도">
      <defs>
        <radialGradient id="glow">
          <stop offset="0%" stopColor="#ffe8a3" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ffe8a3" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width={MAP_W} height={MAP_H} fill="var(--map-bg)" />
      <rect x={0} y={ROAD_H_Y - 22} width={MAP_W} height={44} fill="var(--road)" />
      <rect x={ROAD_V_X - 22} y={0} width={44} height={MAP_H} fill="var(--road)" />
      <line x1={0} y1={ROAD_H_Y} x2={MAP_W} y2={ROAD_H_Y} stroke="var(--lane)" strokeDasharray="14 12" strokeWidth={2} />
      <line x1={ROAD_V_X} y1={0} x2={ROAD_V_X} y2={MAP_H} stroke="var(--lane)" strokeDasharray="14 12" strokeWidth={2} />

      {/* 카메라 구간 표시. 손동작으로 옮겨진다 */}
      <rect
        className="map-cam"
        x={camZone.x0}
        y={ROAD_H_Y - 58}
        width={camZone.x1 - camZone.x0}
        height={116}
        rx={10}
        fill="none"
        stroke="var(--accent)"
        strokeDasharray="5 5"
      />
      <text
        className="map-label map-cam"
        x={camZone.x1 > MAP_W - 190 ? camZone.x1 - 6 : camZone.x0 + 6}
        textAnchor={camZone.x1 > MAP_W - 190 ? "end" : "start"}
        y={ROAD_H_Y - 64}
        fill="var(--accent)"
      >
        📷 카메라 구간 (웹캠 화면)
      </text>

      {lamps.map((l) => (
        <circle key={`g-${l.id}`} cx={l.x} cy={l.y} r={14 + 34 * l.brightness} fill="url(#glow)" opacity={l.brightness} />
      ))}

      {walkers.map((w, i) => {
        const p = walkerXY(w);
        return w.kind === "car" ? (
          <rect key={i} x={p.x - 9} y={p.y - 6} width={18} height={12} rx={3} fill="var(--car)" />
        ) : (
          <circle key={i} cx={p.x} cy={p.y} r={4.5} fill="var(--person)" />
        );
      })}

      {targets.map((t) => {
        const y = ROAD_H_Y + (t.kind === "person" ? 20 : 0);
        return (
          <g key={t.key} opacity={t.ghost ? 0.6 : 1}>
            {t.aheadX !== null && (
              <line x1={t.x} y1={y} x2={t.aheadX} y2={y} stroke="var(--target)" strokeWidth={2} strokeDasharray="4 5" />
            )}
            <circle cx={t.x} cy={y} r={7} fill={t.ghost ? "none" : "var(--target)"} stroke="var(--target)" strokeWidth={2} strokeDasharray={t.ghost ? "3 3" : undefined} />
          </g>
        );
      })}

      {lamps.map((l) => (
        <g key={l.id} className="lamp" onClick={() => onSelect(l.id)}>
          <circle cx={l.x} cy={l.y} r={12} fill="transparent" />
          <circle
            cx={l.x}
            cy={l.y}
            r={6}
            fill={statusColor(l)}
            stroke={selectedId === l.id ? "var(--text)" : "var(--map-bg)"}
            strokeWidth={selectedId === l.id ? 3 : 2}
          />
          {l.source === "device" && (
            <rect x={l.x - 11} y={l.y - 11} width={22} height={22} rx={4} fill="none" stroke="var(--accent)" strokeWidth={2} />
          )}
          {l.litBy === "predict" && <circle cx={l.x} cy={l.y} r={9} fill="none" stroke="var(--target)" strokeWidth={1.5} />}
          {alert(l) !== null && (
            <circle cx={l.x} cy={l.y} r={10} fill="none" stroke={statusColor(l)} strokeWidth={2} className="pulse" />
          )}
        </g>
      ))}
    </svg>
  );
}
