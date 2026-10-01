// 핑거 스냅(딱!) 인식과 횟수 세기. 웹캠 손 관절 좌표만 쓴다 (마이크는 쓰지 않는다).
//
// 스냅 한 번 = 엄지와 중지를 맞대고(준비) → 짧은 순간에 떨어지며 중지가 손바닥 쪽으로 접힌다.
// - 준비: 엄지 끝–중지 끝 거리가 손 크기의 35% 미만이고, 검지보다 중지가 엄지에 더 가깝다
//   (엄지·검지로 집는 "끌기"와 구분)
// - 딱: 준비 상태에서 0.35초 안에 엄지–중지가 60% 넘게 벌어지고, 중지 끝이 손목 쪽으로 15% 넘게 다가온다
//   스냅 순간에는 손이 흔들려 인식이 한두 프레임 끊기기도 해서, 끊겼다 돌아온 손이 위 조건이면 스냅으로 친다
// 연달아 친 횟수(1~3)를 마지막 스냅 뒤 0.7초 동안 기다렸다가 확정한다.

import type { Point } from "./gesture";

const ARM_RATIO = 0.35;
const RELEASE_RATIO = 0.6;
const FOLD = 0.85; // 중지 끝–손목 거리가 준비 때의 85% 아래로 줄면 접힌 것
const SNAP_WINDOW_MS = 350;
const ARM_FRAMES = 2;
const SETTLE_MS = 700;
const MAX_COUNT = 3;

const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export type SnapState = { armed: boolean; pending: number; fired: number | null };

export class SnapDetector {
  private armFrames = 0;
  private armedAt = -Infinity; // 마지막으로 준비 자세였던 시각
  private baseReach = 0; // 준비 때 중지 끝–손목 거리 (손 크기 비율)
  private count = 0;
  private lastSnap = -Infinity;

  reset() {
    this.armFrames = 0;
    this.armedAt = -Infinity;
    this.count = 0;
    this.lastSnap = -Infinity;
  }

  // 준비 자세인가: 다른 손동작(끌기 등)을 잠시 멈추는 데도 쓴다
  static isArmPose(lm: Point[]) {
    const size = Math.max(1e-6, d(lm[0], lm[9]));
    const mid = d(lm[4], lm[12]) / size;
    const idx = d(lm[4], lm[8]) / size;
    return mid < ARM_RATIO && mid < idx * 0.8;
  }

  update(lm: Point[] | null, now: number): SnapState {
    let fired: number | null = null;

    if (lm) {
      const size = Math.max(1e-6, d(lm[0], lm[9]));
      const mid = d(lm[4], lm[12]) / size;
      const reach = d(lm[12], lm[0]) / size;
      if (SnapDetector.isArmPose(lm)) {
        this.armFrames++;
        this.armedAt = now;
        this.baseReach = this.armFrames === 1 ? reach : Math.max(this.baseReach * 0.7 + reach * 0.3, reach);
      } else {
        const wasArmed = this.armFrames >= ARM_FRAMES && now - this.armedAt <= SNAP_WINDOW_MS;
        if (wasArmed && mid > RELEASE_RATIO && reach < this.baseReach * FOLD) {
          this.count = Math.min(MAX_COUNT, this.count + 1);
          this.lastSnap = now;
        }
        // 준비 자세가 아니면 다시 준비해야 다음 스냅을 센다 (한 번 딱에 두 번 세지 않게)
        if (now - this.armedAt > SNAP_WINDOW_MS || wasArmed) this.armFrames = 0;
      }
    } else if (now - this.armedAt > SNAP_WINDOW_MS) {
      this.armFrames = 0;
    }

    if (this.count > 0 && now - this.lastSnap > SETTLE_MS) {
      fired = this.count;
      this.count = 0;
    }
    return { armed: this.armFrames >= ARM_FRAMES, pending: this.count, fired };
  }
}

// 매크로 번호 → 이동할 대상
export type MacroTarget = "child" | "person" | "cam";
// short: 버튼 이름, going: 이동 중 안내, missing: 대상이 없을 때 안내
export const MACROS: Record<1 | 2 | 3, { target: MacroTarget; label: string; short: string; going: string; missing: string }> = {
  1: { target: "child", label: "어린이", short: "어린이", going: "어린이를 따라가는 중", missing: "지금 보이는 어린이가 없어요" },
  2: { target: "person", label: "보행자", short: "보행자", going: "보행자를 따라가는 중", missing: "지금 보이는 보행자가 없어요" },
  3: { target: "cam", label: "현재 카메라 위치", short: "카메라", going: "현재 카메라 위치로 이동", missing: "카메라 구간을 찾지 못했어요" },
};
