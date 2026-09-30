// 태양광 예측 TS 구현이 Python과 같은 답을 내는지, 기상청 격자 변환이 맞는지 확인한다.
// 실행: npx tsx scripts/check-solar.ts
import { readFileSync } from "node:fs";
import { clearSkyGhi, latLonToGrid, predictHourWh, type SolarModel } from "../lib/solar";

const m: SolarModel = JSON.parse(readFileSync("public/models/solar-gbr.json", "utf8"));
const ref = JSON.parse(readFileSync("ml/results/solar-parity.json", "utf8")) as { time: string[]; clear_ghi: number[]; x: number[][]; pred: number[] };
let ghi = 0, pred = 0;
ref.time.forEach((t, i) => {
  ghi = Math.max(ghi, Math.abs(clearSkyGhi(t, m.site.lat, m.site.lon) - ref.clear_ghi[i]));
  const [, sky, rain, temp, humidity] = ref.x[i];
  pred = Math.max(pred, Math.abs(predictHourWh(m, { time: t, sky: sky as 1, rain: rain as 0, temp, humidity }) - Math.max(0, ref.pred[i])));
});
const seoul = latLonToGrid(37.5665, 126.978);
const busan = latLonToGrid(35.1798, 129.075);
const jeju = latLonToGrid(33.4996, 126.5312);
console.log(`표본 ${ref.time.length}개 · 맑은 하늘 일사량 최대 차이 ${ghi.toExponential(2)} W/m² · 발전량 최대 차이 ${pred.toExponential(2)} Wh`);
console.log(`격자: 서울시청 (${seoul.nx}, ${seoul.ny}) 기대 (60, 127) · 부산시청 (${busan.nx}, ${busan.ny}) 기대 (98, 76) · 제주시청 (${jeju.nx}, ${jeju.ny}) 기대 (53, 38)`);
if (ghi > 1e-6 || pred > 1e-3 || seoul.nx !== 60 || seoul.ny !== 127 || busan.nx !== 98 || busan.ny !== 76 || jeju.nx !== 53 || jeju.ny !== 38) process.exit(1);
