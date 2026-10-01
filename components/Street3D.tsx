"use client";

// 관제 지도의 3D 버전. 2D 지도(StreetMap)와 같은 시뮬레이션 상태를 그대로 그린다.
// 좌표: 지도 1px = 0.25m. 지도 중심이 원점, x 동쪽, z 남쪽(지도 y 아래), y 위.
// 성능: 가로등 44개는 InstancedMesh로 한 번에 그리고, 휴대폰에서는 그림자를 끈다.

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { Suspense, createContext, useContext, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import GestureHud from "@/components/GestureHud";
import { Person, type PersonState } from "@/components/three/people";
import { VmsFace, asphalt, beamGradient, facade, glowDisc, pavers, roadText, signboard, speedMark, tagTexture } from "@/components/three/textures";
import { buildVehicle, type Vehicle, type VehicleType } from "@/components/three/vehicles";
import { handBus } from "@/lib/handBus";
import type { MapAction } from "@/lib/mapGesture";
import { MACROS, type MacroTarget } from "@/lib/snap";
import type { MapTarget } from "@/lib/predictive";
import { RT, ZONE, inZone, simSpeedKmh, type Sign } from "@/lib/schoolzone";
import { MAP_H, MAP_W, ROAD_H_Y, ROAD_V_X, camZone, walkerXY, type Lamp, type Walker } from "@/lib/sim";

const S = 0.25;
const wx = (x: number) => (x - MAP_W / 2) * S;
const wz = (y: number) => (y - MAP_H / 2) * S;
const RX = wx(ROAD_V_X); // 세로 도로 중심 x
const HALF = 22 * S; // 도로 반폭 5.5m
const WALK = 7.6; // 도로 중심에서 인도 보행선까지
const LANE = 2.75;
const SPAN = { x0: wx(0), x1: wx(MAP_W), z0: wz(0), z1: wz(MAP_H) };
const WARM = new THREE.Color("#ffd49a");
// 여러 번 쓰는 형상은 한 번만 만든다
const HEAD_GEO = new RoundedBoxGeometry(0.8, 0.14, 0.36, 2, 0.05);
const CCTV_GEO = new RoundedBoxGeometry(0.34, 0.3, 0.7, 2, 0.06);

type Props = {
  lamps: Lamp[];
  walkers: Walker[];
  targets: MapTarget[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  alert: (l: Lamp) => "bad" | "warn" | null;
  sign?: Sign;
  rtSign?: Sign;
  limit?: number;
  view?: Preset;
};

export type Preset = "all" | "zone" | "cross" | "cam" | "road";
const PRESETS: Record<Preset, { label: string; pos: [number, number, number]; target: [number, number, number] }> = {
  all: { label: "전체", pos: [-24, 96, 62], target: [-4, 0, 4] },
  // 시점 카메라는 건물이 없는 도로 위에 둔다
  zone: { label: "스쿨존", pos: [-60, 13, 6], target: [-28, 0, 0] },
  cross: { label: "교차로", pos: [31, 19, 50], target: [29, 0, 6] },
  cam: { label: "카메라 구간", pos: [-38, 7, 9], target: [-24, 1, 0] },
  // 로드뷰: 스쿨존 서쪽 끝 차로 위 눈높이에서 동쪽(학교 쪽)을 본다
  road: { label: "로드뷰", pos: [wx(ZONE.x0) - 30, 1.6, 1.4], target: [wx(ZONE.x0) - 20, 1.6, 1.4] },
};

const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

// ---------- 정적 배경: 땅·도로·노면 표시·건물·학교·나무 ----------

function Ground() {
  const tex = useMemo(
    () => ({
      asphaltH: asphalt([40, 2]),
      asphaltV: asphalt([2, 24]),
      paverH: pavers([60, 2]),
      paverV: pavers([2, 30]),
      zoneText: roadText("어린이 보호구역"),
      speed: speedMark(30),
      slow: roadText("천천히"),
    }),
    [],
  );
  const W = SPAN.x1 - SPAN.x0;
  const D = SPAN.z1 - SPAN.z0;
  const zoneX0 = wx(ZONE.x0);
  const zoneX1 = wx(ZONE.x1);
  const cross = wx(ZONE.crossX);
  const rtZ = wz(RT.y);
  const flat = [-Math.PI / 2, 0, 0] as const;
  return (
    <group>
      {/* 땅 */}
      <mesh rotation={flat} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[W + 80, D + 80]} />
        <meshStandardMaterial color="#141a17" roughness={1} />
      </mesh>
      {/* 도로 */}
      <mesh rotation={flat} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[W, HALF * 2]} />
        <meshStandardMaterial map={tex.asphaltH} roughness={0.9} />
      </mesh>
      <mesh rotation={flat} position={[RX, 0.001, 0]} receiveShadow>
        <planeGeometry args={[HALF * 2, D]} />
        <meshStandardMaterial map={tex.asphaltV} roughness={0.9} />
      </mesh>
      {/* 스쿨존 붉은 노면 */}
      <mesh rotation={flat} position={[(zoneX0 + zoneX1) / 2, 0.006, 0]} receiveShadow>
        <planeGeometry args={[zoneX1 - zoneX0, HALF * 2 - 0.4]} />
        <meshStandardMaterial color="#9c2f2a" roughness={0.75} />
      </mesh>
      {/* 중앙 황색 복선, 가장자리 흰 실선 */}
      {[-0.13, 0.13].map((d) => (
        <group key={d}>
          <mesh rotation={flat} position={[(SPAN.x0 + RX - HALF) / 2, 0.01, d]}>
            <planeGeometry args={[RX - HALF - SPAN.x0, 0.12]} />
            <meshBasicMaterial color="#e7b416" />
          </mesh>
          <mesh rotation={flat} position={[(RX + HALF + SPAN.x1) / 2, 0.01, d]}>
            <planeGeometry args={[SPAN.x1 - RX - HALF, 0.12]} />
            <meshBasicMaterial color="#e7b416" />
          </mesh>
          <mesh rotation={flat} position={[RX + d, 0.011, (SPAN.z0 - HALF) / 2]}>
            <planeGeometry args={[0.12, -HALF - SPAN.z0]} />
            <meshBasicMaterial color="#e7b416" />
          </mesh>
          <mesh rotation={flat} position={[RX + d, 0.011, (SPAN.z1 + HALF) / 2]}>
            <planeGeometry args={[0.12, SPAN.z1 - HALF]} />
            <meshBasicMaterial color="#e7b416" />
          </mesh>
        </group>
      ))}
      {[-HALF + 0.3, HALF - 0.3].map((z) => (
        <mesh key={z} rotation={flat} position={[0, 0.01, z]}>
          <planeGeometry args={[W, 0.12]} />
          <meshBasicMaterial color="#cfd3d6" />
        </mesh>
      ))}
      {/* 횡단보도: 스쿨존(가로 도로), 교차로 남쪽(세로 도로) */}
      {Array.from({ length: 6 }, (_, i) => (
        <mesh key={`c${i}`} rotation={flat} position={[cross, 0.012, -HALF + 0.9 + i * 1.85]}>
          <planeGeometry args={[4, 0.9]} />
          <meshStandardMaterial color="#eef0f2" roughness={0.6} />
        </mesh>
      ))}
      {Array.from({ length: 6 }, (_, i) => (
        <mesh key={`r${i}`} rotation={flat} position={[RX - HALF + 0.9 + i * 1.85, 0.012, rtZ]}>
          <planeGeometry args={[0.9, 4]} />
          <meshStandardMaterial color="#eef0f2" roughness={0.6} />
        </mesh>
      ))}
      {/* 정지선 */}
      <mesh rotation={flat} position={[cross - 3.2, 0.012, LANE]}>
        <planeGeometry args={[0.4, HALF - 0.4]} />
        <meshBasicMaterial color="#eef0f2" />
      </mesh>
      <mesh rotation={flat} position={[cross + 3.2, 0.012, -LANE]}>
        <planeGeometry args={[0.4, HALF - 0.4]} />
        <meshBasicMaterial color="#eef0f2" />
      </mesh>
      {/* 노면 글자: 동쪽으로 오는 운전자가 읽는 방향 */}
      <group position={[zoneX0 + 12, 0.014, LANE]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh rotation={flat}>
          <planeGeometry args={[4.6, 1.15]} />
          <meshStandardMaterial map={tex.zoneText} transparent roughness={0.7} />
        </mesh>
      </group>
      <group position={[zoneX0 + 20, 0.014, LANE]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh rotation={flat}>
          <planeGeometry args={[3.2, 3.2]} />
          <meshStandardMaterial map={tex.speed} transparent roughness={0.7} />
        </mesh>
      </group>
      <group position={[zoneX1 - 12, 0.014, -LANE]} rotation={[0, Math.PI / 2, 0]}>
        <mesh rotation={flat}>
          <planeGeometry args={[4.6, 1.15]} />
          <meshStandardMaterial map={tex.zoneText} transparent roughness={0.7} />
        </mesh>
      </group>
      <group position={[zoneX1 - 20, 0.014, -LANE]} rotation={[0, Math.PI / 2, 0]}>
        <mesh rotation={flat}>
          <planeGeometry args={[3.2, 3.2]} />
          <meshStandardMaterial map={tex.speed} transparent roughness={0.7} />
        </mesh>
      </group>
      {/* 인도 (턱 높이 15cm) */}
      {[
        [SPAN.x0, RX - HALF, HALF, HALF + 5],
        [RX + HALF, SPAN.x1, HALF, HALF + 5],
        [SPAN.x0, RX - HALF, -HALF - 5, -HALF],
        [RX + HALF, SPAN.x1, -HALF - 5, -HALF],
      ].map(([a, b, c, d], i) => (
        <mesh key={`sh${i}`} position={[(a + b) / 2, 0.075, (c + d) / 2]} receiveShadow>
          <boxGeometry args={[b - a, 0.15, d - c]} />
          <meshStandardMaterial map={tex.paverH} roughness={0.85} />
        </mesh>
      ))}
      {[
        [RX - HALF - 5, RX - HALF, SPAN.z0, -HALF - 5],
        [RX + HALF, RX + HALF + 5, SPAN.z0, -HALF - 5],
        [RX - HALF - 5, RX - HALF, HALF + 5, SPAN.z1],
        [RX + HALF, RX + HALF + 5, HALF + 5, SPAN.z1],
      ].map(([a, b, c, d], i) => (
        <mesh key={`sv${i}`} position={[(a + b) / 2, 0.075, (c + d) / 2]} receiveShadow>
          <boxGeometry args={[b - a, 0.15, d - c]} />
          <meshStandardMaterial map={tex.paverV} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

// 결정적 난수 (매번 같은 도시 모양)
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
}

function City() {
  const blocks = useMemo(() => {
    const r = rng(7);
    const out: { x: number; z: number; w: number; d: number; h: number; tint: string; seed: number }[] = [];
    const school = { x0: wx(ZONE.crossX) - 20, x1: wx(ZONE.crossX) + 20 };
    const rows: [number, number, number, number][] = [
      [SPAN.x0 - 10, RX - HALF - 10, -HALF - 12, -1],
      [RX + HALF + 10, SPAN.x1 + 10, -HALF - 12, -1],
      [SPAN.x0 - 10, RX - HALF - 10, HALF + 12, 1],
      [RX + HALF + 10, SPAN.x1 + 10, HALF + 12, 1],
    ];
    const tints = ["#1d2433", "#232a38", "#2a2620", "#1f2a2c", "#262433"];
    for (const [a, b, z0, dir] of rows) {
      let x = a;
      while (x < b - 6) {
        const w = 9 + r() * 9;
        const d = 10 + r() * 8;
        const cx = x + w / 2;
        if (!(dir < 0 && cx > school.x0 && cx < school.x1)) {
          out.push({ x: cx, z: z0 + (dir * d) / 2, w, d, h: 5 + r() * 11, tint: tints[Math.floor(r() * tints.length)], seed: Math.floor(r() * 1000) });
        }
        x += w + 4 + r() * 5;
      }
    }
    // 세로 도로 양옆
    for (const side of [-1, 1])
      for (const [z0, z1] of [
        [SPAN.z0 - 10, -HALF - 14],
        [HALF + 14, SPAN.z1 + 10],
      ]) {
        let z = z0;
        while (z < z1 - 6) {
          const d = 9 + r() * 8;
          const w = 10 + r() * 6;
          out.push({ x: RX + side * (HALF + 12 + w / 2), z: z + d / 2, w, d, h: 5 + r() * 12, tint: tints[Math.floor(r() * tints.length)], seed: Math.floor(r() * 1000) });
          z += d + 4 + r() * 5;
        }
      }
    return out;
  }, []);

  return (
    <group>
      {blocks.map((b, i) => (
        <Building key={i} {...b} />
      ))}
      <School />
      <Trees />
    </group>
  );
}

function Building({ x, z, w, d, h, tint, seed }: { x: number; z: number; w: number; d: number; h: number; tint: string; seed: number }) {
  const mats = useMemo(() => {
    const side = facade(Math.max(2, Math.round(w / 2.4)), Math.max(2, Math.round(h / 3.2)), tint, seed);
    const end = facade(Math.max(2, Math.round(d / 2.4)), Math.max(2, Math.round(h / 3.2)), tint, seed + 3);
    const roof = new THREE.MeshStandardMaterial({ color: "#191d24", roughness: 0.9 });
    const m = (f: { map: THREE.Texture; emissive: THREE.Texture }) =>
      new THREE.MeshStandardMaterial({ map: f.map, emissiveMap: f.emissive, emissive: "#ffffff", emissiveIntensity: 0.55, roughness: 0.8 });
    return [m(end), m(end), roof, roof, m(side), m(side)];
  }, [w, d, h, tint, seed]);
  return (
    <mesh position={[x, h / 2, z]} material={mats} castShadow receiveShadow>
      <boxGeometry args={[w, h, d]} />
    </mesh>
  );
}

function School() {
  const x = wx(ZONE.crossX);
  const sign = useMemo(() => signboard("다모초등학교", "#1d4f2e", "#ffffff", 768, 128), []);
  const zoneSign = useMemo(() => signboard("어린이 보호구역", "#ffc400", "#14110a", 512, 128), []);
  const win = useMemo(() => facade(14, 3, "#c9b48f", 11), []);
  return (
    <group>
      <mesh position={[x, 6, -24]} castShadow receiveShadow>
        <boxGeometry args={[34, 12, 14]} />
        <meshStandardMaterial map={win.map} emissiveMap={win.emissive} emissive="#ffffff" emissiveIntensity={0.9} roughness={0.85} />
      </mesh>
      <mesh position={[x, 12.4, -24]} castShadow>
        <boxGeometry args={[35, 0.8, 15]} />
        <meshStandardMaterial color="#6b3b2a" roughness={0.8} />
      </mesh>
      <mesh position={[x, 9.2, -16.95]}>
        <planeGeometry args={[12, 2]} />
        <meshBasicMaterial map={sign} toneMapped={false} />
      </mesh>
      {/* 운동장 + 울타리 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.02, -13.5]} receiveShadow>
        <planeGeometry args={[36, 5.5]} />
        <meshStandardMaterial color="#6b5a43" roughness={1} />
      </mesh>
      {Array.from({ length: 25 }, (_, i) => (
        <mesh key={i} position={[x - 18 + i * 1.5, 0.75, -HALF - 5.1]}>
          <boxGeometry args={[0.06, 1.5, 0.06]} />
          <meshStandardMaterial color="#2f8f4e" />
        </mesh>
      ))}
      <mesh position={[x, 1.4, -HALF - 5.1]}>
        <boxGeometry args={[36, 0.07, 0.07]} />
        <meshStandardMaterial color="#2f8f4e" />
      </mesh>
      {/* 보호구역 시작 표지판 */}
      {[wx(ZONE.x0) + 1, wx(ZONE.x1) - 1].map((sx, i) => (
        <group key={i} position={[sx, 0, i ? -HALF - 1.2 : HALF + 1.2]}>
          <mesh position={[0, 1.4, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 2.8, 8]} />
            <meshStandardMaterial color="#9aa3ad" metalness={0.8} roughness={0.3} />
          </mesh>
          <mesh position={[0, 2.9, 0]} rotation={[0, i ? Math.PI / 2 : -Math.PI / 2, 0]}>
            <planeGeometry args={[1.8, 0.45]} />
            <meshBasicMaterial map={zoneSign} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Trees() {
  const spots = useMemo(() => {
    const out: [number, number][] = [];
    for (let x = SPAN.x0 + 6; x < SPAN.x1; x += 11) {
      if (Math.abs(x - RX) < HALF + 6) continue;
      out.push([x + 4, HALF + 3.9], [x - 2, -HALF - 3.9]);
    }
    return out;
  }, []);
  const trunk = useRef<THREE.InstancedMesh>(null);
  const crown = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const m = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      const s = 0.85 + ((i * 37) % 10) / 25;
      trunk.current!.setMatrixAt(i, m.compose(new THREE.Vector3(x, 1.4 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
      crown.current!.setMatrixAt(i, m.compose(new THREE.Vector3(x, 3.6 * s, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, i, 0)), new THREE.Vector3(s, s * 1.1, s)));
    });
    trunk.current!.instanceMatrix.needsUpdate = true;
    crown.current!.instanceMatrix.needsUpdate = true;
  }, [spots]);
  return (
    <group>
      <instancedMesh ref={trunk} args={[undefined, undefined, spots.length]} castShadow>
        <cylinderGeometry args={[0.12, 0.18, 2.8, 8]} />
        <meshStandardMaterial color="#3b2a1d" roughness={1} />
      </instancedMesh>
      <instancedMesh ref={crown} args={[undefined, undefined, spots.length]} castShadow>
        <icosahedronGeometry args={[1.6, 1]} />
        <meshStandardMaterial color="#1f3b25" roughness={0.9} flatShading />
      </instancedMesh>
    </group>
  );
}

// ---------- 가로등 ----------

function lampPose(l: Lamp) {
  const hRoad = Math.abs(Math.abs(l.y - ROAD_H_Y) - 34) < 1;
  const x = wx(l.x);
  const z = wz(l.y);
  // 팔은 도로 쪽으로
  const dir = hRoad ? new THREE.Vector3(0, 0, Math.sign(ROAD_H_Y - l.y)) : new THREE.Vector3(Math.sign(ROAD_V_X - l.x), 0, 0);
  return { x, z, dir };
}

const POLE_H = 8;
const ARM = 2.6;

function Lamps({ lamps, selectedId, onSelect, alert }: Pick<Props, "lamps" | "selectedId" | "onSelect" | "alert">) {
  const n = lamps.length;
  const poles = useRef<THREE.InstancedMesh>(null);
  const arms = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const cones = useRef<THREE.InstancedMesh>(null);
  const pools = useRef<THREE.InstancedMesh>(null);
  const orbs = useRef<THREE.InstancedMesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const disc = useMemo(() => glowDisc(), []);
  const grad = useMemo(() => beamGradient(), []);
  const poses = useMemo(() => lamps.map(lampPose), [lamps]);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    document.body.style.cursor = hover ? "pointer" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hover]);

  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const black = new THREE.Color(0, 0, 0);
    poses.forEach((p, i) => {
      poles.current!.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, POLE_H / 2, p.z), q, one));
      const yaw = Math.atan2(-p.dir.z, p.dir.x);
      const qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
      arms.current!.setMatrixAt(i, m.compose(new THREE.Vector3(p.x + p.dir.x * (ARM / 2), POLE_H - 0.15, p.z + p.dir.z * (ARM / 2)), qa, one));
      const hx = p.x + p.dir.x * ARM;
      const hz = p.z + p.dir.z * ARM;
      heads.current!.setMatrixAt(i, m.compose(new THREE.Vector3(hx, POLE_H - 0.28, hz), qa, one));
      cones.current!.setMatrixAt(i, m.compose(new THREE.Vector3(hx, (POLE_H - 0.4) / 2, hz), q, one));
      pools.current!.setMatrixAt(i, m.compose(new THREE.Vector3(hx, 0.03, hz), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), one));
      orbs.current!.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, POLE_H + 0.35, p.z), q, one));
      for (const r of [heads, cones, pools, orbs]) r.current!.setColorAt(i, black);
    });
    for (const r of [poles, arms, heads, cones, pools, orbs]) {
      r.current!.instanceMatrix.needsUpdate = true;
      if (r.current!.instanceColor) {
        r.current!.instanceColor.needsUpdate = true;
        // 개별 색은 첫 렌더 뒤에 생겼으므로 셰이더를 다시 만들게 한다
        (r.current!.material as THREE.Material).needsUpdate = true;
      }
    }
  }, [poses]);

  const c = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    lamps.forEach((l, i) => {
      const b = l.brightness;
      heads.current!.setColorAt(i, c.copy(WARM).multiplyScalar(0.25 + b * 2.6));
      cones.current!.setColorAt(i, c.copy(WARM).multiplyScalar(0.01 + b * 0.11));
      pools.current!.setColorAt(i, c.copy(WARM).multiplyScalar(0.05 + b * 0.75));
      const a = alert(l);
      const pulse = 0.6 + 0.4 * Math.sin(t * 5 + i);
      orbs.current!.setColorAt(i, a === "bad" ? c.set("#ff3b3b").multiplyScalar(2 * pulse) : a === "warn" ? c.set("#ffb020").multiplyScalar(1.6 * pulse) : c.set("#2bd46a").multiplyScalar(0.6));
    });
    for (const r of [heads, cones, pools, orbs]) r.current!.instanceColor!.needsUpdate = true;
    const sel = lamps.findIndex((l) => l.id === selectedId);
    if (ring.current) {
      ring.current.visible = sel >= 0;
      if (sel >= 0) {
        ring.current.position.set(poses[sel].x, 0.2, poses[sel].z);
        ring.current.scale.setScalar(1 + 0.08 * Math.sin(t * 4));
      }
    }
  });

  const click = (e: { instanceId?: number; stopPropagation: () => void }) => {
    e.stopPropagation();
    if (e.instanceId !== undefined) onSelect(lamps[e.instanceId].id);
  };
  const hoverOn = () => setHover(true);
  const hoverOff = () => setHover(false);

  return (
    <group>
      <instancedMesh ref={poles} args={[undefined, undefined, n]} castShadow onClick={click} onPointerOver={hoverOn} onPointerOut={hoverOff}>
        <cylinderGeometry args={[0.08, 0.13, POLE_H, 10]} />
        <meshStandardMaterial color="#6f7782" metalness={0.85} roughness={0.35} />
      </instancedMesh>
      <instancedMesh ref={arms} args={[undefined, undefined, n]} castShadow>
        <boxGeometry args={[ARM, 0.09, 0.09]} />
        <meshStandardMaterial color="#6f7782" metalness={0.85} roughness={0.35} />
      </instancedMesh>
      <instancedMesh ref={heads} args={[undefined, undefined, n]} onClick={click} onPointerOver={hoverOn} onPointerOut={hoverOff}>
        <primitive object={HEAD_GEO} attach="geometry" />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={cones} args={[undefined, undefined, n]}>
        <coneGeometry args={[3.4, POLE_H - 0.4, 24, 1, true]} />
        <meshBasicMaterial map={grad} transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={pools} args={[undefined, undefined, n]}>
        <planeGeometry args={[11, 11]} />
        <meshBasicMaterial map={disc} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={orbs} args={[undefined, undefined, n]}>
        <sphereGeometry args={[0.2, 12, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.9, 1.25, 40]} />
        <meshBasicMaterial color="#ffb020" toneMapped={false} />
      </mesh>
    </group>
  );
}

