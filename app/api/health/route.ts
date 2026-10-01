// 운영 점검용. 누구에게나 "살아 있음"만 알려 주고, 설정 상태(AI 공급자·모델, 연동 여부, 배포 커밋)는
// HEALTH_TOKEN을 아는 사람에게만 보여 준다 (공격자가 구성을 정찰하지 못하게). 키 값은 어느 경우에도 내보내지 않는다.
//   curl -H "Authorization: Bearer $HEALTH_TOKEN" https://<배포 주소>/api/health

import { timingSafeEqual } from "node:crypto";
import { llmStatus } from "@/lib/llm";

export const dynamic = "force-dynamic";

const TOKEN = process.env.HEALTH_TOKEN ?? "";

function authorized(req: Request) {
  if (!TOKEN) return process.env.NODE_ENV === "development"; // 토큰을 안 정했으면 로컬 개발에서만 자세히
  const got = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ ok: true });
  return Response.json({
    ok: true,
    llm: llmStatus(),
    vworld: !!process.env.VWORLD_KEY,
    controlCenter: !!process.env.CONTROL_CENTER_WEBHOOK_URL,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  });
}
