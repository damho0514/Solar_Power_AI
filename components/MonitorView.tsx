"use client";

// 모니터링 화면: 웹캠 + 3D 로드뷰를 나란히 보면서, 정한 시간 동안 요구사항별 분석을 기록하고,
// 기록마다 대시보드와 AI 분석 리포트를 만든다. 전체 화면에서는 이 화면만 꽉 차게 보인다.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Icon from "@/components/Icon";
import { renderMarkdown } from "@/components/ReportPanel";
import { dockSlot } from "@/lib/dockSlot";
import { summarize, toCsv, type MonitorRecorder, type Session, type SessionMeta, type Snapshot, type Summary } from "@/lib/monitor";
import { evaluate, kindLabel, type ReqStatus } from "@/lib/requirements";
import { EVENT_LABEL, type EventKind } from "@/lib/schoolzone";

type Props = { monitor: MonitorRecorder; now: Snapshot | undefined; map: ReactNode };

const DURATIONS: { v: number | null; label: string }[] = [
  { v: 5, label: "5분" },
  { v: 15, label: "15분" },
  { v: 30, label: "30분" },
  { v: 60, label: "60분" },
  { v: null, label: "직접 멈출 때까지" },
];
const RANGES = [1, 5, 15, 60]; // 그래프 보기 범위 (분)
const STATUS_LABEL: Record<ReqStatus, string> = { ok: "정상", watch: "주의", alert: "경고", idle: "대기" };
const LEVEL_COLOR: Record<string, string> = { idle: "transparent", child: "#2bd46a", slow: "#f59e0b", danger: "#ef4444" };

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);
const clock = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function download(name: string, text: string, type: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 보행자·차량 수 계단선 + 아래 띠에 전광판 경고 단계
function Timeline({ samples, from, to }: { samples: Snapshot[]; from: number; to: number }) {
  const W = 720, H = 170, L = 30, R = 8, T = 10, B = 40;
  const rows = samples.filter((s) => s.t >= from && s.t <= to);
  const top = Math.max(3, ...rows.map((s) => Math.max(s.cam.person, s.cam.vehicle)));
  const x = (t: number) => L + ((t - from) / Math.max(1, to - from)) * (W - L - R);
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const line = (get: (s: Snapshot) => number) =>
    rows.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(get(s)).toFixed(1)}${i < rows.length - 1 ? `H${x(rows[i + 1].t).toFixed(1)}` : ""}`).join("");
  const ticks = 5;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="시간대별 웹캠 감지와 전광판 경고">
        {[0, Math.ceil(top / 2), top].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="axis">
              {v}
            </text>
          </g>
        ))}
        {rows.length > 1 && (
          <>
            <path d={line((s) => s.cam.vehicle)} fill="none" stroke="var(--chart-1)" strokeWidth={2} />
            <path d={line((s) => s.cam.person)} fill="none" stroke="var(--chart-3)" strokeWidth={2} />
          </>
        )}
        {rows.map((s, i) =>
          s.zone.level === "idle" ? null : (
            <rect key={i} x={x(s.t)} y={H - B + 8} width={Math.max(1.5, i < rows.length - 1 ? x(rows[i + 1].t) - x(s.t) : 2)} height={8} fill={LEVEL_COLOR[s.zone.level]} />
          ),
        )}
        <rect x={L} y={H - B + 8} width={W - L - R} height={8} fill="none" stroke="var(--grid)" />
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const t = from + ((to - from) * i) / ticks;
          return (
            <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === ticks ? "end" : "middle"} className="axis">
              {new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: to - from < 600_000 ? "2-digit" : undefined })}
            </text>
          );
        })}
      </svg>
      <p className="chart-note">
        <i className="key solid" style={{ background: "var(--chart-3)" }} />웹캠 보행자 <i className="key solid" style={{ background: "var(--chart-1)", marginLeft: 12 }} />웹캠 차량
        <i className="key solid" style={{ background: "#f59e0b", marginLeft: 12 }} />전광판 주의 <i className="key solid" style={{ background: "#ef4444", marginLeft: 6 }} />멈추세요
        {rows.length < 2 && " · 데이터 쌓는 중"}
      </p>
    </div>
  );
}

function Requirements({ now }: { now: Snapshot | undefined }) {
  const groups = evaluate(now);
  if (!groups.length) return <p className="empty">분석 데이터를 모으는 중이에요.</p>;
  return (
    <div className="req-grid">
      {groups.map((g) => (
        <section key={g.id} className={`card req req-${g.id}`}>
          <header className="card-head">
            <h2>{g.title}</h2>
            <span className={`pill tone-${g.items.some((i) => i.status === "alert") ? "bad" : g.items.some((i) => i.status === "watch") ? "warn" : "ok"}`}>
              {g.items.some((i) => i.status === "alert") ? "경고 있음" : g.items.some((i) => i.status === "watch") ? "주의" : "정상"}
            </span>
          </header>
          <ul className="req-list">
            {g.items.map((it) => (
              <li key={it.label} className={`st-${it.status}`}>
                <i aria-label={STATUS_LABEL[it.status]} />
                <div>
                  <b>{it.label}</b>
                  <p>{it.value}</p>
                </div>
                <em>{it.basis}</em>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SummaryKpis({ s }: { s: Summary }) {
  const e = s.school.events;
  const risk = e.speeding + e.conflict + e.parking + e.rightturn;
  return (
    <div className="kpis">
      <div className="kpi tone-base">
        <span className="kpi-label">기록 시간</span>
        <b className="kpi-value">{mmss(s.seconds * 1000)}</b>
        <span className="kpi-sub">웹캠 켜짐 {pct(s.camOnPct)}</span>
      </div>
      <div className={`kpi tone-${risk ? "warn" : "ok"}`}>
        <span className="kpi-label">스쿨존 위험 사건</span>
        <b className="kpi-value">{risk}건</b>
        <span className="kpi-sub">웹캠 실측 {s.school.cameraEvents}건 · 경고 후 감속 {pct(s.school.slowRate)}</span>
      </div>
      <div className={`kpi tone-${s.facility.peakFlagged ? "bad" : "ok"}`}>
        <span className="kpi-label">이상 가로등 (최대)</span>
        <b className="kpi-value">{s.facility.peakFlagged}개</b>
        <span className="kpi-sub">긴급 상태 {s.facility.badSec}초</span>
      </div>
      <div className="kpi tone-ok">
        <span className="kpi-label">절전율</span>
        <b className="kpi-value">{s.energy.savingPct.toFixed(0)}%</b>
        <span className="kpi-sub">아낀 전기 {s.energy.savedWh.toFixed(0)}Wh · 배터리 부족 예상 {s.energy.risky}개</span>
      </div>
    </div>
  );
}

// 저장된 기록 한 건의 대시보드 + AI 리포트
function SessionReport({ session, onClose, onDelete }: { session: Session; onClose: () => void; onDelete: () => void }) {
  const summary = useMemo(() => summarize(session.samples, session.events), [session]);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);
  const e = summary.school.events;
  const kinds = (["speeding", "conflict", "parking", "rightturn", "crossing"] as EventKind[]).map((k) => ({ k, n: e[k] }));
  const peak = Math.max(1, ...kinds.map((x) => x.n));

  // 분 단위로 묶어 LLM에 넘긴다 (최대 60줄)
  const minutes = useMemo(() => {
    const out: { t: string; person: number; vehicle: number; maxKmh: number; danger: number; flagged: number }[] = [];
    const step = Math.max(60_000, Math.ceil((session.end - session.start) / 60 / 60_000) * 60_000);
    for (let t0 = session.start; t0 < session.end; t0 += step) {
      const rows = session.samples.filter((s) => s.t >= t0 && s.t < t0 + step);
      if (!rows.length) continue;
      out.push({
        t: new Date(t0).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
        person: Math.max(...rows.map((r) => r.cam.person)),
        vehicle: Math.max(...rows.map((r) => r.cam.vehicle)),
        maxKmh: Math.max(...rows.map((r) => r.cam.maxKmh)),
        danger: rows.filter((r) => r.zone.level === "danger").length,
        flagged: Math.max(...rows.map((r) => r.lamps.flagged)),
      });
    }
    return out;
  }, [session]);

  async function write() {
    ac.current?.abort();
    const c = new AbortController();
    ac.current = c;
    setText("");
    setState("streaming");
    try {
      const res = await fetch("/api/monitor/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: session.name, start: new Date(session.start).toLocaleString("ko-KR"), end: new Date(session.end).toLocaleString("ko-KR"), summary, minutes }),
        signal: c.signal,
      });
      if (!res.ok || !res.body) {
        setText(await res.text());
        setState("error");
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setText((t) => t + dec.decode(value, { stream: true }));
      }
      setState("done");
    } catch (err) {
      if (c.signal.aborted) return;
      setText(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  return (
    <section className="card session-report">
      <header className="card-head">
        <h2>{session.name}</h2>
        <div className="row-btns">
          <button className="btn small" onClick={() => download(`${session.name}.csv`, toCsv(session), "text/csv")}>
            CSV 내려받기
          </button>
          <button className="btn small" onClick={() => download(`${session.name}.json`, JSON.stringify({ ...session, summary }, null, 1), "application/json")}>
            JSON
          </button>
          <button className="btn small" onClick={onDelete}>
            삭제
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" size={18} />
          </button>
        </div>
      </header>
      <p className="muted">
        {new Date(session.start).toLocaleString("ko-KR")} ~ {clock(session.end)} · 1초 간격 {session.samples.length}장
      </p>
      <SummaryKpis s={summary} />
      <div className="grid-2">
        <div>
          <h3>어린이보호구역 사건</h3>
          <ul className="bars">
            {kinds.map(({ k, n }) => (
              <li key={k}>
                <span>{EVENT_LABEL[k]}</span>
                <i style={{ width: `${(n / peak) * 100}%` }} />
                <b>{n}</b>
              </li>
            ))}
          </ul>
          <p className="muted small">
            웹캠 최대 보행자 {summary.school.peakPerson}명 · 차량 {summary.school.peakVehicle}대 · 최고 {summary.school.maxKmh.toFixed(0)}km/h · "멈추세요" 경고 {summary.school.dangerSec}초 · 우회전 일시정지{" "}
            {pct(summary.school.rtRate)}
          </p>
        </div>
        <div>
          <h3>시설·전기 안전</h3>
          {summary.facility.faults.length === 0 ? (
            <p className="empty">기록 동안 이상 징후가 있던 가로등이 없어요.</p>
          ) : (
            <ul className="bullets">
              {summary.facility.faults.map((f) => (
                <li key={f.id}>
                  <b>{f.id}</b> {f.kinds.map(kindLabel).join(", ")}
                </li>
              ))}
            </ul>
          )}
          <h3 style={{ marginTop: 12 }}>태양광·에너지</h3>
          <p className="muted">
            절전율 {summary.energy.savingPct.toFixed(1)}% · 내일 충전 예보 {summary.energy.solarWh === null ? "-" : `${Math.round(summary.energy.solarWh)}Wh`} · 배터리 부족 예상{" "}
            {summary.energy.risky}개
          </p>
        </div>
      </div>
      <h3>시간대 흐름</h3>
      <Timeline samples={session.samples} from={session.start} to={session.end} />
      <div className="report">
        <button className="btn primary" onClick={write} disabled={state === "streaming"}>
          {state === "streaming" ? "작성 중…" : state === "idle" ? "AI 분석 리포트 만들기" : "다시 만들기"}
        </button>
        {text && state !== "streaming" && (
          <button className="btn small" style={{ marginLeft: 8 }} onClick={() => download(`${session.name} 리포트.md`, text, "text/markdown")}>
            리포트 내려받기
          </button>
        )}
        <div className={`report-body ${state === "error" ? "error" : ""}`}>
          {text ? renderMarkdown(text) : state === "idle" && <p className="muted">요구사항(어린이보호구역 · 시설·전기 안전 · 태양광·에너지)별로 기록을 분석해 담당자용 리포트를 써요.</p>}
          {state === "streaming" && <span className="cursor" />}
        </div>
      </div>
    </section>
  );
}

export default function MonitorView({ monitor, now, map }: Props) {
  const [duration, setDuration] = useState<number | null>(15);
  const [range, setRange] = useState(5);
  const [full, setFull] = useState(false);
  const [list, setList] = useState<SessionMeta[]>([]);
  const [open, setOpen] = useState<Session | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const rec = monitor.rec;

  // 웹캠 칸: 떠 있는 카메라 창을 여기에 붙인다
  useEffect(() => {
    dockSlot.set(slotRef.current);
    return () => dockSlot.set(null);
  }, []);

  useEffect(() => {
    let seq = 0;
    // 조회가 겹치면 마지막에 시작한 결과만 쓴다
    const load = () => {
      const n = ++seq;
      void monitor.list().then((l) => n === seq && setList(l));
    };
    load();
    return monitor.onChange(load);
  }, [monitor]);

  // 전체 화면: 브라우저 전체 화면 + 이 화면만 꽉 차게 (카메라 창은 웹캠 칸에 붙어 그대로 보인다)
  useEffect(() => {
    if (!full) return;
    document.body.style.overflow = "hidden";
    document.documentElement.requestFullscreen?.().catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    const onFs = () => !document.fullscreenElement && setFull(false);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [full]);

  const elapsed = monitor.elapsed();
  const planned = rec?.plannedMin ? rec.plannedMin * 60_000 : null;
  const to = now?.t ?? Date.now();
  const liveSummary = rec && rec.samples.length > 1 ? summarize(rec.samples, rec.events) : null;

  return (
    <div className={`monitor${full ? " monitor-full" : ""}`}>
      <section className="card monitor-bar">
        <div className="rec-state">
          <span className={`rec-dot${rec ? " on" : ""}`} />
          <div>
            <b>{rec ? "기록 중" : "기록 대기"}</b>
            <p className="muted small">
              {rec ? `${mmss(elapsed)}${planned ? ` / ${mmss(planned)}` : ""} · ${rec.samples.length}장` : "시간을 정하고 기록을 시작하세요. 1초마다 요구사항별 분석 결과를 남겨요."}
            </p>
          </div>
        </div>
        {planned && <progress className="rec-progress" max={planned} value={elapsed} />}
        <label className="field-inline">
          기록 시간
          <select className="input" value={String(duration)} disabled={!!rec} onChange={(e) => setDuration(e.target.value === "null" ? null : Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.label} value={String(d.v)}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {rec ? (
          <button className="btn primary" onClick={() => void monitor.stop()}>
            ■ 기록 끝내기
          </button>
        ) : (
          <button className="btn primary" onClick={() => monitor.start(duration)}>
            ● 기록 시작
          </button>
        )}
        <label className="field-inline">
          그래프
          <select className="input" value={range} onChange={(e) => setRange(Number(e.target.value))}>
            {RANGES.map((r) => (
              <option key={r} value={r}>
                최근 {r}분
              </option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={() => setFull((f) => !f)}>
          <Icon name={full ? "shrink" : "expand"} size={16} /> {full ? "전체 화면 끝내기" : "전체 화면"}
        </button>
      </section>
      {monitor.error && <p className="bad-text">{monitor.error}</p>}

      <div className="monitor-stage">
        <div className="monitor-cam">
          <div ref={slotRef} className="cam-slot">
            <p className="muted">웹캠을 켜면 이 칸에 실시간 화면과 AI 인식 결과가 나와요.</p>
          </div>
        </div>
        <div className="monitor-map">{map}</div>
      </div>

      <h2 className="section-title">AI가 지금 분석 중인 요구사항</h2>
      <Requirements now={now} />

      <section className="card">
        <header className="card-head">
          <h2>실시간 흐름</h2>
          <span className="muted">최근 {range}분 · 웹캠 감지 수와 전광판 경고</span>
        </header>
        <Timeline samples={monitor.live} from={to - range * 60_000} to={to} />
      </section>

      {liveSummary && (
        <section className="card">
          <header className="card-head">
            <h2>이번 기록 중간 결과</h2>
          </header>
          <SummaryKpis s={liveSummary} />
        </section>
      )}

      <section className="card">
        <header className="card-head">
          <h2>모니터링 기록</h2>
          <span className="muted">이 기기 브라우저에 저장 · {list.length}건</span>
        </header>
        {list.length === 0 ? (
          <p className="empty">아직 저장된 기록이 없어요. 위에서 기록을 시작해 보세요.</p>
        ) : (
          <ul className="sessions">
            {list.map((m) => {
              const e = m.summary.school.events;
              return (
                <li key={m.id}>
                  <button onClick={() => void monitor.get(m.id).then(setOpen)} className={open?.id === m.id ? "on" : ""}>
                    <b>{m.name}</b>
                    <span className="muted small">
                      {mmss(m.summary.seconds * 1000)} · 위험 {e.speeding + e.conflict + e.parking + e.rightturn}건 · 이상 가로등 {m.summary.facility.peakFlagged}개 · 절전{" "}
                      {m.summary.energy.savingPct.toFixed(0)}%
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {open && (
        <SessionReport
          key={open.id}
          session={open}
          onClose={() => setOpen(null)}
          onDelete={() => {
            void monitor.remove(open.id);
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}
