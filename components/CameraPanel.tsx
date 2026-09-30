"use client";

import { useEffect, useRef, useState } from "react";
import { LABELS, createEngine, type Engine } from "@/lib/detectors";
import { GestureController, createHandEngine, type HandEngine, type Mode, type Point, type View } from "@/lib/gesture";
import { openCamera, type Ptz } from "@/lib/ptz";
import { CAM_HOME_POS, MAP_W, zoneFor } from "@/lib/sim";
import { Tracker, isMoving, predict, type Detection, type Track } from "@/lib/tracker";

// 속도 표시용 가정: 웹캠 화면 가로 폭이 실제 3m를 비춘다.
export const FRAME_WIDTH_M = 3;
export const speedKmh = (t: Track) => Math.abs(t.vx) * FRAME_WIDTH_M * 3.6;

export type CameraFrame = { active: Track[]; born: Track[]; lost: Track[]; now: number };
type Props = {
  onFrame: (f: CameraFrame) => void;
  onView?: (v: View) => void; // 손동작으로 바뀐 카메라 시점 (지도 위 카메라 구간 위치)
};

// 처음 자리: 지도의 원래 카메라 구간
const HOME: View = { x: CAM_HOME_POS, y: 0, zoom: 1 };

const MODE_TEXT: Record<Mode, string> = {
  none: "손을 카메라에 보여 주세요",
  follow: "🖐 손 따라 이동 중",
  stop: "✊ 정지",
  "reset-hold": "✌️ 원래 자리로…",
};

const sameView = (a: View, b: View) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

