// 가상 가로등 44개의 센서 값을 만들어 내는 시뮬레이터와 규칙 기반 이상 탐지.
// 1틱 = 현장 시간 1분으로 가정한다.

import { FEATURE_NAMES, lampFeatures } from "./features";

export type FaultKind = "voltage" | "overheat" | "driver";

export type Issue = {
  kind: FaultKind;
  label: string;
  detail: string;
};

export type Lamp = {
  id: string;
  x: number;
  y: number;
  // 카메라가 달린 구간이면 true. 웹캠 인식 결과로 밝기가 바뀐다.
  camera: boolean;
  brightness: number; // 0~1
  // 지금 밝게 켜진 이유. camera=카메라가 직접 봄, predict=이동 예측으로 선제 점등, walker=가상 통행
  litBy: "camera" | "predict" | "walker" | null;
  voltage: number; // V
  current: number; // A
  temp: number; // °C
  battery: number; // %
  solarWh: number; // 어제 태양광 발전량
  // 시뮬레이터만 아는 "정답" 고장. 탐지 로직은 이 값을 보지 않는다.
  hiddenFault: FaultKind | null;
  faultAge: number;
  faultSeverity: number; // 0.35~1, 약할수록 늦게·작게 드러난다
  // 현장 차이: 설치 위치(양지/음지)에 따른 주변 온도 차, 센서 품질에 따른 잡음 크기
  ambientOffset: number;
  noiseScale: number;
  minute: number;
  features: number[] | null; // lib/features.ts 순서
  // 값의 출처. device = MQTT로 들어온 실제 기기 측정값
  source: "sim" | "device";
  lastReadingAt: number;
  ml: { anomaly: number; anomalyFlag: boolean; kind: FaultKind | "normal"; prob: number } | null;
  // 밝기만으로 계산한 정상 기대 온도. 실제 온도처럼 천천히 따라간다.
  refTemp: number;
  history: { voltage: number[]; current: number[]; temp: number[]; expCurrent: number[]; expTemp: number[] };
  issues: Issue[];
  health: number; // 0~100
};

export type Walker = { road: "h" | "v"; pos: number; speed: number; kind: "person" | "car" };

export const RATED_WATT = 100;
export const DIM_LEVEL = 0.2;
const NOMINAL_V = 220;
const AMBIENT = 16;
const WINDOW = 30;

// 지도 좌표계: 800 x 460. 가로 도로 y=230, 세로 도로 x=520.
export const ROAD_H_Y = 230;
export const ROAD_V_X = 520;
export const MAP_W = 800;
export const MAP_H = 460;
// 웹캠 화면이 비추는 가로 도로 구간 (지도 x 좌표). 손동작으로 옮길 수 있어 camZone 값은 바뀐다.
export const CAM_HOME = { x0: 200, x1: 380 };
export const camZone = { ...CAM_HOME };
export const camToMapX = (cx: number) => camZone.x0 + cx * (camZone.x1 - camZone.x0);

// 카메라 시점 → 카메라 구간. pos: -1(도로 왼쪽 끝) ~ 1(오른쪽 끝), zoom 할수록 구간이 좁아진다
export function zoneFor(pos: number, zoom: number) {
  const w = (CAM_HOME.x1 - CAM_HOME.x0) / zoom;
  const c = w / 2 + ((pos + 1) / 2) * (MAP_W - w);
  return { x0: c - w / 2, x1: c + w / 2 };
}
// 원래 구간에 해당하는 pos 값, 구간 하나만큼 옮기는 pos 변화량 (확대 전 기준)
export const CAM_HOME_POS = (CAM_HOME.x0 / (MAP_W - (CAM_HOME.x1 - CAM_HOME.x0))) * 2 - 1;
export const CAM_ZONE_STEP = ((CAM_HOME.x1 - CAM_HOME.x0) / (MAP_W - (CAM_HOME.x1 - CAM_HOME.x0))) * 2;

const inCamZone = (l: Pick<Lamp, "x" | "y">) => Math.abs(l.y - ROAD_H_Y) < 50 && l.x > camZone.x0 && l.x < camZone.x1;

