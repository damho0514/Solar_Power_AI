// 스쿨존 사건을 통합관제센터로 전달하는 중계. 형식은 docs/integration.md.
// 관제센터 주소는 서버 환경변수로만 정한다 (브라우저가 아무 주소로나 보내게 하지 않기 위해).
//   CONTROL_CENTER_WEBHOOK_URL  사건을 받을 주소 (https)
//   CONTROL_CENTER_TOKEN        있으면 Authorization: Bearer <토큰>
//   CONTROL_CENTER_SECRET       있으면 본문의 HMAC-SHA256을 X-Damo-Signature: sha256=<hex> 로 붙인다

import { createHmac } from "node:crypto";
import type { OutboundEvent } from "@/lib/integration";

const URL_ = process.env.CONTROL_CENTER_WEBHOOK_URL ?? "";
const TOKEN = process.env.CONTROL_CENTER_TOKEN ?? "";
const SECRET = process.env.CONTROL_CENTER_SECRET ?? "";
const KINDS = new Set(["speeding", "conflict", "parking", "rightturn", "crossing"]);

const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

function valid(e: Partial<OutboundEvent>): e is OutboundEvent {
  return (
    e.type === "damo.zone.event" &&
    e.version === 1 &&
    str(e.id, 120) &&
    str(e.occurredAt, 40) &&
    !Number.isNaN(Date.parse(e.occurredAt!)) &&
    KINDS.has(e.kind as string) &&
    str(e.label, 40) &&
    ["info", "warning", "critical"].includes(e.severity as string) &&
    ["camera", "sim"].includes(e.source as string) &&
    str(e.message, 500) &&
    typeof e.clip === "boolean" &&
    (e.speedKmh === undefined || typeof e.speedKmh === "number") &&
    (e.limitKmh === undefined || typeof e.limitKmh === "number")
  );
}

export async function GET() {
  return Response.json({ configured: URL_ !== "" });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { events?: unknown[] } | null;
  const events = Array.isArray(body?.events) ? body.events : null;
  if (!events || events.length === 0 || events.length > 50) return Response.json({ error: "events는 1~50개 배열이어야 해요" }, { status: 400 });
  if (!events.every((e) => valid(e as Partial<OutboundEvent>))) return Response.json({ error: "사건 형식이 맞지 않아요" }, { status: 400 });
  if (!URL_) return Response.json({ configured: false, forwarded: 0 });

  const payload = JSON.stringify({ events, sentAt: new Date().toISOString() });
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "damo-streetlight/1" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (SECRET) headers["X-Damo-Signature"] = `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
  try {
    const res = await fetch(URL_, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return Response.json({ configured: true, forwarded: 0, error: `관제센터 응답 ${res.status}` }, { status: 502 });
    return Response.json({ configured: true, forwarded: events.length });
  } catch (e) {
    return Response.json({ configured: true, forwarded: 0, error: `관제센터에 연결하지 못했어요: ${e instanceof Error ? e.message : e}` }, { status: 502 });
  }
}
