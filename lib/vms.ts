// 전광판(VMS) 문구 내보내기. 관제 화면이 정한 문구를 두 길로 보낸다.
// 1. 같은 브라우저의 다른 창: BroadcastChannel. 태블릿·두 번째 모니터에 /vms 를 띄워 전광판처럼 쓰는 시연용.
// 2. 실제 전광판 장비: MQTT streetlight/vms/<id>/set (lib/device.ts의 sendSign, 장비는 device/vms_agent.py)

import type { Sign } from "@/lib/schoolzone";

export const VMS_IDS = { main: "vms-zone", rt: "vms-rightturn" } as const;
export type VmsId = keyof typeof VMS_IDS;
export type VmsMessage = { id: VmsId; sign: Sign; ts: number };

const CHANNEL = "damo-vms";

export class VmsBus {
  private ch: BroadcastChannel | null = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  private last: Partial<Record<VmsId, string>> = {};
  private lastAt: Partial<Record<VmsId, number>> = {};

  // 문구가 바뀌었을 때만 보낸다 (+ 10초마다 한 번은 다시 보내 새로 연 화면도 맞춘다). 보냈으면 true.
  publish(id: VmsId, sign: Sign, now: number, onSend?: (id: VmsId, sign: Sign) => void) {
    const key = `${sign.level}|${sign.text}|${sign.sub}`;
    if (this.last[id] === key && now - (this.lastAt[id] ?? 0) < 10_000) return false;
    this.last[id] = key;
    this.lastAt[id] = now;
    this.ch?.postMessage({ id, sign, ts: Date.now() } satisfies VmsMessage);
    onSend?.(id, sign);
    return true;
  }

  close() {
    this.ch?.close();
  }
}

export function listenVms(fn: (m: VmsMessage) => void) {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => fn(e.data as VmsMessage);
  return () => ch.close();
}
