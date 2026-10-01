// 손동작 → 지도 뷰어 조작. 3D 장면, 3D 로드뷰, 2D 지도가 같은 명령을 받아 각자 방식으로 적용한다.
//
// 원칙: "집었을 때만 움직인다" (터치스크린처럼). 손을 펴고 있으면 커서만 따라오고 장면은 가만히 있다.
// 그래서 손을 옮기려고 멈춤 동작을 따로 할 필요가 없고, 손을 들기만 해도 장면이 도는 일이 없다.
//
//   🖐 손 펴기               커서만 (아무것도 안 움직임)
//   🤏 한 손 집고 끌기        회전 · 로드뷰에서는 둘러보기. 놓으면 관성으로 부드럽게 멈춘다
//   🤏🤏 두 손 집고           벌리기/모으기 = 확대/축소(로드뷰: 앞으로/뒤로), 함께 옮기기 = 이동(로드뷰: 옆걸음),
//                            비틀기 = 회전
//   ✌️ 1초 유지              다음 시점 (전체 → 스쿨존 → 교차로 → 카메라 구간 → 로드뷰)
//   👍 1초 유지              처음 시점
//
// 손 모양끼리 헷갈리지 않게 동작 수를 줄였다 (예전의 🫰 스냅은 🤏 집기와 손 모양이 비슷해 오작동이 많아
// 화면 버튼·숫자 키로 옮겼다). 유지 동작은 손이 거의 멈춰 있어야만 센다.
//
// 정밀하게 다루기 위해
// - One Euro 필터: 손이 멈춰 있을 때는 떨림을 강하게 거르고, 빠르게 움직일 때는 지연 없이 따라간다
// - 가속 곡선: 천천히 움직이면 적게, 빠르게 움직이면 많이 움직인다
// - 집는 순간·두 손이 되는 순간의 첫 프레임은 기준만 잡는다 (튀지 않게)
// 좌표는 lib/gesture.ts와 같이 화면에 보이는(거울 반전된) 웹캠 화면 기준 0~1.

import type { Gesture, Hand, Point } from "./gesture";

export type MapAction =
  | { kind: "orbit"; dx: number; dy: number } // 손 이동량 (웹캠 화면 비율)
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "zoom"; factor: number } // 1보다 작으면 가까이(확대), 크면 멀리(축소)
  | { kind: "twist"; angle: number } // 두 손을 비튼 각도 (라디안, 시계 방향 +)
  | { kind: "reset" }
  | { kind: "next" } // 다음 시점
  | { kind: "macro"; n: 1 | 2 | 3 }; // 화면 버튼·숫자 키: 어린이 / 보행자 / 현재 카메라 위치로 자동 이동

// none = 손이 안 보임, hover = 손은 보이지만 집지 않음
export type MapMode = "none" | "hover" | "rotate" | "zoom2" | "next-hold" | "reset-hold" | "done";
export type Cursor = { p: Point; pinch: boolean };
export type MapStep = {
  actions: MapAction[];
  mode: MapMode;
  cursors: Cursor[];
  hold: number | null; // 유지 동작 진행률 0~1
  toast?: string;
  now: number;
};

const PINCH_ON = 0.3; // 엄지 끝-검지 끝 거리 / 손 크기
const PINCH_OFF = 0.46; // 한 번 집으면 이보다 벌어져야 놓은 것으로 (경계에서 깜빡이지 않게)
const GRAB_FRAMES = 2; // 집기가 이만큼 이어져야 잡은 것으로 (스치듯 닿은 건 무시)
const LOST_GRACE_MS = 250;
const HOLD_MS = 1000;
const HOLD_STILL = 0.035; // 유지 동작 중 손이 이보다 많이 움직이면 처음부터 다시 센다
const ACCEL_REF = 0.45; // 이 속도(화면 폭/초)에서 가속 배율 1
const ACCEL_MIN = 0.55;
const ACCEL_MAX = 1.9;
const DEAD = 0.0012; // 이보다 작은 이동은 떨림으로 보고 버린다
const GLIDE_DECAY = 7; // 놓은 뒤 관성이 줄어드는 빠르기 (1/초)
const GLIDE_MIN = 0.05; // 이 속도 아래면 관성 끝

