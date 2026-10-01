"use client";

import { useRef, useState, type ReactNode } from "react";

type Props = { buildInput: () => unknown };

// LLM이 돌려주는 마크다운 중 제목·목록·표·굵게만 간단히 그린다.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}

export function renderMarkdown(md: string) {
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <table key={`t${i}`}>
          <thead>
            <tr>{head?.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, k) => (
              <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^#{1,3} /.test(line)) out.push(<h3 key={i}>{inline(line.replace(/^#+ /, ""))}</h3>);
    else if (/^[-*] /.test(line)) out.push(<li key={i}>{inline(line.slice(2))}</li>);
    else if (line) out.push(<p key={i}>{inline(line)}</p>);
    i++;
  }
  return out;
}

export default function ReportPanel({ buildInput }: Props) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const [model, setModel] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  async function generate() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setText("");
    setState("streaming");
    const t0 = performance.now();
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildInput()),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        setText(await res.text());
        setState("error");
        return;
      }
      setModel(`${res.headers.get("X-Model") ?? ""} · ${res.headers.get("X-Provider") === "gemini" ? "Gemini 무료 API" : "로컬 실행 · 무료"}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setText((t) => t + decoder.decode(value, { stream: true }));
        setElapsed((performance.now() - t0) / 1000);
      }
      setState("done");
    } catch (e) {
      if (ac.signal.aborted) return;
      setText(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  return (
    <section className="card report">
      <header className="card-head">
        <h2>오늘의 점검 보고서</h2>
        <span className="muted">
          {model || "무료 LLM (로컬 Ollama 또는 Gemini)"}
          {state !== "idle" && ` · ${elapsed.toFixed(1)}초`}
        </span>
      </header>
      <button className="btn primary" onClick={generate} disabled={state === "streaming"}>
        {state === "streaming" ? "작성 중…" : state === "idle" ? "지금 상태로 보고서 만들기" : "다시 만들기"}
      </button>
      <div className={`report-body ${state === "error" ? "error" : ""}`}>
        {text ? renderMarkdown(text) : state === "idle" && <p className="muted">가로등 상태, 어린이보호구역 기록, 에너지 절약, 내일 태양광 예보를 모아 AI가 담당자용 보고서를 써 줘요.</p>}
        {state === "streaming" && <span className="cursor" />}
      </div>
    </section>
  );
}
