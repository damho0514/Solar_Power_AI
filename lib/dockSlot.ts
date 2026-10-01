// 떠 있는 카메라 창(CameraDock)을 화면의 특정 자리(예: 모니터링 화면의 웹캠 칸)에 붙인다.
// 웹캠 <video>는 하나뿐이라 다시 만들면 카메라가 끊긴다. 그래서 창을 옮기지 않고 그 자리 위에 겹쳐 놓는다.

import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export const dockSlot = {
  set(el: HTMLElement | null) {
    if (el === slot) return;
    slot = el;
    listeners.forEach((f) => f());
  },
  get: () => slot,
  subscribe(f: () => void) {
    listeners.add(f);
    return () => void listeners.delete(f);
  },
};

export const useDockSlot = () => useSyncExternalStore(dockSlot.subscribe, dockSlot.get, () => null);
