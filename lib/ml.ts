// ml/train_fault.py가 학습해 public/models/에 내보낸 모델을 브라우저에서 돌린다.
// - 로버스트 z: 정상 데이터의 중앙값·MAD에서 가장 크게 벗어난 특징의 z 점수 (비지도)
// - Random Forest: 고장 종류 분류 (지도)
// 두 방법 모두 Python 채점과 같은 "N분 연속" 조건을 걸어 경보를 낸다.

import type { FaultKind, Lamp } from "./sim";

type Tree = { left: number[]; right: number[]; feature: number[]; threshold: number[]; value: number[][] };
export type RfModel = { features: string[]; classes: string[]; persist: number; trees: Tree[] };
export type ZModel = { signals: string[]; median: number[]; mad: number[]; threshold: number; persist: number };
export type Models = { rf: RfModel; z: ZModel };

// scikit-learn은 나무에 넣기 전에 입력을 float32로 바꾼다. 경계값에서 같은 답을 내려면 똑같이 맞춘다.
export function rfProba(m: RfModel, x: number[]) {
  const xs = x.map(Math.fround);
  const out = new Array(m.classes.length).fill(0);
  for (const t of m.trees) {
    let n = 0;
    while (t.left.at(n) !== -1) n = xs[t.feature[n]] <= t.threshold[n] ? t.left[n] : t.right[n];
    t.value[n].forEach((p, i) => (out[i] += p / m.trees.length));
  }
  return out;
}

export function zScore(m: ZModel, x: number[], featureNames: readonly string[]) {
  return Math.max(...m.signals.map((s, i) => Math.abs(x[featureNames.indexOf(s)] - m.median[i]) / m.mad[i]));
}

export async function loadModels(): Promise<Models> {
  const [rf, z] = await Promise.all(["/models/fault-rf.json", "/models/fault-zscore.json"].map((u) => fetch(u).then((r) => r.json())));
  return { rf, z };
}

// 가로등마다 연속 판정 횟수를 기억한다
const streak = new Map<string, { z: number; kind: string; kindRun: number }>();

export function scoreLamp(models: Models, lamp: Lamp, featureNames: readonly string[]) {
  const s = streak.get(lamp.id) ?? { z: 0, kind: "normal", kindRun: 0 };
  if (!lamp.features) {
    streak.delete(lamp.id);
    lamp.ml = null;
    return;
  }
  const z = zScore(models.z, lamp.features, featureNames);
  s.z = z > models.z.threshold ? s.z + 1 : 0;

  const proba = rfProba(models.rf, lamp.features);
  const best = proba.indexOf(Math.max(...proba));
  const kind = models.rf.classes[best];
  s.kindRun = kind === s.kind ? s.kindRun + 1 : 1;
  s.kind = kind;
  streak.set(lamp.id, s);

  lamp.ml = {
    anomaly: z,
    anomalyFlag: s.z >= models.z.persist,
    kind: s.kindRun >= models.rf.persist ? (kind as FaultKind | "normal") : "normal",
    prob: proba[best],
  };
}

export function resetLamp(id: string) {
  streak.delete(id);
}
