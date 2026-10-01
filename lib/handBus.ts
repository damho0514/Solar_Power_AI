// 웹캠 손 인식(CameraPanel) → 지도 뷰어(3D 장면, 로드뷰, 2D 지도)로 손동작 명령을 전달한다.
// 프레임마다 React 상태를 바꾸지 않도록 구독 방식으로 넘기고, 각 뷰어가 자기 그리기 루프에서 적용한다.
// 손동작 대상은 "지도"(기본)와 "카메라 구간"(지도 위 카메라 구간을 좌우로 옮기기) 중 하나다.

import { useSyncExternalStore } from "react";
import type { Hand } from "./gesture";
import { MapGestureController, type MapStep } from "./mapGesture";

export type HandTarget = "map" | "camera";
export type HandStatus = "off" | "ready" | "unavailable";
// road: 지금 보이는 3D 뷰어가 로드뷰인지 (안내 문구를 걷기·둘러보기로 바꾼다)
// reason: 손 인식을 쓸 수 없을 때 그 이유
// macro: 지금 진행 중인 이동 매크로 (뷰어가 대상을 따라가는 중). missing = 대상이 안 보여 못 감
export type MacroState = { n: 1 | 2 | 3; label: string; missing?: boolean } | null;
type State = { target: HandTarget; status: HandStatus; road: boolean; reason: string; macro: MacroState };

const KEY = "damo.handTarget";
let state: State = { target: "map", status: "off", road: false, reason: "", macro: null };
let loaded = false;
const stepListeners = new Set<(s: MapStep) => void>();
const stateListeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const t = localStorage.getItem(KEY);
    if (t === "map" || t === "camera") state = { ...state, target: t };
  } catch {}
}

function set(next: Partial<State>) {
  state = { ...state, ...next };
  stateListeners.forEach((f) => f());
}

export const handBus = {
  get(): State {
    load();
    return state;
  },
  setTarget(target: HandTarget) {
    set({ target });
    try {
      localStorage.setItem(KEY, target);
    } catch {}
  },
  setStatus(status: HandStatus, reason = "") {
    if (status !== state.status || reason !== state.reason) set({ status, reason });
  },
  setRoad(road: boolean) {
    if (road !== state.road) set({ road });
  },
  setMacro(macro: MacroState) {
    if (macro?.n !== state.macro?.n || macro?.missing !== state.macro?.missing) set({ macro });
  },
  // 화면 버튼·숫자 키로 매크로 실행: 손동작 명령과 같은 길로 흘려보낸다
  runMacro(n: 1 | 2 | 3) {
    const step: MapStep = { actions: [{ kind: "macro", n }], mode: "none", cursors: [], hold: null, now: performance.now() };
    stepListeners.forEach((f) => f(step));
  },
  publish(step: MapStep) {
    stepListeners.forEach((f) => f(step));
  },
  onStep(f: (s: MapStep) => void) {
    stepListeners.add(f);
    return () => void stepListeners.delete(f);
  },
  onState(f: () => void) {
    stateListeners.add(f);
    return () => void stateListeners.delete(f);
  },
};

const SERVER: State = { target: "map", status: "off", road: false, reason: "", macro: null };
export function useHandState(): State {
  return useSyncExternalStore(handBus.onState, handBus.get, () => SERVER);
}

// 개발 모드 QA: 웹캠 없이 콘솔에서 손 좌표를 넣어 지도 조작을 시험한다 (window.__damoHand.feed([...]))
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  const ctrl = new MapGestureController();
  Object.assign(window, {
    __damoHand: {
      feed(hands: Hand[], now = performance.now()) {
        handBus.setStatus("ready");
        const step = ctrl.update(hands, now);
        handBus.publish(step);
        return step;
      },
      reset: () => ctrl.reset(),
    },
  });
}
