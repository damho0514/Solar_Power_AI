"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import CameraPanel, { FRAME_WIDTH_M, speedKmh, type CameraFrame } from "@/components/CameraPanel";
import DevicePanel, { type DeviceView } from "@/components/DevicePanel";
import ReportPanel from "@/components/ReportPanel";
import SolarPanel, { type SolarSummary } from "@/components/SolarPanel";
import StreetMap from "@/components/StreetMap";
import TrafficChart from "@/components/TrafficChart";
import { LABELS } from "@/lib/detectors";
import { connectDevices, type DeviceLink } from "@/lib/device";
import { FEATURE_NAMES } from "@/lib/features";
import { BIN_MS } from "@/lib/forecast";
import { loadModels, resetLamp, scoreLamp, type Models } from "@/lib/ml";
import { PredictiveLighting, arrival, type MapTarget } from "@/lib/predictive";
import {
  RATED_WATT,
  ROAD_H_Y,
  createLamps,
  createWalkers,
  detectionScore,
  ingestReading,
  injectFault,
  moveWalkers,
  repairLamp,
  setCamZone,
  stepBrightness,
  stepSensors,
  targetBrightness,
  verdict,
  zoneFor,
  type FaultKind,
  type Lamp,
  type Method,
  type Walker,
} from "@/lib/sim";
import type { View } from "@/lib/gesture";
import { Tracker, isMoving } from "@/lib/tracker";

const METHODS: { id: Method; label: string; note: string }[] = [
  { id: "rule", label: "규칙", note: "사람이 정한 기준값" },
  { id: "anomaly", label: "로버스트 z", note: "정상 데이터만 학습 · 5분 연속" },
  { id: "classifier", label: "Random Forest", note: "고장 종류까지 학습 · 3분 연속" },
];
const KIND_LABEL: Record<FaultKind | "unknown", string> = {
  voltage: "전압 불안정",
  overheat: "과열",
  driver: "LED 드라이버 열화",
  unknown: "이상 (종류 모름)",
};

const FRAME_MS = 250; // 조명·지도 갱신 주기
const SENSOR_EVERY = 4; // 센서는 1초(= 현장 1분)마다

