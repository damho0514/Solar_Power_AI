"use client";

export type DeviceView = {
  state: "off" | "connecting" | "connected" | "reconnecting" | "closed";
  error: string;
  lamps: { id: string; online: boolean; ageSec: number | null; brightness: number; sentBrightness: number | null }[];
  cameras: { id: string; online: boolean; fps: number; lastCount: number }[];
};

type Props = { url: string; setUrl: (u: string) => void; view: DeviceView; onToggle: () => void };

const STATE_LABEL: Record<DeviceView["state"], string> = {
  off: "연결 안 함 (시뮬레이터만)",
  connecting: "연결 중…",
  connected: "연결됨",
  reconnecting: "다시 연결 중…",
  closed: "연결 끊김",
};

export default function DevicePanel({ url, setUrl, view, onToggle }: Props) {
  const on = view.state !== "off";
  return (
    <div className="device">
      <header className="card-head">
        <h3>MQTT 브로커</h3>
        <span className={`muted ${view.state === "connected" ? "ok" : ""}`}>{STATE_LABEL[view.state]}</span>
      </header>
      <div className="device-row">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} disabled={on} aria-label="브로커 주소" />
        <button className={`btn ${on ? "" : "primary"}`} onClick={onToggle}>
          {on ? "끊기" : "연결"}
        </button>
      </div>
      {view.error && <p className="report-body error">{view.error}</p>}
      {on && view.lamps.length === 0 && view.cameras.length === 0 && (
        <p className="muted">아직 들어온 장비가 없어요. device/sensor_agent.py 또는 edge_camera.py를 실행하세요.</p>
      )}
      {(view.lamps.length > 0 || view.cameras.length > 0) && (
        <table className="table">
          <thead>
            <tr>
              <th>기기</th>
              <th>상태</th>
              <th>마지막 값</th>
              <th>밝기 (실제 / 명령)</th>
            </tr>
          </thead>
          <tbody>
            {view.lamps.map((l) => (
              <tr key={l.id}>
                <td>📡 {l.id}</td>
                <td className={l.online ? "ok" : "bad-text"}>{l.online ? "온라인" : "오프라인"}</td>
                <td>{l.ageSec === null ? "-" : `${l.ageSec.toFixed(0)}초 전`}</td>
                <td>
                  {Math.round(l.brightness * 100)}% / {l.sentBrightness === null ? "-" : `${Math.round(l.sentBrightness * 100)}%`}
                </td>
              </tr>
            ))}
            {view.cameras.map((c) => (
              <tr key={c.id}>
                <td>📷 {c.id}</td>
                <td className={c.online ? "ok" : "bad-text"}>{c.online ? "온라인" : "오프라인"}</td>
                <td>{c.fps.toFixed(1)} fps</td>
                <td>인식 {c.lastCount}건</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">실제 장비 값이 들어온 가로등은 가상 데이터 대신 실제 측정값으로 고장을 판정하고, AI가 정한 밝기를 장비에 명령으로 보내요. 휴대폰·배포 사이트(https)에서는 보안 정책상 로컬 브로커(ws://)에 연결할 수 없어요.</p>
    </div>
  );
}
