// 카메라가 센 통행량을 일정 구간(bin)마다 모아 다음 구간 통행량을 예측한다.
// Holt 이중 지수평활: 최근 수준(level)과 증가·감소 추세(trend)를 함께 따라가는 시계열 예측.
// 데모에서는 1구간 = 15초. 실제 현장이라면 1구간 = 15분으로 두고 같은 코드를 쓴다.

export const BIN_MS = 15_000;
const KEEP = 16;
const ALPHA = 0.5;
const BETA = 0.3;

export class TrafficForecaster {
  bins: number[] = [];
  current = 0;
  completed = 0; // 지금까지 끝난 구간 수 (bins는 최근 KEEP개만 보관)
  private binStart: number;

  constructor(now: number) {
    this.binStart = now;
  }

  record(now: number, n = 1) {
    this.roll(now);
    this.current += n;
  }

  roll(now: number) {
    while (now - this.binStart >= BIN_MS) {
      this.bins.push(this.current);
      if (this.bins.length > KEEP) this.bins.shift();
      this.current = 0;
      this.completed++;
      this.binStart += BIN_MS;
    }
  }

  progress(now: number) {
    return Math.min(1, (now - this.binStart) / BIN_MS);
  }

  // 앞으로 horizon개 구간의 예측값. 완료된 구간이 3개 미만이면 예측하지 않는다.
  forecast(horizon: number): number[] | null {
    const y = this.bins;
    if (y.length < 3) return null;
    let level = y[0];
    let trend = y[1] - y[0];
    for (let i = 1; i < y.length; i++) {
      const prev = level;
      level = ALPHA * y[i] + (1 - ALPHA) * (level + trend);
      trend = BETA * (level - prev) + (1 - BETA) * trend;
    }
    return Array.from({ length: horizon }, (_, h) => Math.max(0, level + trend * (h + 1)));
  }
}

// 예측 통행량에 따른 대기 밝기 정책
export function idleLevelFor(expected: number | null) {
  if (expected === null) return { level: 0.2, reason: "데이터 수집 중 · 대기 밝기 기본값 20%" };
  if (expected >= 4) return { level: 0.5, reason: `다음 구간 ${expected.toFixed(1)}건 예상 · 혼잡 대비 대기 밝기 50%` };
  if (expected >= 1.5) return { level: 0.35, reason: `다음 구간 ${expected.toFixed(1)}건 예상 · 대기 밝기 35%` };
  return { level: 0.2, reason: `다음 구간 ${expected.toFixed(1)}건 예상 · 한산해서 대기 밝기 20%` };
}
