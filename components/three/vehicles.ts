// 차량 3D 모델을 코드로 만든다 (외부 모델 파일 없음). 단위는 m, 차 앞이 +X 방향.
// - 차체: 옆모습 윤곽(바퀴 아치 포함)을 밀어 내고 모서리를 둥글게 깎는다. 자동차 도장처럼 클리어코트 재질.
// - 유리: 벨트라인 위 캐빈을 짙은 반사 유리로, 지붕은 다시 도장 재질로 덮는다.
// - 바퀴: 타이어 + 금속 휠. 속도에 맞춰 돌릴 수 있게 wheels 배열로 돌려준다.
// - 전조등·후미등: 발광 재질 + 앞으로 뻗는 빛 원뿔 (블룸 효과로 번진다)

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { signboard } from "@/components/three/textures";

export type VehicleType = "sedan" | "suv" | "bus" | "truck" | "bike";

export type Vehicle = { group: THREE.Group; wheels: THREE.Object3D[]; length: number; height: number; width: number; radius: number };

const glass = new THREE.MeshPhysicalMaterial({ color: "#0c1420", metalness: 0.3, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.4 });
const tire = new THREE.MeshStandardMaterial({ color: "#121316", roughness: 0.92 });
const rim = new THREE.MeshStandardMaterial({ color: "#c7ccd4", metalness: 1, roughness: 0.22 });
const trim = new THREE.MeshStandardMaterial({ color: "#1a1c20", roughness: 0.6, metalness: 0.2 });
const chrome = new THREE.MeshStandardMaterial({ color: "#e6e9ee", metalness: 1, roughness: 0.12 });
const headlight = new THREE.MeshStandardMaterial({ color: "#fff7e0", emissive: "#fff2cf", emissiveIntensity: 3 });
const taillight = new THREE.MeshStandardMaterial({ color: "#7a0b0b", emissive: "#ff2a2a", emissiveIntensity: 2.2 });
const plate = new THREE.MeshStandardMaterial({ color: "#f1f3f6", roughness: 0.5 });
const beam = new THREE.MeshBasicMaterial({ color: "#fff1cc", transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });

export const paint = (color: string) =>
  new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.2 });

// 옆모습 윤곽 [x, y] 목록 → 폭 width만큼 밀어 낸 둥근 덩어리 (z 가운데 정렬)
function extrude(points: [number, number][], width: number, mat: THREE.Material, arches: { x: number; r: number }[] = [], bevel = 0.07) {
  const s = new THREE.Shape();
  // 바닥선은 앞→뒤로 가며 바퀴 자리를 반원으로 파낸다
  const bottom = points[0][1];
  const front = Math.max(...points.map((p) => p[0]));
  const rear = Math.min(...points.map((p) => p[0]));
  s.moveTo(front, bottom);
  for (const a of [...arches].sort((p, q) => q.x - p.x)) {
    s.lineTo(a.x + a.r, bottom);
    s.absarc(a.x, bottom, a.r, 0, Math.PI, false);
  }
  s.lineTo(rear, bottom);
  for (const [x, y] of points.slice(1)) s.lineTo(x, y);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 4, curveSegments: 18 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function wheel(r: number, w: number) {
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 28), tire);
  t.rotation.x = Math.PI / 2;
  t.castShadow = true;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.02, 20), rim);
  hub.rotation.x = Math.PI / 2;
  // 휠 스포크 5개: 돌아가는 게 보이게
  for (let i = 0; i < 5; i++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(r * 1.05, r * 0.14, w + 0.04), trim);
    sp.rotation.z = (i / 5) * Math.PI;
    g.add(sp);
  }
  g.add(t, hub);
  return g;
}

