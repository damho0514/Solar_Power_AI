"use client";

// 영상통화 화면처럼 떠 있는 카메라 창.
// - 창 모드: 손가락이나 마우스로 끌어 옮기고, 놓으면 가까운 모서리에 붙는다. 영상을 톡 누르면 전체 화면.
// - 전체 화면: 카메라를 크게 보고, 구석의 작은 지도를 누르면 지도 화면으로 돌아간다.
// - 최소화: 작은 동그라미만 남긴다. 카메라와 AI 분석은 계속 돈다.
// - 자리 붙이기: 모니터링 화면처럼 웹캠 칸(lib/dockSlot)이 있으면 그 칸 위에 정확히 겹쳐 붙는다.
// 카메라(<video>)는 모드가 바뀌어도 다시 만들지 않는다. 위치·모양만 CSS로 바꾼다.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import CameraPanel, { type CameraFrame, type CameraStatus } from "@/components/CameraPanel";
import Icon from "@/components/Icon";
import type { ClipRecorder } from "@/lib/clips";
import { useDockSlot } from "@/lib/dockSlot";
import type { View } from "@/lib/gesture";

type Mode = "pip" | "full" | "min";
type Corner = "tl" | "tr" | "bl" | "br";

type Props = {
  onFrame: (f: CameraFrame) => void;
  onView?: (v: View) => void;
  inset: ReactNode; // 전체 화면일 때 구석에 띄울 작은 지도
  onShowMap: () => void;
  alert?: string | null; // 스쿨존 경고처럼 창 위에 띄울 한 줄
  privacy?: boolean;
  recorder?: ClipRecorder;
  onCamStatus?: (s: CameraStatus) => void; // 모니터링 기록에 "웹캠 켜짐"을 남기려고
};

const MARGIN = 12;
const STORE = "damo.camdock";

function load(): { mode: Mode; corner: Corner } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (v && ["pip", "min"].includes(v.mode) && ["tl", "tr", "bl", "br"].includes(v.corner)) return v;
  } catch {}
  return { mode: "pip", corner: "br" };
}

export default function CameraDock({ onFrame, onView, inset, onShowMap, alert, privacy, recorder, onCamStatus }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("pip");
  const [corner, setCorner] = useState<Corner>("br");
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState<CameraStatus>("off");
  const start = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const slot = useDockSlot();
  const slotted = !!slot && mode !== "full";

  // 자리에 붙은 동안은 매 프레임 그 칸의 위치·크기를 따라간다 (스크롤·창 크기 변경에도)
  useEffect(() => {
    if (!slotted || !slot) return;
    const el = ref.current!;
    let raf = 0;
    const follow = () => {
      const r = slot.getBoundingClientRect();
      Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: "auto", bottom: "auto" });
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      cancelAnimationFrame(raf);
      for (const k of ["left", "top", "width", "height", "right", "bottom"] as const) el.style[k] = "";
    };
  }, [slotted, slot]);

  useLayoutEffect(() => {
    const v = load();
    setMode(v.mode);
    setCorner(v.corner);
  }, []);

  useEffect(() => {
    if (mode === "full") return;
    try {
      localStorage.setItem(STORE, JSON.stringify({ mode, corner }));
    } catch {}
  }, [mode, corner]);

  // 전체 화면에서는 뒤 페이지가 스크롤되지 않게 하고, Esc로 빠져나온다
  useEffect(() => {
    if (mode !== "full") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMode("pip");
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [mode]);

  const camStatusRef = useRef(onCamStatus);
  camStatusRef.current = onCamStatus;
  const onStatus = useCallback((s: CameraStatus) => {
    setStatus(s);
    camStatusRef.current?.(s);
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (mode === "full" || slotted || (e.target as HTMLElement).closest("button, a, input")) return;
    const r = ref.current!.getBoundingClientRect();
    start.current = { px: e.clientX, py: e.clientY, x: r.left, y: r.top, moved: false };
    ref.current!.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    if (!s.moved && Math.hypot(dx, dy) < 6) return;
    s.moved = true;
    setDrag({ x: s.x + dx, y: s.y + dy });
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = start.current;
    start.current = null;
    if (!s) return;
    if (!s.moved) {
      // 톡 누르기: 최소화 상태면 펼치고, 창 모드에서 켜진 카메라면 전체 화면
      if (slotted) return;
      if (mode === "min") setMode("pip");
      else if (status === "running") setMode("full");
      return;
    }
    const r = ref.current!.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    setCorner(`${cy < window.innerHeight / 2 ? "t" : "b"}${cx < window.innerWidth / 2 ? "l" : "r"}` as Corner);
    setDrag(null);
    e.preventDefault();
  }

  const style = drag ? { left: drag.x, top: drag.y, right: "auto", bottom: "auto", transition: "none" } : undefined;

  return (
    <>
      {mode === "full" && <div className="dock-backdrop" />}
      <div
        ref={ref}
        className={slotted ? "dock dock-slot" : `dock dock-${mode} dock-${corner}${drag ? " dragging" : ""}`}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
        role="region"
        aria-label="현장 카메라 창"
      >
        {alert && (mode !== "min" || slotted) && <div className="dock-alert">{alert}</div>}
        <CameraPanel
          onFrame={onFrame}
          onView={onView}
          onStatus={onStatus}
          privacy={privacy}
          compact={mode !== "full" && !slotted}
          recorder={recorder}
          tools={
            <>
              {slotted ? null : mode === "full" ? (
                <button className="icon-btn" onClick={() => setMode("pip")} aria-label="작은 창으로" title="작은 창으로">
                  <Icon name="shrink" size={18} />
                </button>
              ) : (
                <>
                  <button className="icon-btn" onClick={() => setMode("min")} aria-label="최소화" title="최소화">
                    <Icon name="minimize" size={18} />
                  </button>
                  <button className="icon-btn" onClick={() => setMode("full")} aria-label="전체 화면" title="전체 화면">
                    <Icon name="expand" size={18} />
                  </button>
                </>
              )}
            </>
          }
        />
        {mode === "min" && !slotted && (
          <div className="dock-bubble" aria-label="카메라 창 펼치기">
            <Icon name="camera" size={22} />
            {status === "running" && <i className="live-dot" />}
          </div>
        )}
        {mode === "full" && (
          <button
            className="dock-inset"
            onClick={() => {
              setMode("pip");
              onShowMap();
            }}
            aria-label="지도 화면으로"
          >
            {inset}
            <span>지도 크게 보기</span>
          </button>
        )}
      </div>
    </>
  );
}
