"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import CameraDock from "@/components/CameraDock";
import { FRAME_WIDTH_M, speedKmh, type CameraFrame } from "@/components/CameraPanel";
import DevicePanel, { type DeviceView } from "@/components/DevicePanel";
import Icon, { type IconName } from "@/components/Icon";
import LampDetail, { KIND_LABEL } from "@/components/LampDetail";
import ReportPanel from "@/components/ReportPanel";
import SchoolZonePanel from "@/components/SchoolZonePanel";
import SolarPanel, { type SolarSummary } from "@/components/SolarPanel";
import StreetMap from "@/components/StreetMap";
import TrafficChart from "@/components/TrafficChart";
import { LABELS } from "@/lib/detectors";
import { connectDevices, type DeviceLink } from "@/lib/device";
import { FEATURE_NAMES } from "@/lib/features";
import { BIN_MS } from "@/lib/forecast";
import type { View } from "@/lib/gesture";
import { loadModels, resetLamp, scoreLamp, type Models } from "@/lib/ml";
import { PredictiveLighting, arrival, type MapTarget } from "@/lib/predictive";
import { ClipRecorder } from "@/lib/clips";
import { ControlCenterLink, SITE, toOutbound } from "@/lib/integration";
import { EVENT_LABEL, SchoolZoneMonitor, policyAt, type Sign } from "@/lib/schoolzone";
import { VMS_IDS, VmsBus } from "@/lib/vms";
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
  type Lamp,
  type Method,
  type Walker,
} from "@/lib/sim";
import { Tracker, isMoving } from "@/lib/tracker";

type Tab = "live" | "school" | "facility" | "energy" | "report";

// 화면마다 제목과 한 줄 설명. 담당자가 처음 봐도 "이 화면이 뭘 하는지" 알 수 있게 쓴다.
const TABS: { id: Tab; label: string; icon: IconName; title: string; desc: string }[] = [
  { id: "live", label: "관제", icon: "map", title: "실시간 관제", desc: "AI가 도로를 보고 필요한 곳만 밝게 켜요" },
  { id: "school", label: "스쿨존", icon: "school", title: "어린이보호구역", desc: "과속·충돌 위험·불법 주정차를 찾아 전광판으로 알려요" },
  { id: "facility", label: "시설 점검", icon: "wrench", title: "시설 점검", desc: "고장 날 가로등을 미리 찾아 알려요" },
  { id: "energy", label: "에너지", icon: "bolt", title: "에너지·탄소", desc: "아낀 전기와 줄인 탄소, 내일 태양광 충전 예보" },
  { id: "report", label: "보고서", icon: "report", title: "AI 보고서", desc: "오늘 현황을 보고서로 정리해요" },
];

const METHODS: { id: Method; label: string; note: string }[] = [
  { id: "rule", label: "기본 규칙", note: "사람이 정한 기준값으로 판정" },
  { id: "anomaly", label: "이상 패턴 AI", note: "평소와 다른 패턴이 5분 이어지면 알림" },
  { id: "classifier", label: "고장 유형 AI", note: "어떤 고장인지까지 판정 · 3분 연속" },
];

const FRAME_MS = 250; // 조명·지도 갱신 주기
const SENSOR_EVERY = 4; // 센서는 1초(= 현장 1분)마다
// 전력 1kWh를 쓰면 나오는 온실가스 (전력 배출계수 가정값. 지자체가 쓰는 기준값으로 바꿔 쓰세요)
const KG_CO2_PER_KWH = 0.4594;

const VOICE: Partial<Record<Sign["level"], string>> = {
  danger: "차량이 다가오고 있어요. 멈추세요.",
  slow: "어린이 보호구역입니다. 속도를 줄이세요.",
};

function Kpi({ label, value, sub, tone, icon, onClick }: { label: string; value: string; sub?: string; tone?: string; icon: IconName; onClick?: () => void }) {
  return (
    <button className={`kpi tone-${tone ?? "base"}`} onClick={onClick} disabled={!onClick}>
      <span className="kpi-top">
        <span className="kpi-icon">
          <Icon name={icon} size={18} />
        </span>
        <span className="kpi-label">{label}</span>
      </span>
      <b className="kpi-value">{value}</b>
      {sub && <span className="kpi-sub">{sub}</span>}
    </button>
  );
}

