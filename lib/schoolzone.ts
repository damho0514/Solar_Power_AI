// 어린이보호구역(스쿨존) 안전 판단. 브라우저에서 돈다.
// 카메라가 추적한 사람·차와 지도 위 가상 차량을 보고 네 가지를 찾아낸다.
//   1. 과속: 차량 속도가 지금 시간대 제한속도를 넘음
//   2. 충돌 위험: 보행자가 있는데 차량이 1.5초 안에 보행자 쪽으로 다가옴
//   3. 불법 주정차: 차량이 구역 안에 오래 서 있음 (차 뒤에 가려진 아이가 튀어나오는 사고의 주원인)
//   4. 우회전 위험: 교차로에서 도는 차량이 있는데 횡단보도에 보행자가 있음 (스쿨존 사고의 57%가 교차로)
//   5. 보행자 횡단: 경고는 아니지만 전광판에 "어린이 횡단 중"을 띄우고 통계에 쌓는다
// 카메라 속도는 "화면 가로 폭이 실제 몇 m인가" 설정으로 환산하는 추정값이다.
// 사건이 생기면 onEvent 구독자(사건 영상 저장, 관제센터 연동, 전광판 장비)에게 알린다.

import type { CameraFrame } from "@/components/CameraPanel";
import { MAP_H, ROAD_H_Y, ROAD_V_X, random, walkerXY, type Walker } from "@/lib/sim";
import { isMoving, type Track } from "@/lib/tracker";

// 지도 위 스쿨존: 가로 도로의 이 구간. 횡단보도는 crossX, 학교는 도로 위쪽.
export const ZONE = { x0: 140, x1: 440, crossX: 290 };
export const inZone = (x: number, y: number) => x > ZONE.x0 && x < ZONE.x1 && Math.abs(y - ROAD_H_Y) < 40;
// 교차로 남쪽 횡단보도. 동쪽으로 가던 차가 우회전(남쪽)하면 바로 건너는 곳이다.
export const RT = { x: ROAD_V_X, y: ROAD_H_Y + 58 };
const nearRT = (x: number, y: number) => Math.abs(x - RT.x) < 50 && Math.abs(y - RT.y) < 34;

// 지도 1px ≈ 0.5m, 250ms마다 한 칸 → px/틱 × 7.2 = km/h
const SIM_KMH = 7.2;

export type EventKind = "speeding" | "conflict" | "parking" | "rightturn" | "crossing";
export type ZoneEvent = {
  id: number;
  at: number; // Date.now()
  kind: EventKind;
  source: "camera" | "sim";
  text: string;
  kmh?: number;
  limit?: number;
  device?: string; // 엣지 카메라에서 온 사건이면 그 카메라 ID (이 화면의 카메라가 아니라 영상이 없다)
};

export const EVENT_LABEL: Record<EventKind, string> = {
  speeding: "과속",
  conflict: "충돌 위험",
  parking: "불법 주정차",
  rightturn: "우회전 위험",
  crossing: "보행자 횡단",
};