// 카메라 구간을 옮기고, 구간 안에 든 가로등을 다시 정한다
export function setCamZone(lamps: Lamp[], z: { x0: number; x1: number }) {
  camZone.x0 = z.x0;
  camZone.x1 = z.x1;
  for (const l of lamps) l.camera = inCamZone(l);
}

// 시드를 주면 같은 데이터가 다시 나온다 (학습 데이터 생성용). 브라우저에서는 매번 다르게.
let seed = (Date.now() ^ 0x9e3779b9) >>> 0;
export function setSeed(s: number) {
  seed = s >>> 0;
}
export function random() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rand = (a: number, b: number) => a + random() * (b - a);
const noise = (s: number) => (random() + random() + random() - 1.5) * s;

const emptyHistory = () => ({ voltage: [], current: [], temp: [], expCurrent: [], expTemp: [] });

export function createLamps(opts: { initialFaults?: boolean } = {}): Lamp[] {
  const lamps: Lamp[] = [];
  let n = 1;
  const push = (x: number, y: number, camera: boolean) => {
    const id = `L-${String(n++).padStart(2, "0")}`;
    lamps.push({
      id,
      x,
      y,
      camera,
      brightness: DIM_LEVEL,
      litBy: null,
      voltage: NOMINAL_V,
      current: 0.1,
      temp: AMBIENT,
      battery: rand(70, 98),
      solarWh: rand(1100, 1400),
      hiddenFault: null,
      faultAge: 0,
      faultSeverity: 1,
      ambientOffset: rand(-2, 3),
      noiseScale: rand(0.7, 1.5),
      minute: Math.floor(rand(0, 720)),
      features: null,
      ml: null,
      source: "sim",
      lastReadingAt: 0,
      refTemp: AMBIENT,
      history: emptyHistory(),
      issues: [],
      health: 100,
    });
  };
  // 가로 도로 양쪽 (카메라 구간 안의 가로등은 웹캠이 직접 제어)
  for (let i = 0; i < 15; i++) {
    const x = 30 + i * 52;
    if (Math.abs(x - ROAD_V_X) < 30) continue;
    push(x, ROAD_H_Y - 34, inCamZone({ x, y: ROAD_H_Y - 34 }));
    push(x, ROAD_H_Y + 34, inCamZone({ x, y: ROAD_H_Y + 34 }));
  }
  // 세로 도로 양쪽
  for (let i = 0; i < 9; i++) {
    const y = 20 + i * 52;
    if (Math.abs(y - ROAD_H_Y) < 40) continue;
    push(ROAD_V_X - 34, y, false);
    push(ROAD_V_X + 34, y, false);
  }

  // 시작할 때 고장 3개를 몰래 심어 둔다.
  if (opts.initialFaults !== false) {
    const kinds: FaultKind[] = ["voltage", "overheat", "driver"];
    kinds.forEach((k) => injectFault(lamps, k));
  }
  return lamps;
}

export function injectFault(lamps: Lamp[], kind?: FaultKind, severity = rand(0.35, 1)): Lamp | null {
  const healthy = lamps.filter((l) => !l.hiddenFault);
  if (healthy.length === 0) return null;
  const target = healthy[Math.floor(random() * healthy.length)];
  const kinds: FaultKind[] = ["voltage", "overheat", "driver"];
  target.hiddenFault = kind ?? kinds[Math.floor(random() * kinds.length)];
  target.faultAge = 0;
  target.faultSeverity = severity;
  // 발전량이 낮은 패널은 태양광 쪽도 같이 나빠 보이게
  if (target.hiddenFault === "driver") target.solarWh *= 0.7;
  return target;
}

export function repairLamp(lamp: Lamp) {
  lamp.hiddenFault = null;
  lamp.faultAge = 0;
  lamp.history = emptyHistory();
  lamp.issues = [];
  lamp.features = null;
  lamp.ml = null;
  lamp.health = 100;
}

export function createWalkers(): Walker[] {
  return [
    { road: "h", pos: rand(0, MAP_W), speed: 3, kind: "car" },
    { road: "h", pos: rand(0, MAP_W), speed: -2.2, kind: "car" },
    { road: "v", pos: rand(0, MAP_H), speed: 0.8, kind: "person" },
    { road: "h", pos: rand(0, MAP_W), speed: -0.7, kind: "person" },
  ];
}

