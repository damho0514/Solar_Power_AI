// 손동작으로 카메라 위치를 실시간 조종한다. 클릭 없이 손만 쓴다.
// - 🤏 엄지·검지를 붙인 채 움직이면: 카메라가 손을 실시간으로 따라 이동
// - 🖐 손을 펴면: 그 자리에서 정지 (다시 집으면 그 자리부터 이어서)
// - ✌️ 브이를 1초 유지하면: 원래 자리로
// 손 인식 AI는 두 가지 중 되는 것을 쓴다.
// 1. MediaPipe GestureRecognizer: 손동작까지 학습된 모델. WebGL이 필요하다.
// 2. TF.js MediaPipe Hands (WASM): WebGL이 완전히 막힌 브라우저용. 손동작은 손가락 관절 위치로 판별한다.
// 좌표는 모두 화면에 보이는(거울 반전된) 기준 0~1 값이다.

import { prepareTfWasm, quietly, testFrame } from "@/lib/detectors";

export type Point = { x: number; y: number };
export type Gesture = "fist" | "open" | "victory" | "thumb_up" | "thumb_down" | "point" | "other";
export type Hand = { lm: Point[]; gesture: Gesture };
export type HandFrame = Hand | null;

// 한 프레임에서 찾은 손 (최대 2개). 지도 조작은 두 손을, 카메라 구간 조종은 첫 번째 손만 쓴다.
export type HandEngine = {
  label: string;
  detect: (video: HTMLVideoElement, now: number) => Promise<Hand[]>;
  close: () => void;
};

const MAX_HANDS = 2;
const GESTURES: Record<string, Gesture> = {
  Closed_Fist: "fist",
  Open_Palm: "open",
  Victory: "victory",
  Thumb_Up: "thumb_up",
  Thumb_Down: "thumb_down",
  Pointing_Up: "point",
};

async function mediapipeEngine(delegate: "GPU" | "CPU"): Promise<HandEngine> {
  const { FilesetResolver, GestureRecognizer } = await import("@mediapipe/tasks-vision");
  // 첫 인식 때 MediaPipe가 안내 문구를 console.error로 남기므로 시험 프레임까지 quietly 안에서 돌린다
  const rec = await quietly(async () => {
    const vision = await FilesetResolver.forVisionTasks("/mediapipe");
    const r = await GestureRecognizer.createFromOptions(vision, {
      baseOptions: { modelAssetPath: "/models/gesture_recognizer.task", delegate },
      runningMode: "VIDEO",
      numHands: MAX_HANDS,
      cannedGesturesClassifierOptions: { scoreThreshold: 0.5 },
    });
    try {
      r.recognizeForVideo(testFrame(), 1);
    } catch (e) {
      r.close();
      throw e;
    }
    return r;
  });
  return {
    label: `MediaPipe ${delegate}`,
    detect: async (video, now) => {
      const res = rec.recognizeForVideo(video, now);
      return res.landmarks.map((lm, i) => {
        const name = res.gestures[i]?.[0]?.categoryName ?? "";
        const pts = lm.map((p) => ({ x: 1 - p.x, y: p.y }));
        // 학습된 손동작이 아니면(손등이 보이거나 비스듬할 때 많다) 손가락 관절 위치로 한 번 더 판별한다
        return { lm: pts, gesture: GESTURES[name] ?? classifyGesture(pts) };
      });
    },
    close: () => rec.close(),
  };
}