// ---------- 카메라 (CCTV) 와 보는 구간 ----------

function CameraZone() {
  const area = useRef<THREE.Mesh>(null);
  const edge = useRef<THREE.LineSegments>(null);
  const cam = useRef<THREE.Group>(null);
  const lines = useMemo(() => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3)), []);
  useFrame(() => {
    const x0 = wx(camZone.x0);
    const x1 = wx(camZone.x1);
    const cx = (x0 + x1) / 2;
    area.current!.position.set(cx, 0.03, 0);
    area.current!.scale.set(x1 - x0, 1, 1);
    cam.current!.position.set(cx, 6.2, -HALF - 3);
    cam.current!.lookAt(cx, 0, 0);
    const p = lines.attributes.position as THREE.BufferAttribute;
    const c = cam.current!.position;
    const corners = [
      [x0, -HALF],
      [x1, -HALF],
      [x1, HALF],
      [x0, HALF],
    ];
    corners.forEach(([x, z], i) => {
      p.setXYZ(i * 2, c.x, c.y - 0.2, c.z);
      p.setXYZ(i * 2 + 1, x, 0.05, z);
    });
    p.needsUpdate = true;
    edge.current!.geometry = lines;
  });
  return (
    <group>
      <mesh ref={area} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1, HALF * 2]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.09} depthWrite={false} toneMapped={false} />
      </mesh>
      <lineSegments ref={edge}>
        <lineBasicMaterial color="#38bdf8" transparent opacity={0.35} />
      </lineSegments>
      <group ref={cam}>
        <mesh position={[0, 0, 0.15]}>
          <primitive object={CCTV_GEO} attach="geometry" />
          <meshStandardMaterial color="#e9edf2" roughness={0.4} />
        </mesh>
        <mesh position={[0, 0, 0.52]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.1, 0.1, 0.06, 16]} />
          <meshBasicMaterial color="#38bdf8" toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

