"use client";

// 전광판 화면. 태블릿이나 두 번째 모니터에 띄워 실제 전광판처럼 쓴다.
//   /vms              스쿨존 전광판 (같은 브라우저의 관제 화면과 자동 동기화)
//   /vms?id=rt        교차로 우회전 알리미
//   /vms?broker=ws://192.168.0.10:9001   MQTT 전광판 장비로 동작 (다른 기기의 관제 화면과 동기화)
// 화면을 누르면 전체 화면이 되고, 켜 두는 동안 화면이 꺼지지 않게 한다.

import { useEffect, useState } from "react";
import type { Sign } from "@/lib/schoolzone";
import { VMS_IDS, listenVms, type VmsId } from "@/lib/vms";

const WAITING: Sign = { level: "idle", text: "연결 대기 중", sub: "관제 화면을 켜 주세요" };

export default function VmsPage() {
  const [id, setId] = useState<VmsId>("main");
  const [sign, setSign] = useState<Sign>(WAITING);
  const [via, setVia] = useState("같은 브라우저의 관제 화면");
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const vid: VmsId = q.get("id") === "rt" ? "rt" : "main";
    setId(vid);
    const update = (s: Sign) => {
      setSign(s);
      setAt(Date.now());
    };
    const stopLocal = listenVms((m) => m.id === vid && update(m.sign));

    // MQTT 전광판 장비 모드: 문구를 구독하고, 켜져 있음을 알린다 (끊기면 브로커가 offline을 남김)
    const broker = q.get("broker");
    let end: (() => void) | null = null;
    if (broker) {
      setVia(`MQTT ${broker}`);
      void import("mqtt").then(({ default: mqtt }) => {
        const device = VMS_IDS[vid];
        const status = `streetlight/vms/${device}/status`;
        const c = mqtt.connect(broker, { reconnectPeriod: 3000, will: { topic: status, payload: "offline", qos: 1, retain: true } });
        c.on("connect", () => {
          c.publish(status, "online", { qos: 1, retain: true });
          c.subscribe(`streetlight/vms/${device}/set`);
        });
        c.on("message", (_t, p) => {
          try {
            update(JSON.parse(p.toString()) as Sign);
          } catch {}
        });
        end = () => {
          c.publish(status, "offline", { qos: 1, retain: true });
          c.end();
        };
      });
    }

    // 화면 꺼짐 방지 (지원하는 브라우저만)
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});

    return () => {
      stopLocal();
      end?.();
      void lock?.release();
    };
  }, []);

  return (
    <main
      className={`vms-screen vms-${sign.level}`}
      onClick={() => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
      }}
    >
      <div className="vms-face">
        <span className="vms-screen-tag">{id === "rt" ? "우회전 알리미" : "어린이 보호구역"}</span>
        <span className="vms-text">{sign.text}</span>
        <span className="vms-sub">{sign.sub}</span>
      </div>
      <p className="vms-foot">
        {via} · {at ? `마지막 갱신 ${new Date(at).toLocaleTimeString("ko-KR")}` : "아직 받은 문구 없음"} · 화면을 누르면 전체 화면
      </p>
    </main>
  );
}
