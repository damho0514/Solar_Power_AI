// 3D 장면에 쓰는 텍스처를 캔버스로 그린다. 이미지 파일 없이 한글 노면 글자·창문·전광판을 만든다.

import * as THREE from "three";

const FONT = `"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, g: c.getContext("2d")! };
}

function tex(c: HTMLCanvasElement, repeat?: [number, number]) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

// 아스팔트: 짙은 회색 바탕에 잔 알갱이
export function asphalt(repeat: [number, number]) {
  const { c, g } = canvas(256, 256);
  g.fillStyle = "#2a2d33";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const v = 30 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 4},${0.25 + Math.random() * 0.4})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
  }
  return tex(c, repeat);
}

// 보도블록
export function pavers(repeat: [number, number]) {
  const { c, g } = canvas(128, 128);
  g.fillStyle = "#5d6168";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#474a50";
  g.lineWidth = 3;
  for (let y = 0; y <= 128; y += 32) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(128, y);
    g.stroke();
    for (let x = (y / 32) % 2 ? 0 : 32; x <= 128; x += 64) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + 32);
      g.stroke();
    }
  }
  return tex(c, repeat);
}

// 건물 외벽 + 창문. 같은 그림을 발광 맵으로도 써서 켜진 창만 밤에 빛나게 한다.
export function facade(cols: number, rows: number, tint = "#1b2232", seed = 1) {
  const W = cols * 24;
  const H = rows * 32;
  const base = canvas(W, H);
  const glow = canvas(W, H);
  base.g.fillStyle = tint;
  base.g.fillRect(0, 0, W, H);
  glow.g.fillStyle = "#000";
  glow.g.fillRect(0, 0, W, H);
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < cols; k++) {
      const x = k * 24 + 5;
      const y = r * 32 + 7;
      const lit = rnd() < 0.28;
      const warm = rnd() < 0.7;
      base.g.fillStyle = lit ? (warm ? "#f4d79b" : "#bcd7ff") : "#0d121c";
      base.g.fillRect(x, y, 14, 18);
      if (lit) {
        glow.g.fillStyle = warm ? "#ffcf7a" : "#9fc4ff";
        glow.g.fillRect(x, y, 14, 18);
      }
    }
  return { map: tex(base.c), emissive: tex(glow.c) };
}

// 노면 표시: 흰 글씨 (투명 바탕)
export function roadText(text: string, w = 512, h = 128, color = "#f4f4f2") {
  const { c, g } = canvas(w, h);
  g.fillStyle = color;
  g.font = `900 ${h * 0.72}px ${FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2 + 4);
  return tex(c);
}

// 노면 제한속도 표시: 흰 원 안에 숫자
export function speedMark(limit: number) {
  const { c, g } = canvas(256, 256);
  g.strokeStyle = "#f4f4f2";
  g.lineWidth = 20;
  g.beginPath();
  g.arc(128, 128, 110, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "#f4f4f2";
  g.font = `900 130px ${FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(limit), 128, 136);
  return tex(c);
}

// 가로등 불빛이 바닥에 번지는 동그란 빛
export function glowDisc() {
  const { c, g } = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,225,170,1)");
  grd.addColorStop(0.35, "rgba(255,205,140,0.45)");
  grd.addColorStop(1, "rgba(255,190,120,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return tex(c);
}

// 간판·현수막 (색 바탕 + 글씨)
export function signboard(text: string, bg: string, fg: string, w = 512, h = 128) {
  const { c, g } = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = `800 ${h * 0.5}px ${FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2 + 3);
  return tex(c);
}

const VMS_COLOR: Record<string, string> = { idle: "#ffd84d", child: "#7ee787", slow: "#ff9f43", danger: "#ff5a5a" };

// 전광판 LED 면: 검은 바탕에 점 무늬, 큰 글씨 + 작은 글씨. 같은 캔버스를 다시 그려 문구를 바꾼다.
export class VmsFace {
  readonly texture: THREE.CanvasTexture;
  private c: HTMLCanvasElement;
  private key = "";

  constructor(w = 512, h = 256) {
    this.c = canvas(w, h).c;
    this.texture = tex(this.c);
  }

  draw(level: string, text: string, sub: string) {
    const key = `${level}|${text}|${sub}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.c.getContext("2d")!;
    const { width: W, height: H } = this.c;
    g.fillStyle = "#050505";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(255,255,255,0.05)";
    for (let y = 0; y < H; y += 6) for (let x = 0; x < W; x += 6) g.fillRect(x, y, 2, 2);
    g.strokeStyle = level === "danger" ? "#ef4444" : "#ffc400";
    g.lineWidth = 12;
    g.strokeRect(6, 6, W - 12, H - 12);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = VMS_COLOR[level] ?? "#ffd84d";
    g.shadowColor = g.fillStyle;
    g.shadowBlur = 18;
    let size = 92;
    g.font = `900 ${size}px ${FONT}`;
    while (g.measureText(text).width > W - 50 && size > 40) g.font = `900 ${(size -= 6)}px ${FONT}`;
    g.fillText(text, W / 2, H * 0.42);
    g.shadowBlur = 0;
    g.fillStyle = "#fde68a";
    g.font = `700 34px ${FONT}`;
    g.fillText(sub, W / 2, H * 0.78);
    this.texture.needsUpdate = true;
  }
}

// 3D 이름표: 둥근 알약 모양 바탕 + 글씨. 화면 크기가 일정한 스프라이트로 쓴다.
const TAG_STYLE: Record<string, { bg: string; fg: string; border: string }> = {
  base: { bg: "rgba(10,15,26,0.86)", fg: "#e8edf6", border: "rgba(255,255,255,0.18)" },
  ai: { bg: "rgba(8,24,32,0.88)", fg: "#a5f3fc", border: "#22d3ee" },
  bad: { bg: "rgba(127,29,29,0.9)", fg: "#fecaca", border: "#ef4444" },
  ghost: { bg: "rgba(10,15,26,0.7)", fg: "#94a3b8", border: "#64748b" },
  sign: { bg: "rgba(255,196,0,0.95)", fg: "#1a1300", border: "rgba(0,0,0,0)" },
};

export function tagTexture(text: string, style: keyof typeof TAG_STYLE = "base") {
  const st = TAG_STYLE[style];
  const H = 64;
  const probe = canvas(8, 8).g;
  probe.font = `700 30px ${FONT}`;
  const tw = probe.measureText(text).width;
  const dot = style === "ai" ? 22 : 0;
  const W = Math.ceil(tw + 36 + dot);
  const { c, g } = canvas(W, H);
  const r = 18;
  g.beginPath();
  g.roundRect(2, 2, W - 4, H - 4, r);
  g.fillStyle = st.bg;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = st.border;
  g.stroke();
  if (dot) {
    g.fillStyle = "#22d3ee";
    g.beginPath();
    g.arc(26, H / 2, 6, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = st.fg;
  g.font = `700 30px ${FONT}`;
  g.textBaseline = "middle";
  g.fillText(text, 18 + dot, H / 2 + 1);
  const t = tex(c);
  return { texture: t, aspect: W / H };
}

// 가로등 빛 원뿔용 세로 그러데이션: 위(등) 쪽이 밝고 땅으로 갈수록 사라진다
export function beamGradient() {
  const { c, g } = canvas(4, 128);
  const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.5, "rgba(120,120,120,1)");
  grd.addColorStop(1, "rgba(0,0,0,1)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 128);
  return tex(c);
}
