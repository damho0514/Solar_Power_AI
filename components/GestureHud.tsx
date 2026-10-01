"use client";

// 지도 뷰어 위에 겹쳐 그리는 손동작 안내: 손 위치 커서, 지금 동작, 대상 선택(지도 / 카메라 구간), 도움말.
// 손 인식은 카메라 창(CameraPanel)이 하고, 여기서는 lib/handBus로 결과만 받는다.

import { useEffect, useRef, useState } from "react";
import { handBus, useHandState } from "@/lib/handBus";
import { modeText, type MapStep } from "@/lib/mapGesture";
import { MACROS } from "@/lib/snap";

const IDLE_MS = 1500; // 손이 이 시간 넘게 안 보이면 커서를 숨긴다

export default function GestureHud({ road }: { road?: boolean }) {
  const { target, status, reason, macro } = useHandState();
  const [step, setStep] = useState<MapStep | null>(null);
  const [help, setHelp] = useState(false);
  const pending = useRef<MapStep | null>(null);

  // 손 인식(15fps)마다 다시 그리되, 같은 그리기 프레임에 여러 번 오면 마지막 것만
  useEffect(() => {
    let raf = 0;
    const off = handBus.onStep((st) => {
      pending.current = st;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setStep(pending.current);
        });
    });
    const idle = setInterval(() => setStep((s) => (s && performance.now() - s.now > IDLE_MS ? null : s)), 500);
    return () => {
      off();
      cancelAnimationFrame(raf);
      clearInterval(idle);
    };
  }, []);

  const active = status === "ready" && target === "map";
  const mode = step?.mode ?? "none";
  const text = modeText(mode, road);
  const chip =
    status === "unavailable"
      ? "손 인식 AI를 불러오지 못해 손동작을 쓸 수 없어요"
      : status === "off"
        ? "🖐 노트북 카메라를 켜면 손동작으로 지도를 조작할 수 있어요"
        : active
          ? text
          : "손동작이 카메라 구간을 옮기는 중";

  return (
    <div className="ghud" aria-live="polite">
      {active &&
        step?.cursors.map((c, i) => (
          <span
            key={i}
            className={`ghud-cursor${c.pinch ? " pinch" : ""}`}
            style={{ left: `${c.p.x * 100}%`, top: `${c.p.y * 100}%` }}
            aria-hidden
          >
            {(mode === "reset-hold" || mode === "next-hold") && step.hold !== null && (
              <svg viewBox="0 0 36 36" className="ghud-hold">
                <circle cx="18" cy="18" r="15" pathLength={1} strokeDasharray={`${step.hold} 1`} />
              </svg>
            )}
          </span>
        ))}
      {macro && (
        <div className={`ghud-macro${macro.missing ? " missing" : ""}`} role="status">
          {!macro.missing && <span className="ghud-ghost" aria-hidden>🖐</span>}
          <b>{macro.n}번</b>
          {macro.missing ? ` ${MACROS[macro.n].missing}` : ` ${MACROS[macro.n].going} · 손을 움직이면 멈춰요`}
        </div>
      )}
      <div className="ghud-macros" role="toolbar" aria-label="이동 매크로 (숫자 키 1~3)">
        {([1, 2, 3] as const).map((n) => (
          <button key={n} className={macro?.n === n && !macro.missing ? "on" : ""} onClick={() => handBus.runMacro(n)} title={`숫자 키 ${n}`}>
            <b>{n}</b> {MACROS[n].short}
          </button>
        ))}
      </div>
      <div className="ghud-bar">
        <span className={`ghud-chip${active && mode !== "none" && mode !== "hover" ? " on" : ""}`} title={status === "unavailable" ? reason : undefined}>
          {chip}
        </span>
        {status === "ready" && (
          <>
            <div className="seg-mini inline" role="radiogroup" aria-label="손동작 대상">
              <button role="radio" aria-checked={target === "map"} className={target === "map" ? "on" : ""} onClick={() => handBus.setTarget("map")}>
                지도
              </button>
              <button role="radio" aria-checked={target === "camera"} className={target === "camera" ? "on" : ""} onClick={() => handBus.setTarget("camera")}>
                카메라 구간
              </button>
            </div>
            <button className="ghud-help-btn" onClick={() => setHelp((h) => !h)} aria-expanded={help} aria-label="손동작 도움말">
              ?
            </button>
          </>
        )}
      </div>
      {help && (
        <div className="ghud-help" onClick={() => setHelp(false)}>
          <p className="muted">집었을 때만 움직여요. 손을 펴면 커서만 따라와요.</p>
          <p><b>🤏 한 손 집고 끌기</b> {road ? "둘러보기" : "회전 (2D는 이동)"} · 놓으면 부드럽게 멈춤</p>
          <p><b>🤏🤏 두 손 집기</b> {road ? "벌리면 앞으로, 모으면 뒤로, 함께 옮기면 옆걸음" : "벌리면 확대, 모으면 축소, 함께 옮기면 이동, 비틀면 회전"}</p>
          <p><b>✌️ 1초 유지</b> 다음 시점</p>
          <p><b>👍 1초 유지</b> {road ? "출발점으로" : "처음 시점"}</p>
          <p><b>1 · 2 · 3 키 / 아래 버튼</b> 어린이 / 보행자 / 현재 카메라 위치로 이동</p>
          <p className="muted">천천히 움직이면 더 정밀해요. 엄지와 검지 끝을 확실히 붙이세요.</p>
        </div>
      )}
    </div>
  );
}
