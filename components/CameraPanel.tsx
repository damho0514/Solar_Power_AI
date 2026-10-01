"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Icon from "@/components/Icon";
import { LABELS, createEngine, type Engine } from "@/lib/detectors";
import { GestureController, createHandEngine, type HandEngine, type Mode, type Point, type View } from "@/lib/gesture";
import { handBus, useHandState } from "@/lib/handBus";
import { MapGestureController, modeText, type MapMode } from "@/lib/mapGesture";
import type { ClipRecorder } from "@/lib/clips";
import { mask } from "@/lib/privacy";
import { openCamera, type Facing, type Ptz } from "@/lib/ptz";
import { CAM_HOME_POS, MAP_W, zoneFor } from "@/lib/sim";
import { Tracker, isMoving, predict, type Detection, type Track } from "@/lib/tracker";

// 속도 표시용 가정: 웹캠 화면 가로 폭이 실제 3m를 비춘다.
export const FRAME_WIDTH_M = 3;
export const speedKmh = (t: Track) => Math.abs(t.vx) * FRAME_WIDTH_M * 3.6;

export type CameraFrame = { active: Track[]; born: Track[]; lost: Track[]; now: number };
export type CameraStatus = "off" | "loading" | "running" | "error";
type Props = {
  onFrame: (f: CameraFrame) => void;
  onView?: (v: View) => void; // 손동작으로 바뀐 카메라 시점 (지도 위 카메라 구간 위치)
  onStatus?: (s: CameraStatus) => void;
  tools?: ReactNode; // 창 크기 버튼 등 카메라 창이 붙이는 버튼
  privacy?: boolean; // 얼굴·번호판 부분 모자이크
  compact?: boolean; // 작은 창: 카메라 전환·끄기 버튼은 숨기고 창 버튼만
  recorder?: ClipRecorder; // 사건 영상 저장
};

// 처음 자리: 지도의 원래 카메라 구간
const HOME: View = { x: CAM_HOME_POS, y: 0, zoom: 1 };

const MODE_TEXT: Record<Mode, string> = {
  none: "손을 보여 주면 카메라 구간을 옮길 수 있어요",
  follow: "🖐 손을 따라 이동 중",
  stop: "✊ 멈춤",
  "reset-hold": "✌️ 원래 자리로…",
};

// 마우스가 있는 기기(노트북)는 바로 켜고 앞면 카메라·손동작을 쓴다.
// 휴대폰은 권한 창이 갑자기 뜨지 않게 버튼으로 켜고, 도로를 비추도록 뒷면 카메라를 쓴다.
const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;

const sameView = (a: View, b: View) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

