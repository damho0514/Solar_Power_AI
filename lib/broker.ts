// 브라우저가 붙을 MQTT 브로커 주소 검사와 받은 전광판 문구 검사.
// 링크(?broker=)나 입력란으로 바깥 브로커를 지정하면 공격자가 보낸 가짜 경고 문구를 띄우거나
// 관제 화면에 가짜 측정값을 흘려 넣을 수 있어서, 현장 브로커가 있을 만한 주소만 허용한다.

import type { Sign } from "./schoolzone";

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^169\.254\./];

export function checkBrokerUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "브로커 주소 형식이 아니에요 (예: ws://192.168.0.10:9001)" };
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return { ok: false, reason: "ws:// 또는 wss:// 주소만 쓸 수 있어요" };
  const h = u.hostname.replace(/^\[|\]$/g, "");
  const local =
    h === "localhost" || h === "::1" || h.endsWith(".local") || PRIVATE.some((r) => r.test(h)) || (typeof location !== "undefined" && h === location.hostname);
  if (!local) return { ok: false, reason: "현장 브로커(이 컴퓨터, 사설망 주소, .local)만 연결할 수 있어요" };
  return { ok: true, url: u.toString() };
}

const LEVELS = new Set<Sign["level"]>(["idle", "child", "slow", "danger"]);
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").slice(0, n) : "");

// MQTT로 받은 문구를 허용한 모양으로만 받는다. 틀리면 null
export function toSign(raw: unknown): Sign | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!LEVELS.has(r.level as Sign["level"])) return null;
  const text = clip(r.text, 24);
  return text ? { level: r.level as Sign["level"], text, sub: clip(r.sub, 40) } : null;
}