// ---- One Euro 필터 (Casiez et al., 2012) ----
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(
    private minCutoff = 1.3,
    private beta = 4,
    private dCutoff = 1,
  ) {}
  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v: number, now: number) {
    if (this.x === null) {
      this.x = v;
      this.t = now;
      return v;
    }
    const dt = Math.max(1e-3, (now - this.t) / 1000);
    this.t = now;
    const d = (v - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
}

class PointFilter {
  private fx = new OneEuro();
  private fy = new OneEuro();
  filter(p: Point, now: number): Point {
    return { x: this.fx.filter(p.x, now), y: this.fy.filter(p.y, now) };
  }
  reset() {
    this.fx.reset();
    this.fy.reset();
  }
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const handSize = (lm: Point[]) => dist(lm[0], lm[9]);
const palm = (lm: Point[]): Point => ({ x: (lm[0].x + lm[9].x) / 2, y: (lm[0].y + lm[9].y) / 2 });
const pinchPoint = (lm: Point[]): Point => ({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 });
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const accel = (dx: number, dy: number, dt: number) => Math.min(ACCEL_MAX, Math.max(ACCEL_MIN, Math.hypot(dx, dy) / dt / ACCEL_REF));

type Slot = { pinch: boolean; grabN: number; filter: PointFilter; prev: Point | null };
const newSlot = (): Slot => ({ pinch: false, grabN: 0, filter: new PointFilter(), prev: null });

export class MapGestureController {
  private slots: Slot[] = [newSlot(), newSlot()];
  private count = 0;
  private seenAt = -Infinity;
  private lastAt = -Infinity;
  private two: { d: number; a: number; mid: Point } | null = null;
  private hold: { g: "victory" | "thumb_up"; since: number; at: Point; fired: boolean } | null = null;
  private glide: { vx: number; vy: number } | null = null; // 놓은 뒤 관성 (화면 비율/초)
  private vel = { vx: 0, vy: 0 };

  reset() {
    this.slots = [newSlot(), newSlot()];
    this.count = 0;
    this.two = null;
    this.hold = null;
    this.glide = null;
  }

  update(hands: Hand[], now: number): MapStep {
    // 첫 프레임은 앞 프레임이 없으니 보통 간격(15fps)으로 친다
    const dt = Number.isFinite(this.lastAt) ? Math.min(0.25, Math.max(0.001, (now - this.lastAt) / 1000)) : 1 / 15;
    this.lastAt = now;
    const actions: MapAction[] = [];

    // 관성: 집은 손을 놓은 뒤 잠깐 미끄러지듯 이어서 돈다
    const glide = () => {
      const g = this.glide;
      if (!g) return;
      actions.push({ kind: "orbit", dx: g.vx * dt, dy: g.vy * dt });
      const k = Math.exp(-GLIDE_DECAY * dt);
      g.vx *= k;
      g.vy *= k;
      if (Math.hypot(g.vx, g.vy) < GLIDE_MIN) this.glide = null;
    };

    if (hands.length === 0) {
      glide();
      if (now - this.seenAt > LOST_GRACE_MS) {
        this.slots = [newSlot(), newSlot()];
        this.count = 0;
        this.two = null;
        this.hold = null;
      }
      return { actions, mode: "none", cursors: [], hold: null, now };
    }
    this.seenAt = now;

    // 손을 왼쪽부터 0, 1번 자리에 둔다. 손 개수가 바뀌면 기준을 새로 잡는다
    const sorted = [...hands].slice(0, 2).sort((a, b) => palm(a.lm).x - palm(b.lm).x);
    if (sorted.length !== this.count) {
      for (const s of this.slots) {
        s.prev = null;
        s.filter.reset();
      }
      this.count = sorted.length;
      this.two = null;
    }
    const info = sorted.map((h, i) => {
      const s = this.slots[i];
      const r = dist(h.lm[4], h.lm[8]) / Math.max(1e-6, handSize(h.lm));
      s.pinch = s.pinch ? r < PINCH_OFF : r < PINCH_ON;
      s.grabN = s.pinch ? s.grabN + 1 : 0;
      const grab = s.grabN >= GRAB_FRAMES;
      const raw = s.pinch ? pinchPoint(h.lm) : palm(h.lm);
      return { s, raw, grab, gesture: h.gesture as Gesture };
    });
    const cursors: Cursor[] = info.map(({ raw, grab }) => ({ p: raw, pinch: grab }));
    const out = (mode: MapMode, hold: number | null = null, toast?: string): MapStep => ({ actions, mode, cursors, hold, toast, now });
    const grabbed = info.filter((h) => h.grab);

    // 🤏🤏 두 손 집기: 확대·축소 + 함께 옮겨 이동 + 비틀어 회전
    if (grabbed.length === 2) {
      this.hold = null;
      this.glide = null;
      const a = grabbed[0].s.filter.filter(grabbed[0].raw, now);
      const b = grabbed[1].s.filter.filter(grabbed[1].raw, now);
      const d = dist(a, b);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!this.two) {
        this.two = { d, a: ang, mid };
        return out("zoom2");
      }
      const factor = this.two.d / Math.max(1e-6, d);
      if (Math.abs(1 - factor) > 0.004) actions.push({ kind: "zoom", factor });
      const twist = wrapAngle(ang - this.two.a);
      if (Math.abs(twist) > 0.006) actions.push({ kind: "twist", angle: twist });
      let mx = mid.x - this.two.mid.x;
      let my = mid.y - this.two.mid.y;
      const gain = accel(mx, my, dt);
      mx = Math.abs(mx) < DEAD ? 0 : mx * gain;
      my = Math.abs(my) < DEAD ? 0 : my * gain;
      if (mx || my) actions.push({ kind: "pan", dx: mx, dy: my });
      this.two = { d, a: ang, mid };
      return out("zoom2");
    }
    this.two = null;

    // 🤏 한 손 집고 끌기: 회전 (로드뷰는 둘러보기)
    if (grabbed.length === 1) {
      this.hold = null;
      this.glide = null;
      const g = grabbed[0];
      for (const h of info) if (h !== g) h.s.prev = null; // 다른 손은 기준을 버린다
      const p = g.s.filter.filter(g.raw, now);
      if (!g.s.prev) {
        g.s.prev = p;
        this.vel = { vx: 0, vy: 0 };
        return out("rotate");
      }
      let dx = p.x - g.s.prev.x;
      let dy = p.y - g.s.prev.y;
      g.s.prev = p;
      // 놓을 때 쓸 속도 (최근 움직임에 가중)
      this.vel = { vx: this.vel.vx * 0.5 + (dx / dt) * 0.5, vy: this.vel.vy * 0.5 + (dy / dt) * 0.5 };
      const gain = accel(dx, dy, dt);
      dx = Math.abs(dx) < DEAD ? 0 : dx * gain;
      dy = Math.abs(dy) < DEAD ? 0 : dy * gain;
      if (dx || dy) actions.push({ kind: "orbit", dx, dy });
      return out("rotate");
    }

    // 여기부터는 아무 손도 집지 않음: 방금 놓았으면 관성을 시작한다
    for (const h of info) {
      if (h.s.prev && !h.s.pinch && Math.hypot(this.vel.vx, this.vel.vy) > 0.25) this.glide = { vx: this.vel.vx * 0.6, vy: this.vel.vy * 0.6 };
      h.s.prev = null;
      h.s.filter.reset();
    }
    this.vel = { vx: 0, vy: 0 };
    glide();

    // ✌️ / 👍 1초 유지 (손이 거의 멈춰 있을 때만)
    const holder = info.find((h) => h.gesture === "victory" || h.gesture === "thumb_up");
    if (holder) {
      const g = holder.gesture as "victory" | "thumb_up";
      const at = palm(sorted[info.indexOf(holder)].lm);
      if (!this.hold || this.hold.g !== g || dist(at, this.hold.at) > HOLD_STILL) this.hold = { g, since: now, at, fired: false };
      if (this.hold.fired) return out("done");
      const ratio = Math.min(1, (now - this.hold.since) / HOLD_MS);
      if (ratio < 1) return out(g === "victory" ? "next-hold" : "reset-hold", ratio);
      this.hold.fired = true;
      actions.push(g === "victory" ? { kind: "next" } : { kind: "reset" });
      return out("done", null, g === "victory" ? "✌️ 다음 시점" : "👍 처음 시점");
    }
    this.hold = null;
    return out("hover");
  }
}

const MODE_TEXT: Record<MapMode, string> = {
  none: "손을 보여 주면 지도를 조작할 수 있어요",
  hover: "🖐 손 인식됨 · 🤏 집고 끌면 회전, 두 손으로 집으면 확대·이동",
  rotate: "🤏 회전 중 · 손을 펴면 멈춰요",
  zoom2: "🤏🤏 벌리면 확대, 모으면 축소, 함께 옮기면 이동",
  "next-hold": "✌️ 그대로 1초… 다음 시점",
  "reset-hold": "👍 그대로 1초… 처음 시점",
  done: "✔ 바꿨어요 · 손을 바꾸면 다시 할 수 있어요",
};

// 로드뷰에서는 같은 손동작이 둘러보기·걷기가 된다
const ROAD_TEXT: Partial<Record<MapMode, string>> = {
  hover: "🖐 손 인식됨 · 🤏 집고 끌면 둘러보기, 두 손으로 집으면 걷기",
  rotate: "🤏 둘러보는 중 · 손을 펴면 멈춰요",
  zoom2: "🤏🤏 벌리면 앞으로, 모으면 뒤로, 함께 옮기면 옆걸음",
  "reset-hold": "👍 그대로 1초… 출발점으로",
};

export const modeText = (mode: MapMode, road = false) => (road && ROAD_TEXT[mode]) || MODE_TEXT[mode];