// ---------- 전광판 ----------

function VmsBoard({ sign, position, yaw, label }: { sign?: Sign; position: [number, number, number]; yaw: number; label: string }) {
  const face = useMemo(() => new VmsFace(), []);
  useEffect(() => {
    if (sign) face.draw(sign.level, sign.text, sign.sub);
  }, [face, sign?.level, sign?.text, sign?.sub, sign]);
  return (
    <group position={position} rotation={[0, yaw, 0]}>
      {[-1.3, 1.3].map((x) => (
        <mesh key={x} position={[x, 2.2, 0]} castShadow>
          <cylinderGeometry args={[0.07, 0.07, 4.4, 8]} />
          <meshStandardMaterial color="#7d8691" metalness={0.8} roughness={0.35} />
        </mesh>
      ))}
      <mesh position={[0, 4.2, -0.06]} castShadow>
        <boxGeometry args={[3.4, 1.8, 0.14]} />
        <meshStandardMaterial color="#20252c" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh position={[0, 4.2, 0.02]}>
        <planeGeometry args={[3.2, 1.6]} />
        <meshBasicMaterial map={face.texture} toneMapped={false} />
      </mesh>
      <Tag text={label} style="sign" position={[0, 5.6, 0]} />
    </group>
  );
}

// ---------- 움직이는 대상: 차량·사람 ----------

