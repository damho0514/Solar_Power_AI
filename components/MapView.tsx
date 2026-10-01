"use client";

// 관제 지도: 3D 장면 ↔ 2D 평면 지도. 선택은 이 기기에 기억한다.
// 3D 코드(three.js)는 처음 3D를 볼 때만 내려받고, WebGL이 안 되는 기기는 2D로 보여 준다.

import dynamic from "next/dynamic";
import { useEffect, useState, type ComponentProps } from "react";
import GestureHud from "@/components/GestureHud";
import Icon from "@/components/Icon";
import StreetMap from "@/components/StreetMap";
import type { Preset } from "@/components/Street3D";
import type { MapTarget } from "@/lib/predictive";

const Street3D = dynamic(() => import("@/components/Street3D"), {
  ssr: false,
  loading: () => (
    <div className="street3d loading3d">
      <span className="spinner" />
      <p>3D 도로를 불러오는 중…</p>
    </div>
  ),
});

type Props = ComponentProps<typeof StreetMap> & { targets: MapTarget[]; view?: Preset };
type Mode = "3d" | "2d";
const KEY = "damo.mapMode";

// 3D(three.js)는 WebGL2가 필요하다. 안 되면 이유를 구분해 안내한다.
function webglSupport(): "ok" | "webgl1" | "none" {
  try {
    const c = document.createElement("canvas");
    if (c.getContext("webgl2")) return "ok";
    return c.getContext("webgl") ? "webgl1" : "none";
  } catch {
    return "none";
  }
}

export default function MapView({ view, ...props }: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [support, setSupport] = useState<"ok" | "webgl1" | "none">("ok");
  const can3d = support === "ok";

  useEffect(() => {
    const sup = webglSupport();
    setSupport(sup);
    const ok = sup === "ok";
    let saved: Mode | null = null;
    try {
      saved = localStorage.getItem(KEY) as Mode | null;
    } catch {}
    setMode(ok ? (saved ?? "3d") : "2d");
  }, []);

  // 전체 화면: 지도가 화면을 꽉 채우고, 떠 있는 웹캠 창은 그 위에 남는다 (로드뷰 + 웹캠만 보기)
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.requestFullscreen?.().catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    // 브라우저 전체 화면을 Esc로 빠져나오면 지도도 원래대로
    const onFs = () => !document.fullscreenElement && setFull(false);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [full]);

  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {}
  };

  return (
    <div className={`mapview${full ? " mapview-full" : ""}`}>
      <button className="map-full-btn" onClick={() => setFull((f) => !f)} aria-label={full ? "전체 화면 끝내기" : "지도 전체 화면"} title={full ? "전체 화면 끝내기 (Esc)" : "지도 전체 화면"}>
        <Icon name={full ? "shrink" : "expand"} size={16} />
      </button>
      <div className="seg-mini" role="radiogroup" aria-label="지도 보기 방식">
        <button
          role="radio"
          aria-checked={mode === "3d"}
          className={mode === "3d" ? "on" : ""}
          disabled={!can3d}
          title={can3d ? undefined : "이 브라우저에서는 3D를 쓸 수 없어요"}
          onClick={() => choose("3d")}
        >
          3D
        </button>
        <button role="radio" aria-checked={mode === "2d"} className={mode === "2d" ? "on" : ""} onClick={() => choose("2d")}>
          2D
        </button>
      </div>
      {!can3d && (
        <div className="no3d" role="note">
          <b>3D를 쓸 수 없어 2D로 보여 드려요</b>
          <p>
            {support === "none"
              ? "이 브라우저의 그래픽 가속(WebGL)이 꺼져 있어요. 크롬이면 설정 → 시스템 → '가능한 경우 그래픽 가속 사용'을 켜고 브라우저를 다시 시작하세요. chrome://gpu 에서 WebGL2가 'Hardware accelerated'인지 확인할 수 있어요."
              : "이 기기의 그래픽(WebGL1)이 오래돼 3D(WebGL2)를 지원하지 않아요. 최신 크롬·엣지·사파리에서 열어 보세요."}
          </p>
          <p>VS Code 안의 미리보기 창은 그래픽 가속이 막혀 있을 수 있어요. 일반 브라우저 창에서 열어 주세요.</p>
          <button className="btn small" onClick={() => location.reload()}>
            설정을 바꿨다면 다시 확인
          </button>
        </div>
      )}
      {mode === "3d" ? (
        <Street3D
          lamps={props.lamps}
          walkers={props.walkers}
          targets={props.targets}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          alert={props.alert}
          sign={props.sign}
          rtSign={props.rtSign}
          limit={props.limit}
          view={view}
        />
      ) : mode === "2d" ? (
        <>
          <StreetMap {...props} />
          {!props.compact && <GestureHud />}
        </>
      ) : (
        <div className="street3d loading3d" />
      )}
    </div>
  );
}