export default function CameraPanel({ onFrame, onView, onStatus, tools, privacy = true, compact, recorder }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const trackerRef = useRef(new Tracker());
  const onFrameRef = useRef(onFrame);
  const onViewRef = useRef(onView);
  const [status, setStatus] = useState<CameraStatus>("off");
  const [facing, setFacing] = useState<Facing>("user");
  const facingRef = useRef<Facing>("user");
  const [help, setHelp] = useState(false);
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
  // 손동작 대상이 "지도"이면 지도 뷰어(3D·로드뷰·2D)를 조작한다
  const mapCtrlRef = useRef(new MapGestureController());
  const [mapMode, setMapMode] = useState<MapMode>("none");
  const [snapPending, setSnapPending] = useState(0);
  const { target: handTarget, road } = useHandState();
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);

  onFrameRef.current = onFrame;
  onViewRef.current = onView;
  const privacyRef = useRef(privacy);
  privacyRef.current = privacy;
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const mirror = facing === "user"; // 앞면 카메라만 거울처럼 보여 준다

  useEffect(() => onStatus?.(status), [status, onStatus]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 900);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    ptzRef.current?.apply(view);
    onViewRef.current?.(view);
  }, [view]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const desktop = isDesktop();
    const f: Facing = desktop ? "user" : "environment";
    facingRef.current = f;
    setFacing(f);
    if (desktop) void start(f);
  }, []);

  function stopStream() {
    (videoRef.current?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function stop() {
    stopStream();
    setStatus("off");
  }

  function flip() {
    const f: Facing = facingRef.current === "user" ? "environment" : "user";
    facingRef.current = f;
    setFacing(f);
    void start(f);
  }

  async function start(f: Facing = facingRef.current) {
    stopStream();
    setStatus("loading");
    setLoadingMsg("카메라 연결 중…");
    try {
      const { stream, ptz } = await openCamera(f);
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
      // 손동작은 노트북 앞면 카메라 시연용. 휴대폰·뒷면 카메라에서는 불러오지 않아 배터리를 아낀다
      if (!handRef.current && handStatus !== "unavailable" && f === "user" && isDesktop()) {
        setLoadingMsg("손동작 AI 모델 불러오는 중…");
        try {
          handRef.current = await createHandEngine();
          setHandLabel(handRef.current.label);
          setHandStatus("ready");
          handBus.setStatus("ready");
        } catch (e) {
          // 손 제스처는 부가 기능이라 실패해도 카메라는 그대로 쓴다
          console.warn("손 제스처 사용 불가", e);
          setHandStatus("unavailable");
          handBus.setStatus("unavailable", e instanceof Error ? e.message : String(e));
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
        // 앞면 카메라는 화면을 거울처럼 보여 주므로 x를 뒤집어 저장한다
        const flipX = facingRef.current === "user";
        const dets: Detection[] = raw.map((d) => ({
          label: LABELS[d.name] ?? d.name,
          score: d.score,
          x: flipX ? (W - d.x - d.w) / W : d.x / W,
          y: d.y / H,
          w: d.w / W,
          h: d.h / H,
        }));
        const frame = trackerRef.current.update(dets, now);
        onFrameRef.current({ ...frame, now });
        draw(canvas, W, H, frame.active, privacyRef.current ? { video, flipX } : null);
        recorderRef.current?.capture({ video, flipX }, frame.active, now);

        // 인식은 항상 전체 프레임에서 하므로 디지털 확대 중에도 화면 밖의 손을 알아본다
        const hand = handRef.current;
        const control = controlRef.current;
        if (hand && control && flipX) {
          const hands = await hand.detect(video, now);
          if (stopped) return;
          if (handBus.get().target === "map") {
            const step = mapCtrlRef.current.update(hands, now);
            handBus.publish(step);
            setMapMode(step.mode);
            setSnapPending(step.snap?.pending ?? 0);
            if (step.toast) setToast({ text: step.toast, id: now });
          } else {
            const step = control.update(hands[0] ?? null, now, viewRef.current);
            if (!sameView(step.view, viewRef.current)) {
              viewRef.current = step.view;
              setView(step.view);
            }
            setMode(step.mode);
            if (step.toast) setToast({ text: step.toast, id: now });
            if (miniRef.current) drawMini(miniRef.current, step.view, step.palm, step.hold);
          }
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
      handBus.setStatus("off");
    };
  }, []);

  // 대상을 바꾸면 이전 대상의 손동작 상태를 버린다
  useEffect(() => {
    mapCtrlRef.current.reset();
    setMapMode("none");
    setMode("none");
  }, [handTarget]);

  const gestures = status === "running" && handStatus === "ready" && mirror;
  return (
    <div className="cam">
      <div className={`cam-stage-wrap${mirror ? " mirror" : ""}`}>
        <div className="camera-stage" style={{ transform: stageTransform(view, ptz) }}>
          <video ref={videoRef} muted playsInline />
          <canvas ref={canvasRef} />
        </div>
        {gestures && (
          <>
            {handTarget === "map" ? (
              <span className={`camera-hud${mapMode === "none" ? "" : " on"}`}>{modeText(mapMode, road, snapPending)}</span>
            ) : (
              <>
                <span className={`camera-hud${mode === "none" ? "" : " on"}`}>{MODE_TEXT[mode]}</span>
                <canvas ref={miniRef} className="camera-mini" width={96} height={72} aria-hidden />
              </>
            )}
            {toast && (
              <div key={toast.id} className="camera-toast">
                {toast.text}
              </div>
            )}
          </>
        )}
        {status !== "running" && (
          <div className="camera-overlay">
            {status === "off" && (
              <>
                <Icon name="camera" size={32} />
                <p>현장 카메라를 켜면 AI가 사람과 차를 알아봐요</p>
                <button className="btn primary" onClick={() => start()}>
                  카메라 켜기
                </button>
                <p className="hint">{facing === "environment" ? "휴대폰 뒷면 카메라로 도로를 비춰 주세요" : "노트북 웹캠 앞을 지나가 보세요"}</p>
              </>
            )}
            {status === "loading" && (
              <>
                <span className="spinner" aria-hidden />
                <p>{loadingMsg}</p>
              </>
            )}
            {status === "error" && (
              <>
                <p>카메라를 켜지 못했어요</p>
                <p className="hint">{error}</p>
                <p className="hint">주소창 옆 카메라 아이콘에서 권한을 허용한 뒤 다시 시도하세요.</p>
                <button className="btn primary" onClick={() => start()}>
                  다시 시도
                </button>
              </>
            )}
          </div>
        )}
        {help && gestures && (
          <div className="camera-help" onClick={() => setHelp(false)}>
            {handTarget === "map" ? (
              <>
                <p><b>🖐 손 펴고 움직이기</b> 지도를 돌려요 (2D는 이동)</p>
                <p><b>🤏 집고 끌기</b> 지도를 잡고 옮겨요 (로드뷰는 걷기)</p>
                <p><b>🤏🤏 두 손 집고 벌리기</b> 확대 · 모으면 축소 · 비틀면 회전</p>
                <p><b>👍 / 👎</b> 확대 / 축소</p>
                <p><b>✊ 주먹</b> 멈춤 (손을 옮긴 뒤 다시 펴면 이어서)</p>
                <p><b>✌️ 1초 유지</b> 처음 시점으로</p>
              </>
            ) : (
              <>
                <p><b>🖐 손 펴고 좌우로</b> 지도의 카메라 구간이 손을 따라가요{ptz ? " (카메라도 실제로 회전)" : ""}</p>
                <p><b>✊ 주먹</b> 그 자리에 멈춰요</p>
                <p><b>✌️ 1초 유지</b> 원래 자리로 돌아가요</p>
              </>
            )}
            <div className="seg-mini inline" role="radiogroup" aria-label="손동작 대상" onClick={(e) => e.stopPropagation()}>
              <button role="radio" aria-checked={handTarget === "map"} className={handTarget === "map" ? "on" : ""} onClick={() => handBus.setTarget("map")}>
                지도 조작
              </button>
              <button role="radio" aria-checked={handTarget === "camera"} className={handTarget === "camera" ? "on" : ""} onClick={() => handBus.setTarget("camera")}>
                카메라 구간
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="cam-bar">
        <span className={`cam-live${status === "running" ? " on" : ""}`}>
          {status === "running" ? (compact ? "AI 분석 중" : `AI 분석 중 · ${fps}fps`) : status === "loading" ? "연결 중" : "꺼짐"}
        </span>
        {status === "running" && recorder?.recording && <span className="cam-rec">녹화</span>}
        {status === "running" && engineInfo.label && (
          <span className="cam-engine" title={engineInfo.skipped.length ? "GPU를 쓸 수 없어 CPU로 실행 중. 크롬 설정에서 그래픽 가속을 켜면 빨라져요." : undefined}>
            {engineInfo.label}
          </span>
        )}
        <span className="cam-spacer" />
        {gestures && !compact && (
          <button className="icon-btn" onClick={() => setHelp((h) => !h)} aria-label="손동작 도움말" title="손동작 도움말">
            <Icon name="info" size={18} />
          </button>
        )}
        {!compact && (
          <button className="icon-btn" onClick={flip} aria-label="앞·뒤 카메라 바꾸기" title="앞·뒤 카메라 바꾸기">
            <Icon name="flip" size={18} />
          </button>
        )}
        {status !== "off" && !compact && (
          <button className="icon-btn" onClick={stop} aria-label="카메라 끄기" title="카메라 끄기">
            <Icon name="cameraOff" size={18} />
          </button>
        )}
        {tools}
      </div>
    </div>
  );
}

function draw(canvas: HTMLCanvasElement, W: number, H: number, tracks: Track[], privacy: { video: HTMLVideoElement; flipX: boolean } | null) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  if (privacy) for (const t of tracks) mask(ctx, W, H, t, privacy);
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
