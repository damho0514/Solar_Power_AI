"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { encodeVideo, type ClipMeta, type ClipRecorder } from "@/lib/clips";
import { EVENT_LABEL } from "@/lib/schoolzone";

const when = (t: number) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// 저장된 장면을 fps대로 넘겨 보여 준다
function Player({ recorder, clip, onClose }: { recorder: ClipRecorder; clip: ClipMeta; onClose: () => void }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let made: string[] = [];
    void recorder.frames(clip.id).then((fs) => {
      made = fs.map((b) => URL.createObjectURL(b));
      setUrls(made);
    });
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [recorder, clip.id]);

  useEffect(() => {
    if (!urls.length) return;
    const id = setInterval(() => setI((n) => (n + 1) % urls.length), 1000 / clip.fps);
    return () => clearInterval(id);
  }, [urls, clip.fps]);

  async function download() {
    setBusy(true);
    setErr("");
    try {
      const { blob, ext } = await encodeVideo(await recorder.frames(clip.id), clip.fps);
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `damo-${clip.kind}-${clip.id}.${ext}` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal aria-label="사건 영상" onClick={onClose}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <header className="card-head">
          <h2>{EVENT_LABEL[clip.kind]}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="player">{urls[i] ? <img src={urls[i]} alt="" /> : <span className="spinner" />}</div>
        <p className="muted">
          {when(clip.at)} · {clip.text} · {(clip.frames / clip.fps).toFixed(0)}초
        </p>
        {err && <p className="bad-text">{err}</p>}
        <div className="row-btns">
          <button className="btn primary" onClick={download} disabled={busy}>
            {busy ? "동영상 만드는 중…" : "동영상으로 내려받기"}
          </button>
          <button
            className="btn"
            onClick={() => {
              void recorder.remove(clip.id);
              onClose();
            }}
          >
            삭제
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ClipsPanel({ recorder }: { recorder: ClipRecorder }) {
  const [clips, setClips] = useState<ClipMeta[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<ClipMeta | null>(null);
  const [days, setDays] = useState(recorder.retentionDays);
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;

  useEffect(() => {
    const load = async () => {
      const list = await recorder.list();
      setClips(list);
      setThumbs((old) => {
        const next: Record<string, string> = {};
        for (const c of list) next[c.id] = old[c.id] ?? URL.createObjectURL(c.thumb);
        for (const [id, u] of Object.entries(old)) if (!next[id]) URL.revokeObjectURL(u);
        return next;
      });
    };
    void recorder.purge().then(load);
    const off = recorder.onChange(() => void load());
    return () => {
      off();
      Object.values(thumbsRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [recorder]);

  return (
    <section className="card">
      <header className="card-head">
        <h2>사건 영상</h2>
        <span className="muted">카메라가 위험을 잡으면 앞뒤 {recorder.preSec + recorder.postSec}초를 자동 저장</span>
      </header>
      {recorder.error && <p className="bad-text">{recorder.error}</p>}
      {clips.length === 0 ? (
        <p className="empty">아직 저장된 영상이 없어요. 카메라 앞에서 과속·충돌 위험·주정차·우회전 위험이 잡히면 여기에 쌓여요.</p>
      ) : (
        <ul className="clips">
          {clips.map((c) => (
            <li key={c.id}>
              <button onClick={() => setOpen(c)}>
                {thumbs[c.id] && <img src={thumbs[c.id]} alt="" />}
                <span className="clip-kind">{EVENT_LABEL[c.kind]}</span>
                <span className="clip-time">{when(c.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="clip-foot">
        <label>
          보관 기간
          <select
            className="input"
            value={days}
            onChange={(e) => {
              const d = Number(e.target.value);
              setDays(d);
              void recorder.setRetention(d);
            }}
          >
            {[1, 3, 7, 30].map((d) => (
              <option key={d} value={d}>
                {d}일
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">영상은 이 기기 브라우저에만 저장되고, 얼굴·번호판은 항상 모자이크돼요. 기간이 지나면 자동으로 지워요.</p>
      </div>
      {open && <Player recorder={recorder} clip={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
