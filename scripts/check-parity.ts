// 브라우저용 모델 계산(lib/ml.ts)이 Python(scikit-learn)과 같은 답을 내는지 확인한다.
// 실행: npx tsx scripts/check-parity.ts
import { readFileSync } from "node:fs";
import { FEATURE_NAMES } from "../lib/features";
import { rfProba, zScore, type RfModel, type ZModel } from "../lib/ml";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const rf: RfModel = read("public/models/fault-rf.json");
const z: ZModel = read("public/models/fault-zscore.json");
const ref = read("ml/results/fault-parity.json") as { x: number[][]; zscore: number[]; rf: number[][] };

let rfMax = 0;
let zMax = 0;
let argmaxDiff = 0;
ref.x.forEach((x, i) => {
  const p = rfProba(rf, x);
  rfMax = Math.max(rfMax, ...p.map((v, j) => Math.abs(v - ref.rf[i][j])));
  if (p.indexOf(Math.max(...p)) !== ref.rf[i].indexOf(Math.max(...ref.rf[i]))) argmaxDiff++;
  zMax = Math.max(zMax, Math.abs(zScore(z, x, FEATURE_NAMES) - ref.zscore[i]) / Math.max(1, ref.zscore[i]));
});
console.log(`표본 ${ref.x.length}개 · RF 확률 최대 차이 ${rfMax.toExponential(2)} · 판정이 다른 표본 ${argmaxDiff}개 · z 점수 최대 상대 차이 ${zMax.toExponential(2)}`);
if (rfMax > 1e-3 || argmaxDiff > 0 || zMax > 1e-4) process.exit(1);