// 관제센터로 보낼 때의 위험도
export const SEVERITY: Record<EventKind, "info" | "warning" | "critical"> = {
  speeding: "warning",
  conflict: "critical",
  parking: "warning",
  rightturn: "critical",
  crossing: "info",
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

// 추적 경로가 꺾였는가: 앞쪽 절반과 뒤쪽 절반의 진행 방향이 35° 넘게 다르면 회전 중
function turning(t: Track) {
  const tr = t.trail;
  if (tr.length < 6) return false;
  const a = tr[0], m = tr[Math.floor(tr.length / 2)], b = tr[tr.length - 1];
  const v1 = { x: m.x - a.x, y: m.y - a.y };
  const v2 = { x: b.x - m.x, y: b.y - m.y };
  const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
  if (n1 < 0.03 || n2 < 0.03) return false;
  const cos = (v1.x * v2.x + v1.y * v2.y) / (n1 * n2);
  return cos < Math.cos((35 * Math.PI) / 180);
}

type SimState = { inside: boolean; warned: boolean; turn: boolean; rtChecked: boolean; hold: number };

export class SchoolZoneMonitor {
  settings: Settings = { ...DEFAULT_SETTINGS };
  events: ZoneEvent[] = [];
  counts: Record<EventKind, number> = { speeding: 0, conflict: 0, parking: 0, rightturn: 0, crossing: 0 };
  hourly: number[] = Array(24).fill(0); // 시간대별 위험(과속·충돌·정차) 건수
  warned = 0; // 과속 경고를 받은 가상 차량
  slowed = 0; // 그중 제한속도 아래로 줄인 차량
  maxKmh = 0; // 지금 카메라에 보이는 가장 빠른 차량 속도
  rtWarned = 0; // 보행자가 있는데 우회전하려던 가상 차량
  rtYielded = 0; // 그중 횡단보도 앞에서 멈춘 차량

  private nextId = 1;
  private seen = new Set<string>(); // 같은 대상·같은 사건은 한 번만 기록
  private sign: Sign & { until: number } = { level: "idle", text: "", sub: "", until: 0 };
  private rtSign: Sign & { until: number } = { level: "idle", text: "", sub: "", until: 0 };
  private simPass = new Map<Walker, SimState>();
  private listeners = new Set<(e: ZoneEvent) => void>();

  onEvent(fn: (e: ZoneEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

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
    for (const fn of this.listeners) fn(ev);
  }

  private showRT(level: Sign["level"], text: string, sub: string, now: number) {
    this.rtSign = { level, text, sub, until: now + HOLD_MS };
  }

  private show(level: Sign["level"], text: string, sub: string, now: number) {
    const rank = { idle: 0, child: 1, slow: 2, danger: 3 };
    // 더 높은 단계는 바로 덮어쓰고, 낮은 단계는 앞 문구가 끝난 뒤에만 바꾼다
    if (rank[level] >= rank[this.sign.level] || now > this.sign.until) this.sign = { level, text, sub, until: now + HOLD_MS };
  }

  // 카메라 한 프레임. 사람·차 추적 결과로 판단한다. device는 엣지 카메라 ID (없으면 이 화면의 카메라).
  onCamera(f: CameraFrame, device?: string) {
    const now = f.now;
    const tag = device ? `${device}-` : "";
    const base = { source: "camera" as const, ...(device && { device }) };
    const { limit } = policyAt(new Date(), this.settings);
    const people = f.active.filter((t) => t.kind === "person");
    const cars = f.active.filter((t) => t.kind === "vehicle");
    this.maxKmh = cars.reduce((m, t) => Math.max(m, isMoving(t) ? this.kmh(t) : 0), 0);

    for (const p of f.born) if (p.kind === "person") this.log(`${tag}cross-${p.id}`, { ...base, kind: "crossing", text: `보행자 #${p.id} 횡단 구역 진입` });
    if (people.length) this.show("child", "어린이 보호", "보행자가 있어요 · 서행", now);

    for (const c of cars) {
      const v = this.kmh(c);
      if (isMoving(c) && v > limit) {
        this.log(`${tag}speed-${c.id}`, { ...base, kind: "speeding", kmh: v, limit, text: `차량 #${c.id} ${v.toFixed(0)}km/h (제한 ${limit})` });
        this.show("slow", `${v.toFixed(0)}km/h`, `속도를 줄이세요 · 제한 ${limit}`, now);
      }
      if (!isMoving(c) && now - c.firstSeen > this.settings.parkingSec * 1000)
        this.log(`${tag}park-${c.id}`, { ...base, kind: "parking", text: `차량 #${c.id} ${this.settings.parkingSec}초 넘게 정차 · 아이가 가려질 수 있어요` });
      if (!isMoving(c) && now - c.firstSeen > this.settings.parkingSec * 1000) this.show("slow", "주정차 금지", "어린이 시야를 가려요", now);
      // 교차로 카메라: 경로가 꺾이는(회전하는) 차량이 있는데 보행자가 있으면 우회전 위험
      if (people.length && isMoving(c) && turning(c)) {
        this.log(`${tag}rt-${c.id}`, { ...base, kind: "rightturn", text: `회전 중인 차량 #${c.id} · 보행자 ${people.length}명 횡단 중` });
        this.showRT("danger", "우회전 멈춤", "보행자 횡단 중", now);
        this.show("danger", "멈추세요", "회전 차량 · 보행자 있음", now);
      }
      // 1.5초 뒤 차량 위치가 보행자를 지나치거나 닿으면 충돌 위험
      for (const p of people) {
        const dx = p.cx - c.cx;
        const reach = c.vx * 1.5;
        if (isMoving(c) && Math.sign(dx) === Math.sign(c.vx) && Math.abs(reach) >= Math.abs(dx) - p.box.w / 2) {
          this.log(`${tag}conf-${c.id}-${p.id}`, { ...base, kind: "conflict", text: `차량 #${c.id}가 보행자 #${p.id} 쪽으로 접근` });
          this.show("danger", "멈추세요", "보행자 앞 차량 접근", now);
        }
      }
    }
  }

  // 지도 위 가상 차량 (250ms마다).
  // - 스쿨존 구간: 과속 차량은 전광판 경고를 보고 70% 확률로 속도를 줄인다.
  // - 교차로: 동쪽으로 가는 차의 절반이 우회전한다. 남쪽 횡단보도에 보행자가 있으면 우회전 알리미가 켜지고,
  //   운전자의 65%가 횡단보도 앞에서 멈췄다가 보행자가 지나면 돈다.
  onSim(walkers: Walker[], now: number) {
    const { limit } = policyAt(new Date(), this.settings);
    const people = walkers.filter((w) => w.kind === "person" && inZone(walkerXY(w).x, walkerXY(w).y));
    const rtPeople = walkers.filter((w) => w.kind === "person" && nearRT(walkerXY(w).x, walkerXY(w).y));
    if (rtPeople.length && now > this.rtSign.until) this.showRT("child", "보행자 횡단 중", "우회전 차량 일시정지", now);
    for (const w of walkers) {
      if (w.kind !== "car") continue;
      const st = this.simPass.get(w) ?? { inside: false, warned: false, turn: false, rtChecked: false, hold: 0 };
      this.simPass.set(w, st);

      // 세로 도로로 돈 차가 지도 아래로 빠지면 다시 가로 도로 왼쪽 끝에서 들어온다
      if (w.road === "v") {
        if (w.pos > MAP_H + 10 || w.pos < 0) {
          w.road = "h";
          w.pos = -20;
          w.speed = 1.8 + random() * 2.2;
          st.turn = false;
          st.rtChecked = false;
        }
        continue;
      }

      const p = walkerXY(w);
      // 교차로 접근: 우회전할 차인지 정하고, 횡단보도에 사람이 있으면 경고
      if (w.speed > 0 && p.x > ROAD_V_X - 80 && p.x < ROAD_V_X - 70 && !st.rtChecked) {
        st.rtChecked = true;
        st.turn = random() < 0.5;
        if (st.turn && rtPeople.length) {
          this.rtWarned++;
          this.log(`simrt-${now}`, { kind: "rightturn", source: "sim", text: "가상 차량 우회전 접근 · 보행자 횡단 중" });
          this.showRT("danger", "우회전 멈춤", "보행자 횡단 중", now);
          if (random() < 0.65) {
            this.rtYielded++;
            st.hold = 12 + Math.floor(random() * 8); // 3~5초 멈춤
          }
        }
      }
      if (st.hold > 0 && w.speed > 0 && p.x >= ROAD_V_X - 30) {
        // 횡단보도 앞 정지: 한 칸 뒤로 물려 제자리를 지킨다
        w.pos -= w.speed;
        st.hold--;
      }
      if (st.turn && w.speed > 0 && p.x >= ROAD_V_X) {
        w.road = "v";
        w.pos = ROAD_H_Y + 6;
        w.speed = Math.abs(w.speed) * 0.7; // 돌 때는 느리게
        continue;
      }
      if (p.x < 0) st.rtChecked = false;

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
        this.log(`sim-${now}-${p.x.toFixed(0)}`, { kind: "speeding", source: "sim", kmh: v, limit, text: `가상 차량 ${v.toFixed(0)}km/h (제한 ${limit})` });
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
    }
  }

  signAt(now: number): Sign {
    if (now > this.sign.until) return { level: "idle", text: "어린이 보호구역", sub: `제한속도 ${policyAt(new Date(), this.settings).limit}km/h` };
    return this.sign;
  }

  // 교차로 우회전 알리미 전광판
  rtSignAt(now: number): Sign {
    if (now > this.rtSign.until) return { level: "idle", text: "우회전 주의", sub: "보행자 먼저" };
    return this.rtSign;
  }

  // 위험 = 과속 + 충돌 위험 + 불법 주정차 + 우회전 위험
  risks() {
    return this.counts.speeding + this.counts.conflict + this.counts.parking + this.counts.rightturn;
  }

  rtRate() {
    return this.rtWarned ? this.rtYielded / this.rtWarned : null;
  }

  slowRate() {
    return this.warned ? this.slowed / this.warned : null;
  }
}

export const simSpeedKmh = (w: Walker) => Math.abs(w.speed) * SIM_KMH;
