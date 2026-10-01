"use client";

// 2D 지도(SVG) 확대·이동: 손동작(lib/handBus), 마우스 휠, 끌기.
// 가로등 클릭과 섞이지 않게 4px 넘게 끌었을 때만 이동으로 본다.

import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from "react";
import { handBus } from "./handBus";
import { MACROS, type MacroTarget } from "./snap";

// 매크로 대상의 지금 위치를 지도 좌표로 알려 주는 함수 (지도 쪽이 시뮬레이션 상태로 계산)
export type Locate = (target: MacroTarget, from: { x: number; y: number }) => (() => { x: number; y: number } | null) | null;

export type Box = { x: number; y: number; w: number; h: number };
const MAX_ZOOM = 6;
const HAND_GAIN = 1.2; // 손을 웹캠 화면 폭만큼 움직이면 보이는 지도 폭의 1.2배만큼 이동

export function usePanZoom(W: number, H: number, enabled: boolean, locate?: Locate) {
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const macro = useRef<(() => { x: number; y: number } | null) | null>(null);
  const full: Box = { x: 0, y: 0, w: W, h: H };
  const [box, setBox] = useState<Box>(full);
  const boxRef = useRef(box);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);

  const apply = useCallback(
    (f: (b: Box) => Box) => {
      const b = f(boxRef.current);
      // 너무 크게·작게 되지 않게 하고, 지도 밖으로 벗어나지 않게 붙잡는다
      const w = Math.min(W, Math.max(W / MAX_ZOOM, b.w));
      const h = (w * H) / W;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const x = Math.min(W - w, Math.max(0, cx - w / 2));
      const y = Math.min(H - h, Math.max(0, cy - h / 2));
      boxRef.current = { x, y, w, h };
      setBox(boxRef.current);
    },
    [W, H],
  );

  // (px, py)는 지도 좌표. 그 점을 기준으로 확대해 손·마우스 아래 지점이 제자리에 있게 한다
  const zoomAt = useCallback(
    (factor: number, px?: number, py?: number) =>
      apply((b) => {
        const ax = px ?? b.x + b.w / 2;
        const ay = py ?? b.y + b.h / 2;
        return { x: ax - (ax - b.x) * factor, y: ay - (ay - b.y) * factor, w: b.w * factor, h: b.h * factor };
      }),
    [apply],
  );

  const reset = useCallback(() => apply(() => ({ x: 0, y: 0, w: W, h: H })), [apply, W, H]);

  const stopMacro = useCallback(() => {
    if (!macro.current) return;
    macro.current = null;
    handBus.setMacro(null);
  }, []);

  // 이동 매크로(버튼·숫자 키): 대상 쪽으로 미끄러지듯 이동하며 2.5배로 확대하고, 움직이는 대상을 따라간다
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = macro.current?.();
      if (macro.current && !p) stopMacro();
      if (!p) return;
      const k = 1 - Math.exp(-dt * 2.4);
      apply((b) => {
        const w = b.w + (W / 2.5 - b.w) * k;
        const cx = b.x + b.w / 2 + (p.x - (b.x + b.w / 2)) * k;
        const cy = b.y + b.h / 2 + (p.y - (b.y + b.h / 2)) * k;
        const h = (w * H) / W;
        return { x: cx - w / 2, y: cy - h / 2, w, h };
      });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (macro.current) handBus.setMacro(null);
    };
  }, [enabled, apply, stopMacro, W, H]);

  useEffect(() => {
    if (!enabled) return;
    return handBus.onStep((st) => {
      for (const a of st.actions) {
        if (a.kind === "macro") {
          const b = boxRef.current;
          const m = MACROS[a.n];
          macro.current = locateRef.current?.(m.target, { x: b.x + b.w / 2, y: b.y + b.h / 2 }) ?? null;
          handBus.setMacro({ n: a.n, label: m.label, missing: !macro.current });
          if (!macro.current) setTimeout(() => handBus.get().macro?.missing && handBus.setMacro(null), 2500);
          continue;
        }
        stopMacro();
        if (a.kind === "reset") reset();
        else if (a.kind === "zoom") zoomAt(a.factor);
        // 2D에는 회전이 없으니 손을 펴고 움직여도 집고 끌 때처럼 이동한다
        else if (a.kind === "pan" || a.kind === "orbit") apply((b) => ({ ...b, x: b.x - a.dx * b.w * HAND_GAIN, y: b.y - a.dy * b.h * HAND_GAIN }));
      }
    });
  }, [enabled, apply, zoomAt, reset, stopMacro]);

  const toMap = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const b = boxRef.current;
    return { x: b.x + ((e.clientX - r.left) / r.width) * b.w, y: b.y + ((e.clientY - r.top) / r.height) * b.h };
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!enabled || !el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toMap(e);
      stopMacro();
      zoomAt(Math.exp(e.deltaY * 0.0015), p.x, p.y);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [enabled, zoomAt, stopMacro]);

  const handlers = enabled
    ? {
        onPointerDown: (e: RPointerEvent<SVGSVGElement>) => {
          drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
        },
        onPointerMove: (e: RPointerEvent<SVGSVGElement>) => {
          const d = drag.current;
          if (!d) return;
          if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
          if (!d.moved) {
            d.moved = true;
            stopMacro();
            svgRef.current?.setPointerCapture(d.id);
          }
          const r = svgRef.current!.getBoundingClientRect();
          const b = boxRef.current;
          const dx = ((e.clientX - d.x) / r.width) * b.w;
          const dy = ((e.clientY - d.y) / r.height) * b.h;
          d.x = e.clientX;
          d.y = e.clientY;
          apply((bb) => ({ ...bb, x: bb.x - dx, y: bb.y - dy }));
        },
        onPointerUp: () => {
          suppressClick.current = !!drag.current?.moved;
          drag.current = null;
        },
        onPointerCancel: () => (drag.current = null),
        // 끌기가 끝난 직후의 클릭은 가로등 선택으로 보지 않는다
        onClickCapture: (e: RMouseEvent) => {
          if (suppressClick.current) {
            e.stopPropagation();
            suppressClick.current = false;
          }
        },
      }
    : {};

  return { box, svgRef, handlers, zoomed: box.w < W - 0.5, reset, scale: W / box.w };
}
