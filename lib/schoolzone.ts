// 어린이보호구역(스쿨존) 안전 판단. 브라우저에서 돈다.
// 카메라가 추적한 사람·차와 지도 위 가상 차량을 보고 네 가지를 찾아낸다.
//   1. 과속: 차량 속도가 지금 시간대 제한속도를 넘음
//   2. 충돌 위험: 보행자가 있는데 차량이 1.5초 안에 보행자 쪽으로 다가옴
//   3. 불법 주정차: 차량이 구역 안에 오래 서 있음 (차 뒤에 가려진 아이가 튀어나오는 사고의 주원인)
//   4. 보행자 횡단: 경고는 아니지만 전광판에 "어린이 횡단 중"을 띄우고 통계에 쌓는다
// 카메라 속도는 "화면 가로 폭이 실제 몇 m인가" 설정으로 환산하는 추정값이다.

import type { CameraFrame } from "@/components/CameraPanel";
import { ROAD_H_Y, random, walkerXY, type Walker } from "@/lib/sim";
import { isMoving, type Track } from "@/lib/tracker";

// 지도 위 스쿨존: 가로 도로의 이 구간. 횡단보도는 crossX, 학교는 도로 위쪽.
export const ZONE = { x0: 140, x1: 440, crossX: 290 };
export const inZone = (x: number, y: number) => x > ZONE.x0 && x < ZONE.x1 && Math.abs(y - ROAD_H_Y) < 40;

// 지도 1px ≈ 0.5m, 250ms마다 한 칸 → px/틱 × 7.2 = km/h
const SIM_KMH = 7.2;

export type EventKind = "speeding" | "conflict" | "parking" | "crossing";
export type ZoneEvent = {
  id: number;
  at: number; // Date.now()
  kind: EventKind;
  source: "camera" | "sim";
  text: string;
  kmh?: number;
};

export const EVENT_LABEL: Record<EventKind, string> = {
  speeding: "과속",
  conflict: "충돌 위험",
  parking: "불법 주정차",
  crossing: "보행자 횡단",
};

export type Sign = { level: "idle" | "child" | "slow" | "danger"; text: string; sub: string };

export type Settings = {
  frameWidthM: number; // 카메라 화면 가로 폭이 비추는 실제 거리
  nightRelax: boolean; // 야간 탄력 속도제한 (심야에 제한속도를 올려 운영하는 곳)
  parkingSec: number; // 이 시간 넘게 서 있으면 불법 주정차
  voice: boolean; // 보행자·운전자 음성 안내 (브라우저 음성 합성)
  privacy: boolean; // 카메라 화면에서 얼굴·번호판 부분을 모자이크
};

export const DEFAULT_SETTINGS: Settings = { frameWidthM: 3, nightRelax: false, parkingSec: 10, voice: false, privacy: true };

// 등하교 시간대. 스쿨존 사상자의 절반 가까이가 14~18시, 서울은 사고의 65%가 8~10시·14~18시에 난다.
export const isSchoolHour = (h: number) => (h >= 7 && h < 10) || (h >= 13 && h < 18);

// 시간대별 운영. 등하교 시간은 가장 엄격하게.
export function policyAt(d: Date, s: Settings) {
  const m = d.getHours() * 60 + d.getMinutes();
  if (m >= 7 * 60 + 30 && m < 10 * 60) return { period: "등교 시간", limit: 30, strict: true };
  if (m >= 13 * 60 && m < 18 * 60) return { period: "하교 시간", limit: 30, strict: true };
  if (s.nightRelax && (m >= 21 * 60 || m < 7 * 60)) return { period: "야간 (탄력 운영)", limit: 50, strict: false };
  return { period: m >= 21 * 60 || m < 7 * 60 ? "야간" : "주간", limit: 30, strict: false };
}

const HOLD_MS = 3000; // 전광판 문구를 최소 이만큼 유지

export class SchoolZoneMonitor {
  settings: Settings = { ...DEFAULT_SETTINGS };
  events: ZoneEvent[] = [];
  counts: Record<EventKind, number> = { speeding: 0, conflict: 0, parking: 0, crossing: 0 };
  hourly: number[] = Array(24).fill(0); // 시간대별 위험(과속·충돌·정차) 건수
  warned = 0; // 과속 경고를 받은 가상 차량
  slowed = 0; // 그중 제한속도 아래로 줄인 차량
  maxKmh = 0; // 지금 카메라에 보이는 가장 빠른 차량 속도

  private nextId = 1;
  private seen = new Set<string>(); // 같은 대상·같은 사건은 한 번만 기록
  private sign: Sign & { until: number } = { level: "idle", text: "", sub: "", until: 0 };
  private simPass = new Map<Walker, { inside: boolean; warned: boolean }>();

  kmh(t: Track) {
    return Math.abs(t.vx) * this.settings.frameWidthM * 3.6;
  }

