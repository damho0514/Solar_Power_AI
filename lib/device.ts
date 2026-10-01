// 관제 화면 ↔ 실제 기기(라즈베리파이) 연결. 브라우저에서 MQTT over WebSocket으로 브로커에 붙는다.
// 메시지 형식은 device/sensor_agent.py, device/edge_camera.py, device/vms_agent.py 상단 설명과 docs/integration.md에 있다.

import type { MqttClient } from "mqtt";
import type { OutboundEvent } from "./integration";
import type { Sign } from "./schoolzone";
import type { Reading } from "./sim";

export type SensorMessage = Reading & { ts: number };
export type DetectionMessage = {
  ts: number;
  w: number;
  h: number;
  detections: { label: string; score: number; x: number; y: number; w: number; h: number }[];
};

export type DeviceHandlers = {
  onSensor: (lampId: string, m: SensorMessage) => void;
  onDetections: (cameraId: string, m: DetectionMessage) => void;
  onStatus: (kind: "lamp" | "camera" | "vms", id: string, online: boolean) => void;
  onConnection: (state: "connected" | "reconnecting" | "closed", error?: string) => void;
};

export type DeviceLink = {
  sendBrightness: (lampId: string, brightness: number, reason: string) => void;
  sendSign: (vmsId: string, sign: Sign) => void; // 전광판 문구 (보존 메시지: 나중에 켜진 전광판도 마지막 문구를 받는다)
  sendEvent: (siteId: string, e: OutboundEvent) => void; // 현장 관제 PC·기록 장치용 사건
  close: () => void;
};

export async function connectDevices(url: string, h: DeviceHandlers): Promise<DeviceLink> {
  const mqtt = (await import("mqtt")).default;
  const client: MqttClient = mqtt.connect(url, { reconnectPeriod: 3000, connectTimeout: 5000, clientId: `dashboard-${Math.random().toString(16).slice(2, 8)}` });

  client.on("connect", () => {
    h.onConnection("connected");
    client.subscribe([
      "streetlight/+/sensor",
      "streetlight/+/status",
      "streetlight/camera/+/detections",
      "streetlight/camera/+/status",
      "streetlight/vms/+/status",
    ]);
  });
  client.on("reconnect", () => h.onConnection("reconnecting"));
  client.on("close", () => h.onConnection("closed"));
  client.on("error", (e) => h.onConnection("closed", e.message));

  client.on("message", (topic, payload) => {
    const parts = topic.split("/");
    try {
      if (parts[1] === "vms") {
        if (parts[3] === "status") h.onStatus("vms", parts[2], payload.toString() === "online");
      } else if (parts[1] === "camera") {
        if (parts[3] === "detections") h.onDetections(parts[2], JSON.parse(payload.toString()));
        else if (parts[3] === "status") h.onStatus("camera", parts[2], payload.toString() === "online");
      } else if (parts[2] === "sensor") {
        h.onSensor(parts[1], JSON.parse(payload.toString()));
      } else if (parts[2] === "status") {
        h.onStatus("lamp", parts[1], payload.toString() === "online");
      }
    } catch (e) {
      console.warn("잘못된 MQTT 메시지", topic, e);
    }
  });

  return {
    sendBrightness: (lampId, brightness, reason) =>
      client.publish(`streetlight/${lampId}/command`, JSON.stringify({ brightness: Math.round(brightness * 100) / 100, reason }), { qos: 1 }),
    sendSign: (vmsId, sign) =>
      client.publish(`streetlight/vms/${vmsId}/set`, JSON.stringify({ ...sign, ts: Date.now() }), { qos: 1, retain: true }),
    sendEvent: (siteId, e) => client.publish(`streetlight/zone/${siteId}/event`, JSON.stringify(e), { qos: 1 }),
    close: () => client.end(true),
  };
}
