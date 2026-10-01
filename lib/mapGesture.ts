// 손동작 → 지도 뷰어 조작. 3D 장면, 3D 로드뷰, 2D 지도가 같은 명령을 받아 각자 방식으로 적용한다.
//
//   🖐 손 펴고 움직이기      회전 (2D에서는 이동)
//   🤏 엄지·검지 집고 끌기    지도를 잡고 끌기 (로드뷰에서는 걷기)
//   🤏🤏 두 손 집고 벌리기    확대 / 모으기 축소, 두 손을 비틀면 회전
//   👍 / 👎                  한 손으로 확대 / 축소 (로드뷰에서는 앞으로 / 뒤로)
//   ✊ 주먹                  멈춤. 주먹 쥔 채 손을 옮기고 다시 펴면 그 자리부터 이어서 (마우스를 들어 옮기듯)
//   ✌️ 1초 유지              처음 시점으로
//
// 정밀하게 다루기 위해
// - One Euro 필터: 손이 멈춰 있을 때는 떨림을 강하게 거르고, 빠르게 움직일 때는 지연 없이 따라간다
// - 가속 곡선: 천천히 움직이면 적게, 빠르게 움직이면 많이 움직인다 (마우스 포인터 가속과 같은 원리)
// - 손동작이 바뀌는 첫 프레임은 기준만 잡고 움직이지 않는다 (집는 순간 지도가 튀지 않게)
// 좌표는 lib/gesture.ts와 같이 화면에 보이는(거울 반전된) 웹캠 화면 기준 0~1.

import type { Gesture, Hand, Point } from "./gesture";
import { MACROS, SnapDetector } from "./snap";

export type MapAction =
  | { kind: "orbit"; dx: number; dy: number } // 손 이동량 (웹캠 화면 비율)
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "zoom"; factor: number } // 1보다 작으면 가까이(확대), 크면 멀리(축소)
  | { kind: "twist"; angle: number } // 두 손을 비튼 각도 (라디안, 시계 방향 +)
  | { kind: "reset" }
  | { kind: "macro"; n: 1 | 2 | 3 }; // 🫰 스냅 1~3번: 어린이 / 보행자 / 현재 카메라 위치로 자동 이동

// none = 손이 안 보임, seen = 손은 보이지만 조작 손동작이 아님
export type MapMode = "none" | "seen" | "rotate" | "pan" | "zoom2" | "zoom-in" | "zoom-out" | "pause" | "reset-hold" | "reset-done" | "snap";
export type Cursor = { p: Point; pinch: boolean };
// snap: 스냅 준비 자세인지, 지금까지 센 횟수 (확정 전)
export type MapStep = {
  actions: MapAction[];
  mode: MapMode;
  cursors: Cursor[];
  hold: number | null;
  toast?: string;
  now: number;
  snap?: { armed: boolean; pending: number };
};

const PINCH_ON = 0.33; // 엄지 끝-검지 끝 거리 / 손 크기
const PINCH_OFF = 0.45; // 한 번 집으면 이보다 벌어져야 놓은 것으로 (경계에서 깜빡이지 않게)
const STABLE_FRAMES = 2;
const LOST_GRACE_MS = 300;
const HOLD_MS = 1000;
const ZOOM_RATE = 0.9; // 👍👎 유지 시 초당 확대·축소 비율 (e^0.9 ≈ 2.5배)
const ACCEL_REF = 0.5; // 이 속도(화면 폭/초)에서 가속 배율 1
const ACCEL_MIN = 0.5;
const ACCEL_MAX = 1.8;
const DEAD = 0.0012; // 이보다 작은 이동은 떨림으로 보고 버린다