type Pose = { x: number; z: number; yaw: number };
const lerpAngle = (a: number, b: number, t: number) => a + ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * t;

// 지도 위 차량 → 3D 위치·방향 (우측통행 차로)
function carPose(w: Walker): Pose {
  const p = walkerXY(w);
  if (w.road === "h") return { x: wx(p.x), z: w.speed >= 0 ? LANE : -LANE, yaw: w.speed >= 0 ? 0 : Math.PI };
  return { x: RX + (w.speed >= 0 ? -LANE : LANE), z: wz(p.y), yaw: w.speed >= 0 ? -Math.PI / 2 : Math.PI / 2 };
}

// 지도 위 보행자 → 인도 위 위치. 횡단보도 구간에서는 길을 건넌다.
function personPose(w: Walker): { x: number; z: number } {
  if (w.road === "h") {
    const c = ZONE.crossX;
    const fwd = w.speed >= 0;
    const t = THREE.MathUtils.clamp(fwd ? (w.pos - (c - 24)) / 48 : (c + 24 - w.pos) / 48, 0, 1);
    const crossing = t > 0 && t < 1;
    const from = fwd ? WALK : -WALK;
    return { x: crossing ? wx(c) + (fwd ? -0.8 : 0.8) : wx(w.pos), z: THREE.MathUtils.lerp(from, -from, t) };
  }
  const fwd = w.speed >= 0;
  const t = THREE.MathUtils.clamp(fwd ? (w.pos - (RT.y - 34)) / 68 : (RT.y + 34 - w.pos) / 68, 0, 1);
  const crossing = t > 0 && t < 1;
  return { x: RX + THREE.MathUtils.lerp(WALK, -WALK, t), z: crossing ? wz(RT.y) + (fwd ? -0.8 : 0.8) : wz(w.pos) };
}