export function walkerXY(w: Walker) {
  return w.road === "h" ? { x: w.pos, y: ROAD_H_Y + (w.kind === "car" ? 0 : 20) } : { x: ROAD_V_X + (w.kind === "car" ? 0 : 20), y: w.pos };
}

export function moveWalkers(walkers: Walker[]) {
  for (const w of walkers) {
    const len = w.road === "h" ? MAP_W : MAP_H;
    w.pos += w.speed;
    if (w.pos > len + 20) w.pos = -20;
    if (w.pos < -20) w.pos = len + 20;
  }
}

export type CameraCtx = {
  seeing: boolean; // 카메라가 지금 대상을 보고 있음
  points: number[]; // 예측·추정 위치 (가로 도로 위 지도 x 좌표)
  idle: number; // 통행량 예측으로 정한 가로 도로 대기 밝기
};

const onMainRoad = (l: Lamp) => Math.abs(l.y - ROAD_H_Y) < 50;

// 밝기 목표값과 그 이유
export function targetBrightness(lamp: Lamp, walkers: Walker[], cam: CameraCtx): { level: number; by: Lamp["litBy"] } {
  const idle = onMainRoad(lamp) ? cam.idle : DIM_LEVEL;
  if (lamp.camera) return cam.seeing ? { level: 1, by: "camera" } : { level: idle, by: null };
  if (onMainRoad(lamp) && cam.points.some((x) => Math.abs(x - lamp.x) < 40)) return { level: 1, by: "predict" };
  const near = walkers.some((w) => {
    const p = walkerXY(w);
    return Math.hypot(p.x - lamp.x, p.y - lamp.y) < 90;
  });
  return near ? { level: 1, by: "walker" } : { level: idle, by: null };
}

// 밝기는 켤 때 빠르게, 끌 때 천천히 따라간다 (250ms마다 호출)
export function stepBrightness(lamp: Lamp, target: { level: number; by: Lamp["litBy"] }) {
  lamp.brightness += (target.level - lamp.brightness) * (target.level > lamp.brightness ? 0.5 : 0.08);
  lamp.litBy = target.by;
}

const push = (arr: number[], v: number) => {
  arr.push(v);
  if (arr.length > WINDOW) arr.shift();
};

export type Reading = { voltage: number; current: number; temp: number; brightness?: number; battery?: number };

// 센서 1틱 갱신 (시뮬레이터): 측정값을 만들어 기록한다
export function stepSensors(lamp: Lamp) {
  ingestReading(lamp, simulateReading(lamp));
}

// 시뮬레이터가 만드는 측정값. 실제 기기에서는 이 자리에 MQTT 메시지가 들어온다.
export function simulateReading(lamp: Lamp): Reading {
  const watt = RATED_WATT * lamp.brightness;

  const ns = lamp.noiseScale;
  let voltage = NOMINAL_V + noise(1.5 * ns);
  let currentFactor = 1;
  let extraHeat = 0;

  lamp.minute++;
  if (lamp.hiddenFault) lamp.faultAge++;
  const age = lamp.faultAge;
  const sev = lamp.faultSeverity;
  switch (lamp.hiddenFault) {
    case "voltage":
      voltage += noise(18 * sev) + (random() < 0.15 * sev ? rand(-40, 30) * sev : 0);
      break;
    case "overheat":
      extraHeat = Math.min(35 * sev, age * 0.4 * sev);
      break;
    case "driver":
      currentFactor = 1 + Math.min(0.6 * sev, age * 0.012 * sev);
      break;
  }

  // 기대 온도는 가로등이 아는 값(밝기)만으로 계산한다. 실제 주변 온도는 위치와 시간대에 따라 다르다.
  const ambient = AMBIENT + lamp.ambientOffset + 1.5 * Math.sin((2 * Math.PI * lamp.minute) / 720);
  return {
    voltage,
    current: (watt / NOMINAL_V + 0.02) * currentFactor + noise(0.008 * ns),
    temp: lamp.temp + (ambient + 28 * lamp.brightness + extraHeat - lamp.temp) * 0.2 + noise(0.3 * ns),
    battery: Math.max(0, Math.min(100, lamp.battery - watt / 3000 + 0.01)),
  };
}

