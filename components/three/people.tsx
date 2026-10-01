"use client";

// 사람 3D 모델. three.js 예제의 Mixamo 실사형 캐릭터(Michelle)에 같은 뼈대의 걷기·서 있기 동작(Xbot에서 추출)을 입힌다.
// 두 모델은 뼈마다 기본 자세가 달라서 동작을 그대로 입히면 사람이 눕거나 팔이 들린다.
// 그래서 three.js SkeletonUtils.retargetClip으로 Michelle 골격에 맞춰 미리 변환한 동작(walk-clips.json)을 쓴다.
// 같은 모델을 사람 수만큼 복제하고 키를 맞춘다. 어린이는 작게 + 노란 책가방.

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

export const PERSON_URL = "/models/3d/Michelle.glb";
const CLIPS_URL = "/models/3d/walk-clips.json";

type Clips = { walk: THREE.AnimationClip; idle: THREE.AnimationClip };
let clipsPromise: Promise<Clips> | null = null;
function loadClips(): Promise<Clips> {
  clipsPromise ??= fetch(CLIPS_URL)
    .then((r) => r.json() as Promise<Record<"walk" | "idle", THREE.AnimationClipJSON>>)
    .then((j) => ({ walk: THREE.AnimationClip.parse(j.walk), idle: THREE.AnimationClip.parse(j.idle) }));
  return clipsPromise;
}

const bag = new THREE.MeshStandardMaterial({ color: "#ffc400", roughness: 0.6 });

export type PersonState = { moving: boolean; speed: number }; // speed: m/s (걷는 동작 빠르기)

type Props = {
  height: number; // m
  child?: boolean;
  state: React.RefObject<PersonState>;
  group: React.RefObject<THREE.Group | null>; // 위치·방향은 부모가 매 프레임 바꾼다
  opacity?: number;
};

export function Person({ height, child, state, group, opacity = 1 }: Props) {
  const { scene } = useGLTF(PERSON_URL);
  const model = useMemo(() => {
    const m = cloneSkinned(scene);
    // 모델 안의 축척(Mixamo 0.01)을 반영한 뒤 키를 잰다. 안 하면 1.7cm짜리 사람이 된다.
    m.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(m, true);
    const s = height / (box.max.y - box.min.y);
    m.scale.setScalar(s);
    m.position.y = -box.min.y * s;
    m.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false; // 걷는 동안 뼈가 움직여 경계가 바뀌므로 잘림 방지
      if (opacity < 1) {
        const mat = (mesh.material as THREE.Material).clone();
        mat.transparent = true;
        mat.opacity = opacity;
        mat.depthWrite = false;
        mesh.material = mat;
      }
    });
    return m;
  }, [scene, height, opacity]);

  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model]);
  const actions = useRef<{ walk?: THREE.AnimationAction; idle?: THREE.AnimationAction }>({});

  useEffect(() => {
    let live = true;
    void loadClips().then((clips) => {
      if (!live) return;
      const walk = mixer.clipAction(clips.walk);
      const idle = mixer.clipAction(clips.idle);
      walk.play();
      idle.play();
      walk.time = Math.random() * clips.walk.duration; // 여러 사람이 발을 맞추지 않게
      walk.setEffectiveWeight(1);
      idle.setEffectiveWeight(0);
      actions.current = { walk, idle };
    });
    return () => {
      live = false;
      mixer.stopAllAction();
    };
  }, [mixer]);

  useFrame((_, dt) => {
    const { walk, idle } = actions.current;
    const st = state.current;
    if (walk && idle) {
      // 걷기 ↔ 서 있기를 부드럽게 섞는다
      const target = st.moving ? 1 : 0;
      const w = THREE.MathUtils.lerp(walk.getEffectiveWeight(), target, Math.min(1, dt * 5));
      walk.setEffectiveWeight(w);
      idle.setEffectiveWeight(1 - w);
      walk.timeScale = THREE.MathUtils.clamp(st.speed / 1.3, 0.6, 1.8);
    }
    mixer.update(Math.min(dt, 0.1));
  });

  return (
    <group ref={group}>
      <primitive object={model} />
      {child && (
        <mesh position={[0, height * 0.62, -0.16 * (height / 1.2)]} castShadow>
          <boxGeometry args={[0.32 * (height / 1.2), 0.36 * (height / 1.2), 0.16 * (height / 1.2)]} />
          <primitive object={bag} attach="material" />
        </mesh>
      )}
    </group>
  );
}

useGLTF.preload(PERSON_URL);