function useSmooth(get: () => Pose | { x: number; z: number }, group: RefObject<THREE.Group | null>, onStep?: (dist: number, dt: number) => void) {
  const cur = useRef<Pose | null>(null);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const t = get();
    const c = cur.current;
    const k = 1 - Math.exp(-dt * 7);
    if (!c || Math.hypot(t.x - c.x, t.z - c.z) > 25) {
      // 처음이거나 지도 끝에서 반대쪽으로 넘어감: 바로 옮긴다
      cur.current = { x: t.x, z: t.z, yaw: "yaw" in t ? t.yaw : c?.yaw ?? 0 };
    } else {
      const nx = c.x + (t.x - c.x) * k;
      const nz = c.z + (t.z - c.z) * k;
      const d = Math.hypot(nx - c.x, nz - c.z);
      const yaw = "yaw" in t ? t.yaw : d > 0.004 ? Math.atan2(nx - c.x, nz - c.z) : c.yaw;
      c.yaw = lerpAngle(c.yaw, yaw, Math.min(1, dt * 6));
      c.x = nx;
      c.z = nz;
      onStep?.(d, dt);
    }
    g.position.set(cur.current!.x, 0, cur.current!.z);
    g.rotation.y = cur.current!.yaw;
  });
}

// AI 인식 박스: 대상을 감싸는 청록색 모서리선
function AiBox({ w, h, d, ghost }: { w: number; h: number; d: number; ghost?: boolean }) {
  const geo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), [w, h, d]);
  return (
    <lineSegments geometry={geo} position={[0, h / 2, 0]}>
      <lineBasicMaterial color={ghost ? "#94a3b8" : "#22d3ee"} transparent opacity={ghost ? 0.5 : 0.95} toneMapped={false} />
    </lineSegments>
  );
}

// 화면에서 늘 같은 크기로 보이는 이름표 (캔버스 스프라이트)
function Tag({ text, style = "base", position }: { text: string; style?: Parameters<typeof tagTexture>[1]; position: [number, number, number] }) {
  const { texture, aspect } = useMemo(() => tagTexture(text, style), [text, style]);
  useEffect(() => () => texture.dispose(), [texture]);
  const h = 0.034;
  return (
    <sprite position={position} scale={[h * aspect, h, 1]} renderOrder={10}>
      <spriteMaterial map={texture} sizeAttenuation={false} depthTest={false} transparent toneMapped={false} />
    </sprite>
  );
}

function CarModel({ v }: { v: Vehicle }) {
  return <primitive object={v.group} />;
}

function SimCar({ w, type, color, limit }: { w: Walker; type: VehicleType; color: string; limit: number }) {
  const g = useRef<THREE.Group>(null);
  const v = useMemo(() => buildVehicle(type, color, { schoolBus: type === "bus" }), [type, color]);
  const [tag, setTag] = useState<{ show: boolean; kmh: number }>({ show: false, kmh: 0 });
  const last = useRef(0);
  useSmooth(
    () => carPose(w),
    g,
    (dist) => {
      for (const wh of v.wheels) wh.rotation.z -= dist / v.radius;
    },
  );
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current < 0.25) return;
    last.current = clock.elapsedTime;
    const p = walkerXY(w);
    const show = inZone(p.x, p.y) || (p.x > camZone.x0 && p.x < camZone.x1 && w.road === "h");
    const kmh = Math.round(simSpeedKmh(w));
    if (show !== tag.show || kmh !== tag.kmh) setTag({ show, kmh });
  });
  return (
    <group ref={g}>
      <CarModel v={v} />
      {tag.show && (
        <>
          <AiBox w={v.length + 0.3} h={v.height + 0.2} d={v.width + 0.3} />
          <Tag text={`${type === "bus" ? "통학버스" : "차량"} · ${tag.kmh}km/h`} style={tag.kmh > limit ? "bad" : "ai"} position={[0, v.height + 0.9, 0]} />
        </>
      )}
    </group>
  );
}

function SimPerson({ w, child, height }: { w: Walker; child: boolean; height: number }) {
  const g = useRef<THREE.Group>(null);
  useTrack(g, child ? "child" : "person", false, true);
  const state = useRef<PersonState>({ moving: true, speed: 1.2 });
  const [tag, setTag] = useState(false);
  useSmooth(
    () => personPose(w),
    g,
    (d, dt) => {
      state.current.moving = d / Math.max(dt, 1e-3) > 0.15;
      state.current.speed = d / Math.max(dt, 1e-3);
    },
  );
  const last = useRef(0);
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current < 0.3) return;
    last.current = clock.elapsedTime;
    const p = walkerXY(w);
    const show = inZone(p.x, p.y + (w.road === "h" ? -20 : 0)) || Math.abs(p.y - RT.y) < 40;
    if (show !== tag) setTag(show);
  });
  return (
    <group>
      <Person height={height} child={child} state={state} group={g} />
      {tag && <FollowTag target={g} y={height + 0.55} text={child ? "어린이" : "보행자"} box={{ w: 0.8, h: height + 0.1, d: 0.8 }} />}
    </group>
  );
}

// 따라다니는 인식 박스·이름표 (대상 그룹과 따로 그려 대상 회전에 박스가 같이 돌지 않게)
function FollowTag({ target, y, text, box, ghost }: { target: RefObject<THREE.Group | null>; y: number; text: string; box: { w: number; h: number; d: number }; ghost?: boolean }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (target.current && g.current) g.current.position.copy(target.current.position);
  });
  return (
    <group ref={g}>
      <AiBox {...box} ghost={ghost} />
      <Tag text={text} style={ghost ? "ghost" : "ai"} position={[0, y, 0]} />
    </group>
  );
}