async function tfjsEngine(): Promise<HandEngine> {
  await prepareTfWasm();
  const hpd = await import("@tensorflow-models/hand-pose-detection");
  const detector = await hpd.createDetector(hpd.SupportedModels.MediaPipeHands, {
    runtime: "tfjs",
    modelType: "lite",
    maxHands: MAX_HANDS,
    detectorModelUrl: "/models/handpose/detector/model.json",
    landmarkModelUrl: "/models/handpose/landmark/model.json",
  });
  await detector.estimateHands(testFrame());
  // 이 라이브러리는 <video>의 width/height 속성(보통 0)으로 좌표를 계산하므로, 크기가 확실한 캔버스에 옮겨 넘긴다
  const frame = document.createElement("canvas");
  const fctx = frame.getContext("2d", { willReadFrequently: true })!;
  return {
    label: "TF.js WASM",
    detect: async (video) => {
      const W = video.videoWidth;
      const H = video.videoHeight;
      if (frame.width !== W || frame.height !== H) {
        frame.width = W;
        frame.height = H;
      }
      fctx.drawImage(video, 0, 0, W, H);
      return (await detector.estimateHands(frame)).map((hand) => {
        const lm = hand.keypoints.map((k) => ({ x: 1 - k.x / W, y: k.y / H }));
        return { lm, gesture: classifyGesture(lm) };
      });
    },
    close: () => detector.dispose(),
  };
}

export async function createHandEngine(): Promise<HandEngine> {
  const errors: unknown[] = [];
  for (const make of [() => mediapipeEngine("GPU"), () => mediapipeEngine("CPU"), tfjsEngine]) {
    try {
      return await make();
    } catch (e) {
      errors.push(e);
    }
  }
  throw new AggregateError(errors, "손 인식 엔진을 하나도 만들지 못했습니다");
}

// 손가락 끝이 두 번째 마디보다 손목에서 충분히 멀면 펴진 손가락 (검지, 중지, 약지, 새끼)
const FINGERS: [tip: number, pip: number][] = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];

export function classifyGesture(lm: Point[]): Gesture {
  const wrist = lm[0];
  const d = (p: Point) => Math.hypot(p.x - wrist.x, p.y - wrist.y);
  const up = FINGERS.map(([tip, pip]) => d(lm[tip]) > d(lm[pip]) * 1.1);
  const n = up.filter(Boolean).length;
  if (n === 0) {
    // 네 손가락을 접고 엄지만 위·아래로 세우면 👍·👎 (손 크기의 절반 넘게 엄지 뿌리보다 위/아래)
    const size = Math.hypot(lm[9].x - wrist.x, lm[9].y - wrist.y);
    const rise = lm[2].y - lm[4].y;
    if (rise > size * 0.5) return "thumb_up";
    if (rise < -size * 0.5) return "thumb_down";
    return "fist";
  }
  if (up[0] && !up[1] && !up[2] && !up[3]) return "point";
  if (n === 4) return "open";
  if (up[0] && up[1] && !up[2] && !up[3]) return "victory";
  return "other";
}

// 손바닥 중심: 손목과 가운데 손가락 뿌리의 중간
export const palmCenter = (lm: Point[]): Point => ({ x: (lm[0].x + lm[9].x) / 2, y: (lm[0].y + lm[9].y) / 2 });

// ---- 카메라 시점 ----
// x, y: -1(왼쪽/위 끝) ~ 1(오른쪽/아래 끝). 지도 위 카메라 구간의 위치이자, PTZ 카메라면 팬·틸트 각도가 된다.

export type View = { x: number; y: number; zoom: number };
export const MAX_ZOOM = 3;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampView = (v: View): View => ({ x: clamp(v.x, -1, 1), y: clamp(v.y, -1, 1), zoom: clamp(v.zoom, 1, MAX_ZOOM) });

export type ControlOptions = {
  home: View; // ✌️ 유지로 돌아갈 자리
  lockY: boolean; // 위아래 이동을 쓰지 않을 때 (가로 도로만 비추는 카메라)
};

// ---- 손동작 → 시점 ----

const FOLLOW_GAIN = 3; // 손을 화면 폭의 1/3만큼 움직이면 카메라가 도로 절반만큼 간다
const SMOOTH = 0.5; // 손 떨림을 줄이는 지수 평활 계수
const STABLE_FRAMES = 2; // 손동작 판정이 이 프레임 수만큼 이어져야 바뀐 것으로 본다
const LOST_GRACE_MS = 300; // 손을 한두 프레임 놓쳐도 이 시간까지는 상태를 유지한다
const HOLD_MS = 1000; // ✌️ 유지 시간