// ---- One Euro 필터 (Casiez et al., 2012) ----
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(
    private minCutoff = 1.4,
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

type Slot = { pinch: boolean; filter: PointFilter; prev: Point | null; cand: { g: Gesture; n: number } | null; stable: Gesture | null };
const newSlot = (): Slot => ({ pinch: false, filter: new PointFilter(), prev: null, cand: null, stable: null });

export class MapGestureController {
  private slots: Slot[] = [newSlot(), newSlot()];
  private count = 0;
  private seenAt = -Infinity;
  private lastAt = -Infinity;
  private mode: MapMode = "none";
  private key = ""; // 지금 하는 동작. 바뀌면 이전 위치를 버려 튀지 않게 한다
  private two: { d: number; a: number } | null = null;
  private hold: { since: number; fired: boolean } | null = null;
  private snap = new SnapDetector();

  reset() {
    this.snap.reset();
    this.slots = [newSlot(), newSlot()];
    this.count = 0;
    this.mode = "none";
    this.key = "";
    this.two = null;
    this.hold = null;
  }

  update(hands: Hand[], now: number): MapStep {
    // 첫 프레임은 앞 프레임이 없으니 보통 간격(15fps)으로 친다
    const dt = Number.isFinite(this.lastAt) ? Math.min(0.25, Math.max(0.001, (now - this.lastAt) / 1000)) : 1 / 15;
    this.lastAt = now;
    // 스냅은 첫 번째(가장 오른쪽이 아닌, 화면 왼쪽부터 첫) 손으로 센다. 손이 잠깐 사라져도 계속 센다
    const snapHand = hands.length ? [...hands].sort((a, b) => palm(a.lm).x - palm(b.lm).x)[0].lm : null;
    const sn = this.snap.update(snapHand, now);
    const snapActs: MapAction[] = sn.fired ? [{ kind: "macro", n: sn.fired as 1 | 2 | 3 }] : [];
    const snapToast = sn.fired ? `🫰 ${sn.fired}번 · ${MACROS[sn.fired as 1 | 2 | 3].going}` : undefined;
    const snapInfo = { armed: sn.armed, pending: sn.pending };
    if (hands.length === 0) {
      if (now - this.seenAt > LOST_GRACE_MS && !sn.pending) this.reset();
      return { actions: snapActs, mode: sn.pending ? "snap" : this.mode, cursors: [], hold: null, now, toast: snapToast, snap: snapInfo };
    }
    this.seenAt = now;

    // 손을 왼쪽부터 0, 1번 자리에 둔다. 손 개수가 바뀌면 필터를 새로 시작한다
    const sorted = [...hands].slice(0, 2).sort((a, b) => palm(a.lm).x - palm(b.lm).x);
    if (sorted.length !== this.count) {
      this.slots = [newSlot(), newSlot()];
      this.count = sorted.length;
      this.key = "";
    }
    const info = sorted.map((h, i) => {
      const s = this.slots[i];
      const r = dist(h.lm[4], h.lm[8]) / Math.max(1e-6, handSize(h.lm));
      s.pinch = s.pinch ? r < PINCH_OFF : r < PINCH_ON;
      s.cand = s.cand?.g === h.gesture ? { g: h.gesture, n: s.cand.n + 1 } : { g: h.gesture, n: 1 };
      if (s.cand.n >= STABLE_FRAMES || s.stable === null) s.stable = s.cand.g;
      const raw = s.pinch ? pinchPoint(h.lm) : palm(h.lm);
      return { s, raw, gesture: s.stable };
    });
    const cursors: Cursor[] = info.map(({ s, raw }) => ({ p: raw, pinch: s.pinch }));
    const out = (mode: MapMode, actions: MapAction[] = [], hold: number | null = null, toast?: string): MapStep => {
      this.mode = mode;
      return { actions: [...snapActs, ...actions], mode, cursors, hold, toast: snapToast ?? toast, now, snap: snapInfo };
    };

    // 🫰 스냅 준비 중이거나 연달아 치는 중이면 지도를 움직이지 않는다 (스냅 치다 지도가 흔들리지 않게)
    if (sn.armed || sn.pending || SnapDetector.isArmPose(sorted[0].lm)) {
      this.key = "snap";
      this.two = null;
      info.forEach((h) => {
        h.s.prev = null;
        h.s.filter.reset();
      });
      return out("snap");
    }

    // 두 손 모두 집기: 확대·축소 + 비틀어 회전
    if (info.length === 2 && info[0].s.pinch && info[1].s.pinch) {
      this.hold = null;
      const a = info[0].s.filter.filter(info[0].raw, now);
      const b = info[1].s.filter.filter(info[1].raw, now);
      const d = dist(a, b);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (this.key !== "zoom2" || !this.two) {
        this.key = "zoom2";
        this.two = { d, a: ang };
        return out("zoom2");
      }
      const actions: MapAction[] = [];
      const factor = this.two.d / Math.max(1e-6, d);
      if (Math.abs(1 - factor) > 0.003) actions.push({ kind: "zoom", factor });
      const twist = wrapAngle(ang - this.two.a);
      if (Math.abs(twist) > 0.004) actions.push({ kind: "twist", angle: twist });
      this.two = { d, a: ang };
      return out("zoom2", actions);
    }
    this.two = null;

    // 한 손 동작: 집은 손이 있으면 그 손, 없으면 첫 번째 손
    const main = info.find((h) => h.s.pinch) ?? info[0];
    const g: Gesture | "pinch" = main.s.pinch ? "pinch" : (main.gesture ?? "other");

    if (g === "victory") {
      this.key = "victory";
      this.hold ??= { since: now, fired: false };
      if (this.hold.fired) return out("reset-done");
      const ratio = Math.min(1, (now - this.hold.since) / HOLD_MS);
      if (ratio < 1) return out("reset-hold", [], ratio);
      this.hold.fired = true;
      return out("reset-done", [{ kind: "reset" }], null, "처음 시점");
    }
    this.hold = null;

    if (g === "fist" || g === "other" || g === "point") {
      this.key = g;
      main.s.filter.reset();
      main.s.prev = null;
      return out(g === "fist" ? "pause" : "seen");
    }

    if (g === "thumb_up" || g === "thumb_down") {
      this.key = g;
      const factor = Math.exp((g === "thumb_up" ? -1 : 1) * ZOOM_RATE * dt);
      return out(g === "thumb_up" ? "zoom-in" : "zoom-out", [{ kind: "zoom", factor }]);
    }

    // 🖐 회전 / 🤏 끌기: 필터 거친 위치의 프레임 간 이동량에 가속 곡선을 곱한다
    const kind = g === "pinch" ? "pan" : "orbit";
    const p = main.s.filter.filter(main.raw, now);
    const k = `${kind}:${info.indexOf(main)}`;
    if (this.key !== k || !main.s.prev) {
      this.key = k;
      main.s.prev = p;
      return out(kind === "pan" ? "pan" : "rotate");
    }
    let dx = p.x - main.s.prev.x;
    let dy = p.y - main.s.prev.y;
    main.s.prev = p;
    const speed = Math.hypot(dx, dy) / dt;
    const gain = Math.min(ACCEL_MAX, Math.max(ACCEL_MIN, speed / ACCEL_REF));
    dx = Math.abs(dx) < DEAD ? 0 : dx * gain;
    dy = Math.abs(dy) < DEAD ? 0 : dy * gain;
    const actions: MapAction[] = dx || dy ? [{ kind, dx, dy }] : [];
    return out(kind === "pan" ? "pan" : "rotate", actions);
  }
}

const MODE_TEXT: Record<MapMode, string> = {
  none: "손을 보여 주면 지도를 조작할 수 있어요",
  seen: "✋ 손 인식됨 · 🖐 펴서 움직이기, 🤏 집기, 👍👎로 조작해요",
  rotate: "🖐 회전",
  pan: "🤏 끌어서 이동",
  zoom2: "🤏🤏 확대·축소",
  "zoom-in": "👍 확대",
  "zoom-out": "👎 축소",
  pause: "✊ 멈춤",
  "reset-hold": "✌️ 처음 시점으로…",
  "reset-done": "✌️ 처음 시점으로 왔어요",
  snap: "🫰 스냅 준비 · 1번 어린이, 2번 보행자, 3번 카메라 위치",
};

// 로드뷰에서는 같은 손동작이 걷기·둘러보기가 된다
const ROAD_TEXT: Partial<Record<MapMode, string>> = {
  rotate: "🖐 둘러보기",
  pan: "🤏 걷기",
  zoom2: "🤏🤏 앞으로·뒤로",
  "zoom-in": "👍 앞으로",
  "zoom-out": "👎 뒤로",
  "reset-done": "✌️ 처음 자리로 왔어요",
};

export const modeText = (mode: MapMode, road = false, snapPending = 0) =>
  mode === "snap" && snapPending > 0 ? `🫰 ${snapPending}번… (${MACROS[snapPending as 1 | 2 | 3].label})` : (road && ROAD_TEXT[mode]) || MODE_TEXT[mode];
