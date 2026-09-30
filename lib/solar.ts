// 태양광 발전량 예측 (ml/train_solar.py가 학습한 Gradient Boosting 모델)과 배터리 계산.
// 서버(app/api/solar)와 브라우저 양쪽에서 쓴다.

export type SolarModel = {
  features: string[];
  site: { lat: number; lon: number };
  panelWp: number;
  init: number;
  learningRate: number;
  trees: { left: number[]; right: number[]; feature: number[]; threshold: number[]; value: number[] }[];
};

// 한 시간 예보. time = 한국 시각 "YYYY-MM-DDTHH:MM" (그 시각까지 1시간)
export type HourWeather = { time: string; sky: 1 | 3 | 4; rain: 0 | 1; temp: number; humidity: number };

// 맑은 하늘 수평면 일사량 (W/m², Haurwitz 식). ml/train_solar.py의 clear_sky_ghi와 같은 식.
export function clearSkyGhi(time: string, lat: number, lon: number) {
  const [d, hm] = time.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [H, M] = hm.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day, H, M) - 30 * 60_000); // 1시간 평균의 가운데
  const doy = Math.round((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(t.getUTCFullYear(), 0, 0)) / 864e5);
  const hour = t.getUTCHours() + t.getUTCMinutes() / 60;
  const rad = Math.PI / 180;
  const decl = 23.45 * Math.sin((2 * Math.PI * (284 + doy)) / 365) * rad;
  const b = (2 * Math.PI * (doy - 81)) / 364;
  const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const solarTime = hour + (4 * (lon - 135) + eot) / 60;
  const ha = 15 * (solarTime - 12) * rad;
  const cosZ = Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(ha);
  return cosZ > 0 ? 1098 * cosZ * Math.exp(-0.059 / Math.max(cosZ, 1e-6)) : 0;
}

// 운량(%) → 기상청 하늘상태: 0~5할 맑음(1), 6~8할 구름많음(3), 9~10할 흐림(4)
export function cloudToSky(cloudPct: number): 1 | 3 | 4 {
  const tenths = Math.round(cloudPct / 10);
  return tenths <= 5 ? 1 : tenths <= 8 ? 3 : 4;
}

export function predictHourWh(m: SolarModel, w: HourWeather) {
  const x = [clearSkyGhi(w.time, m.site.lat, m.site.lon), w.sky, w.rain, w.temp, w.humidity, Number(w.time.slice(11, 13))].map(Math.fround);
  let y = m.init;
  for (const t of m.trees) {
    let n = 0;
    while (t.left.at(n) !== -1) n = x[t.feature[n]] <= t.threshold[n] ? t.left[n] : t.right[n];
    y += m.learningRate * t.value[n];
  }
  return Math.max(0, y);
}

// 위경도 → 기상청 동네예보 격자 (람베르트 정각원추 투영, 기상청 격자 상수)
export function latLonToGrid(lat: number, lon: number) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const d = Math.PI / 180;
  const re = RE / GRID;
  const s1 = SLAT1 * d, s2 = SLAT2 * d, olon = OLON * d, olat = OLAT * d;
  let sn = Math.tan(Math.PI * 0.25 + s2 * 0.5) / Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(sn);
  const sf = (Math.pow(Math.tan(Math.PI * 0.25 + s1 * 0.5), sn) * Math.cos(s1)) / sn;
  const ro = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  const ra = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + lat * d * 0.5), sn);
  let theta = lon * d - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// 배터리 계산 가정: 용량 1.5kWh, 밤 12시간 점등. 오늘 밤을 쓰고, 내일 낮에 충전하고, 내일 밤을 쓴 뒤 남는 양.
export const BATTERY_WH = 1500;
export const NIGHT_HOURS = 12;
export const RISK_LEVEL = 0.2; // 내일 밤이 끝났을 때 20% 미만이면 위험
// 밤 평균 밝기 계획값: 대기 20% + 통행 시 100%. 데모 지도는 통행이 실제보다 훨씬 잦아서 실시간 평균을 쓰지 않는다.
// 현장 데이터가 쌓이면 가로등별 실제 야간 평균으로 바꾼다.
export const NIGHT_DUTY = 0.35;

export function batteryOutlook(batteryPct: number, avgWatt: number, genWh: number) {
  const night = avgWatt * NIGHT_HOURS;
  const afterTonight = (batteryPct / 100) * BATTERY_WH - night;
  const afterDay = Math.min(BATTERY_WH, Math.max(0, afterTonight) + genWh);
  const afterTomorrowNight = afterDay - night;
  return {
    nightWh: night,
    endPct: Math.max(0, (afterTomorrowNight / BATTERY_WH) * 100),
    risk: afterTonight < 0 || afterTomorrowNight < RISK_LEVEL * BATTERY_WH,
  };
}
