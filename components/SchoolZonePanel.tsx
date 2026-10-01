"use client";

import type { ReactNode } from "react";
import ClipsPanel from "@/components/ClipsPanel";
import Icon, { type IconName } from "@/components/Icon";
import type { ClipRecorder } from "@/lib/clips";
import type { ControlCenterLink } from "@/lib/integration";
import { EVENT_LABEL, isSchoolHour, policyAt, type EventKind, type SchoolZoneMonitor, type Sign } from "@/lib/schoolzone";

type Props = {
  zone: SchoolZoneMonitor;
  sign: Sign;
  rtSign: Sign;
  onChange: () => void;
  map?: ReactNode;
  recorder: ClipRecorder;
  link: ControlCenterLink;
  vmsDevices: { id: string; online: boolean }[]; // MQTT로 붙은 실제 전광판
  mqttOn: boolean;
};

const KIND_ICON: Record<EventKind, IconName> = { speeding: "gauge", conflict: "alert", parking: "car", rightturn: "turn", crossing: "walk" };
const KIND_TONE: Record<EventKind, string> = { speeding: "warn", conflict: "bad", parking: "warn", rightturn: "bad", crossing: "info" };

const time = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// 전광판 미리보기: 운전자가 실제로 보게 될 문구
export function SignBoard({ sign, large }: { sign: Sign; large?: boolean }) {
  return (
    <div className={`vms vms-${sign.level}${large ? " large" : ""}`} role="status" aria-live="polite">
      <span className="vms-text">{sign.text}</span>
      <span className="vms-sub">{sign.sub}</span>
    </div>
  );
}