function Sparkline({ values, color, min, max }: { values: number[]; color: string; min?: number; max?: number }) {
  if (values.length < 2) return <svg className="spark" />;
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 26}`).join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function Home() {
  const lampsRef = useRef<Lamp[]>([]);
  const walkersRef = useRef<Walker[]>([]);
  const energyRef = useRef({ actualWh: 0, fullWh: 0 });
  const brainRef = useRef<PredictiveLighting | null>(null);
  const viewRef = useRef<{ targets: MapTarget[]; forecast: number[] | null; idleReason: string; seeing: boolean; prelit: number }>({
    targets: [],
    forecast: null,
    idleReason: "",
    seeing: false,
    prelit: 0,
  });
  const [, force] = useState(0);
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const modelsRef = useRef<Models | null>(null);
  const solarRef = useRef<SolarSummary | null>(null);
  // 실제 기기(MQTT)
  const linkRef = useRef<DeviceLink | null>(null);
  const edgeTrackerRef = useRef(new Tracker());
  const devRef = useRef({
    lamps: new Map<string, { online: boolean; lastAt: number | null; brightness: number; sent: number | null; sentAt: number }>(),
    cams: new Map<string, { online: boolean; times: number[]; lastCount: number }>(),
  });
  const [deviceState, setDeviceState] = useState<DeviceView["state"]>("off");
  const [deviceError, setDeviceError] = useState("");
  const [brokerUrl, setBrokerUrl] = useState("ws://localhost:9001");
  const [method, setMethod] = useState<Method>("rule");

  // 랜덤 값이 들어가므로 서버 렌더와 어긋나지 않게 브라우저에서만 만든다.
  useEffect(() => {
    lampsRef.current = createLamps();
    walkersRef.current = createWalkers();
    brainRef.current = new PredictiveLighting(performance.now());
    setReady(true);
    loadModels()
      .then((m) => {
        modelsRef.current = m;
        setMethod("classifier");
      })
      .catch((e) => console.warn("고장 탐지 모델을 불러오지 못해 규칙만 씁니다.", e));
  }, []);

  useEffect(() => {
    if (!ready) return;
    let tick = 0;
    const id = setInterval(() => {
      const brain = brainRef.current!;
      const { ctx, targets, forecast, idle } = brain.step(performance.now());
      moveWalkers(walkersRef.current);
      const now = performance.now();
      for (const l of lampsRef.current) {
        const target = targetBrightness(l, walkersRef.current, ctx);
        stepBrightness(l, target);
        // 실제 기기에는 계산한 목표 밝기를 명령으로 보낸다 (5% 넘게 바뀌었거나 10초마다)
        const d = l.source === "device" ? devRef.current.lamps.get(l.id) : undefined;
        if (d && linkRef.current && (d.sent === null || Math.abs(target.level - d.sent) > 0.05 || now - d.sentAt > 10_000)) {
          linkRef.current.sendBrightness(l.id, target.level, target.by ?? "idle");
          d.sent = target.level;
          d.sentAt = now;
        }
      }
      viewRef.current = {
        targets,
        forecast,
        idleReason: idle.reason,
        seeing: ctx.seeing,
        prelit: lampsRef.current.filter((l) => l.litBy === "predict").length,
      };

      if (++tick % SENSOR_EVERY === 0) {
        let watt = 0;
        for (const l of lampsRef.current) {
          if (l.source === "device") continue; // 기기 값은 MQTT로 들어올 때 기록한다
          stepSensors(l);
          if (modelsRef.current) scoreLamp(modelsRef.current, l, FEATURE_NAMES);
          watt += RATED_WATT * l.brightness;
        }
        energyRef.current.actualWh += watt / 60;
        energyRef.current.fullWh += (lampsRef.current.length * RATED_WATT) / 60;
      }
      force((n) => n + 1);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, [ready]);

  const onFrame = useCallback((f: CameraFrame) => brainRef.current?.onFrame(f), []);
  // 손동작으로 카메라 구간을 옮기면 지도와 가로등 제어가 새 구간을 따른다
  const onCamView = useCallback((v: View) => setCamZone(lampsRef.current, zoneFor(v.x, v.zoom)), []);

  async function toggleDevices() {
    if (linkRef.current || deviceState !== "off") {
      linkRef.current?.close();
      linkRef.current = null;
      for (const l of lampsRef.current) l.source = "sim";
      devRef.current.lamps.clear();
      devRef.current.cams.clear();
      setDeviceState("off");
      return;
    }
    setDeviceError("");
    setDeviceState("connecting");
    const dev = devRef.current;
    const lampEntry = (id: string) => {
      let d = dev.lamps.get(id);
      if (!d) dev.lamps.set(id, (d = { online: true, lastAt: null, brightness: 0, sent: null, sentAt: 0 }));
      return d;
    };
    try {
      linkRef.current = await connectDevices(brokerUrl, {
        onConnection: (state, error) => {
          setDeviceState(state);
          if (error) setDeviceError(`브로커에 연결하지 못했습니다: ${error}. mosquitto -c device/mosquitto.conf 를 실행했는지 확인하세요.`);
        },
        onStatus: (kind, id, online) => {
          if (kind === "lamp") lampEntry(id).online = online;
          else dev.cams.set(id, { ...(dev.cams.get(id) ?? { times: [], lastCount: 0 }), online });
        },
        onSensor: (id, m) => {
          const lamp = lampsRef.current.find((l) => l.id === id);
          if (!lamp) return;
          const d = lampEntry(id);
          d.online = true;
          d.lastAt = performance.now();
          d.brightness = m.brightness ?? lamp.brightness;
          if (lamp.source !== "device") {
            // 시뮬레이터 기록을 버리고 실제 값으로 새로 쌓는다
            repairLamp(lamp);
            resetLamp(lamp.id);
            lamp.source = "device";
          }
          ingestReading(lamp, m);
          if (modelsRef.current) scoreLamp(modelsRef.current, lamp, FEATURE_NAMES);
        },
        onDetections: (id, m) => {
          const c = dev.cams.get(id) ?? { online: true, times: [], lastCount: 0 };
          c.online = true;
          c.times = [...c.times.filter((t) => performance.now() - t < 3000), performance.now()];
          c.lastCount = m.detections.length;
          dev.cams.set(id, c);
          // 기기 시각(ts)을 이 화면의 시계로 옮긴다: 전송 지연만큼 과거의 프레임
          const now = performance.now() - Math.max(0, Date.now() - m.ts);
          const frame = edgeTrackerRef.current.update(
            m.detections.map((d) => ({ ...d, label: LABELS[d.label] ?? d.label })),
            now,
          );
          brainRef.current?.onFrame({ ...frame, now });
        },
      });
    } catch (e) {
      setDeviceState("off");
      setDeviceError(String(e));
    }
  }

  if (!ready) return <main className="loading">관제 시스템 시작 중…</main>;

  const lamps = lampsRef.current;
  const brain = brainRef.current!;
  const view = viewRef.current;
  const stats = brain.stats();
  const { actualWh, fullWh } = energyRef.current;
  const savingPct = fullWh ? (1 - actualWh / fullWh) * 100 : 0;
  const alertOf = (l: Lamp) => verdict(l, method);
  const flagged = lamps.filter((l) => alertOf(l) !== null).sort((a, b) => a.health - b.health);
  const scores = METHODS.map((m) => ({ ...m, ...detectionScore(lamps, m.id) }));
  const methodLabel = METHODS.find((m) => m.id === method)!.label;
  const selected = lamps.find((l) => l.id === selectedId) ?? null;
  const mainRoad = lamps.filter((l) => Math.abs(l.y - ROAD_H_Y) < 50 && l.y < ROAD_H_Y);
  const lampAt = (x: number) => mainRoad.find((l) => l.x === x)?.id ?? "";

  const nowMs = performance.now();
  const deviceView: DeviceView = {
    state: deviceState,
    error: deviceError,
    lamps: [...devRef.current.lamps.entries()].map(([id, d]) => ({
      id,
      online: d.online,
      ageSec: d.lastAt === null ? null : (nowMs - d.lastAt) / 1000,
      brightness: d.brightness,
      sentBrightness: d.sent,
    })),
    cameras: [...devRef.current.cams.entries()].map(([id, c]) => ({
      id,
      online: c.online,
      fps: c.times.filter((t) => nowMs - t < 3000).length / 3,
      lastCount: c.lastCount,
    })),
  };

  const buildReportInput = () => ({
    total: lamps.length,
    savingPct,
    savedWh: fullWh - actualWh,
    camera: {
      total: brain.total,
      person: brain.byKind.person,
      vehicle: brain.byKind.vehicle,
      avgSpeedKmh: stats.avgSpeed === null ? null : stats.avgSpeed * FRAME_WIDTH_M * 3.6,
      predErrM: stats.predErr === null ? null : stats.predErr * FRAME_WIDTH_M,
      nextForecast: view.forecast?.[0] ?? null,
      binSeconds: BIN_MS / 1000,
      idleReason: view.idleReason,
    },
    solar: solarRef.current,
    method: methodLabel,
    flagged: flagged.map((l) => ({
      id: l.id,
      health: l.health,
      verdict: KIND_LABEL[alertOf(l)!],
      issues: l.issues.map(({ label, detail }) => ({ label, detail })),
      battery: l.battery,
      solarWh: l.solarWh,
    })),
  });

  return (
    <main>
      <header className="top">
        <div>
          <h1>스마트 가로등 관제 데모</h1>
          <p className="muted">웹캠 AI로 사람·차를 추적하고, 이동과 통행량을 예측해 가로등을 미리 켭니다</p>
          <Link className="muted" href="/siting">태양광 입지 분석 →</Link>
        </div>
        <div className="kpis">
          <div className="kpi">
            <span className="kpi-label">디밍 절감률</span>
            <span className="kpi-value ok">{savingPct.toFixed(1)}%</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">카메라 누적 통행</span>
            <span className="kpi-value">{brain.total}건</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">선제 점등 중</span>
            <span className="kpi-value">{view.prelit}개</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">고장 이상 징후</span>
            <span className={`kpi-value ${flagged.length ? "warn" : ""}`}>{flagged.length}개</span>
          </div>
        </div>
      </header>

      <div className="grid">
        <div className="col">
          <CameraPanel onFrame={onFrame} onView={onCamView} />

          <section className="panel">
            <header className="panel-head">
              <h2>② 이동 예측</h2>
              <span className="muted">1초 뒤 위치를 예측하고 실제와 비교</span>
            </header>
            <p className={`camera-state ${view.seeing ? "on" : ""}`}>
              {view.seeing ? "💡 카메라 구간 100%" : "🌙 카메라 구간 대기 밝기"}
            </p>
            {brain.active.length === 0 && brain.ghosts.length === 0 ? (
              <p className="muted">추적 중인 대상이 없습니다.</p>
            ) : (
              <table className="tracks">
                <thead>
                  <tr>
                    <th>번호</th>
                    <th>종류</th>
                    <th>방향·속도</th>
                    <th>예측</th>
                  </tr>
                </thead>
                <tbody>
                  {brain.active.map((t) => {
                    const a = arrival(t, mainRoad.map((l) => l.x));
                    return (
                      <tr key={t.id}>
                        <td>#{t.id}</td>
                        <td>{t.label}</td>
                        <td>{isMoving(t) ? `${t.vx > 0 ? "→" : "←"} ${speedKmh(t).toFixed(1)}km/h` : "정지"}</td>
                        <td>{a ? `${lampAt(a.x)}까지 ${a.seconds.toFixed(1)}초` : "-"}</td>
                      </tr>
                    );
                  })}
                  {brain.ghosts.map((g) => (
                    <tr key={`g${g.id}`} className="ghost">
                      <td>#{g.id}</td>
                      <td>{g.label}</td>
                      <td>{g.v > 0 ? "→" : "←"} 화면 밖</td>
                      <td>속도로 위치 추정 중</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted">
              {stats.predSamples > 0
                ? `1초 뒤 위치 예측 평균 오차 ${(stats.predErr! * FRAME_WIDTH_M * 100).toFixed(0)}cm (${stats.predSamples}회 채점, 화면 폭 ${FRAME_WIDTH_M}m 가정)`
                : "움직이는 대상이 생기면 예측 정확도를 채점합니다."}
            </p>
          </section>

          <DevicePanel url={brokerUrl} setUrl={setBrokerUrl} view={deviceView} onToggle={toggleDevices} />

          <section className="panel">
            <header className="panel-head">
              <h2>③ 통행량 예측</h2>
              <span className="muted">카메라가 센 통행량으로 예측</span>
            </header>
            <TrafficChart bins={brain.forecaster.bins} current={brain.forecaster.current} forecast={view.forecast} />
            <p className="policy">{view.idleReason}</p>
            <p className="muted">
              {stats.forecastSamples > 0
                ? `예측 평균 오차 ${stats.forecastMae!.toFixed(2)}건 · "직전과 같다" 단순 예측 ${stats.naiveMae!.toFixed(2)}건 (${stats.forecastSamples}구간 채점)`
                : `예측은 ${BIN_MS / 1000}초 구간 3개가 쌓이면 시작합니다.`}
            </p>
          </section>
        </div>

        <div className="col wide">
          <section className="panel">
            <header className="panel-head">
              <h2>관제 지도</h2>
              <span className="muted">점을 누르면 상세 센서값 · 1초 = 현장 1분</span>
            </header>
            <StreetMap
              lamps={lamps}
              walkers={walkersRef.current}
              selectedId={selectedId}
              onSelect={setSelectedId}
              targets={view.targets}
              alert={(l) => (alertOf(l) === null ? null : l.health < 60 ? "bad" : "warn")}
            />
            <div className="legend">
              <span><i style={{ background: "var(--target)", borderRadius: "50%" }} />카메라 추적 대상 (점선=예측 경로·화면 밖 추정)</span>
              <span><i style={{ border: "2px solid var(--target)", borderRadius: "50%", background: "transparent" }} />선제 점등</span>
              <span><i style={{ border: "2px solid var(--accent)", background: "transparent" }} />실제 기기</span>
              <span><i style={{ background: "var(--ok)" }} />정상</span>
              <span><i style={{ background: "var(--warn)" }} />이상 징후</span>
              <span><i style={{ background: "var(--bad)" }} />점검 필요</span>
              <span><i style={{ background: "var(--car)" }} />가상 차량</span>
              <span><i style={{ background: "var(--person)", borderRadius: "50%" }} />가상 보행자</span>
            </div>
          </section>

          <div className="row">
            <section className="panel">
              <header className="panel-head">
                <h2>④ 고장 예측</h2>
                <button
                  className="btn small"
                  onClick={() => {
                    const l = injectFault(lamps);
                    if (l) setSelectedId(l.id);
                  }}
                >
                  고장 몰래 심기
                </button>
              </header>
              <div className="methods" role="radiogroup" aria-label="판정 방법">
                {scores.map((m) => (
                  <button
                    key={m.id}
                    role="radio"
                    aria-checked={method === m.id}
                    className={`method ${method === m.id ? "on" : ""}`}
                    disabled={m.id !== "rule" && !modelsRef.current}
                    onClick={() => setMethod(m.id)}
                  >
                    <b>{m.label}</b>
                    <span>{m.note}</span>
                    <span className="method-score">
                      탐지 {m.caught}/{m.faulty} · 오탐 {m.falseAlarms}
                    </span>
                  </button>
                ))}
              </div>
              {flagged.length === 0 ? (
                <p className="muted">데이터를 모으는 중이거나 이상 징후가 없습니다.</p>
              ) : (
                <ul className="issues">
                  {flagged.map((l) => (
                    <li key={l.id} className={selectedId === l.id ? "active" : ""} onClick={() => setSelectedId(l.id)}>
                      <strong>{l.id}</strong>
                      <span className={`health ${l.health < 60 ? "bad" : "warn"}`}>{l.health}점</span>
                      <span>{KIND_LABEL[alertOf(l)!]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel">
              <header className="panel-head">
                <h2>{selected ? `${selected.id} 상세` : "가로등 상세"}</h2>
                {selected && (
                  <button
                    className="btn small"
                    onClick={() => {
                      repairLamp(selected);
                      resetLamp(selected.id);
                    }}
                  >
                    수리 완료 처리
                  </button>
                )}
              </header>
              {!selected ? (
                <p className="muted">지도나 목록에서 가로등을 선택하세요.</p>
              ) : (
                <div className="detail">
                  <div className="metric">
                    <span>전압</span>
                    <b>{selected.voltage.toFixed(1)}V</b>
                    <Sparkline values={selected.history.voltage} color="var(--chart-1)" min={170} max={260} />
                  </div>
                  <div className="metric">
                    <span>전류</span>
                    <b>{selected.current.toFixed(3)}A</b>
                    <Sparkline values={selected.history.current} color="var(--chart-2)" min={0} max={0.8} />
                  </div>
                  <div className="metric">
                    <span>온도</span>
                    <b>{selected.temp.toFixed(1)}°C</b>
                    <Sparkline values={selected.history.temp} color="var(--chart-3)" min={10} max={85} />
                  </div>
                  <p className="muted">
                    밝기 {Math.round(selected.brightness * 100)}%
                    {selected.litBy === "predict" ? " (선제 점등)" : selected.litBy === "camera" ? " (카메라 감지)" : ""} · 배터리{" "}
                    {selected.battery.toFixed(0)}% · 어제 발전량 {selected.solarWh.toFixed(0)}Wh · 건강도 {selected.health}점
                  </p>
                  {selected.ml && (
                    <p className="muted">
                      ML 판정 · Random Forest: {selected.ml.kind === "normal" ? "정상" : KIND_LABEL[selected.ml.kind]} (확률{" "}
                      {(selected.ml.prob * 100).toFixed(0)}%) · 로버스트 z {selected.ml.anomaly.toFixed(1)}
                      {selected.ml.anomalyFlag ? " (이상)" : ""}
                    </p>
                  )}
                  {selected.issues.map((i) => (
                    <p key={i.kind} className="issue-detail">
                      <b>{i.label}</b> {i.detail}
                    </p>
                  ))}
                </div>
              )}
            </section>
          </div>

          <SolarPanel lamps={lamps} onSelect={setSelectedId} summaryRef={solarRef} />

          <ReportPanel buildInput={buildReportInput} />
        </div>
      </div>
    </main>
  );
}
