// 모니터링 기록. 웹캠이 보고 있는 현장을 요구사항(어린이보호구역 · 시설·전기 안전 · 태양광·에너지)별로
// 1초마다 한 장씩 남기고, 정해 둔 시간이 지나면 기록을 끝내 이 기기 브라우저(IndexedDB)에 보관한다.
// 기록하지 않을 때도 최근 60분은 메모리에 들고 있어 실시간 그래프를 그린다.

import type { EventKind, Sign, ZoneEvent } from "@/lib/schoolzone";

export type Snapshot = {
  t: number; // Date.now()
  cam: { on: boolean; person: number; vehicle: number; maxKmh: number; seenPerson: number; seenVehicle: number };
  zone: {
    level: Sign["level"];
    text: string;
    limit: number;
    period: string;
    counts: Record<EventKind, number>;
    warned: number;
    slowed: number;
    rtWarned: number;
    rtYielded: number;
  };
  lamps: { total: number; flagged: number; bad: number; prelit: number; avgBright: number; issues: { id: string; kind: string }[] };
  energy: { savingPct: number; savedWh: number };
  solar: { totalWh: number | null; risky: number; date: string | null };
};

export type Session = {
  id: string;
  name: string;
  start: number;
  end: number;
  plannedMin: number | null; // null = 직접 멈출 때까지
  samples: Snapshot[];
  events: ZoneEvent[];
};

export type SessionMeta = Omit<Session, "samples" | "events"> & { summary: Summary };

const DB = "damo-monitor";
const STORE = "sessions";
const LIVE_MAX = 3600; // 최근 60분 (1초 간격)

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ---------- 요약: 요구사항별 결과 ----------

export type Summary = {
  seconds: number;
  camOnPct: number; // 기록 중 웹캠이 켜져 있던 비율
  school: {
    events: Record<EventKind, number>; // 기록 동안 새로 생긴 건수
    cameraEvents: number; // 그중 웹캠 실측
    peakPerson: number;
    peakVehicle: number;
    maxKmh: number;
    dangerSec: number; // 전광판이 "멈추세요" 단계였던 시간
    slowRate: number | null; // 경고 후 감속률
    rtRate: number | null; // 우회전 일시정지율
  };
  facility: { peakFlagged: number; badSec: number; faults: { id: string; kinds: string[] }[]; total: number };
  energy: { savingPct: number; savedWh: number; solarWh: number | null; risky: number; solarDate: string | null };
};

const ZERO: Record<EventKind, number> = { speeding: 0, conflict: 0, parking: 0, rightturn: 0, crossing: 0 };

export function summarize(samples: Snapshot[], events: ZoneEvent[] = []): Summary {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = first && last ? Math.max(1, Math.round((last.t - first.t) / 1000) + 1) : 0;
  const ev = { ...ZERO };
  if (first && last) for (const k of Object.keys(ZERO) as EventKind[]) ev[k] = Math.max(0, last.zone.counts[k] - first.zone.counts[k]);
  const d = (a: number, b: number) => Math.max(0, b - a);
  const warned = first && last ? d(first.zone.warned, last.zone.warned) : 0;
  const slowed = first && last ? d(first.zone.slowed, last.zone.slowed) : 0;
  const rtW = first && last ? d(first.zone.rtWarned, last.zone.rtWarned) : 0;
  const rtY = first && last ? d(first.zone.rtYielded, last.zone.rtYielded) : 0;
  const faults = new Map<string, Set<string>>();
  for (const s of samples) for (const i of s.lamps.issues) faults.set(i.id, (faults.get(i.id) ?? new Set()).add(i.kind));
  return {
    seconds,
    camOnPct: samples.length ? samples.filter((s) => s.cam.on).length / samples.length : 0,
    school: {
      events: ev,
      cameraEvents: events.filter((e) => e.source === "camera" && e.kind !== "crossing").length,
      peakPerson: Math.max(0, ...samples.map((s) => s.cam.person)),
      peakVehicle: Math.max(0, ...samples.map((s) => s.cam.vehicle)),
      maxKmh: Math.max(0, ...samples.map((s) => s.cam.maxKmh)),
      dangerSec: samples.filter((s) => s.zone.level === "danger").length,
      slowRate: warned ? slowed / warned : null,
      rtRate: rtW ? rtY / rtW : null,
    },
    facility: {
      peakFlagged: Math.max(0, ...samples.map((s) => s.lamps.flagged)),
      badSec: samples.filter((s) => s.lamps.bad > 0).length,
      faults: [...faults].map(([id, k]) => ({ id, kinds: [...k] })),
      total: last?.lamps.total ?? 0,
    },
    energy: {
      savingPct: last?.energy.savingPct ?? 0,
      savedWh: first && last ? d(first.energy.savedWh, last.energy.savedWh) : 0,
      solarWh: last?.solar.totalWh ?? null,
      risky: last?.solar.risky ?? 0,
      solarDate: last?.solar.date ?? null,
    },
  };
}

