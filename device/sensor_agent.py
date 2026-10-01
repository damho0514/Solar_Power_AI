"""가로등 센서 에이전트: 라즈베리파이에서 전압·전류·온도를 읽어 MQTT로 보내고, 관제 화면의 밝기 명령을 받는다.

라즈베리파이 실물:
    python device/sensor_agent.py --lamp L-05 --broker 192.168.0.10
    · 전압·전류: INA219 (I2C 0x40, LED 드라이버 입력단 션트)
    · 온도: DS18B20 (1-Wire, LED 모듈 방열판에 부착)
    · 밝기: GPIO18 PWM → LED 드라이버 디밍 입력

노트북에서 기기 없이 시험 (값을 흉내 내고, 원하면 고장도 흉내 낸다):
    python device/sensor_agent.py --lamp L-05 --simulate --interval 1 --fault overheat --fault-after 20

주고받는 메시지 (JSON)
    보냄  streetlight/<lamp>/sensor   {"ts": ms, "voltage": V, "current": A, "temp": °C, "brightness": 0~1}
    받음  streetlight/<lamp>/command  {"brightness": 0~1, "reason": "..."}
    상태  streetlight/<lamp>/status   "online" / "offline" (보존 메시지, 연결이 끊기면 브로커가 offline을 남긴다)

현장 설치 때는 --interval 60 (1분)으로 둔다. 고장 탐지 모델이 1분 간격 데이터로 학습되었다.

안전장치: 관제 서버의 밝기 명령이 --failsafe-after 초(기본 300초) 넘게 없으면 --failsafe-brightness(기본 100%)로 돌아간다.
서버·통신이 끊겼을 때 가로등이 어두운 채로 남지 않게 하기 위해서다.
"""

import argparse
import glob
import json
import random
import time

from mqtt_common import add_mqtt_args, clean_text, finite_in, make_client, parse_object, safe_handler


class RealHardware:
    def __init__(self):
        from gpiozero import PWMLED  # 라즈베리파이에서만 설치
        from ina219 import INA219

        self.ina = INA219(shunt_ohms=0.1, address=0x40)
        self.ina.configure()
        self.led = PWMLED(18)
        self.sensor_file = glob.glob("/sys/bus/w1/devices/28-*/w1_slave")[0]

    def set_brightness(self, b: float):
        self.led.value = b

    def read(self, brightness: float):
        with open(self.sensor_file) as f:
            raw = f.read()
        temp = int(raw.split("t=")[1]) / 1000
        return {"voltage": self.ina.voltage(), "current": self.ina.current() / 1000, "temp": temp}


class Simulated:
    """lib/sim.ts와 같은 물리식으로 값을 흉내 낸다."""

    def __init__(self, fault: str | None, fault_after: float):
        self.fault, self.fault_at = fault, time.time() + fault_after
        self.temp = 16.0

    def set_brightness(self, b: float):
        pass

    def read(self, brightness: float):
        age = max(0.0, time.time() - self.fault_at) if self.fault else 0.0
        on = self.fault and age > 0
        noise = lambda s: (random.random() + random.random() + random.random() - 1.5) * s
        voltage = 220 + noise(1.5) + (noise(18) + (random.uniform(-40, 30) if random.random() < 0.15 else 0) if on and self.fault == "voltage" else 0)
        factor = 1 + min(0.6, age * 0.012) if on and self.fault == "driver" else 1
        extra = min(35, age * 0.4) if on and self.fault == "overheat" else 0
        self.temp += (16 + 28 * brightness + extra - self.temp) * 0.2 + noise(0.3)
        return {"voltage": voltage, "current": (100 * brightness / 220 + 0.02) * factor + noise(0.008), "temp": self.temp}


def clean_reason(v) -> str:
    return clean_text(v, 20)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lamp", required=True, help="관제 화면의 가로등 번호, 예: L-05")
    ap.add_argument("--interval", type=float, default=60, help="측정 주기(초)")
    ap.add_argument("--simulate", action="store_true", help="센서 없이 값을 흉내 냄")
    ap.add_argument("--fault", choices=["voltage", "overheat", "driver"], help="--simulate에서 흉내 낼 고장")
    ap.add_argument("--fault-after", type=float, default=30, help="고장이 시작되는 시점(초)")
    ap.add_argument("--count", type=int, default=0, help="이 횟수만큼 보내고 끝냄 (0 = 계속)")
    ap.add_argument("--failsafe-after", type=float, default=300, help="이 시간(초) 동안 명령이 없으면 안전 밝기로")
    ap.add_argument("--failsafe-brightness", type=float, default=1.0)
    # 명령이 위조되더라도 밤에 완전히 꺼지지 않게 하는 하한 (관제 화면의 최저 대기 밝기는 20%)
    ap.add_argument("--min-brightness", type=float, default=0.1)
    add_mqtt_args(ap)
    args = ap.parse_args()

    hw = Simulated(args.fault, args.fault_after) if args.simulate else RealHardware()
    state = {"brightness": 0.2, "last_command": time.time(), "failsafe": False}
    base = f"streetlight/{args.lamp}"

    def on_connect(client, userdata, flags, reason, props):
        client.publish(f"{base}/status", "online", qos=1, retain=True)
        client.subscribe(f"{base}/command", qos=1)
        print(f"[{args.lamp}] 브로커 연결됨: {args.broker}:{args.port}", flush=True)

    def on_message(client, userdata, msg):
        cmd = parse_object(msg.payload)
        b = finite_in(cmd.get("brightness"), 0.0, 1.0) if cmd else None
        if b is None:
            print(f"[{args.lamp}] 형식이 틀린 밝기 명령을 버림", flush=True)
            return
        b = max(args.min_brightness, b)
        if abs(b - state["brightness"]) > 0.01:
            print(f"[{args.lamp}] 밝기 명령 {state['brightness']:.0%} → {b:.0%} ({clean_reason(cmd.get('reason'))})", flush=True)
        state.update(brightness=b, last_command=time.time(), failsafe=False)
        hw.set_brightness(b)

    client = make_client(args, f"sensor-{args.lamp}", f"{base}/status")
    client.on_connect, client.on_message = on_connect, safe_handler(args.lamp, on_message)
    client.connect(args.broker, args.port, keepalive=30)
    client.loop_start()

    sent = 0
    try:
        while not args.count or sent < args.count:
            if not state["failsafe"] and time.time() - state["last_command"] > args.failsafe_after:
                print(f"[{args.lamp}] {args.failsafe_after:.0f}초 동안 명령 없음 → 안전 밝기 {args.failsafe_brightness:.0%}", flush=True)
                state.update(brightness=args.failsafe_brightness, failsafe=True)
                hw.set_brightness(args.failsafe_brightness)
            r = hw.read(state["brightness"])
            msg = {"ts": int(time.time() * 1000), **{k: round(v, 4) for k, v in r.items()}, "brightness": state["brightness"]}
            client.publish(f"{base}/sensor", json.dumps(msg), qos=0)
            sent += 1
            time.sleep(args.interval)
    finally:
        client.publish(f"{base}/status", "offline", qos=1, retain=True).wait_for_publish(2)
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