export type Mode = "none" | "follow" | "stop" | "reset-hold";
export type Step = { view: View; mode: Mode; palm: Point | null; hold: number | null; toast?: string };

export class GestureController {
  private palm: Point | null = null;
  private seenAt = -Infinity;
  private stable: Gesture | null = null;
  private cand: { g: Gesture; n: number } | null = null;
  private follow: { anchor: Point; from: View } | null = null;
  private hold: { since: number; fired: boolean } | null = null;
  private pinch = false;
  private mode: Mode = "none";

  constructor(private opts: ControlOptions) {}

  // 집었을 때만 따라 움직인다 (지도 손동작 lib/mapGesture.ts와 같은 원칙).
  // 🤏 엄지·검지를 붙인 채 옮기면 카메라 구간이 따라오고, 손을 펴면 그 자리에 멈춘다. ✌️ 1초 유지 = 원래 자리.
  update(f: HandFrame, now: number, view: View): Step {
    if (!f) {
      if (now - this.seenAt > LOST_GRACE_MS) this.forget();
      return { view, mode: this.mode, palm: this.palm, hold: null };
    }
    this.seenAt = now;
    const size = Math.max(1e-6, Math.hypot(f.lm[0].x - f.lm[9].x, f.lm[0].y - f.lm[9].y));
    const r = Math.hypot(f.lm[4].x - f.lm[8].x, f.lm[4].y - f.lm[8].y) / size;
    this.pinch = this.pinch ? r < 0.46 : r < 0.3;
    const raw = this.pinch ? { x: (f.lm[4].x + f.lm[8].x) / 2, y: (f.lm[4].y + f.lm[8].y) / 2 } : palmCenter(f.lm);
    this.palm = this.palm
      ? { x: this.palm.x + (raw.x - this.palm.x) * SMOOTH, y: this.palm.y + (raw.y - this.palm.y) * SMOOTH }
      : raw;
    const p = this.palm;

    // 손동작 판정이 한 프레임씩 튀는 것을 걸러 낸다
    this.cand = this.cand?.g === f.gesture ? { g: f.gesture, n: this.cand.n + 1 } : { g: f.gesture, n: 1 };
    if (this.cand.n >= STABLE_FRAMES || this.stable === null) this.stable = this.cand.g;
    const g = this.stable;

    // ✌️ 1초 유지: 원래 자리
    if (!this.pinch && g === "victory") {
      this.follow = null;
      this.hold ??= { since: now, fired: false };
      if (this.hold.fired) return this.step(view, "stop", p, null);
      const ratio = Math.min(1, (now - this.hold.since) / HOLD_MS);
      if (ratio < 1) return this.step(view, "reset-hold", p, ratio);
      this.hold.fired = true; // 계속 유지해도 한 번만
      return { ...this.step(this.opts.home, "stop", p, null), toast: "원래 자리" };
    }
    this.hold = null;

    // 손을 펴고 있으면 멈춤 (커서만). 다시 집으면 그때 손 위치를 새 기준으로 삼아 튀지 않는다
    if (!this.pinch) {
      this.follow = null;
      return this.step(view, "stop", p, null);
    }

    // 🤏 따라가기: 손이 움직인 만큼 카메라를 옮긴다 (마우스처럼 상대 이동)
    if (!this.follow) {
      this.palm = raw;
      this.follow = { anchor: raw, from: view };
      return this.step(view, "follow", raw, null);
    }
    const { anchor, from } = this.follow;
    const dy = this.opts.lockY ? 0 : (p.y - anchor.y) * FOLLOW_GAIN;
    const next = clampView({ ...from, x: from.x + (p.x - anchor.x) * FOLLOW_GAIN, y: from.y + dy });
    return this.step(next, "follow", p, null);
  }

  private step(view: View, mode: Mode, palm: Point, hold: number | null): Step {
    this.mode = mode;
    return { view, mode, palm, hold };
  }

  private forget() {
    this.palm = null;
    this.stable = null;
    this.cand = null;
    this.follow = null;
    this.hold = null;
    this.mode = "none";
  }
}