// 측정값 한 건을 기록하고 특징값·규칙 판정을 갱신한다. 시뮬레이터와 실제 기기가 같이 쓴다.
// 기기가 실제 밝기(PWM 듀티)를 보내면 그 값으로 기대 전류·온도를 계산한다.
export function ingestReading(lamp: Lamp, r: Reading) {
  const b = r.brightness ?? lamp.brightness;
  const expCurrent = (RATED_WATT * b) / NOMINAL_V + 0.02;
  lamp.voltage = r.voltage;
  lamp.current = r.current;
  lamp.temp = r.temp;
  if (r.battery !== undefined) lamp.battery = r.battery;
  lamp.refTemp += (AMBIENT + 28 * b - lamp.refTemp) * 0.2;

  push(lamp.history.voltage, lamp.voltage);
  push(lamp.history.current, lamp.current);
  push(lamp.history.temp, lamp.temp);
  push(lamp.history.expCurrent, expCurrent);
  push(lamp.history.expTemp, lamp.refTemp);

  lamp.features = lampFeatures(lamp.history, b);
  detect(lamp);
}

const F = (name: (typeof FEATURE_NAMES)[number], f: number[]) => f[FEATURE_NAMES.indexOf(name)];

// 이상 탐지: 밝기로 계산한 "정상 기대값"과 실제 측정값의 차이를 본다.
// 1단계는 통계 규칙이고, 데이터가 쌓이면 이 함수를 학습 모델로 바꾸면 된다.
function detect(lamp: Lamp) {
  const h = lamp.history;
  const issues: Issue[] = [];
  const f = lamp.features;
  if (!f) {
    lamp.issues = issues;
    lamp.health = 100;
    return;
  }

  const vStd = F("v_std", f);
  if (vStd > 8) {
    issues.push({
      kind: "voltage",
      label: "전압 불안정",
      detail: `최근 ${h.voltage.length}분 전압 표준편차 ${vStd.toFixed(1)}V (정상 2V 이하)`,
    });
  }

  const recentTemp = h.temp.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, h.temp.length);
  const tempGap = F("temp_gap", f);
  if (tempGap > 6) {
    issues.push({
      kind: "overheat",
      label: "과열",
      detail: `현재 ${recentTemp.toFixed(1)}°C, 밝기 대비 기대 온도보다 ${tempGap.toFixed(1)}°C 높음`,
    });
  }

  const ratio = F("cur_ratio", f);
  if (ratio > 1.15) {
    issues.push({
      kind: "driver",
      label: "LED 드라이버 열화 의심",
      detail: `소비 전류가 정상 대비 ${((ratio - 1) * 100).toFixed(0)}% 높음 (효율 저하)`,
    });
  }

  lamp.issues = issues;
  const penalty =
    Math.min(40, Math.max(0, vStd - 2) * 3) + Math.min(40, Math.max(0, tempGap) * 2) + Math.min(40, Math.max(0, ratio - 1) * 150);
  lamp.health = Math.max(0, Math.round(100 - penalty));
}

// 판정 방법별로 "지금 고장이라고 보는 종류"
export type Method = "rule" | "anomaly" | "classifier";
export function verdict(l: Lamp, m: Method): FaultKind | "unknown" | null {
  if (m === "rule") return l.issues[0]?.kind ?? null;
  if (!l.ml) return null;
  if (m === "anomaly") return l.ml.anomalyFlag ? "unknown" : null;
  return l.ml.kind === "normal" ? null : l.ml.kind;
}

// 시뮬레이터가 심은 고장 중 탐지 로직이 맞힌 비율 (데모용 채점)
// 이상 탐지(anomaly)는 종류를 모르므로 "이상 있음"만 맞으면 탐지로 친다.
export function detectionScore(lamps: Lamp[], m: Method = "rule") {
  const faulty = lamps.filter((l) => l.hiddenFault);
  const caught = faulty.filter((l) => {
    const v = verdict(l, m);
    if (m === "rule") return l.issues.some((i) => i.kind === l.hiddenFault);
    return v === "unknown" || v === l.hiddenFault;
  });
  const falseAlarms = lamps.filter((l) => !l.hiddenFault && verdict(l, m) !== null);
  return { faulty: faulty.length, caught: caught.length, falseAlarms: falseAlarms.length };
}
