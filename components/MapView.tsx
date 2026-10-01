"use client";

// 관제 지도: 3D 장면 ↔ 2D 평면 지도. 선택은 이 기기에 기억한다.
// 3D 코드(three.js)는 처음 3D를 볼 때만 내려받고, WebGL이 안 되는 기기는 2D로 보여 준다.

import dynamic from "next/dynamic";
import { useEffect, useState, type ComponentProps } from "react";
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

function webgl() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export default function MapView({ view, ...props }: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [can3d, setCan3d] = useState(true);

  useEffect(() => {
    const ok = webgl();
    setCan3d(ok);
    let saved: Mode | null = null;
    try {
      saved = localStorage.getItem(KEY) as Mode | null;
    } catch {}
    setMode(ok ? (saved ?? "3d") : "2d");
  }, []);

  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {}
  };

  return (
    <div className="mapview">
      <div className="seg-mini" role="radiogroup" aria-label="지도 보기 방식">
        <button role="radio" aria-checked={mode === "3d"} className={mode === "3d" ? "on" : ""} disabled={!can3d} onClick={() => choose("3d")}>
          3D
        </button>
        <button role="radio" aria-checked={mode === "2d"} className={mode === "2d" ? "on" : ""} onClick={() => choose("2d")}>
          2D
        </button>
      </div>
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
        <StreetMap {...props} />
      ) : (
        <div className="street3d loading3d" />
      )}
    </div>
  );
}
