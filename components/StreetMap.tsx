"use client";

import type { MapTarget } from "@/lib/predictive";
import { usePanZoom, type Locate } from "@/lib/usePanZoom";
import { useRef } from "react";
import { RT, ZONE, inZone, simSpeedKmh, type Sign } from "@/lib/schoolzone";
import { MAP_H, MAP_W, ROAD_H_Y, ROAD_V_X, camZone, walkerXY, type Lamp, type Walker } from "@/lib/sim";

type Props = {
  lamps: Lamp[];
  walkers: Walker[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  targets: MapTarget[];
  alert: (l: Lamp) => "bad" | "warn" | null;
  sign?: Sign; // 스쿨존 전광판 현재 문구
  rtSign?: Sign; // 교차로 우회전 알리미 문구
  limit?: number; // 스쿨존 제한속도
  compact?: boolean; // 작은 미리보기 (글자·범례 생략)
};

const SIGN_COLOR: Record<Sign["level"], string> = { idle: "#1f2a3d", child: "#b7791f", slow: "#c2410c", danger: "#b91c1c" };

export default function StreetMap({ lamps, walkers, selectedId, onSelect, targets, alert, sign, rtSign, limit = 30, compact }: Props) {
  const statusColor = (l: Lamp) => {
    const a = alert(l);
    return a === "bad" ? "var(--bad)" : a === "warn" ? "var(--warn)" : "var(--ok)";
  };
  // 작은 미리보기를 뺀 지도는 손동작·휠·끌기로 확대하고 옮긴다
  // 매크로 대상 찾기: 시뮬레이션의 가로 도로 보행자 = 어린이, 세로 도로 = 어른 보행자. 보행자는 웹캠이 본 사람을 먼저
  const live = useRef({ walkers, targets });
  live.current = { walkers, targets };
  const locate: Locate = (target, from) => {
    if (target === "cam") return () => ({ x: (camZone.x0 + camZone.x1) / 2, y: ROAD_H_Y });
    const near = <T,>(xs: T[], at: (t: T) => { x: number; y: number }) =>
      xs.reduce<T | null>((best, t) => (!best || dist(at(t), from) < dist(at(best), from) ? t : best), null);
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    if (target === "person") {
      const ai = near(live.current.targets.filter((t) => t.kind === "person" && !t.ghost), (t) => ({ x: t.x, y: ROAD_H_Y + 20 }));
      if (ai) return () => {
        const t = live.current.targets.find((x) => x.key === ai.key);
        return t ? { x: t.x, y: ROAD_H_Y + 20 } : null;
      };
    }
    const want = target === "child" ? "h" : "v";
    const w = near(live.current.walkers.filter((x) => x.kind === "person" && x.road === want), walkerXY);
    return w ? () => walkerXY(w) : null; // 같은 객체를 시뮬레이터가 계속 움직인다
  };
  const pz = usePanZoom(MAP_W, MAP_H, !compact, locate);
  const { box } = pz;
  const k = box.w / MAP_W; // 확대해도 버튼 크기는 그대로
  return (
    <svg
      ref={pz.svgRef}
      className={`map${compact ? " compact" : ""}${pz.zoomed ? " zoomed" : ""}`}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      role="img"
      aria-label="가로등 관제 지도"
      {...pz.handlers}
    >
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

      {/* 어린이보호구역: 노란 노면, 횡단보도, 학교, 전광판 */}
      <rect x={ZONE.x0} y={ROAD_H_Y - 22} width={ZONE.x1 - ZONE.x0} height={44} fill="var(--zone-road)" />
      <line x1={ZONE.x0} y1={ROAD_H_Y - 23} x2={ZONE.x1} y2={ROAD_H_Y - 23} stroke="var(--zone)" strokeWidth={3} />
      <line x1={ZONE.x0} y1={ROAD_H_Y + 23} x2={ZONE.x1} y2={ROAD_H_Y + 23} stroke="var(--zone)" strokeWidth={3} />
      {Array.from({ length: 6 }, (_, i) => (
        <rect key={i} x={ZONE.crossX - 14} y={ROAD_H_Y - 20 + i * 7} width={28} height={4} fill="#f5f7fb" opacity={0.85} />
      ))}
      <g transform={`translate(${ZONE.crossX - 34}, ${ROAD_H_Y - 178})`}>
        <rect width={68} height={44} rx={6} fill="#223049" stroke="var(--zone)" strokeWidth={1.5} />
        <path d="M10 22 34 9l24 13M16 20v18h36V20M29 38v-9h10v9" fill="none" stroke="var(--zone)" strokeWidth={2} />
        {!compact && (
          <text x={34} y={58} textAnchor="middle" className="map-label" fill="var(--zone)">
            다모초등학교
          </text>
        )}
      </g>
      {sign && (
        <g transform={`translate(${ZONE.x0 + 4}, ${ROAD_H_Y + 44})`}>
          <g className="sign-scale">
            <line x1={20} y1={0} x2={20} y2={-18} stroke="#94a3b8" strokeWidth={2} />
            <rect width={compact ? 90 : 128} height={compact ? 30 : 40} rx={5} fill={SIGN_COLOR[sign.level]} stroke="var(--zone)" strokeWidth={1.5} />
            <text x={compact ? 45 : 64} y={compact ? 20 : 18} textAnchor="middle" className="map-sign" fill="#fff">
              {sign.text}
            </text>
            {!compact && (
              <text x={64} y={33} textAnchor="middle" className="map-sign-sub" fill="#fde68a">
                {sign.sub}
              </text>
            )}
          </g>
        </g>
      )}

      {/* 교차로 남쪽 횡단보도와 우회전 알리미 */}
      {Array.from({ length: 6 }, (_, i) => (
        <rect key={`rt${i}`} x={RT.x - 20 + i * 7} y={RT.y - 13} width={4} height={26} fill="#f5f7fb" opacity={0.85} />
      ))}
      {rtSign && (
        <g transform={`translate(${RT.x + 30}, ${RT.y + 4})`}>
          <g className="sign-scale">
            <rect width={compact ? 80 : 112} height={compact ? 28 : 38} rx={5} fill={SIGN_COLOR[rtSign.level]} stroke="var(--zone)" strokeWidth={1.5} />
            <text x={compact ? 40 : 56} y={compact ? 19 : 17} textAnchor="middle" className="map-sign" fill="#fff">
              {rtSign.text}
            </text>
            {!compact && (
              <text x={56} y={31} textAnchor="middle" className="map-sign-sub" fill="#fde68a">
                {rtSign.sub}
              </text>
            )}
          </g>
        </g>
      )}

      {/* 카메라 구간 표시. 손동작으로 옮겨진다 */}
      <rect
        className="map-cam"
        x={camZone.x0}
        y={ROAD_H_Y - 58}
        width={camZone.x1 - camZone.x0}
        height={116}
        rx={10}
        fill="none"
        stroke="var(--map-accent)"
        strokeDasharray="5 5"
      />
      <text
        className="map-label map-cam"
        x={camZone.x1 > MAP_W - 190 ? camZone.x1 - 6 : camZone.x0 + 6}
        textAnchor={camZone.x1 > MAP_W - 190 ? "end" : "start"}
        y={ROAD_H_Y - 64}
        fill="var(--map-accent)"
      >
        {compact ? "카메라" : "📷 카메라가 보는 구간"}
      </text>

      {lamps.map((l) => (
        <circle key={`g-${l.id}`} cx={l.x} cy={l.y} r={14 + 34 * l.brightness} fill="url(#glow)" opacity={l.brightness} />
      ))}

      {walkers.map((w, i) => {
        const p = walkerXY(w);
        if (w.kind !== "car") return <circle key={i} cx={p.x} cy={p.y} r={4.5} fill="var(--person)" />;
        const kmh = simSpeedKmh(w);
        const tag = inZone(p.x, p.y) && !compact;
        const over = kmh > limit;
        return (
          <g key={i}>
            <rect x={p.x - 9} y={p.y - 6} width={18} height={12} rx={3} fill={tag && over ? "var(--bad)" : "var(--car)"} />
            {tag && (
              <text x={p.x} y={p.y - 11} textAnchor="middle" className="map-speed" fill={over ? "#fca5a5" : "#cbd5e1"}>
                {kmh.toFixed(0)}km/h
              </text>
            )}
          </g>
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
            stroke={selectedId === l.id ? "#ffffff" : "var(--map-bg)"}
            strokeWidth={selectedId === l.id ? 3 : 2}
          />
          {l.source === "device" && (
            <rect x={l.x - 11} y={l.y - 11} width={22} height={22} rx={4} fill="none" stroke="var(--map-accent)" strokeWidth={2} />
          )}
          {l.litBy === "predict" && <circle cx={l.x} cy={l.y} r={9} fill="none" stroke="var(--target)" strokeWidth={1.5} />}
          {alert(l) !== null && (
            <circle cx={l.x} cy={l.y} r={10} fill="none" stroke={statusColor(l)} strokeWidth={2} className="pulse" />
          )}
        </g>
      ))}

      {pz.zoomed && (
        <g className="map-reset" transform={`translate(${box.x + 10 * k}, ${box.y + box.h - 36 * k}) scale(${k})`} onClick={pz.reset} role="button" aria-label="전체 보기">
          <rect width={86} height={26} rx={13} fill="#1f2a3d" stroke="var(--amber)" strokeWidth={1.5} />
          <text x={43} y={17} textAnchor="middle" fontSize={12} fill="var(--text)">
            전체 보기 ×{pz.scale.toFixed(1)}
          </text>
        </g>
      )}
    </svg>
  );
}
