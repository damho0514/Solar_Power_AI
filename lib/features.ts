// 가로등 한 대의 최근 30분 센서 기록에서 고장 판정에 쓰는 특징값을 뽑는다.
// 규칙 판정, 학습 데이터(CSV), 브라우저 속 ML 모델이 모두 이 함수 하나를 쓴다.
// Python 학습 코드는 CSV의 열 이름으로 이 순서를 받는다: 순서를 바꾸면 모델을 다시 학습해야 한다.

export const FEATURE_NAMES = [
  "v_std", // 전압 표준편차 (V)
  "v_range", // 전압 최대-최소 (V)
  "temp_gap", // 최근 5분 실제 온도 - 기대 온도 (°C)
  "temp_gap_slope", // 온도 차이의 분당 증가량
  "cur_ratio", // 최근 5분 실제 전류 / 기대 전류
  "cur_ratio_slope", // 전류 비율의 분당 증가량
  "brightness", // 현재 밝기 (0~1)
] as const;

export type History = { voltage: number[]; current: number[]; temp: number[]; expCurrent: number[]; expTemp: number[] };

export const MIN_HISTORY = 10;

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};
// 최소제곱 기울기 (단위: 1분당)
const slope = (a: number[]) => {
  const n = a.length;
  const xm = (n - 1) / 2;
  const ym = mean(a);
  let num = 0;
  let den = 0;
  a.forEach((y, i) => {
    num += (i - xm) * (y - ym);
    den += (i - xm) ** 2;
  });
  return den ? num / den : 0;
};

export function lampFeatures(h: History, brightness: number): number[] | null {
  if (h.voltage.length < MIN_HISTORY) return null;
  const gap = h.temp.map((t, i) => t - h.expTemp[i]);
  const ratio = h.current.map((c, i) => c / h.expCurrent[i]);
  return [
    std(h.voltage),
    Math.max(...h.voltage) - Math.min(...h.voltage),
    mean(h.temp.slice(-5)) - mean(h.expTemp.slice(-5)),
    slope(gap),
    mean(h.current.slice(-5)) / mean(h.expCurrent.slice(-5)),
    slope(ratio),
    brightness,
  ];
}