export default function SchoolZonePanel({ zone, sign, rtSign, onChange, map, recorder, link, vmsDevices, mqttOn }: Props) {
  const policy = policyAt(new Date(), zone.settings);
  const rate = zone.slowRate();
  const rtRate = zone.rtRate();
  const ls = link.state;
  const peak = Math.max(1, ...zone.hourly);
  const nowH = new Date().getHours();
  const s = zone.settings;

  const stat = (kind: EventKind, hint: string) => (
    <div className={`stat tone-${KIND_TONE[kind]}`}>
      <span className="stat-icon">
        <Icon name={KIND_ICON[kind]} size={18} />
      </span>
      <span className="stat-label">{EVENT_LABEL[kind]}</span>
      <b className="stat-value">{zone.counts[kind]}건</b>
      <span className="stat-hint">{hint}</span>
    </div>
  );

  return (
    <div className="stack">
      <section className="card zone-hero">
        <div className="zone-hero-main">
          <span className="eyebrow">지금 전광판 · 보호구역 / 교차로 우회전 알리미</span>
          <div className="signs">
            <SignBoard sign={sign} large />
            <SignBoard sign={rtSign} />
          </div>
          <p className="muted">AI가 보행자와 차량 속도를 보고 운전자에게 보여 줄 문구를 자동으로 바꿔요.</p>
        </div>
        <div className="zone-policy">
          <div>
            <span className="eyebrow">운영 시간대</span>
            <b>{policy.period}</b>
          </div>
          <div>
            <span className="eyebrow">제한속도</span>
            <b>{policy.limit}km/h</b>
          </div>
          <div>
            <span className="eyebrow">카메라 최고 속도</span>
            <b className={zone.maxKmh > policy.limit ? "bad-text" : ""}>{zone.maxKmh ? `${zone.maxKmh.toFixed(0)}km/h` : "-"}</b>
          </div>
        </div>
      </section>

      {map && (
        <section className="card map-card">
          <header className="card-head">
            <h2>보호구역 지도</h2>
            <span className="muted">노란 구간이 보호구역, 흰 줄무늬가 횡단보도예요</span>
          </header>
          {map}
        </section>
      )}

      <section className="card">
        <header className="card-head">
          <h2>오늘의 안전 기록</h2>
          <span className="muted">카메라 실측과 지도 시뮬레이션 합계</span>
        </header>
        <div className="stats">
          {stat("speeding", "제한속도 초과")}
          {stat("conflict", "보행자 쪽으로 차량 접근")}
          {stat("parking", "차 뒤에 아이가 가려져요")}
          {stat("rightturn", "도는 차 앞에 보행자")}
          {stat("crossing", "횡단 구역에 들어온 사람")}
        </div>
        <div className="effect">
          <div>
            <span className="eyebrow">경고 후 감속</span>
            <b>{rate === null ? "-" : `${Math.round(rate * 100)}%`}</b>
          </div>
          <p className="muted">
            {rate === null
              ? "과속 차량이 생기면 전광판 경고 뒤 속도를 줄였는지 집계해요."
              : `과속 차량 ${zone.warned}대 중 ${zone.slowed}대가 경고를 보고 제한속도 아래로 줄였어요. 지자체 성과 보고의 핵심 지표예요.`}
          </p>
        </div>
        <div className="effect">
          <div>
            <span className="eyebrow">우회전 일시정지</span>
            <b>{rtRate === null ? "-" : `${Math.round(rtRate * 100)}%`}</b>
          </div>
          <p className="muted">
            {rtRate === null
              ? "보행자가 있을 때 우회전하려는 차가 생기면, 알리미를 보고 멈췄는지 집계해요."
              : `보행자가 있는데 우회전하려던 차량 ${zone.rtWarned}대 중 ${zone.rtYielded}대가 횡단보도 앞에서 멈췄어요.`}
          </p>
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>시간대별 위험</h2>
          <span className="muted">과속·충돌 위험·주정차 · 노란 밑줄이 등하교 시간</span>
        </header>
        <div className="hours" role="img" aria-label="시간대별 위험 건수">
          {zone.hourly.map((n, h) => {
            const school = isSchoolHour(h);
            return (
              <div key={h} className={`hour${school ? " school" : ""}${h === nowH ? " now" : ""}`} title={`${h}시 ${n}건`}>
                <i style={{ height: `${(n / peak) * 100}%` }} />
                {h % 3 === 0 && <span>{h}</span>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>실시간 알림</h2>
          <span className="muted">최근 {zone.events.length}건</span>
        </header>
        {zone.events.length === 0 ? (
          <p className="empty">아직 기록이 없어요. 카메라 앞을 지나가거나 잠시 기다리면 가상 차량 기록이 쌓여요.</p>
        ) : (
          <ul className="feed">
            {zone.events.slice(0, 12).map((e) => (
              <li key={e.id} className={`tone-${KIND_TONE[e.kind]}`}>
                <span className="feed-icon">
                  <Icon name={KIND_ICON[e.kind]} size={16} />
                </span>
                <div>
                  <b>{EVENT_LABEL[e.kind]}</b>
                  <p>{e.text}</p>
                </div>
                <span className="feed-meta">
                  {time(e.at)}
                  <em>{e.source === "camera" ? "카메라" : "시뮬레이션"}</em>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ClipsPanel recorder={recorder} />

      <div className="grid-2">
        <section className="card">
          <header className="card-head">
            <h2>통합관제센터 연동</h2>
            <span className={`pill ${ls.configured ? "tone-ok" : ls.configured === false ? "tone-warn" : ""}`}>
              {ls.configured === null ? "확인 중" : ls.configured ? "연결됨" : "주소 미설정"}
            </span>
          </header>
          <p className="muted">
            위험 사건을 표준 형식(JSON)으로 관제센터에 바로 보내요. 영상은 보내지 않고, 영상이 저장됐는지만 알려요.
          </p>
          <div className="kv-row">
            <span>보낸 사건 <b>{ls.sent}건</b></span>
            <span>실패 <b className={ls.failed ? "bad-text" : ""}>{ls.failed}건</b></span>
            <span>마지막 전송 <b>{ls.lastAt ? new Date(ls.lastAt).toLocaleTimeString("ko-KR") : "-"}</b></span>
          </div>
          {ls.lastError && <p className="bad-text small">{ls.lastError}</p>}
          {ls.configured === false && (
            <p className="muted small">서버 환경변수 CONTROL_CENTER_WEBHOOK_URL에 관제센터 주소를 넣으면 전송이 시작돼요. 형식은 docs/integration.md를 보세요.</p>
          )}
          <label className="field check">
            <input
              type="checkbox"
              checked={ls.enabled}
              onChange={(e) => {
                ls.enabled = e.target.checked;
                onChange();
              }}
            />
            <span>사건 자동 전송</span>
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={ls.includeSim}
              onChange={(e) => {
                ls.includeSim = e.target.checked;
                onChange();
              }}
            />
            <span>시뮬레이션 사건도 보내기 (연동 시험용)</span>
          </label>
          <button className="btn small" onClick={() => void link.test().then(onChange)}>
            시험 메시지 보내기
          </button>
        </section>

        <section className="card">
          <header className="card-head">
            <h2>전광판 장비</h2>
            <span className={`pill ${vmsDevices.some((d) => d.online) ? "tone-ok" : ""}`}>
              {vmsDevices.filter((d) => d.online).length}대 연결
            </span>
          </header>
          <p className="muted">전광판 문구는 실제 장비(MQTT)와 화면 전광판으로 동시에 나가요. 태블릿이나 모니터를 현장 전광판처럼 쓸 수 있어요.</p>
          <div className="row-btns">
            <a className="btn small" href="/vms" target="_blank" rel="noreferrer">
              <Icon name="monitor" size={16} /> 보호구역 전광판 열기
            </a>
            <a className="btn small" href="/vms?id=rt" target="_blank" rel="noreferrer">
              <Icon name="turn" size={16} /> 우회전 알리미 열기
            </a>
          </div>
          {vmsDevices.length > 0 && (
            <ul className="bullets">
              {vmsDevices.map((d) => (
                <li key={d.id}>
                  {d.id} · <span className={d.online ? "ok" : "bad-text"}>{d.online ? "켜짐" : "꺼짐"}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            {mqttOn
              ? "MQTT 연결됨: 문구를 streetlight/vms/<장비>/set 으로 보내는 중이에요."
              : "실제 장비는 시설 점검 → 실제 장비 연결에서 MQTT 브로커에 연결하면 받아요 (device/vms_agent.py)."}
          </p>
        </section>
      </div>

      <details className="card settings">
        <summary>
          <h2>현장 설정</h2>
          <Icon name="chevron" size={18} />
        </summary>
        <label className="field">
          <span>
            카메라 화면이 비추는 도로 폭 <b>{s.frameWidthM}m</b>
          </span>
          <input
            type="range"
            min={2}
            max={40}
            value={s.frameWidthM}
            onChange={(e) => {
              s.frameWidthM = Number(e.target.value);
              onChange();
            }}
          />
          <small>차량 속도는 화면 속 이동 거리를 이 폭으로 환산한 추정값이에요. 책상 시연은 3m, 도로 설치는 실제 폭을 넣으세요.</small>
        </label>
        <label className="field">
          <span>
            시야 가림 정차 기준 <b>{s.parkingSec}초</b>
          </span>
          <input
            type="range"
            min={5}
            max={120}
            step={5}
            value={s.parkingSec}
            onChange={(e) => {
              s.parkingSec = Number(e.target.value);
              onChange();
            }}
          />
        </label>
        <label className="field check">
          <input
            type="checkbox"
            checked={s.privacy}
            onChange={(e) => {
              s.privacy = e.target.checked;
              onChange();
            }}
          />
          <span>개인정보 가림: 카메라 화면에서 사람 얼굴·차량 번호판 부분을 모자이크</span>
        </label>
        <label className="field check">
          <input
            type="checkbox"
            checked={s.voice}
            onChange={(e) => {
              s.voice = e.target.checked;
              onChange();
            }}
          />
          <span>음성 안내: 위험할 때 "멈추세요", "속도를 줄이세요"를 소리로 알림</span>
        </label>
        <label className="field check">
          <input
            type="checkbox"
            checked={s.nightRelax}
            onChange={(e) => {
              s.nightRelax = e.target.checked;
              onChange();
            }}
          />
          <span>야간 탄력 속도제한 (21시~7시 제한속도 50km/h로 운영하는 구역)</span>
        </label>
      </details>
    </div>
  );
}