// 카메라 AI가 실제로 인식한 대상 (웹캠 실측)
function Target({ t, all }: { t: MapTarget; all: RefObject<Map<string, MapTarget>> }) {
  const g = useRef<THREE.Group>(null);
  const state = useRef<PersonState>({ moving: true, speed: 1.2 });
  const vehicle = t.kind === "vehicle";
  useTrack(g, "person", true, !vehicle && !t.ghost); // 웹캠이 실제로 본 보행자
  const type: VehicleType = /버스/.test(t.label) ? "bus" : /트럭/.test(t.label) ? "truck" : /오토바이|자전거/.test(t.label) ? "bike" : "sedan";
  const v = useMemo(() => (vehicle ? buildVehicle(type, type === "bus" ? "#2b6cb0" : "#b4232a") : null), [vehicle, type]);
  const path = useRef<THREE.Line>(null);
  const ahead = useRef<THREE.Mesh>(null);
  const geo = useMemo(() => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3)), []);
  const pathLine = useMemo(() => new THREE.Line(geo, new THREE.LineDashedMaterial({ color: "#ff9e64", dashSize: 0.6, gapSize: 0.4, toneMapped: false })), [geo]);
  useSmooth(
    () => {
      const cur = all.current.get(t.key) ?? t;
      const fwd = cur.aheadX === null ? true : cur.aheadX >= cur.x;
      return vehicle ? { x: wx(cur.x), z: fwd ? LANE : -LANE, yaw: fwd ? 0 : Math.PI } : { x: wx(cur.x), z: WALK - 1.4 };
    },
    g,
    (d, dt) => {
      state.current.moving = d / Math.max(dt, 1e-3) > 0.1;
      state.current.speed = d / Math.max(dt, 1e-3);
      if (v) for (const wh of v.wheels) wh.rotation.z -= d / v.radius;
    },
  );
  useFrame(() => {
    const cur = all.current.get(t.key) ?? t;
    const show = cur.aheadX !== null && g.current;
    path.current!.visible = !!show;
    ahead.current!.visible = !!show;
    if (!show) return;
    const p = g.current!.position;
    const ax = wx(cur.aheadX!);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, p.x, 0.08, p.z);
    pos.setXYZ(1, ax, 0.08, p.z);
    pos.needsUpdate = true;
    path.current!.computeLineDistances();
    ahead.current!.position.set(ax, 0.06, p.z);
  });
  const h = vehicle ? (v?.height ?? 1.5) : 1.72;
  return (
    <group>
      {vehicle ? (
        <group ref={g}>
          <primitive object={v!.group} />
        </group>
      ) : (
        <Person height={1.72} state={state} group={g} opacity={t.ghost ? 0.45 : 1} />
      )}
      <FollowTag
        target={g}
        y={h + 0.7}
        ghost={t.ghost}
        text={t.ghost ? `${t.label} #${t.id} · 화면 밖 추정` : `AI 인식 · ${t.label} #${t.id}`}
        box={vehicle ? { w: (v?.length ?? 4.6) + 0.4, h: h + 0.2, d: (v?.width ?? 1.9) + 0.4 } : { w: 0.9, h: 1.85, d: 0.9 }}
      />
      <primitive object={pathLine} ref={path} />
      <mesh ref={ahead} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.45, 0.65, 28]} />
        <meshBasicMaterial color="#ff9e64" toneMapped={false} transparent opacity={0.9} />
      </mesh>
    </group>
  );
}

// ---------- 카메라 시점 ----------

function Rig({ preset, controls, moving }: { preset: Preset; controls: RefObject<OrbitControlsImpl | null>; moving: RefObject<boolean> }) {
  const { camera } = useThree();
  useEffect(() => {
    moving.current = true;
  }, [preset, moving]);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const stop = () => (moving.current = false);
    c.addEventListener("start", stop);
    return () => c.removeEventListener("start", stop);
  }, [controls, moving]);
  useFrame((_, dt) => {
    if (preset === "road" || !moving.current || !controls.current) return;
    const p = PRESETS[preset];
    const k = 1 - Math.exp(-dt * 2.5);
    camera.position.lerp(new THREE.Vector3(...p.pos), k);
    controls.current.target.lerp(new THREE.Vector3(...p.target), k);
    controls.current.update();
    if (camera.position.distanceTo(new THREE.Vector3(...p.pos)) < 0.05) moving.current = false;
  });
  return null;
}

// ---------- 매크로가 찾아갈 대상 ----------
// 사람 모델과 웹캠 인식 대상이 장면 안에서 실제로 그려지는 위치를 등록해 두고, 매크로가 그 위치를 따라간다.
// (Canvas 안은 별도 렌더러라 Canvas 바깥의 React 컨텍스트가 닿지 않는다. 그래서 Canvas 안쪽에서 제공한다)

type Tracked = { g: RefObject<THREE.Group | null>; kind: "child" | "person"; ai: boolean };
const TrackCtx = createContext<Map<string, Tracked> | null>(null);

function useTrack(g: RefObject<THREE.Group | null>, kind: Tracked["kind"], ai: boolean, enabled: boolean) {
  const reg = useContext(TrackCtx);
  const id = useId();
  useEffect(() => {
    if (!reg || !enabled) return;
    reg.set(id, { g, kind, ai });
    return () => void reg.delete(id);
  }, [reg, id, g, kind, ai, enabled]);
}

// get: 매 프레임 대상의 지금 위치 (사라지면 null), dist: 3D에서 대상까지 둘 거리
type Goal = { get: () => THREE.Vector3 | null; dist: number };

// from(지금 보는 곳)에서 가장 가까운 대상. 보행자는 웹캠이 실제로 본 사람을 먼저 고른다
function pickGoal(kind: MacroTarget, reg: Map<string, Tracked> | null, from: THREE.Vector3): Goal | null {
  if (kind === "cam") {
    const p = new THREE.Vector3();
    return { get: () => p.set(wx((camZone.x0 + camZone.x1) / 2), 0, 0), dist: 30 };
  }
  if (!reg) return null;
  const all = [...reg.values()].filter((t) => t.kind === kind && t.g.current);
  const pool = kind === "person" && all.some((t) => t.ai) ? all.filter((t) => t.ai) : all;
  let best: Tracked | null = null;
  for (const t of pool) if (!best || t.g.current!.position.distanceTo(from) < best.g.current!.position.distanceTo(from)) best = t;
  if (!best) return null;
  const g = best.g;
  return { get: () => g.current?.position ?? null, dist: kind === "child" ? 14 : 18 };
}

// 매크로 시작: 대상을 찾으면 안내에 "따라가는 중", 못 찾으면 "안 보여요"를 띄운다
function startMacro(n: 1 | 2 | 3, reg: Map<string, Tracked> | null, from: THREE.Vector3): Goal | null {
  const m = MACROS[n];
  const goal = pickGoal(m.target, reg, from);
  handBus.setMacro({ n, label: m.label, missing: !goal });
  if (!goal) setTimeout(() => handBus.get().macro?.missing && handBus.setMacro(null), 2500);
  return goal;
}

// ---------- 손동작 조작 ----------
// lib/mapGesture.ts의 명령을 받아 그리기 루프 안에서 적용한다. 손 이동량은 웹캠 화면 비율(0~1)이다.

const ROT = Math.PI; // 손을 웹캠 화면 끝에서 끝까지 움직이면 180° 회전
const PAN_K = 1.1; // 끌기: 지금 보는 거리에 비례해 움직인다 (가까이 볼수록 정밀하게)
const MIN_DIST = 6;
const MAX_DIST = 190;
const MAX_POLAR = Math.PI / 2.15;

// 손동작 명령을 모아 두는 큐. 손 인식(15fps)과 그리기(60fps)의 박자가 달라서 다음 프레임에 한꺼번에 적용한다
function useGestureQueue() {
  const queue = useRef<MapAction[]>([]);
  useEffect(() => handBus.onStep((st) => queue.current.push(...st.actions)), []);
  return queue;
}

