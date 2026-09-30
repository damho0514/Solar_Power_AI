// 브라우저 안에서 도는 물체 인식 엔진. 환경에 따라 되는 것으로 자동 선택한다.
// 1. MediaPipe GPU  : 가장 빠름. WebGL2가 필요하다.
// 2. MediaPipe CPU  : 추론만 CPU. 영상 프레임을 넘길 때는 여전히 WebGL이 필요하다.
// 3. TF.js COCO-SSD : WASM으로 도는 순수 CPU 엔진. WebGL이 막힌 브라우저에서도 동작한다.
// 모델 파일은 모두 public/ 아래에 있어서 인터넷 없이 돌아간다.

export type RawDetection = { name: string; score: number; x: number; y: number; w: number; h: number }; // 픽셀

export type Engine = {
  id: "mediapipe-gpu" | "mediapipe-cpu" | "tfjs-wasm";
  label: string;
  detect: (video: HTMLVideoElement, now: number) => Promise<RawDetection[]>;
  close: () => void;
};

// COCO 데이터셋 이름 → 화면 표시 이름. 휴대폰은 책상 앞에서 차량 대신 쓰라고 넣었다.
export const LABELS: Record<string, string> = {
  person: "보행자",
  bicycle: "자전거",
  car: "차량",
  motorcycle: "오토바이",
  bus: "버스",
  truck: "트럭",
  "cell phone": "차량(휴대폰)",
};

const MIN_SCORE = 0.45;

export function webgl2Available() {
  try {
    if (typeof OffscreenCanvas !== "undefined" && !new OffscreenCanvas(1, 1).getContext("webgl2")) return false;
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

// 엔진이 실제로 한 프레임을 처리할 수 있는지 확인하는 용도
export function testFrame() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 48;
  c.getContext("2d")!.fillRect(0, 0, 64, 48);
  return c;
}

// MediaPipe는 실패를 console.error로도 남기는데, 여기서는 다음 엔진으로 넘어가므로 경고로 낮춘다.
export async function quietly<T>(fn: () => Promise<T>) {
  const orig = console.error;
  console.error = (...args: unknown[]) => console.warn("[인식 엔진 전환]", ...args);
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

async function mediapipe(delegate: "GPU" | "CPU"): Promise<Engine> {
  const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
  return quietly(async () => {
    const vision = await FilesetResolver.forVisionTasks("/mediapipe");
    const detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: "/models/efficientdet_lite0.tflite", delegate },
      runningMode: "VIDEO",
      scoreThreshold: MIN_SCORE,
      categoryAllowlist: Object.keys(LABELS),
    });
    try {
      detector.detectForVideo(testFrame(), 1);
    } catch (e) {
      detector.close();
      throw e;
    }
    return {
      id: delegate === "GPU" ? "mediapipe-gpu" : "mediapipe-cpu",
      label: `MediaPipe ${delegate}`,
      detect: async (video, now) =>
        detector.detectForVideo(video, now).detections.flatMap((d) => {
          const c = d.categories[0];
          const b = d.boundingBox;
          return c && b ? [{ name: c.categoryName, score: c.score, x: b.originX, y: b.originY, w: b.width, h: b.height }] : [];
        }),
      close: () => detector.close(),
    } satisfies Engine;
  });
}

// TF.js WASM 백엔드 준비. 물체 인식과 손 인식이 같이 쓴다
let tfWasmReady: Promise<void> | null = null;
export function prepareTfWasm() {
  tfWasmReady ??= (async () => {
    const tf = await import("@tensorflow/tfjs-core");
    const wasm = await import("@tensorflow/tfjs-backend-wasm");
    wasm.setWasmPaths("/tfjs/");
    await tf.setBackend("wasm");
    await tf.ready();
    await import("@tensorflow/tfjs-converter");
  })();
  return tfWasmReady;
}

async function tfjsWasm(): Promise<Engine> {
  await prepareTfWasm();
  const cocoSsd = await import("@tensorflow-models/coco-ssd");
  const model = await cocoSsd.load({ base: "lite_mobilenet_v2", modelUrl: "/models/coco-ssd/model.json" });
  await model.detect(testFrame());
  return {
    id: "tfjs-wasm",
    label: "TF.js WASM (CPU)",
    detect: async (video) =>
      (await model.detect(video, 10, MIN_SCORE))
        .filter((d) => d.class in LABELS)
        .map((d) => ({ name: d.class, score: d.score, x: d.bbox[0], y: d.bbox[1], w: d.bbox[2], h: d.bbox[3] })),
    close: () => model.dispose(),
  };
}

export async function createEngine(onTry?: (label: string) => void): Promise<{ engine: Engine; skipped: string[] }> {
  const skipped: string[] = [];
  const attempts: [string, () => Promise<Engine>][] = [];
  if (webgl2Available()) {
    attempts.push(["MediaPipe GPU", () => mediapipe("GPU")], ["MediaPipe CPU", () => mediapipe("CPU")]);
  } else {
    skipped.push("MediaPipe (WebGL2 없음)");
  }
  attempts.push(["TF.js WASM", tfjsWasm]);

  for (const [label, make] of attempts) {
    onTry?.(label);
    try {
      return { engine: await make(), skipped };
    } catch (e) {
      console.warn(`${label} 사용 불가, 다음 엔진으로 전환합니다.`, e);
      skipped.push(label);
    }
  }
  throw new Error(`사용 가능한 인식 엔진이 없습니다 (${skipped.join(", ")})`);
}
