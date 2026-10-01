// 이동 매크로 1~3번: 화면 버튼과 숫자 키(1·2·3)로 실행한다.
// (예전에는 핑거 스냅으로 셌지만, 🤏 집기와 손 모양이 비슷해 오작동이 많아 손동작에서는 뺐다)

// 매크로 번호 → 이동할 대상
export type MacroTarget = "child" | "person" | "cam";
// short: 버튼 이름, going: 이동 중 안내, missing: 대상이 없을 때 안내
export const MACROS: Record<1 | 2 | 3, { target: MacroTarget; label: string; short: string; going: string; missing: string }> = {
  1: { target: "child", label: "어린이", short: "어린이", going: "어린이를 따라가는 중", missing: "지금 보이는 어린이가 없어요" },
  2: { target: "person", label: "보행자", short: "보행자", going: "보행자를 따라가는 중", missing: "지금 보이는 보행자가 없어요" },
  3: { target: "cam", label: "현재 카메라 위치", short: "카메라", going: "현재 카메라 위치로 이동", missing: "카메라 구간을 찾지 못했어요" },
};
