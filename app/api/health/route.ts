// 운영 점검용: AI·연동 설정이 서버에 들어가 있는지만 알려 준다 (키 값은 내보내지 않음).

import { llmStatus } from "@/lib/llm";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    llm: llmStatus(),
    vworld: !!process.env.VWORLD_KEY,
    controlCenter: !!process.env.CONTROL_CENTER_WEBHOOK_URL,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  });
}