export default function CameraPanel({ onFrame, onView }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const trackerRef = useRef(new Tracker());
  const onFrameRef = useRef(onFrame);
  const onViewRef = useRef(onView);
  const [status, setStatus] = useState<"loading" | "running" | "error">("loading");
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [fps, setFps] = useState(0);
  const [engineInfo, setEngineInfo] = useState({ label: "", skipped: [] as string[] });

  // 손동작으로 조종하는 카메라 시점. PTZ 웹캠이면 실제 각도를, 아니면 디지털 확대·이동을 바꾼다
  const miniRef = useRef<HTMLCanvasElement>(null);
  const handRef = useRef<HandEngine | null>(null);
  const controlRef = useRef<GestureController | null>(null);
  const ptzRef = useRef<Ptz | null>(null);
  const startedRef = useRef(false);
  const [handStatus, setHandStatus] = useState<"off" | "ready" | "unavailable">("off");
  const [handLabel, setHandLabel] = useState("");
  const [ptz, setPtz] = useState<Ptz | null>(null);
  const [view, setView] = useState<View>(HOME);
  const viewRef = useRef(view);
  const [mode, setMode] = useState<Mode>("none");
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);

  onFrameRef.current = onFrame;
  onViewRef.current = onView;

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 900);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    ptzRef.current?.apply(view);
    onViewRef.current?.(view);
  }, [view]);

  // 클릭 없이 바로 켠다 (브라우저의 카메라 권한 요청만 한 번 뜬다)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, []);

  async function start() {
    setStatus("loading");
    setLoadingMsg("카메라 연결 중…");
    try {
      const { stream, ptz } = await openCamera();
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      ptzRef.current = ptz;
      setPtz(ptz);
      // 지도의 카메라는 가로 도로만 비추므로 좌우로만 옮긴다
      controlRef.current = new GestureController({ home: HOME, lockY: true });
      if (!engineRef.current) {
        const { engine, skipped } = await createEngine((label) => setLoadingMsg(`AI 모델 불러오는 중… (${label})`));
        engineRef.current = engine;
        setEngineInfo({ label: engine.label, skipped });
      }
      if (!handRef.current && handStatus !== "unavailable") {
        setLoadingMsg("손동작 AI 모델 불러오는 중…");
        try {
          handRef.current = await createHandEngine();
          setHandLabel(handRef.current.label);
          setHandStatus("ready");
        } catch (e) {
          // 손 제스처는 부가 기능이라 실패해도 카메라는 그대로 쓴다
          console.warn("손 제스처 사용 불가", e);
          setHandStatus("unavailable");
        }
      }
      setStatus("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  useEffect(() => {
    if (status !== "running") return;
    let raf = 0;
    let last = 0;
    let frames = 0;
    let fpsAt = performance.now();

    let busy = false;
    let stopped = false;

    const loop = async () => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (busy || !video || !canvas || !engine || video.readyState < 2) return;
      const now = performance.now();
      if (now - last < 66) return; // 최대 초당 15회. CPU 엔진은 처리 속도만큼만 돈다
      last = now;
      busy = true;
      try {
        const W = video.videoWidth;
        const H = video.videoHeight;
        const raw = await engine.detect(video, now);
        if (stopped) return;
        // 화면을 거울처럼 보여 주므로 x를 뒤집어 저장한다
        const dets: Detection[] = raw.map((d) => ({
          label: LABELS[d.name] ?? d.name,
          score: d.score,
          x: (W - d.x - d.w) / W,
          y: d.y / H,
          w: d.w / W,
          h: d.h / H,
        }));
        const frame = trackerRef.current.update(dets, now);
        onFrameRef.current({ ...frame, now });
        draw(canvas, W, H, frame.active);

        // 인식은 항상 전체 프레임에서 하므로 디지털 확대 중에도 화면 밖의 손을 알아본다
        const hand = handRef.current;
        const control = controlRef.current;
        if (hand && control) {
          const handFrame = await hand.detect(video, now);
          if (stopped) return;
          const step = control.update(handFrame, now, viewRef.current);
          if (!sameView(step.view, viewRef.current)) {
            viewRef.current = step.view;
            setView(step.view);
          }
          setMode(step.mode);
          if (step.toast) setToast({ text: step.toast, id: now });
          if (miniRef.current) drawMini(miniRef.current, step.view, step.palm, step.hold);
        }
        frames++;
      } catch (e) {
        console.warn("인식 실패", e);
      } finally {
        busy = false;
      }
      if (now - fpsAt > 1000) {
        setFps(frames);
        frames = 0;
        fpsAt = now;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [status]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      (video?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      engineRef.current?.close();
      handRef.current?.close();
    };
  }, []);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>① 가로등 카메라 (웹캠)</h2>
        {status === "running" && (
          <span className="muted">
            브라우저 내 AI 추론 · {engineInfo.label}
            {handLabel && ` · 손 인식 ${handLabel}`} · {fps} fps
          </span>
        )}
      </header>
      <div className="camera">
        <div className="camera-stage" style={{ transform: stageTransform(view, ptz) }}>
          <video ref={videoRef} muted playsInline />
          <canvas ref={canvasRef} />
        </div>
        {status === "running" && handStatus === "ready" && (
          <>
            <span className={`camera-hud${mode === "none" ? "" : " on"}`}>{MODE_TEXT[mode]}</span>
            <canvas ref={miniRef} className="camera-mini" width={96} height={72} aria-hidden />
            {toast && (
              <div key={toast.id} className="camera-toast">
                {toast.text}
              </div>
            )}
          </>
        )}
        {status !== "running" && (
          <div className="camera-overlay">
            {status === "loading" && <p>{loadingMsg}</p>}
            {status === "error" && (
              <>
                <p>카메라를 시작하지 못했습니다: {error}</p>
                <p>주소창 왼쪽의 카메라 아이콘에서 권한을 허용한 뒤 다시 시도하세요.</p>
                <button className="btn" onClick={start}>
                  다시 시도
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {status === "running" && handStatus === "ready" && (
        <ul className="camera-guide">
          <li>
            <b>🖐 손 펴고 좌우로 움직이기</b> 지도의 카메라 구간이 손을 실시간으로 따라 이동{ptz ? " (카메라도 실제로 회전)" : ""}
          </li>
          <li>
            <b>✊ 주먹 쥐기</b> 그 자리에서 정지. 다시 펴면 그 자리부터 이어서 이동
          </li>
          <li>
            <b>✌️ 1초 유지</b> 원래 자리
          </li>
        </ul>
      )}
      {status === "running" && handStatus === "unavailable" && (
        <p className="muted">이 브라우저에서는 손동작 AI를 불러오지 못했습니다.</p>
      )}
      {status === "running" && (
        <p className="muted">
          카메라 앞을 좌우로 걸어 보세요. 가는 방향의 가로등이 먼저 켜집니다.
          {engineInfo.skipped.length > 0 && ` (GPU를 쓸 수 없어 CPU 엔진으로 실행 중. 크롬 설정에서 "그래픽 가속 사용"을 켜면 더 빨라집니다.)`}
        </p>
      )}
    </section>
  );
}

function draw(canvas: HTMLCanvasElement, W: number, H: number, tracks: Track[]) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  ctx.font = "bold 17px system-ui, sans-serif";
  ctx.lineCap = "round";

  for (const t of tracks) {
    const color = t.kind === "person" ? "#ffd166" : "#79c0ff";
    const x = t.box.x * W;
    const y = t.box.y * H;

    // 지나온 경로
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 3;
    ctx.beginPath();
    t.trail.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, t.box.w * W, t.box.h * H);

    // 예측 경로: 0.5초 간격으로 3초까지
    if (isMoving(t)) {
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(t.cx * W, t.cy * H);
      const end = predict(t, 1.5);
      ctx.lineTo(end.x * W, t.cy * H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      for (let s = 0.5; s <= 1.5; s += 0.5) {
        const p = predict(t, s);
        ctx.beginPath();
        ctx.arc(p.x * W, t.cy * H, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const dir = !isMoving(t) ? "정지" : t.vx > 0 ? "→" : "←";
    const text = `#${t.id} ${t.label} ${dir} ${isMoving(t) ? `${speedKmh(t).toFixed(1)}km/h` : ""}`.trim();
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = color;
    ctx.fillRect(x - 1.5, y - 26, w, 26);
    ctx.fillStyle = "#101418";
    ctx.fillText(text, x + 5, y - 7);
  }
}

function stageTransform(v: View, ptz: Ptz | null) {
  // 광학 줌이 있는 PTZ 카메라는 카메라가 직접 확대하고, 아니면 화면을 가운데 기준으로 확대한다
  if (ptz?.hasZoom) return "none";
  return `translate(${50 * (1 - v.zoom)}%, ${50 * (1 - v.zoom)}%) scale(${v.zoom})`;
}

// 도로 전체 중 카메라 구간이 있는 곳과 손 위치를 보여 주는 작은 지도
function drawMini(canvas: HTMLCanvasElement, v: View, palm: Point | null, hold: number | null) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(16, 20, 24, 0.6)";
  ctx.fillRect(0, 0, W, H);

  // 가로 도로와 카메라 구간
  const roadY = H - 14;
  ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
  ctx.fillRect(4, roadY - 3, W - 8, 6);
  const z = zoneFor(v.x, v.zoom);
  const sx = (x: number) => 4 + (x / MAP_W) * (W - 8);
  ctx.strokeStyle = "#ffd166";
  ctx.lineWidth = 2;
  ctx.strokeRect(sx(z.x0), roadY - 8, sx(z.x1) - sx(z.x0), 16);

  if (!palm) return;
  ctx.fillStyle = "#7ee787";
  ctx.beginPath();
  ctx.arc(palm.x * W, palm.y * (roadY - 12), 4, 0, Math.PI * 2);
  ctx.fill();
  if (hold !== null) {
    ctx.strokeStyle = "#7ee787";
    ctx.beginPath();
    ctx.arc(palm.x * W, palm.y * (roadY - 12), 9, -Math.PI / 2, -Math.PI / 2 + hold * Math.PI * 2);
    ctx.stroke();
  }
}