function GestureOrbit({ controls, moving, onReset }: { controls: RefObject<OrbitControlsImpl | null>; moving: RefObject<boolean>; onReset: () => void }) {
  const { camera } = useThree();
  const queue = useGestureQueue();
  const reg = useContext(TrackCtx);
  const macro = useRef<Goal | null>(null);
  const tmp = useMemo(() => ({ off: new THREE.Vector3(), sph: new THREE.Spherical(), right: new THREE.Vector3(), fwd: new THREE.Vector3() }), []);
  const stopMacro = () => {
    if (!macro.current) return;
    macro.current = null;
    handBus.setMacro(null);
  };

  // 마우스로 직접 돌리면 매크로를 멈춘다
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const onStart = () => {
      macro.current = null;
      handBus.setMacro(null);
    };
    c.addEventListener("start", onStart);
    return () => c.removeEventListener("start", onStart);
  }, [controls]);
  useEffect(() => () => void (macro.current && handBus.setMacro(null)), []);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const acts = queue.current.splice(0);
    const { off, sph, right, fwd } = tmp;
    for (const a of acts) {
      if (a.kind === "macro") {
        macro.current = startMacro(a.n, reg, c.target);
        moving.current = false;
        continue;
      }
      stopMacro(); // 손을 직접 움직이면 매크로보다 손이 먼저다
      if (a.kind === "reset") {
        onReset();
        continue;
      }
      moving.current = false; // 손으로 움직이기 시작하면 시점 자동 이동을 멈춘다
      off.copy(camera.position).sub(c.target);
      sph.setFromVector3(off);
      if (a.kind === "orbit") {
        // 마우스로 끌 때와 같은 방향: 손을 오른쪽으로 움직이면 장면이 오른쪽으로 돈다
        sph.theta -= a.dx * ROT;
        sph.phi -= a.dy * ROT;
      } else if (a.kind === "twist") {
        sph.theta -= a.angle;
      } else if (a.kind === "zoom") {
        sph.radius *= a.factor;
      } else if (a.kind === "pan") {
        // 땅바닥을 잡고 끄는 것처럼: 화면 방향을 바닥에 눕혀 움직인다
        right.setFromMatrixColumn(camera.matrix, 0).setY(0).normalize();
        fwd.crossVectors(camera.up, right).normalize();
        const k = sph.radius * PAN_K;
        const move = right.multiplyScalar(-a.dx * k).add(fwd.multiplyScalar(a.dy * k));
        c.target.add(move);
        c.target.x = THREE.MathUtils.clamp(c.target.x, SPAN.x0, SPAN.x1);
        c.target.z = THREE.MathUtils.clamp(c.target.z, SPAN.z0, SPAN.z1);
      }
      sph.phi = THREE.MathUtils.clamp(sph.phi, 0.08, MAX_POLAR);
      sph.radius = THREE.MathUtils.clamp(sph.radius, MIN_DIST, MAX_DIST);
      sph.makeSafe();
      camera.position.copy(c.target).add(off.setFromSpherical(sph));
    }

    // 🫰 매크로: 손으로 끌고 확대하듯 대상 쪽으로 미끄러지듯 다가간 뒤, 움직이는 대상을 계속 따라간다
    const goal = macro.current;
    if (goal) {
      const p = goal.get();
      if (!p) stopMacro();
      else {
        const k = 1 - Math.exp(-dt * 2.4);
        off.copy(camera.position).sub(c.target);
        sph.setFromVector3(off);
        c.target.lerp(p, k);
        sph.radius += (goal.dist - sph.radius) * k;
        sph.phi += (0.95 - sph.phi) * k * 0.8; // 비스듬히 내려다보는 각도
        sph.makeSafe();
        camera.position.copy(c.target).add(off.setFromSpherical(sph));
      }
    }
    if (acts.length || goal) c.update();
  });
  return null;
}

// 로드뷰: 도로 위 눈높이에서 둘러보고 걷는다. 마우스·키보드·손동작 모두 받는다.
type Look = { x: number; z: number; yaw: number; pitch: number };
const roadStart = (): Look => ({ x: PRESETS.road.pos[0], z: PRESETS.road.pos[2], yaw: 0, pitch: -0.04 });
const WALK_SPEED = 4; // m/s (방향키·WASD)
const TURN_SPEED = 1.4; // rad/s (←→)
const MAX_PITCH = 1.1;

function RoadView({ eye, resetKey }: { eye: number; resetKey: number }) {
  const { camera, gl } = useThree();
  const look = useRef<Look>(roadStart());
  const keys = useRef(new Set<string>());
  const queue = useGestureQueue();
  const reg = useContext(TrackCtx);
  const macro = useRef<Goal | null>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const here = useMemo(() => new THREE.Vector3(), []);
  const stopMacro = () => {
    if (!macro.current) return;
    macro.current = null;
    handBus.setMacro(null);
  };

  useEffect(() => {
    look.current = roadStart();
  }, [resetKey]);
  useEffect(() => () => void (macro.current && handBus.setMacro(null)), []);

  useEffect(() => {
    const el = gl.domElement;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      stopMacro();
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const h = el.clientHeight || 1;
      // 장면을 잡고 끄는 방향: 오른쪽으로 끌면 왼쪽을 본다
      look.current.yaw -= ((e.clientX - drag.x) / h) * 1.6;
      look.current.pitch = THREE.MathUtils.clamp(look.current.pitch + ((e.clientY - drag.y) / h) * 1.6, -MAX_PITCH, MAX_PITCH);
      drag = { x: e.clientX, y: e.clientY };
    };
    const up = () => (drag = null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      stopMacro();
      walk(look.current, -e.deltaY * 0.01, 0);
    };
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(k)) {
        stopMacro();
        keys.current.add(k);
        e.preventDefault();
      }
    };
    const ku = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      keys.current.clear();
    };
  }, [gl]);

  useFrame((_, dt) => {
    const L = look.current;
    const k = keys.current;
    const fwd = (k.has("arrowup") || k.has("w") ? 1 : 0) - (k.has("arrowdown") || k.has("s") ? 1 : 0);
    const side = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
    const turn = (k.has("arrowright") ? 1 : 0) - (k.has("arrowleft") ? 1 : 0);
    if (fwd || side) walk(L, fwd * WALK_SPEED * dt, side * WALK_SPEED * dt);
    L.yaw += turn * TURN_SPEED * dt;

    for (const a of queue.current.splice(0)) {
      if (a.kind === "macro") {
        macro.current = startMacro(a.n, reg, here.set(L.x, 0, L.z));
        continue;
      }
      stopMacro();
      if (a.kind === "reset") Object.assign(L, roadStart());
      else if (a.kind === "orbit") {
        // 둘러보기는 회전보다 크게: 손을 화면 폭의 절반 움직이면 약 110°
        L.yaw -= a.dx * ROT * 1.25;
        L.pitch = THREE.MathUtils.clamp(L.pitch + a.dy * ROT * 0.8, -MAX_PITCH, MAX_PITCH);
      } else if (a.kind === "twist") L.yaw += a.angle;
      // 🤏 바닥을 잡고 몸 쪽으로 당기면 앞으로, 옆으로 밀면 반대쪽으로 걷는다
      else if (a.kind === "pan") walk(L, a.dy * 25, -a.dx * 25);
      // 👍·두 손 벌리기 = 앞으로, 👎·모으기 = 뒤로
      else if (a.kind === "zoom") walk(L, (1 - a.factor) * 6, 0);
    }

    // 🫰 매크로: 대상 9m 앞까지 걸어가 대상 쪽을 바라보고, 움직이면 계속 따라 걷는다
    const goal = macro.current;
    if (goal) {
      const p = goal.get();
      if (!p) stopMacro();
      else {
        const k = 1 - Math.exp(-dt * 2.2);
        const dx = L.x - p.x;
        const dz = L.z - p.z;
        const len = Math.hypot(dx, dz) || 1;
        L.x += (p.x + (dx / len) * 9 - L.x) * k;
        L.z += (p.z + (dz / len) * 9 - L.z) * k;
        L.yaw = lerpAngle(L.yaw, Math.atan2(p.z - L.z, p.x - L.x), Math.min(1, k * 1.6));
        L.pitch += (-0.08 - L.pitch) * k;
        walk(L, 0, 0); // 지도 밖으로 나가지 않게
      }
    }

    camera.position.set(L.x, eye, L.z);
    tmp.set(L.x + Math.cos(L.pitch) * Math.cos(L.yaw), eye + Math.sin(L.pitch), L.z + Math.cos(L.pitch) * Math.sin(L.yaw));
    camera.lookAt(tmp);
  });
  return null;
}

