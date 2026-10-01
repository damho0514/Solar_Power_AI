"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SitingInput, SitingResult } from "@/app/api/siting/route";
import Icon from "@/components/Icon";
import { renderMarkdown } from "@/components/ReportPanel";
import { JIMOK_LIST, LEVEL_LABEL, TARGET_LABEL, ZONE_LIST, assess, type Distances, type Setback } from "@/lib/siting";

// 직접 입력할 때 고를 수 있는 주요 구역 (토지이용계획확인서에서 확인)
const AREA_OPTIONS = [
  "농업진흥구역", "농업보호구역", "개발제한구역", "공익용산지", "임업용산지", "준보전산지",
  "상수원보호구역", "자연취락지구", "문화유산보호구역", "군사기지 및 군사시설 보호구역", "백두대간보호지역", "경관지구",
];

const fmtDate = (d: string) => (d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : d);

export default function SitingPage() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [address, setAddress] = useState("");
  const [jimok, setJimok] = useState("전");
  const [zone, setZone] = useState("계획관리지역");
  const [areas, setAreas] = useState<string[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [data, setData] = useState<SitingResult | null>(null);
  const [distances, setDistances] = useState<Distances>({});

  const [report, setReport] = useState("");
  const [reportState, setReportState] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const [model, setModel] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/siting")
      .then((r) => r.json() as Promise<{ vworld: boolean }>)
      .then((r) => {
        setHasKey(r.vworld);
        if (!r.vworld) setMode("manual");
      })
      .catch(() => setHasKey(false));
  }, []);

  const result = useMemo(() => (data ? assess(data.land, data.setbacks, data.slopes, distances) : null), [data, distances]);
  // 대상별로 가장 엄격한 기준만 거리 입력칸으로 보여 준다
  const targets = useMemo(() => {
    const m = new Map<Setback["target"], Setback[]>();
    for (const s of data?.setbacks ?? []) m.set(s.target, [...(m.get(s.target) ?? []), s]);
    return [...m.entries()].map(([t, list]) => ({ target: t, list: list.sort((a, b) => b.meters - a.meters) }));
  }, [data]);

  async function analyze() {
    if (!address.trim()) return;
    abortRef.current?.abort();
    setState("loading");
    setError("");
    setData(null);
    setDistances({});
    setReport("");
    setReportState("idle");
    const body: SitingInput =
      mode === "auto" ? { address } : { manual: { address, jimok, zones: [zone], areas } };
    try {
      const res = await fetch("/api/siting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      setData((await res.json()) as SitingResult);
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  async function writeReport() {
    if (!data || !result) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setReport("");
    setReportState("streaming");
    try {
      const res = await fetch("/api/siting/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ land: data.land, level: result.level, findings: result.findings, permits: result.permits, setbacks: data.setbacks, articles: data.articles, distances }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        setReport(await res.text());
        setReportState("error");
        return;
      }
      setModel(`${res.headers.get("X-Model") ?? ""} · ${res.headers.get("X-Provider") === "gemini" ? "Gemini 무료 API" : "로컬 실행 · 무료"}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setReport((t) => t + decoder.decode(value, { stream: true }));
      }
      setReportState("done");
    } catch (e) {
      if (ac.signal.aborted) return;
      setReport(e instanceof Error ? e.message : String(e));
      setReportState("error");
    }
  }

  const land = data?.land;

  return (
    <main className="siting page">
      <header className="page-bar">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden>
            <Icon name="lamp" size={18} />
          </span>
          <span className="brand-name">
            DAMO<small>안심 가로등</small>
          </span>
        </Link>
        <Link className="btn small" href="/#report">
          관제 화면으로
        </Link>
      </header>
      <div className="page-title">
        <h1>태양광 설치 검토</h1>
        <p>주소를 넣으면 땅의 종류(지목)와 용도지역을 확인하고, 그 지역 조례를 적용해 태양광을 설치할 수 있는지 알려 줘요.</p>
      </div>

      <section className="card">
        <header className="card-head">
          <h2>설치할 땅</h2>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={mode === "auto"} className={mode === "auto" ? "on" : ""} disabled={hasKey === false} onClick={() => setMode("auto")}>
              주소로 자동 조회
            </button>
            <button role="tab" aria-selected={mode === "manual"} className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>
              직접 입력
            </button>
          </div>
        </header>
        {hasKey === false && (
          <p className="muted">
            지금은 주소 자동 조회가 꺼져 있어요. 토지이음(eum.go.kr)의 토지이용계획확인서를 보고 땅 종류와 용도지역을 골라 주세요. 지자체 조례는 주소로 자동으로 찾아요.
          </p>
        )}
        <form
          className="siting-form"
          onSubmit={(e) => {
            e.preventDefault();
            analyze();
          }}
        >
          <input
            className="input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={mode === "auto" ? "예: 경상북도 영양군 영양읍 동부리 123" : "시·도와 시·군·구부터 (예: 경상북도 영양군 영양읍)"}
            aria-label="주소"
          />
          {mode === "manual" && (
            <>
              <label>
                지목 (땅 종류)
                <select className="input" value={jimok} onChange={(e) => setJimok(e.target.value)}>
                  {JIMOK_LIST.map((j) => (
                    <option key={j}>{j}</option>
                  ))}
                </select>
              </label>
              <label>
                용도지역
                <select className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
                  {ZONE_LIST.map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button className="btn primary" disabled={state === "loading" || !address.trim()}>
            {state === "loading" ? "확인 중…" : "설치 가능성 확인"}
          </button>
        </form>
        {mode === "manual" && (
          <div className="chips" aria-label="해당 구역">
            {AREA_OPTIONS.map((a) => (
              <label key={a} className={areas.includes(a) ? "on" : ""}>
                <input
                  type="checkbox"
                  checked={areas.includes(a)}
                  onChange={(e) => setAreas((xs) => (e.target.checked ? [...xs, a] : xs.filter((x) => x !== a)))}
                />
                {a}
              </label>
            ))}
          </div>
        )}
        {state === "error" && <p className="bad-text">{error}</p>}
      </section>

      {data && land && result && (
        <div className="siting-grid">
          <section className="card">
            <header className="card-head">
              <h2>땅 정보</h2>
              <span className="muted">{land.source === "vworld" ? "브이월드 토지이용계획·토지특성" : "직접 입력"}</span>
            </header>
            <table className="kv">
              <tbody>
                <tr><th>주소</th><td>{land.address}</td></tr>
                <tr><th>관할</th><td>{`${land.sido} ${land.sigungu}`.trim()}</td></tr>
                {land.pnu && <tr><th>PNU</th><td>{land.pnu}</td></tr>}
                <tr><th>지목</th><td><b>{land.jimok || "모름"}</b></td></tr>
                <tr><th>용도지역</th><td><b>{land.zones.join(", ") || "모름"}</b></td></tr>
                <tr><th>그 밖의 구역</th><td>{land.areas.join(", ") || "없음"}</td></tr>
                {land.areaM2 !== null && <tr><th>면적</th><td>{land.areaM2.toLocaleString()}㎡</td></tr>}
                {land.terrain && <tr><th>지형</th><td>{land.terrain}</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="card">
            <header className="card-head">
              <h2>설치 가능성</h2>
              <span className={`level ${result.level}`}>{LEVEL_LABEL[result.level]}</span>
            </header>
            <ul className="findings">
              {result.findings.map((f, i) => (
                <li key={i}>
                  <span className={`level small ${f.level}`}>{LEVEL_LABEL[f.level]}</span>
                  <div>
                    <b>{f.topic}</b>
                    <p>{f.reason}</p>
                    <p className="muted">근거: {f.basis}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="muted">가장 까다로운 항목 기준으로 판정해요. 사전 검토용이라 실제 허가 결과와 다를 수 있어요.</p>
            <h3>필요 인허가</h3>
            <ol className="permits">
              {result.permits.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>
          </section>

          <section className="card wide">
            <header className="card-head">
              <h2>지자체 조례 거리 기준</h2>
              <span className="muted">조례 조문에서 자동 추출 · 대상별 가장 엄격한 기준과 비교 · 거리를 넣으면 판정에 반영</span>
            </header>
            {targets.length === 0 && data.slopes.length === 0 ? (
              <p className="muted">
                관련 조례에서 이격거리 기준을 찾지 못했습니다. 기준이 없거나 폐지됐을 수 있으니 아래 조문을 확인하세요.
              </p>
            ) : (
              <table className="setbacks">
                <thead>
                  <tr>
                    <th>대상</th>
                    <th>기준</th>
                    <th>조례 내용</th>
                    <th>부지까지 거리</th>
                  </tr>
                </thead>
                <tbody>
                  {targets.map(({ target, list }) => (
                    <tr key={target}>
                      <td>{TARGET_LABEL[target]}</td>
                      <td>
                        <b>{list[0].meters.toLocaleString()}m</b>
                        {list.length > 1 && <span className="muted"> 외 {list.slice(1).map((s) => `${s.meters}m`).join(", ")}</span>}
                      </td>
                      <td>
                        <p>{list[0].text}</p>
                        <p className="muted">{list[0].article}</p>
                      </td>
                      <td>
                        {target === "other" ? (
                          <span className="muted">조문 확인</span>
                        ) : (
                          <input
                            className="input num"
                            type="number"
                            min={0}
                            inputMode="numeric"
                            placeholder="m"
                            value={distances[target] ?? ""}
                            onChange={(e) =>
                              setDistances((d) => ({ ...d, [target]: e.target.value === "" ? undefined : Number(e.target.value) }))
                            }
                            aria-label={`${TARGET_LABEL[target]}까지 거리`}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.slopes.slice(0, 1).map((s) => (
                    <tr key="slope">
                      <td>경사도</td>
                      <td><b>{s.degrees}° 이하</b></td>
                      <td>
                        <p>{s.text}</p>
                        <p className="muted">{s.article}</p>
                      </td>
                      <td><span className="muted">현장 측량</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card wide">
            <header className="card-head">
              <h2>적용한 조례</h2>
              <span className="muted">법제처 국가법령정보 · 태양광·발전시설 조문 {data.articles.length}개</span>
            </header>
            {data.warnings.map((w) => (
              <p key={w} className="bad-text">{w}</p>
            ))}
            <ul className="ordinances">
              {data.ordinances.map((o) => (
                <li key={o.id}>
                  <a href={o.url} target="_blank" rel="noreferrer">{o.name}</a>
                  <span className="muted"> · {o.org} · 시행 {fmtDate(o.enforced)} · 관련 조문 {o.articles}개</span>
                </li>
              ))}
            </ul>
            {data.articles.map((a, i) => (
              <details key={i} className="article">
                <summary>
                  {a.ordinance} · {a.title || "(제목 없음)"}
                </summary>
                <p>{a.content}</p>
              </details>
            ))}
          </section>

          <section className="card wide report">
            <header className="card-head">
              <h2>AI 검토 의견</h2>
              <span className="muted">{model || "무료 LLM (로컬 Ollama 또는 Gemini)"}</span>
            </header>
            <button className="btn primary" onClick={writeReport} disabled={reportState === "streaming"}>
              {reportState === "streaming" ? "작성 중…" : reportState === "idle" ? "조례 조문을 읽고 의견서 작성" : "다시 작성"}
            </button>
            <div className={`report-body ${reportState === "error" ? "error" : ""}`}>
              {report
                ? renderMarkdown(report)
                : reportState === "idle" && <p className="muted">토지 정보, 판정 결과, 조례 조문을 무료 LLM에 넘겨 예외 조항과 인허가 절차를 정리합니다.</p>}
              {reportState === "streaming" && <span className="cursor" />}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
