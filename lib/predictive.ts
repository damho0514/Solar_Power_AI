// 카메라 추적 결과를 받아 가로등 제어에 쓸 예측을 만든다.
// 1. 이동 예측: 1~3초 뒤 위치를 계산해 가는 방향의 가로등을 미리 켠다.
// 2. 화면 밖 추정: 화면을 벗어난 대상은 마지막 속도로 위치를 계속 추정한다.
// 3. 통행량 예측: 카메라가 센 통행량으로 다음 구간을 예측해 대기 밝기를 정한다.
// 각 예측이 실제로 맞았는지도 채점한다.

import { TrafficForecaster, idleLevelFor } from "./forecast";
import { MAP_W, camToMapX, camZone, type CameraCtx } from "./sim";
import { isMoving, predict, type Track } from "./tracker";

export type MapTarget = { key: string; x: number; aheadX: number | null; kind: "person" | "vehicle"; ghost: boolean };

type Ghost = { id: number; label: string; kind: Track["kind"]; x0: number; v: number; t0: number };

const HOLD_MS = 2000; // 대상이 사라진 뒤에도 카메라 구간 밝기 유지
const GHOST_MS = 4000;
// 카메라 구간은 손동작으로 옮겨지므로 쓸 때마다 읽는다
const camSpan = () => camZone.x1 - camZone.x0;
const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const keep = (a: number[], v: number, n = 100) => {
  a.push(v);
  if (a.length > n) a.shift();
};

export class PredictiveLighting {
  active: Track[] = [];
  ghosts: Ghost[] = [];
  total = 0;
  byKind = { person: 0, vehicle: 0 };
  speeds: number[] = []; // 화면 폭 / 초
  forecaster: TrafficForecaster;

  // 채점용
  predErrors: number[] = []; // 1초 뒤 위치 예측 오차 (화면 폭 비율)
  forecastErrors: number[] = [];
  naiveErrors: number[] = []; // 비교 기준: "직전 구간과 같겠지" 예측의 오차
  private pending: { id: number; due: number; x: number }[] = [];
  private lastPendingAt = new Map<number, number>();
  private lastForecast: number | null = null;
  private completedSeen = 0;
  private lastSeen = -Infinity;

  constructor(now: number) {
    this.forecaster = new TrafficForecaster(now);
  }

  onFrame(f: { active: Track[]; born: Track[]; lost: Track[]; now: number }) {
    const { now } = f;
    this.active = f.active;
    if (f.active.length) this.lastSeen = now;

    for (const t of f.born) {
      this.total++;
      this.byKind[t.kind]++;
      this.forecaster.record(now);
    }
    for (const t of f.lost) {
      this.lastPendingAt.delete(t.id);
      if (!isMoving(t)) continue;
      keep(this.speeds, Math.abs(t.vx));
      this.ghosts.push({ id: t.id, label: t.label, kind: t.kind, x0: camToMapX(t.cx), v: t.vx * camSpan(), t0: now });
    }

    // 1초 뒤 위치를 예측해 두었다가, 1초가 지나면 실제 위치와 비교한다
    this.pending = this.pending.filter((p) => {
      if (p.due > now) return true;
      const t = f.active.find((a) => a.id === p.id);
      if (t && now - p.due < 200) keep(this.predErrors, Math.abs(t.cx - p.x));
      return false;
    });
    for (const t of f.active) {
      if (!isMoving(t) || now - (this.lastPendingAt.get(t.id) ?? -Infinity) < 500) continue;
      this.lastPendingAt.set(t.id, now);
      this.pending.push({ id: t.id, due: now + 1000, x: predict(t, 1).x });
    }
  }

  step(now: number) {
    this.forecaster.roll(now);
    if (this.forecaster.completed > this.completedSeen) {
      const bins = this.forecaster.bins;
      const actual = bins[bins.length - 1];
      if (this.lastForecast !== null) {
        keep(this.forecastErrors, Math.abs(actual - this.lastForecast));
        keep(this.naiveErrors, Math.abs(actual - (bins[bins.length - 2] ?? 0)));
      }
      this.completedSeen = this.forecaster.completed;
    }
    const forecast = this.forecaster.forecast(4);
    this.lastForecast = forecast?.[0] ?? null;
    const idle = idleLevelFor(this.lastForecast);

    const gx = (g: Ghost) => g.x0 + (g.v * (now - g.t0)) / 1000;
    this.ghosts = this.ghosts.filter((g) => now - g.t0 < GHOST_MS && gx(g) > -40 && gx(g) < MAP_W + 40);

    const points: number[] = [];
    const targets: MapTarget[] = [];
    for (const t of this.active) {
      const x = camToMapX(t.cx);
      points.push(x);
      let aheadX: number | null = null;
      if (isMoving(t)) {
        for (let s = 0.5; s <= 3; s += 0.5) points.push(camToMapX(predict(t, s).x));
        aheadX = camToMapX(predict(t, 3).x);
      }
      targets.push({ key: `t${t.id}`, x, aheadX, kind: t.kind, ghost: false });
    }
    for (const g of this.ghosts) {
      const x = gx(g);
      points.push(x, x + g.v, x + g.v * 2);
      targets.push({ key: `g${g.id}`, x, aheadX: x + g.v * 2, kind: g.kind, ghost: true });
    }

    const ctx: CameraCtx = { seeing: now - this.lastSeen < HOLD_MS, points, idle: idle.level };
    return { ctx, targets, forecast, idle };
  }

  stats() {
    return {
      predErr: avg(this.predErrors),
      predSamples: this.predErrors.length,
      forecastMae: avg(this.forecastErrors),
      naiveMae: avg(this.naiveErrors),
      forecastSamples: this.forecastErrors.length,
      avgSpeed: avg(this.speeds),
    };
  }
}

// 대상이 가는 방향으로 카메라 구간 밖 첫 가로등까지 몇 초 남았는지
export function arrival(t: Track, lampXs: number[]) {
  if (!isMoving(t)) return null;
  const x = camToMapX(t.cx);
  const v = t.vx * camSpan();
  const ahead = lampXs.filter((lx) => (v > 0 ? lx >= camZone.x1 && lx > x : lx <= camZone.x0 && lx < x));
  if (!ahead.length) return null;
  const target = v > 0 ? Math.min(...ahead) : Math.max(...ahead);
  return { x: target, seconds: (target - x) / v };
}
