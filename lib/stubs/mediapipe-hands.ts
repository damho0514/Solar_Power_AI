// @tensorflow-models/hand-pose-detection 이 import 하는 @mediapipe/hands 대체 모듈.
// 원본은 ESM export 가 없는 옛 스크립트라 번들러가 읽지 못한다. 우리는 runtime: "tfjs" 만 쓰므로 비워 둔다.
export class Hands {
  constructor() {
    throw new Error("@mediapipe/hands 런타임은 쓰지 않습니다. runtime: \"tfjs\" 를 쓰세요.");
  }
}
