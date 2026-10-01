// 사건 영상 저장. 카메라 화면을 초당 몇 장씩 작게 떠서 최근 몇 초를 늘 들고 있다가,
// 사건(과속·충돌 위험·불법 주정차·우회전 위험)이 생기면 사건 전후를 묶어 브라우저 저장소(IndexedDB)에 보관한다.
// - 개인정보: 저장하는 영상에는 화면 설정과 상관없이 얼굴·번호판 모자이크를 항상 입힌다. 원본은 저장하지 않는다.
// - 보관 기간: retentionDays가 지난 영상은 자동으로 지운다.
// 브라우저 저장소는 이 기기에만 남는다. 관제센터로는 사건 정보만 보내고, 영상은 요청이 있을 때 내려받아 전달한다.

import { mask, type MaskSource } from "@/lib/privacy";
import type { EventKind, ZoneEvent } from "@/lib/schoolzone";
import type { Track } from "@/lib/tracker";

export type ClipMeta = { id: string; at: number; kind: EventKind; text: string; fps: number; frames: number; thumb: Blob };
type ClipRow = ClipMeta & { data: Blob[] };

const W = 320;
const H = 240;
const DB = "damo";
const STORE = "clips";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" }).createIndex("at", "at");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const DAYS_KEY = "damo.clipDays";
function savedDays() {
  try {
    const d = Number(localStorage.getItem(DAYS_KEY));
    return [1, 3, 7, 30].includes(d) ? d : 7;
  } catch {
    return 7;
  }
}

export class ClipRecorder {
  fps = 6;
  preSec = 4;
  postSec = 4;
  retentionDays = typeof window === "undefined" ? 7 : savedDays();

  setRetention(days: number) {
    this.retentionDays = days;
    try {
      localStorage.setItem(DAYS_KEY, String(days));
    } catch {}
    return this.purge();
  }
  saved = 0;
  error = "";

  private canvas: HTMLCanvasElement | null = null;
  private last = 0;
  private ring: Blob[] = [];
  private pending: { meta: Omit<ClipMeta, "thumb" | "frames">; frames: Blob[]; left: number; thumb: Blob | null }[] = [];
  private listeners = new Set<() => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  get recording() {
    return this.pending.length > 0;
  }

  // 카메라 루프에서 매 프레임 부른다. fps에 맞춰 한 장씩만 뜬다.
  capture(src: MaskSource, tracks: Track[], now: number) {
    if (now - this.last < 1000 / this.fps || src.video.readyState < 2) return;
    this.last = now;
    this.canvas ??= Object.assign(document.createElement("canvas"), { width: W, height: H });
    const ctx = this.canvas.getContext("2d")!;
    ctx.save();
    if (src.flipX) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(src.video, 0, 0, W, H);
    ctx.restore();
    for (const t of tracks) {
      mask(ctx, W, H, t, src);
      ctx.strokeStyle = t.kind === "person" ? "#ffd166" : "#79c0ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(t.box.x * W, t.box.y * H, t.box.w * W, t.box.h * H);
    }
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, H - 18, W, 18);
    ctx.fillStyle = "#fff";
    ctx.font = "11px sans-serif";
    ctx.fillText(new Date().toLocaleString("ko-KR"), 6, H - 5);
    this.canvas.toBlob(
      (b) => {
        if (!b) return;
        this.ring.push(b);
        if (this.ring.length > this.preSec * this.fps) this.ring.shift();
        for (const p of this.pending) {
          p.frames.push(b);
          p.thumb ??= b;
          p.left--;
        }
        const done = this.pending.filter((p) => p.left <= 0);
        this.pending = this.pending.filter((p) => p.left > 0);
        for (const p of done) void this.save(p);
      },
      "image/jpeg",
      0.7,
    );
  }

  // 사건 발생: 지금까지의 몇 초 + 앞으로 몇 초를 묶는다. 같은 때 겹친 사건은 하나로 합친다.
  trigger(e: ZoneEvent) {
    const open = this.pending.find((p) => p.left > this.postSec * this.fps * 0.5);
    if (open) {
      open.meta.text += ` / ${e.text}`;
      return;
    }
    this.pending.push({
      meta: { id: `${e.at}-${e.id}`, at: e.at, kind: e.kind, text: e.text, fps: this.fps },
      frames: [...this.ring],
      left: this.postSec * this.fps,
      thumb: null,
    });
    this.emit();
  }

  private async save(p: (typeof this.pending)[number]) {
    try {
      const row: ClipRow = { ...p.meta, frames: p.frames.length, thumb: p.thumb ?? p.frames[0], data: p.frames };
      await tx("readwrite", (s) => s.put(row));
      this.saved++;
      this.error = "";
    } catch (e) {
      this.error = `영상을 저장하지 못했어요: ${e instanceof Error ? e.message : e}`;
    }
    this.emit();
  }

  async list(): Promise<ClipMeta[]> {
    try {
      const rows = (await tx("readonly", (s) => s.getAll())) as ClipRow[];
      return rows.map(({ data: _data, ...m }) => m).sort((a, b) => b.at - a.at);
    } catch {
      return [];
    }
  }

  async frames(id: string): Promise<Blob[]> {
    const row = (await tx("readonly", (s) => s.get(id))) as ClipRow | undefined;
    return row?.data ?? [];
  }

  async remove(id: string) {
    await tx("readwrite", (s) => s.delete(id));
    this.emit();
  }

  // 보관 기간이 지난 영상 지우기
  async purge() {
    const cut = Date.now() - this.retentionDays * 86_400_000;
    const old = (await this.list()).filter((c) => c.at < cut);
    for (const c of old) await tx("readwrite", (s) => s.delete(c.id));
    if (old.length) this.emit();
    return old.length;
  }
}

// 저장된 장면들을 동영상 파일로 만든다 (브라우저 MediaRecorder). 재생 속도대로 그리므로 영상 길이만큼 걸린다.
export async function encodeVideo(frames: Blob[], fps: number): Promise<{ blob: Blob; ext: string }> {
  const type = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error("이 브라우저는 동영상 만들기를 지원하지 않아요.");
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = canvas.getContext("2d")!;
  const rec = new MediaRecorder(canvas.captureStream(fps), { mimeType: type });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  const images = await Promise.all(frames.map((b) => createImageBitmap(b)));
  ctx.drawImage(images[0], 0, 0);
  rec.start();
  for (const img of images) {
    ctx.drawImage(img, 0, 0);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  await stopped;
  return { blob: new Blob(chunks, { type }), ext: type.includes("mp4") ? "mp4" : "webm" };
}