function Legend() {
  return (
    <details className="legend">
      <summary>지도 보는 법</summary>
      <div>
        <span><i className="dot" style={{ background: "var(--ok)" }} />정상 가로등</span>
        <span><i className="dot" style={{ background: "var(--warn)" }} />이상 징후</span>
        <span><i className="dot" style={{ background: "var(--bad)" }} />점검 필요</span>
        <span><i className="dot ring" />미리 켠 가로등</span>
        <span><i className="dot" style={{ background: "var(--target)" }} />카메라가 본 사람·차 (점선은 예상 경로)</span>
        <span><i className="sq" style={{ background: "var(--zone)" }} />어린이보호구역·횡단보도</span>
        <span><i className="sq" style={{ background: "var(--car)" }} />가상 차량</span>
        <span><i className="dot" style={{ background: "var(--person)" }} />가상 보행자</span>
        <span><i className="sq outline" />실제 장비와 연결된 가로등</span>
      </div>
    </details>
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
    vms: new Map<string, boolean>(),
  });
  const [deviceState, setDeviceState] = useState<DeviceView["state"]>("off");
  const [deviceError, setDeviceError] = useState("");
  const [brokerUrl, setBrokerUrl] = useState("ws://localhost:9001");
  const [method, setMethod] = useState<Method>("rule");
  const zoneRef = useRef(new SchoolZoneMonitor());
  const recorderRef = useRef<ClipRecorder | null>(null);
  const ccRef = useRef(new ControlCenterLink());
  const vmsRef = useRef<VmsBus | null>(null);
  const [tab, setTabState] = useState<Tab>("live");
  const lastSpoken = useRef<Sign["level"]>("idle");

  // 주소 끝 #school 처럼 탭을 기억해 링크로 공유할 수 있게 한다
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    history.replaceState(null, "", `#${t}`);
    window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    const read = () => {
      const h = location.hash.slice(1) as Tab;
      if (TABS.some((t) => t.id === h)) setTabState(h);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  // 랜덤 값이 들어가므로 서버 렌더와 어긋나지 않게 브라우저에서만 만든다.
  useEffect(() => {
    lampsRef.current = createLamps();
    // 교차로 남쪽 횡단보도를 오가는 보행자 한 명을 더 둔다 (우회전 알리미 시연용)
    walkersRef.current = [...createWalkers(), { road: "v", pos: 420, speed: -0.5, kind: "person" }];
    brainRef.current = new PredictiveLighting(performance.now());
    recorderRef.current = new ClipRecorder();
    vmsRef.current = new VmsBus();
    ccRef.current.start();
    // 사건이 생기면: 이 화면 카메라의 사건은 영상 저장 → 관제센터 전송 → 현장 MQTT로도 알림
    const offEvent = zoneRef.current.onEvent((e) => {
      const clip = e.source === "camera" && !e.device && e.kind !== "crossing";
      if (clip) recorderRef.current?.trigger(e);
      ccRef.current.push(e, clip);
      if (e.kind !== "crossing") linkRef.current?.sendEvent(SITE.id, toOutbound(e, clip));
    });
    // 개발 모드 QA용: 브라우저 콘솔에서 가짜 사건을 넣어 영상 저장·연동을 시험한다
    if (process.env.NODE_ENV === "development") Object.assign(window, { __damo: { zone: zoneRef.current, recorder: recorderRef.current, cc: ccRef.current } });
    setReady(true);
    loadModels()
      .then((m) => {
        modelsRef.current = m;
        setMethod("classifier");
      })
      .catch((e) => console.warn("고장 탐지 모델을 불러오지 못해 규칙만 씁니다.", e));
    return () => {
      offEvent();
      ccRef.current.stop();
      vmsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let tick = 0;
    const id = setInterval(() => {
      const brain = brainRef.current!;
      const { ctx, targets, forecast, idle } = brain.step(performance.now());
      moveWalkers(walkersRef.current);
      const now = performance.now();
      zoneRef.current.onSim(walkersRef.current, now);
      // 전광판 문구가 바뀌면 화면 전광판(/vms)과 실제 장비(MQTT)로 내보낸다
      const send = (id: keyof typeof VMS_IDS, sg: Sign) => linkRef.current?.sendSign(VMS_IDS[id], sg);
      vmsRef.current?.publish("main", zoneRef.current.signAt(now), now, send);
      vmsRef.current?.publish("rt", zoneRef.current.rtSignAt(now), now, send);
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

  const onFrame = useCallback((f: CameraFrame) => {
    brainRef.current?.onFrame(f);
    zoneRef.current.onCamera(f);
  }, []);
  // 손동작으로 카메라 구간을 옮기면 지도와 가로등 제어가 새 구간을 따른다
  const onCamView = useCallback((v: View) => setCamZone(lampsRef.current, zoneFor(v.x, v.zoom)), []);

  async function toggleDevices() {
    if (linkRef.current || deviceState !== "off") {
      linkRef.current?.close();
      linkRef.current = null;
      for (const l of lampsRef.current) l.source = "sim";
      devRef.current.lamps.clear();
      devRef.current.cams.clear();
      devRef.current.vms.clear();
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
          else if (kind === "vms") dev.vms.set(id, online);
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
          zoneRef.current.onCamera({ ...frame, now }, id); // 엣지 카메라도 스쿨존 판단에 쓴다
        },
      });
    } catch (e) {
      setDeviceState("off");
      setDeviceError(String(e));
    }
  }

  const zone = zoneRef.current;
  const idle: Sign = { level: "idle", text: "", sub: "" };
  const sign = ready ? zone.signAt(performance.now()) : idle;
  const rtSign = ready ? zone.rtSignAt(performance.now()) : idle;

  // 위험 문구가 새로 뜰 때만 음성으로 한 번 읽는다
  useEffect(() => {
    if (sign.level === lastSpoken.current) return;
    lastSpoken.current = sign.level;
    const text = VOICE[sign.level];
    if (!text || !zone.settings.voice || typeof speechSynthesis === "undefined") return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    speechSynthesis.speak(u);
  });

  if (!ready)
    return (
      <main className="loading">
        <span className="brand-mark" aria-hidden>
          <Icon name="lamp" size={22} />
        </span>
        관제 시스템을 켜는 중…
      </main>
    );

  const lamps = lampsRef.current;
  const brain = brainRef.current!;
  const view = viewRef.current;
  const stats = brain.stats();
  const { actualWh, fullWh } = energyRef.current;
  const savingPct = fullWh ? (1 - actualWh / fullWh) * 100 : 0;
  const savedWh = fullWh - actualWh;
  const alertOf = (l: Lamp) => verdict(l, method);
  const flagged = lamps.filter((l) => alertOf(l) !== null).sort((a, b) => a.health - b.health);
  const scores = METHODS.map((m) => ({ ...m, ...detectionScore(lamps, m.id) }));
  const methodLabel = METHODS.find((m) => m.id === method)!.label;
  const selected = lamps.find((l) => l.id === selectedId) ?? null;
  const mainRoad = lamps.filter((l) => Math.abs(l.y - ROAD_H_Y) < 50 && l.y < ROAD_H_Y);
  const lampAt = (x: number) => mainRoad.find((l) => l.x === x)?.id ?? "";
  const policy = policyAt(new Date(), zone.settings);
  const current = TABS.find((t) => t.id === tab)!;
  const mapAlert = (l: Lamp) => (alertOf(l) === null ? null : l.health < 60 ? "bad" : "warn");
  const select = (id: string) => setSelectedId((s) => (s === id ? null : id));

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
    savedWh,
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
    school: {
      period: policy.period,
      limit: policy.limit,
      counts: zone.counts,
      slowRate: zone.slowRate(),
      warned: zone.warned,
      rtRate: zone.rtRate(),
      rtWarned: zone.rtWarned,
      recent: zone.events.filter((e) => e.kind !== "crossing").slice(0, 8).map((e) => `${EVENT_LABEL[e.kind]}: ${e.text}`),
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

  const map = (compact = false) => (
    <StreetMap
      lamps={lamps}
      walkers={walkersRef.current}
      selectedId={selectedId}
      onSelect={select}
      targets={view.targets}
      alert={mapAlert}
      sign={sign}
      rtSign={rtSign}
      limit={policy.limit}
      compact={compact}
    />
  );

  const lampPanel = selected && (
    <section className="card">
      <header className="card-head">
        <h2>가로등 상세</h2>
        <button className="icon-btn" onClick={() => setSelectedId(null)} aria-label="닫기">
          <Icon name="close" size={18} />
        </button>
      </header>
      <LampDetail lamp={selected} verdict={alertOf(selected)} />
    </section>
  );

  return (
    <div className="app">
      <aside className="rail">
        <Link href="/" className="brand" onClick={() => setTab("live")}>
          <span className="brand-mark" aria-hidden>
            <Icon name="lamp" size={20} />
          </span>
          <span className="brand-name">
            DAMO<small>안심 가로등</small>
          </span>
        </Link>
        <nav className="rail-nav" aria-label="메뉴">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined}>
              <Icon name={t.icon} />
              <span>{t.title}</span>
              {t.id === "school" && zone.risks() > 0 && <em className="badge">{zone.risks()}</em>}
              {t.id === "facility" && flagged.length > 0 && <em className="badge">{flagged.length}</em>}
            </button>
          ))}
        </nav>
        <Link href="/siting" className="rail-extra">
          <Icon name="sun" />
          <span>태양광 설치 검토</span>
        </Link>
      </aside>

      <div className="main">
        <header className="appbar">
          <span className="brand-mark mobile-only" aria-hidden>
            <Icon name="lamp" size={18} />
          </span>
          <div className="appbar-title">
            <h1>{current.title}</h1>
            <p>{current.desc}</p>
          </div>
          <button className={`zone-chip vms-${sign.level}`} onClick={() => setTab("school")} aria-label="어린이보호구역 전광판 상태">
            <Icon name="school" size={16} />
            <span>{sign.level === "idle" ? `스쿨존 ${policy.limit}km/h` : sign.text}</span>
          </button>
        </header>

        <main className="content">
          {tab === "live" && (
            <div className="stack">
              <div className="kpis">
                <Kpi icon="bolt" label="전기 절약" value={`${savingPct.toFixed(0)}%`} sub="항상 100% 켤 때보다" tone="ok" onClick={() => setTab("energy")} />
                <Kpi icon="lamp" label="미리 켠 가로등" value={`${view.prelit}개`} sub={`카메라 통행 ${brain.total}건`} />
                <Kpi icon="school" label="스쿨존 위험" value={`${zone.risks()}건`} sub="오늘 과속·충돌 위험·주정차" tone={zone.risks() ? "warn" : "base"} onClick={() => setTab("school")} />
                <Kpi icon="wrench" label="점검 필요" value={`${flagged.length}개`} sub={`전체 ${lamps.length}개 중`} tone={flagged.length ? "bad" : "base"} onClick={() => setTab("facility")} />
              </div>

              <section className="card map-card">
                <header className="card-head">
                  <h2>도로 현황</h2>
                  <span className="muted">가로등을 누르면 상태를 볼 수 있어요 · 1초 = 현장 1분</span>
                </header>
                {map()}
                <Legend />
              </section>

              {lampPanel}

              <div className="grid-2">
                <section className="card">
                  <header className="card-head">
                    <h2>움직임 예측</h2>
                    <span className={`pill ${view.seeing ? "tone-ok" : ""}`}>{view.seeing ? "카메라 구간 100% 점등" : "대기 밝기"}</span>
                  </header>
                  <p className="muted">사람·차가 가는 방향을 예측해 앞쪽 가로등을 미리 켜요. 화면 밖으로 나가도 위치를 계속 추정해요.</p>
                  {brain.active.length === 0 && brain.ghosts.length === 0 ? (
                    <p className="empty">지금 카메라에 잡힌 사람·차가 없어요.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>번호</th>
                            <th>종류</th>
                            <th>방향·속도</th>
                            <th>다음 가로등</th>
                          </tr>
                        </thead>
                        <tbody>
                          {brain.active.map((t) => {
                            const a = arrival(t, mainRoad.map((l) => l.x));
                            return (
                              <tr key={t.id}>
                                <td>#{t.id}</td>
                                <td>{t.label}</td>
                                <td>{isMoving(t) ? `${t.vx > 0 ? "→" : "←"} ${speedKmh(t).toFixed(1)}km/h` : "멈춤"}</td>
                                <td>{a ? `${lampAt(a.x)} · ${a.seconds.toFixed(1)}초 뒤` : "-"}</td>
                              </tr>
                            );
                          })}
                          {brain.ghosts.map((g) => (
                            <tr key={`g${g.id}`} className="ghost">
                              <td>#{g.id}</td>
                              <td>{g.label}</td>
                              <td>{g.v > 0 ? "→" : "←"} 화면 밖</td>
                              <td>위치 추정 중</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="muted small">
                    {stats.predSamples > 0
                      ? `1초 뒤 위치 예측 오차 평균 ${(stats.predErr! * FRAME_WIDTH_M * 100).toFixed(0)}cm (${stats.predSamples}번 채점)`
                      : "움직이는 대상이 생기면 예측이 얼마나 맞는지 채점해요."}
                  </p>
                </section>

                <section className="card">
                  <header className="card-head">
                    <h2>통행량 예측과 밝기</h2>
                  </header>
                  <p className="muted">다음 시간대 통행량을 예측해, 한산할 때는 밝기를 낮춰 전기를 아껴요.</p>
                  <TrafficChart bins={brain.forecaster.bins} current={brain.forecaster.current} forecast={view.forecast} />
                  <p className="policy">{view.idleReason}</p>
                  <p className="muted small">
                    {stats.forecastSamples > 0
                      ? `예측 오차 평균 ${stats.forecastMae!.toFixed(2)}건 · "직전과 같다"고 볼 때 ${stats.naiveMae!.toFixed(2)}건`
                      : `${BIN_MS / 1000}초 구간 3개가 쌓이면 예측을 시작해요.`}
                  </p>
                </section>
              </div>
            </div>
          )}

          {tab === "school" && (
            <SchoolZonePanel
              zone={zone}
              sign={sign}
              rtSign={rtSign}
              onChange={() => force((n) => n + 1)}
              map={map()}
              recorder={recorderRef.current!}
              link={ccRef.current}
              vmsDevices={[...devRef.current.vms.entries()].map(([id, online]) => ({ id, online }))}
              mqttOn={deviceState === "connected"}
            />
          )}

          {tab === "facility" && (
            <div className="stack">
              <section className="card">
                <header className="card-head">
                  <h2>고장 미리 알림</h2>
                  <button
                    className="btn small"
                    onClick={() => {
                      const l = injectFault(lamps);
                      if (l) setSelectedId(l.id);
                    }}
                  >
                    고장 시연하기
                  </button>
                </header>
                <p className="muted">전압·전류·온도 흐름을 AI가 보고, 고장 나기 전에 이상한 가로등을 찾아요. "고장 시연하기"를 누르면 몰래 고장을 심고 몇 초 만에 찾는지 볼 수 있어요.</p>
                <div className="segmented" role="radiogroup" aria-label="판정 방식">
                  {scores.map((m) => (
                    <button
                      key={m.id}
                      role="radio"
                      aria-checked={method === m.id}
                      className={method === m.id ? "on" : ""}
                      disabled={m.id !== "rule" && !modelsRef.current}
                      onClick={() => setMethod(m.id)}
                    >
                      <b>{m.label}</b>
                      <span>{m.note}</span>
                      <span className="seg-score">
                        찾아냄 {m.caught}/{m.faulty} · 잘못 알림 {m.falseAlarms}
                      </span>
                    </button>
                  ))}
                </div>
                {flagged.length === 0 ? (
                  <p className="empty">지금은 점검이 필요한 가로등이 없어요.</p>
                ) : (
                  <ul className="list">
                    {flagged.map((l) => (
                      <li key={l.id}>
                        <button className={selectedId === l.id ? "on" : ""} onClick={() => select(l.id)}>
                          <b>{l.id}</b>
                          <span>{KIND_LABEL[alertOf(l)!]}</span>
                          <span className={`score tone-${l.health < 60 ? "bad" : "warn"}`}>{l.health}점</span>
                          <Icon name="chevron" size={16} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {lampPanel ?? (
                <section className="card">
                  <p className="empty">목록이나 지도에서 가로등을 고르면 센서 값을 보여 줘요.</p>
                </section>
              )}
              <section className="card map-card">
                <header className="card-head">
                  <h2>위치</h2>
                </header>
                {map()}
              </section>
              <details className="card settings">
                <summary>
                  <h2>실제 장비 연결 (개발자용)</h2>
                  <Icon name="chevron" size={18} />
                </summary>
                <DevicePanel url={brokerUrl} setUrl={setBrokerUrl} view={deviceView} onToggle={toggleDevices} />
              </details>
            </div>
          )}

          {tab === "energy" && (
            <div className="stack">
              <div className="kpis">
                <Kpi icon="bolt" label="전기 절약률" value={`${savingPct.toFixed(1)}%`} sub="항상 100%로 켤 때 대비" tone="ok" />
                <Kpi icon="gauge" label="아낀 전기" value={`${(savedWh / 1000).toFixed(2)}kWh`} sub={`가로등 ${lamps.length}개 · ${RATED_WATT}W 기준`} />
                <Kpi icon="leaf" label="줄인 탄소" value={`${((savedWh / 1000) * KG_CO2_PER_KWH).toFixed(2)}kg`} sub={`CO₂ 환산 · 배출계수 ${KG_CO2_PER_KWH}`} tone="ok" />
              </div>
              <section className="card">
                <header className="card-head">
                  <h2>어떻게 아끼나요?</h2>
                </header>
                <ul className="bullets">
                  <li>사람·차가 없을 땐 20~50%로 낮춰 두고, 다가오면 미리 100%로 켜요.</li>
                  <li>통행량이 많을 것으로 예상되는 시간대엔 대기 밝기를 높여 안전을 먼저 챙겨요.</li>
                  <li>어린이보호구역 횡단보도는 보행자가 보이면 항상 최대 밝기로 켜요.</li>
                </ul>
              </section>
              <SolarPanel lamps={lamps} onSelect={(id) => { setSelectedId(id); setTab("facility"); }} summaryRef={solarRef} />
            </div>
          )}

          {tab === "report" && (
            <div className="stack">
              <ReportPanel buildInput={buildReportInput} />
              <Link href="/siting" className="card link-card">
                <span className="kpi-icon">
                  <Icon name="sun" size={18} />
                </span>
                <div>
                  <b>태양광 설치 검토</b>
                  <p className="muted">주소를 넣으면 지목·용도지역과 지자체 조례를 확인해 설치 가능성을 알려 줘요.</p>
                </div>
                <Icon name="chevron" size={18} />
              </Link>
            </div>
          )}
        </main>
      </div>

      <nav className="tabbar" aria-label="메뉴">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined}>
            <span className="tab-icon">
              <Icon name={t.icon} size={22} />
              {t.id === "school" && zone.risks() > 0 && <i className="tab-dot" />}
              {t.id === "facility" && flagged.length > 0 && <i className="tab-dot bad" />}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <CameraDock
        onFrame={onFrame}
        onView={onCamView}
        onShowMap={() => setTab("live")}
        inset={map(true)}
        privacy={zone.settings.privacy}
        recorder={recorderRef.current ?? undefined}
        alert={sign.level === "danger" || sign.level === "slow" ? `${sign.text} · ${sign.sub}` : null}
      />
    </div>
  );
}
