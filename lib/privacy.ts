// 개인정보 가림(비식별). 카메라 화면과 저장하는 사건 영상에 같이 쓴다.
// 사람은 머리 부분(박스 위쪽 30%), 차는 번호판 높이(아래쪽 30%)를 굵은 모자이크로 덮는다.

import type { Track } from "@/lib/tracker";

export type MaskSource = { video: HTMLVideoElement; flipX: boolean };

let mosaic: HTMLCanvasElement | null = null; // 서버 렌더링 때는 document가 없으므로 처음 쓸 때 만든다

// ctx는 W×H 크기로 그리는 캔버스. flipX면 화면이 거울 반전돼 있어 원본에서는 좌우 반대 위치를 떠 온다.
export function mask(ctx: CanvasRenderingContext2D, W: number, H: number, t: Track, src: MaskSource) {
  const b = t.box;
  const part = t.kind === "person" ? { y: b.y, h: b.h * 0.3 } : { y: b.y + b.h * 0.7, h: b.h * 0.3 };
  const dx = b.x * W, dy = part.y * H, dw = b.w * W, dh = part.h * H;
  if (dw < 2 || dh < 2) return;
  const vw = src.video.videoWidth, vh = src.video.videoHeight;
  const sx = ((src.flipX ? W - dx - dw : dx) / W) * vw;
  const cols = Math.max(2, Math.round(dw / 14));
  const rows = Math.max(2, Math.round(dh / 14));
  mosaic ??= document.createElement("canvas");
  mosaic.width = cols;
  mosaic.height = rows;
  mosaic.getContext("2d")!.drawImage(src.video, sx, (dy / H) * vh, (dw / W) * vw, (dh / H) * vh, 0, 0, cols, rows);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (src.flipX) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(mosaic, 0, 0, dw, dh);
  } else ctx.drawImage(mosaic, dx, dy, dw, dh);
  ctx.restore();
}
