// 통합관제센터 연동 (브라우저 쪽). 스쿨존 사건을 표준 JSON으로 바꿔 모았다가 2초마다 /api/events로 보낸다.
// 서버가 관제센터 웹훅(CONTROL_CENTER_WEBHOOK_URL)으로 서명을 붙여 전달한다. 형식은 docs/integration.md.

import { EVENT_LABEL, SEVERITY, type ZoneEvent } from "@/lib/schoolzone";

export const SITE = { id: "zone-damo-es", name: "다모초등학교 앞 어린이보호구역" };

export type OutboundEvent = {
  type: "damo.zone.event";
  version: 1;
  id: string;
  occurredAt: string; // ISO 8601
  site: typeof SITE;
  kind: ZoneEvent["kind"];
  label: string;
  severity: "info" | "warning" | "critical";
  source: ZoneEvent["source"];
  message: string;
  speedKmh?: number;
  limitKmh?: number;
  clip: boolean; // 이 기기에 사건 영상이 저장됐는가
};

export function toOutbound(e: ZoneEvent, clip: boolean): OutboundEvent {
  return {
    type: "damo.zone.event",
    version: 1,
    id: `${SITE.id}-${e.at}-${e.id}`,
    occurredAt: new Date(e.at).toISOString(),
    site: SITE,
    kind: e.kind,
    label: EVENT_LABEL[e.kind],
    severity: SEVERITY[e.kind],
    source: e.source,
    message: e.text,
    ...(e.kmh !== undefined && { speedKmh: Math.round(e.kmh) }),
    ...(e.limit !== undefined && { limitKmh: e.limit }),
    clip,
  };
}

export type LinkState = {
  enabled: boolean;
  includeSim: boolean; // 시뮬레이션 사건도 보낼지 (시연용)
  configured: boolean | null; // 서버에 관제센터 주소가 설정돼 있는가 (null = 확인 전)
  sent: number;
  failed: number;
  lastAt: number | null;
  lastError: string;
};

export class ControlCenterLink {
  state: LinkState = { enabled: true, includeSim: false, configured: null, sent: 0, failed: 0, lastAt: null, lastError: "" };
  private queue: OutboundEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.timer) return;
    fetch("/api/events")
      .then((r) => r.json() as Promise<{ configured: boolean }>)
      .then((r) => (this.state.configured = r.configured))
      .catch(() => (this.state.configured = false));
    this.timer = setInterval(() => void this.flush(), 2000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  push(e: ZoneEvent, clip: boolean) {
    if (!this.state.enabled || e.kind === "crossing") return;
    if (e.source === "sim" && !this.state.includeSim) return;
    this.queue.push(toOutbound(e, clip));
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200); // 오래 끊겨도 메모리가 넘치지 않게
  }

  // 관제센터 담당자와 연동을 맞출 때 쓰는 시험 전송
  async test() {
    const now = Date.now();
    this.queue.push(toOutbound({ id: 0, at: now, kind: "conflict", source: "sim", text: "연동 시험 메시지입니다" }, false));
    return this.flush();
  }

  async flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 20); // 서버(app/api/events)가 한 번에 받는 최대 개수
    let retry = true;
    try {
      const res = await fetch("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: batch }) });
      const j = (await res.json().catch(() => ({}))) as { configured?: boolean; forwarded?: number; error?: string };
      if (j.configured !== undefined) this.state.configured = j.configured;
      if (res.status === 400) retry = false; // 형식 오류는 다시 보내도 같다
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      // 관제센터 주소가 없으면 서버가 받기만 하고 버린다. 다시 보내지 않는다.
      this.state.sent += j.forwarded ?? 0;
      this.state.lastAt = Date.now();
      this.state.lastError = "";
    } catch (e) {
      this.state.failed += batch.length;
      this.state.lastError = e instanceof Error ? e.message : String(e);
      // 실패한 묶음은 다시 앞에 넣어 다음에 보낸다 (최대 200건)
      if (retry) this.queue.unshift(...batch);
      if (this.queue.length > 200) this.queue.length = 200;
    }
  }
}