function lights(L: number, y: number, W: number, add: (o: THREE.Object3D) => void, h = 0.12) {
  for (const z of [-W / 2 + 0.28, W / 2 - 0.28]) {
    const hl = new THREE.Mesh(new RoundedBoxGeometry(0.08, h, 0.38, 2, 0.03), headlight);
    hl.position.set(L / 2 + 0.01, y, z);
    const tl = new THREE.Mesh(new RoundedBoxGeometry(0.08, h, 0.42, 2, 0.03), taillight);
    tl.position.set(-L / 2 - 0.01, y + 0.05, z);
    // 전조등 빛줄기: 앞으로 7m 퍼지는 원뿔
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.4, 7, 20, 1, true), beam);
    cone.rotation.z = Math.PI / 2;
    cone.position.set(L / 2 + 3.5, y - 0.15, z);
    add(hl);
    add(tl);
    add(cone);
  }
  const pl = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.5), plate);
  pl.position.set(L / 2 + 0.06, y - 0.28, 0);
  add(pl);
}

export function buildVehicle(type: VehicleType, color: string, opts: { schoolBus?: boolean } = {}): Vehicle {
  const group = new THREE.Group();
  const body = paint(color);
  const wheels: THREE.Object3D[] = [];
  const addWheels = (xs: number[], r: number, W: number, w = 0.26) => {
    for (const x of xs)
      for (const z of [-W / 2 + w / 2 + 0.04, W / 2 - w / 2 - 0.04]) {
        const wh = wheel(r, w);
        wh.position.set(x, r, z);
        group.add(wh);
        wheels.push(wh);
      }
  };

  if (type === "sedan" || type === "suv") {
    const suv = type === "suv";
    const L = suv ? 4.75 : 4.65;
    const W = suv ? 1.92 : 1.84;
    const r = suv ? 0.38 : 0.33;
    const g0 = suv ? 0.42 : 0.3; // 차체 바닥 높이
    const belt = suv ? 1.18 : 0.98; // 창문 아래선
    const roof = suv ? 1.74 : 1.44;
    const wx = suv ? 1.45 : 1.42;
    // 아래 차체: 범퍼·보닛·트렁크
    group.add(
      extrude(
        [
          [L / 2, g0],
          [-L / 2, g0],
          [-L / 2 - 0.02, g0 + 0.32],
          [-L / 2 + 0.12, belt - 0.03],
          [-L / 2 + (suv ? 0.2 : 0.55), belt],
          [L / 2 - (suv ? 0.9 : 1.15), belt],
          [L / 2 - 0.15, belt - (suv ? 0.12 : 0.17)],
          [L / 2 + 0.02, g0 + 0.3],
        ],
        W,
        body,
        [
          { x: wx, r: r + 0.07 },
          { x: -wx, r: r + 0.07 },
        ],
      ),
    );
    // 유리 캐빈
    const cab: [number, number][] = suv
      ? [[L / 2 - 0.9, belt], [-L / 2 + 0.2, belt], [-L / 2 + 0.26, roof - 0.04], [L / 2 - 1.55, roof - 0.04]]
      : [[L / 2 - 1.15, belt], [-L / 2 + 0.55, belt], [-0.75, roof - 0.04], [0.55, roof - 0.04]];
    group.add(extrude([cab[0], ...cab.slice(1)], W - 0.16, glass, [], 0.05));
    // 지붕
    const rx0 = cab[2][0];
    const rx1 = cab[3][0];
    const top = new THREE.Mesh(new RoundedBoxGeometry(rx1 - rx0 + 0.12, 0.07, W - 0.2, 3, 0.03), body);
    top.position.set((rx0 + rx1) / 2, roof - 0.02, 0);
    top.castShadow = true;
    group.add(top);
    // 사이드미러, 그릴, 범퍼 몰딩
    for (const z of [-W / 2 - 0.08, W / 2 + 0.08]) {
      const mirror = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.12, 0.16, 2, 0.04), body);
      mirror.position.set(cab[0][0] - 0.1, belt + 0.08, z);
      group.add(mirror);
    }
    const grille = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.16, W * 0.5, 2, 0.03), trim);
    grille.position.set(L / 2 + 0.02, g0 + 0.36, 0);
    group.add(grille);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(L * 0.55, 0.06, W + 0.02), chrome);
    sill.position.set(0, g0 + 0.04, 0);
    group.add(sill);
    lights(L, g0 + (suv ? 0.62 : 0.5), W, (o) => group.add(o));
    addWheels([wx, -wx], r, W);
    return { group, wheels, length: L, height: roof, width: W, radius: r };
  }

  if (type === "bus") {
    // 버스: 창 띠 + (통학버스면) 옆면 "어린이 통학버스" 표시
    const L = 9.2, W = 2.4, H = 3.0, r = 0.5;
    const shell = new THREE.Mesh(new RoundedBoxGeometry(L, H - 0.45, W, 4, 0.18), body);
    shell.position.set(0, 0.45 + (H - 0.45) / 2, 0);
    shell.castShadow = true;
    group.add(shell);
    const band = new THREE.Mesh(new RoundedBoxGeometry(L - 1.1, 0.95, W + 0.02, 3, 0.06), glass);
    band.position.set(-0.3, 2.2, 0);
    group.add(band);
    const wind = new THREE.Mesh(new RoundedBoxGeometry(0.08, 1.2, W - 0.25, 2, 0.04), glass);
    wind.position.set(L / 2 + 0.01, 2.0, 0);
    group.add(wind);
    for (const z of opts.schoolBus ? [-W / 2 - 0.012, W / 2 + 0.012] : []) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.5), new THREE.MeshBasicMaterial({ map: signboard("어린이 통학버스", "#ffd21f", "#1a1a1a"), toneMapped: false }));
      sign.position.set(-0.6, 1.2, z);
      if (z < 0) sign.rotation.y = Math.PI;
      group.add(sign);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(L - 0.3, 0.08, 0.01), trim);
      stripe.position.set(0, 1.62, z);
      group.add(stripe);
    }
    lights(L, 0.95, W, (o) => group.add(o), 0.18);
    addWheels([L / 2 - 1.7, -L / 2 + 2.1], r, W, 0.32);
    return { group, wheels, length: L, height: H, width: W, radius: r };
  }

  if (type === "truck") {
    // 1톤 트럭: 운전석 + 짐칸
    const L = 5.4, W = 1.95, r = 0.38;
    const cab = new THREE.Mesh(new RoundedBoxGeometry(1.7, 1.75, W, 4, 0.14), body);
    cab.position.set(L / 2 - 0.85, 0.45 + 0.88, 0);
    cab.castShadow = true;
    const wind = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.7, W - 0.2, 2, 0.03), glass);
    wind.position.set(L / 2 + 0.01, 1.75, 0);
    const side = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.62, W + 0.02, 2, 0.04), glass);
    side.position.set(L / 2 - 0.75, 1.75, 0);
    const box = new THREE.Mesh(new RoundedBoxGeometry(3.5, 2.0, W + 0.05, 3, 0.06), new THREE.MeshStandardMaterial({ color: "#eef1f5", roughness: 0.55 }));
    box.position.set(-L / 2 + 1.75, 0.55 + 1.0, 0);
    box.castShadow = true;
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(L - 0.2, 0.25, W - 0.3), trim);
    chassis.position.set(0, 0.5, 0);
    group.add(cab, wind, side, box, chassis);
    lights(L, 0.85, W, (o) => group.add(o));
    addWheels([L / 2 - 0.85, -L / 2 + 1.0], r, W);
    return { group, wheels, length: L, height: 2.6, width: W, radius: r };
  }

  // 이륜차 (자전거·오토바이)
  const r = 0.33;
  const frame = new THREE.Mesh(new RoundedBoxGeometry(1.2, 0.35, 0.22, 2, 0.08), body);
  frame.position.set(0, 0.75, 0);
  const seat = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.1, 0.26, 2, 0.04), trim);
  seat.position.set(-0.2, 0.98, 0);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 8), chrome);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(0.5, 1.12, 0);
  group.add(frame, seat, bar);
  for (const x of [0.62, -0.62]) {
    const wh = wheel(r, 0.12);
    wh.position.set(x, r, 0);
    group.add(wh);
    wheels.push(wh);
  }
  const hl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), headlight);
  hl.position.set(0.68, 0.98, 0);
  group.add(hl);
  return { group, wheels, length: 1.9, height: 1.2, width: 0.6, radius: r };
}