// 바라보는 방향 기준으로 앞(fwd)·오른쪽(side)으로 걷는다. 지도 밖으로는 못 나간다
function walk(L: Look, fwd: number, side: number) {
  L.x += Math.cos(L.yaw) * fwd - Math.sin(L.yaw) * side;
  L.z += Math.sin(L.yaw) * fwd + Math.cos(L.yaw) * side;
  L.x = THREE.MathUtils.clamp(L.x, SPAN.x0 + 1, SPAN.x1 - 1);
  L.z = THREE.MathUtils.clamp(L.z, SPAN.z0 + 1, SPAN.z1 - 1);
}

function Env() {
  const { gl, scene } = useThree();
  useEffect(() => {
    // 차 도장·유리에 비칠 주변광. 이미지 파일 없이 three.js 기본 실내 환경으로 만든다
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.35;
    return () => {
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene]);
  return null;
}

// ---------- 장면 ----------

export default function Street3D({ lamps, walkers, targets, selectedId, onSelect, alert, sign, rtSign, limit = 30, view = "all" }: Props) {
  const [preset, setPreset] = useState<Preset>(view);
  const [mobile] = useState(coarse);
  const controls = useRef<OrbitControlsImpl | null>(null);
  const moving = useRef(true);
  const tracked = useRef(new Map<string, Tracked>()); // 매크로가 찾아갈 사람들
  const [eye, setEye] = useState(1.6);
  const [roadReset, setRoadReset] = useState(0);
  const road = preset === "road";
  // 카메라 창의 손동작 안내도 로드뷰 문구로 바꾸게 알린다
  useEffect(() => {
    handBus.setRoad(road);
    return () => handBus.setRoad(false);
  }, [road]);
  const all = useRef(new Map<string, MapTarget>());
  all.current = new Map(targets.map((t) => [t.key, t]));
  useEffect(() => setPreset(view), [view]);

  const cars = walkers.map((w, i) => ({ w, i })).filter(({ w }) => w.kind === "car");
  const people = walkers.map((w, i) => ({ w, i })).filter(({ w }) => w.kind === "person");
  const CAR_LOOK: [VehicleType, string][] = [
    ["sedan", "#e9ecef"],
    ["bus", "#ffc20e"],
    ["suv", "#1f3b73"],
    ["truck", "#2f6b4f"],
  ];

  return (
    <div className="street3d">
      <Canvas
        shadows={!mobile}
        dpr={mobile ? [1, 1.5] : [1, 2]}
        camera={{ position: PRESETS[view].pos, fov: 42, near: 0.5, far: 600 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
        onCreated={(st) => {
          // 개발 모드 QA용: 콘솔에서 장면을 살펴볼 수 있게
          if (process.env.NODE_ENV === "development") Object.assign(window, { __three: { scene: st.scene, camera: st.camera, controls } });
        }}
      >
        <TrackCtx.Provider value={tracked.current}>
        <color attach="background" args={["#0a1222"]} />
        <fog attach="fog" args={["#0a1222", 90, 230]} />
        <hemisphereLight args={["#5671aa", "#141a14", 0.8]} />
        <directionalLight
          position={[-60, 90, 40]}
          intensity={0.55}
          color="#a9c1ff"
          castShadow={!mobile}
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-110}
          shadow-camera-right={110}
          shadow-camera-top={70}
          shadow-camera-bottom={-70}
          shadow-camera-far={260}
          shadow-bias={-0.0004}
        />
        <Env />
        <Ground />
        <City />
        <Lamps lamps={lamps} selectedId={selectedId} onSelect={onSelect} alert={alert} />
        <CameraZone />
        <VmsBoard sign={sign} position={[wx(ZONE.x0) - 5, 0, HALF + 2.2]} yaw={-Math.PI / 2} label="보호구역 전광판" />
        <VmsBoard sign={rtSign} position={[RX - HALF - 9, 0, HALF + 2.2]} yaw={-Math.PI / 2} label="우회전 알리미" />
        <Suspense fallback={null}>
          {cars.map(({ w, i }, k) => (
            <SimCar key={i} w={w} type={CAR_LOOK[k % CAR_LOOK.length][0]} color={CAR_LOOK[k % CAR_LOOK.length][1]} limit={limit} />
          ))}
          {people.map(({ w, i }) => (
            <SimPerson key={i} w={w} child={w.road === "h"} height={w.road === "h" ? 1.22 : i % 2 ? 1.78 : 1.66} />
          ))}
          {targets.map((t) => (
            <Target key={t.key} t={t} all={all} />
          ))}
        </Suspense>
        <OrbitControls
          ref={controls}
          makeDefault
          enabled={!road}
          enableDamping
          dampingFactor={0.08}
          maxPolarAngle={MAX_POLAR}
          minDistance={MIN_DIST}
          maxDistance={MAX_DIST}
          target={PRESETS[view].target}
        />
        <Rig preset={preset} controls={controls} moving={moving} />
        {road ? (
          <RoadView eye={eye} resetKey={roadReset} />
        ) : (
          <GestureOrbit
            controls={controls}
            moving={moving}
            onReset={() => {
              setPreset("all");
              moving.current = true;
            }}
          />
        )}
        <EffectComposer multisampling={mobile ? 0 : 4}>
          <Bloom mipmapBlur intensity={mobile ? 0.7 : 1.05} luminanceThreshold={0.72} luminanceSmoothing={0.2} />
        </EffectComposer>
        </TrackCtx.Provider>
      </Canvas>
      <div className="view3d-bar" role="toolbar" aria-label="3D 시점">
        {(Object.keys(PRESETS) as Preset[]).map((p) => (
          <button key={p} className={preset === p ? "on" : ""} onClick={() => setPreset(p)}>
            {PRESETS[p].label}
          </button>
        ))}
      </div>
      <GestureHud road={road} />
      {road && (
        <div className="road-bar" role="toolbar" aria-label="로드뷰">
          <button className={eye > 1.3 ? "on" : ""} onClick={() => setEye(1.6)}>
            어른 눈높이
          </button>
          <button className={eye <= 1.3 ? "on" : ""} onClick={() => setEye(1.1)}>
            어린이 눈높이
          </button>
          <button onClick={() => setRoadReset((n) => n + 1)}>처음 자리</button>
        </div>
      )}
      <p className="view3d-hint">
        {road
          ? "끌어서 둘러보고, 휠·↑↓(W S)로 걷고, ←→로 돌아요 · 손동작도 돼요"
          : "끌어서 돌리고, 두 손가락(휠)으로 확대해요 · 가로등을 누르면 상세"}
      </p>
    </div>
  );
}