// ---------- 기록기 ----------

export class MonitorRecorder {
  live: Snapshot[] = []; // 최근 60분
  rec: { start: number; plannedMin: number | null; samples: Snapshot[]; events: ZoneEvent[] } | null = null;
  error = "";
  private listeners = new Set<() => void>();
  private lastTick = 0;

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  start(plannedMin: number | null) {
    this.rec = { start: Date.now(), plannedMin, samples: [], events: [] };
    this.emit();
  }

  elapsed() {
    return this.rec ? Date.now() - this.rec.start : 0;
  }

  // 1초에 한 번 부른다. 정한 시간이 지나면 저장하고 끝낸다
  tick(s: Snapshot) {
    if (s.t - this.lastTick < 900) return;
    this.lastTick = s.t;
    this.live.push(s);
    if (this.live.length > LIVE_MAX) this.live.splice(0, this.live.length - LIVE_MAX);
    if (!this.rec) return;
    this.rec.samples.push(s);
    if (this.rec.plannedMin !== null && this.elapsed() >= this.rec.plannedMin * 60_000) void this.stop();
  }

  event(e: ZoneEvent) {
    if (this.rec) this.rec.events.push(e);
  }

  async stop(): Promise<SessionMeta | null> {
    const r = this.rec;
    this.rec = null;
    // 목록 새로고침은 저장이 끝난 뒤 한 번만 알린다 (저장 전에 알리면 옛 목록 조회가 늦게 끝나 새 기록을 덮는다)
    if (!r || r.samples.length < 2) {
      this.emit();
      return null;
    }
    const start = new Date(r.start);
    const session: Session = {
      id: `${r.start}`,
      name: `${start.toLocaleDateString("ko-KR")} ${start.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기록`,
      start: r.start,
      end: Date.now(),
      plannedMin: r.plannedMin,
      samples: r.samples,
      events: r.events,
    };
    try {
      await tx("readwrite", (st) => st.put(session));
      this.error = "";
    } catch (e) {
      this.error = `기록을 저장하지 못했어요: ${e instanceof Error ? e.message : e}`;
    }
    this.emit();
    return { ...meta(session) };
  }

  async list(): Promise<SessionMeta[]> {
    try {
      const all = (await tx("readonly", (st) => st.getAll())) as Session[];
      return all.map(meta).sort((a, b) => b.start - a.start);
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<Session | null> {
    return ((await tx("readonly", (st) => st.get(id))) as Session | undefined) ?? null;
  }

  async remove(id: string) {
    await tx("readwrite", (st) => st.delete(id));
    this.emit();
  }
}

const meta = (s: Session): SessionMeta => ({ id: s.id, name: s.name, start: s.start, end: s.end, plannedMin: s.plannedMin, summary: summarize(s.samples, s.events) });

// 표 계산 프로그램에서 열 수 있게 1초 단위 기록을 CSV로
export function toCsv(s: Session) {
  const head = ["시각", "웹캠", "보행자", "차량", "최고속도km/h", "전광판", "과속누계", "충돌위험누계", "주정차누계", "우회전위험누계", "이상가로등", "점검필요", "절전율%", "태양광예보Wh", "배터리부족"];
  const rows = s.samples.map((x) =>
    [
      new Date(x.t).toLocaleTimeString("ko-KR"),
      x.cam.on ? "켜짐" : "꺼짐",
      x.cam.person,
      x.cam.vehicle,
      x.cam.maxKmh.toFixed(0),
      x.zone.text,
      x.zone.counts.speeding,
      x.zone.counts.conflict,
      x.zone.counts.parking,
      x.zone.counts.rightturn,
      x.lamps.flagged,
      x.lamps.bad,
      x.energy.savingPct.toFixed(1),
      x.solar.totalWh === null ? "" : Math.round(x.solar.totalWh),
      x.solar.risky,
    ].join(","),
  );
  return "﻿" + [head.join(","), ...rows].join("\n");
}
