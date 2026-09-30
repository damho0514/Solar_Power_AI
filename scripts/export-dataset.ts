// 시뮬레이터로 학습·시험용 센서 데이터를 CSV로 뽑는다.
// 실행: npx tsx scripts/export-dataset.ts
// 결과: ml/data/train.csv, ml/data/test.csv (시드가 달라 서로 겹치지 않는다)

import { mkdirSync, writeFileSync } from "node:fs";
import { FEATURE_NAMES } from "../lib/features";
import {
  createLamps,
  createWalkers,
  injectFault,
  moveWalkers,
  random,
  setSeed,
  stepBrightness,
  stepSensors,
  targetBrightness,
} from "../lib/sim";

const MINUTES = 360; // 한 번 돌릴 때 현장 6시간
const FAULT_CHANCE = 0.02; // 매분 새 고장이 생길 확률 (6시간에 평균 7건)
const MAX_FAULTY = 10;

function run(seed: number) {
  setSeed(seed);
  const lamps = createLamps({ initialFaults: false });
  const walkers = createWalkers();
  const rows: string[] = [];
  let seeing = false;
  let idle = 0.2;

  for (let minute = 0; minute < MINUTES; minute++) {
    if (minute % 60 === 0) idle = [0.2, 0.35, 0.5][Math.floor(random() * 3)];
    if (random() < 0.1) seeing = !seeing;
    if (random() < FAULT_CHANCE && lamps.filter((l) => l.hiddenFault).length < MAX_FAULTY) injectFault(lamps);

    // 화면에서는 250ms마다 밝기를 바꾸고 1초마다 센서를 읽는다. 같은 비율로 돌린다.
    for (let sub = 0; sub < 4; sub++) {
      moveWalkers(walkers);
      for (const l of lamps) stepBrightness(l, targetBrightness(l, walkers, { seeing, points: [], idle }));
    }
    for (const l of lamps) {
      stepSensors(l);
      if (!l.features) continue;
      rows.push(
        [
          seed,
          minute,
          l.id,
          l.hiddenFault ?? "normal",
          l.faultAge,
          l.hiddenFault ? l.faultSeverity.toFixed(3) : "",
          ...l.features.map((v) => v.toFixed(5)),
          l.issues[0]?.kind ?? "normal",
        ].join(","),
      );
    }
  }
  return rows;
}

const header = ["run", "minute", "lamp", "label", "fault_age", "severity", ...FEATURE_NAMES, "rule"].join(",");
mkdirSync("ml/data", { recursive: true });
for (const [name, seeds] of [
  ["train", Array.from({ length: 24 }, (_, i) => 1 + i)],
  ["test", Array.from({ length: 8 }, (_, i) => 1001 + i)],
] as const) {
  const rows = seeds.flatMap(run);
  writeFileSync(`ml/data/${name}.csv`, [header, ...rows].join("\n") + "\n");
  console.log(`${name}: ${rows.length.toLocaleString()}행 (${seeds.length}회 × 44대 × ${MINUTES}분)`);
}