  private log(key: string, e: Omit<ZoneEvent, "id" | "at">) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250));
    const ev = { ...e, id: this.nextId++, at: Date.now() };
    this.events = [ev, ...this.events].slice(0, 60);
    this.counts[e.kind]++;
    if (e.kind !== "crossing") this.hourly[new Date(ev.at).getHours()]++;
  }

  private show(level: Sign["level"], text: string, sub: string, now: number) {
    const rank = { idle: 0, child: 1, slow: 2, danger: 3 };
    // 더 높은 단계는 바로 덮어쓰고, 낮은 단계는 앞 문구가 끝난 뒤에만 바꾼다
    if (rank[level] >= rank[this.sign.level] || now > this.sign.until) this.sign = { level, text, sub, until: now + HOLD_MS };
  }

  // 카메라 한 프레임. 사람·차 추적 결과로 판단한다.
  onCamera(f: CameraFrame) {
    const now = f.now;
    const { limit } = policyAt(new Date(), this.settings);
    const people = f.active.filter((t) => t.kind === "person");
    const cars = f.active.filter((t) => t.kind === "vehicle");
    this.maxKmh = cars.reduce((m, t) => Math.max(m, isMoving(t) ? this.kmh(t) : 0), 0);

    for (const p of f.born) if (p.kind === "person") this.log(`cross-${p.id}`, { kind: "crossing", source: "camera", text: `보행자 #${p.id} 횡단 구역 진입` });
    if (people.length) this.show("child", "어린이 보호", "보행자가 있어요 · 서행", now);

    for (const c of cars) {
      const v = this.kmh(c);
      if (isMoving(c) && v > limit) {
        this.log(`speed-${c.id}`, { kind: "speeding", source: "camera", kmh: v, text: `차량 #${c.id} ${v.toFixed(0)}km/h (제한 ${limit})` });
        this.show("slow", `${v.toFixed(0)}km/h`, `속도를 줄이세요 · 제한 ${limit}`, now);
      }
      if (!isMoving(c) && now - c.firstSeen > this.settings.parkingSec * 1000)
        this.log(`park-${c.id}`, { kind: "parking", source: "camera", text: `차량 #${c.id} ${this.settings.parkingSec}초 넘게 정차 · 아이가 가려질 수 있어요` });
      if (!isMoving(c) && now - c.firstSeen > this.settings.parkingSec * 1000) this.show("slow", "주정차 금지", "어린이 시야를 가려요", now);
      // 1.5초 뒤 차량 위치가 보행자를 지나치거나 닿으면 충돌 위험
      for (const p of people) {
        const dx = p.cx - c.cx;
        const reach = c.vx * 1.5;
        if (isMoving(c) && Math.sign(dx) === Math.sign(c.vx) && Math.abs(reach) >= Math.abs(dx) - p.box.w / 2) {
          this.log(`conf-${c.id}-${p.id}`, { kind: "conflict", source: "camera", text: `차량 #${c.id}가 보행자 #${p.id} 쪽으로 접근` });
          this.show("danger", "멈추세요", "보행자 앞 차량 접근", now);
        }
      }
    }
  }

  // 지도 위 가상 차량 (250ms마다). 과속 차량은 전광판 경고를 보고 70% 확률로 속도를 줄인다.
  onSim(walkers: Walker[], now: number) {
    const { limit } = policyAt(new Date(), this.settings);
    const people = walkers.filter((w) => w.kind === "person" && inZone(walkerXY(w).x, walkerXY(w).y));
    for (const w of walkers) {
      if (w.kind !== "car" || w.road !== "h") continue;
      const p = walkerXY(w);
      const st = this.simPass.get(w) ?? { inside: false, warned: false };
      const inside = inZone(p.x, p.y);
      if (inside && !st.inside) {
        // 구역에 새로 들어온 차량. 속도를 새로 뽑아 현실처럼 섞는다 (대부분 제한 근처, 가끔 과속)
        const kmh = random() < 0.25 ? limit + 8 + random() * 22 : limit - 12 + random() * 12;
        w.speed = Math.sign(w.speed || 1) * (kmh / SIM_KMH);
        st.warned = false;
      }
      const v = Math.abs(w.speed) * SIM_KMH;
      if (inside && v > limit && !st.warned) {
        st.warned = true;
        this.warned++;
        const key = `sim-${now}-${p.x.toFixed(0)}`;
        this.log(key, { kind: "speeding", source: "sim", kmh: v, text: `가상 차량 ${v.toFixed(0)}km/h (제한 ${limit})` });
        this.show("slow", `${v.toFixed(0)}km/h`, `속도를 줄이세요 · 제한 ${limit}`, now);
        if (random() < 0.7) {
          w.speed = Math.sign(w.speed) * ((limit - 5 - random() * 5) / SIM_KMH);
          this.slowed++;
        }
      }
      if (inside && people.some((q) => Math.abs(walkerXY(q).x - p.x) < 25)) {
        this.log(`simconf-${Math.floor(now / 5000)}`, { kind: "conflict", source: "sim", text: "가상 차량이 보행자 옆을 지남" });
        this.show("danger", "멈추세요", "보행자 앞 차량 접근", now);
      }
      if (!inside && st.inside) w.speed = Math.sign(w.speed) * (1.8 + random() * 2.2); // 구역을 벗어나면 평소 속도
      st.inside = inside;
      this.simPass.set(w, st);
    }
  }

  signAt(now: number): Sign {
    if (now > this.sign.until) return { level: "idle", text: "어린이 보호구역", sub: `제한속도 ${policyAt(new Date(), this.settings).limit}km/h`, };
    return this.sign;
  }

  // 위험 = 과속 + 충돌 위험 + 시야 가림 정차
  risks() {
    return this.counts.speeding + this.counts.conflict + this.counts.parking;
  }

  slowRate() {
    return this.warned ? this.slowed / this.warned : null;
  }
}

export const simSpeedKmh = (w: Walker) => Math.abs(w.speed) * SIM_KMH;
