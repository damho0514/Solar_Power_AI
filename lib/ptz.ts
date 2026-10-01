// 웹캠 열기 + 실제 카메라 각도 제어.
// 팬·틸트를 지원하는 PTZ 웹캠(크롬 등)이면 카메라 자체를 돌리고, 아니면 null을 돌려줘 디지털 시점을 쓰게 한다.
// 시점 x, y, zoom 의 뜻은 lib/gesture.ts 의 View 참고.

import { MAX_ZOOM, type View } from "@/lib/gesture";

type Range = { min: number; max: number };
type PtzCaps = { pan?: Range; tilt?: Range; zoom?: Range };

export type Ptz = {
  hasZoom: boolean;
  apply: (v: View) => void;
};

const SIZE = { width: 640, height: 480 };

// user = 앞면(노트북 웹캠·셀카), environment = 휴대폰 뒷면 카메라(도로를 비출 때)
export type Facing = "user" | "environment";

export async function openCamera(facing: Facing = "user"): Promise<{ stream: MediaStream; ptz: Ptz | null }> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("이 브라우저는 카메라를 지원하지 않아요. https 주소로 접속했는지 확인하세요.");
  const video = { ...SIZE, facingMode: { ideal: facing } };
  let stream: MediaStream;
  try {
    // pan/tilt/zoom 을 요청해야 크롬이 카메라 각도 제어 권한을 함께 묻는다
    stream = await navigator.mediaDevices.getUserMedia({
      video: { ...video, pan: true, tilt: true, zoom: true } as MediaTrackConstraints,
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ video });
  }
  const track = stream.getVideoTracks()[0];
  const caps = (track.getCapabilities?.() ?? {}) as PtzCaps;
  if (!caps.pan || !caps.tilt) return { stream, ptz: null };
  return { stream, ptz: hardware(track, caps) };
}

function hardware(track: MediaStreamTrack, caps: PtzCaps): Ptz {
  const lerp = (r: Range, t: number) => r.min + (r.max - r.min) * t; // t: 0~1
  let busy = false;
  let pending: View | null = null;

  const send = async (v: View) => {
    busy = true;
    // 화면은 거울 반전이라 화면 오른쪽 = 카메라 기준 왼쪽. 틸트는 위가 +
    const set: Record<string, number> = {
      pan: lerp(caps.pan!, (1 - v.x) / 2),
      tilt: lerp(caps.tilt!, (1 - v.y) / 2),
    };
    if (caps.zoom) set.zoom = lerp(caps.zoom, (v.zoom - 1) / (MAX_ZOOM - 1));
    try {
      await track.applyConstraints({ advanced: [set as MediaTrackConstraintSet] });
    } catch (e) {
      console.warn("카메라 각도 변경 실패", e);
    } finally {
      busy = false;
      // 모터가 움직이는 동안 쌓인 요청은 마지막 것만 보낸다
      if (pending) {
        const next = pending;
        pending = null;
        void send(next);
      }
    }
  };

  return {
    hasZoom: !!caps.zoom,
    apply: (v) => {
      if (busy) pending = v;
      else void send(v);
    },
  };
}
