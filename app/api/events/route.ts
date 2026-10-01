// 스쿨존 사건을 통합관제센터로 전달하는 중계. 형식은 docs/integration.md.
// 관제센터 주소는 서버 환경변수로만 정한다 (브라우저가 아무 주소로나 보내게 하지 않기 위해).
//   CONTROL_CENTER_WEBHOOK_URL  사건을 받을 주소 (https)
//   CONTROL_CENTER_TOKEN        있으면 Authorization: Bearer <토큰>
//   CONTROL_CENTER_SECRET       있으면 X-Damo-Timestamp(초)와 "<timestamp>.<본문>"의 HMAC-SHA256을 X-Damo-Signature: sha256=<hex>로 붙인다
//
// 보안: 이 라우트는 로그인 없이 열려 있어 누구나 호출할 수 있다. 그래서
// - 받은 객체를 그대로 보내지 않고 허용한 필드만으로 다시 만든다 (현장 정보 site는 서버 값으로 덮어쓴다)
// - IP별 횟수 제한, 다른 사이트에서 보낸 요청 차단, 이미 보낸 사건 ID 재전송 차단을 한다
// - 관제센터는 source가 "camera"/"sim"인 이 중계 사건을 참고용으로 다뤄야 한다. 공개 시연 사이트에는 웹훅 주소를 넣지 말 것.

import { createHmac } from "node:crypto";
import { SITE, type OutboundEvent } from "@/lib/integration";
import { cleanText, guardJson } from "@/lib/server/guard";

const URL_ = process.env.CONTROL_CENTER_WEBHOOK_URL ?? "";
const TOKEN = process.env.CONTROL_CENTER_TOKEN ?? "";
const SECRET = process.env.CONTROL_CENTER_SECRET ?? "";
const KINDS = new Set<OutboundEvent["kind"]>(["speeding", "conflict", "parking", "rightturn", "crossing"]);
const SEVERITIES = new Set<OutboundEvent["severity"]>(["info", "warning", "critical"]);
const SOURCES = new Set<OutboundEvent["source"]>(["camera", "sim"]);
const MAX_EVENTS = 20;
const MAX_AGE_MS = 10 * 60_000; // 10분보다 오래된 사건이나 미래 시각 사건은 받지 않는다

// 최근에 보낸 사건 ID (같은 사건을 여러 번 보내 관제센터를 어지럽히지 못하게)
const sent = new Map<string, number>();
function seen(id: string, now: number) {
  if (sent.size > 5000) for (const [k, t] of sent) if (now - t > MAX_AGE_MS) sent.delete(k);
  if (sent.has(id)) return true;
  sent.set(id, now);
  return false;
}

const optNum = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

// 허용한 필드만 골라 새 객체를 만든다. 하나라도 틀리면 null
function rebuild(raw: unknown, now: number): OutboundEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.type !== "damo.zone.event" || e.version !== 1) return null;
  if (typeof e.id !== "string" || !/^[\w.:-]{1,120}$/.test(e.id)) return null;
  const at = typeof e.occurredAt === "string" ? Date.parse(e.occurredAt) : NaN;
  if (!Number.isFinite(at) || at > now + 60_000 || now - at > MAX_AGE_MS) return null;
  if (!KINDS.has(e.kind as OutboundEvent["kind"]) || !SEVERITIES.has(e.severity as OutboundEvent["severity"])) return null;
  if (!SOURCES.has(e.source as OutboundEvent["source"]) || typeof e.clip !== "boolean") return null;
  if (typeof e.label !== "string" || typeof e.message !== "string") return null;
  return {
    type: "damo.zone.event",
    version: 1,
    id: e.id,
    occurredAt: new Date(at).toISOString(),
    site: SITE,
    kind: e.kind as OutboundEvent["kind"],
    label: cleanText(e.label, 40),
    severity: e.severity as OutboundEvent["severity"],
    source: e.source as OutboundEvent["source"],
    message: cleanText(e.message, 500),
    speedKmh: optNum(e.speedKmh, 0, 300),
    limitKmh: optNum(e.limitKmh, 0, 200),
    clip: e.clip,
  };
}

export async function GET() {
  return Response.json({ configured: URL_ !== "" });
}

export async function POST(req: Request) {
  const g = await guardJson(req, { name: "events", limit: 30, maxBytes: 32_000 });
  if (!g.ok) return g.res;
  const list = (g.body as { events?: unknown })?.events;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_EVENTS) return Response.json({ error: `events는 1~${MAX_EVENTS}개 배열이어야 해요` }, { status: 400 });
  const now = Date.now();
  const events = list.map((e) => rebuild(e, now));
  if (events.some((e) => e === null)) return Response.json({ error: "사건 형식이 맞지 않거나 너무 오래된 사건이에요" }, { status: 400 });
  const fresh = (events as OutboundEvent[]).filter((e) => !seen(e.id, now));
  if (!URL_) return Response.json({ configured: false, forwarded: 0 });
  if (fresh.length === 0) return Response.json({ configured: true, forwarded: 0, duplicate: true });

  const payload = JSON.stringify({ events: fresh, sentAt: new Date(now).toISOString() });
  const ts = String(Math.floor(now / 1000));
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "damo-streetlight/1", "X-Damo-Timestamp": ts };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (SECRET) headers["X-Damo-Signature"] = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${payload}`).digest("hex")}`;
  try {
    const res = await fetch(URL_, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!res.ok) return Response.json({ configured: true, forwarded: 0, error: `관제센터 응답 ${res.status}` }, { status: 502 });
    return Response.json({ configured: true, forwarded: fresh.length });
  } catch (e) {
    console.error("[api events] 관제센터 전송 실패", e);
    return Response.json({ configured: true, forwarded: 0, error: "관제센터에 연결하지 못했어요" }, { status: 502 });
  }
}
