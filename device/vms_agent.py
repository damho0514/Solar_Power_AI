"""전광판(VMS) 에이전트: 관제 화면이 정한 문구를 받아 전광판에 띄운다.

    python device/vms_agent.py --vms vms-zone --broker 192.168.0.10        # 스쿨존 전광판
    python device/vms_agent.py --vms vms-rightturn --broker 192.168.0.10   # 교차로 우회전 알리미

받음  streetlight/vms/<vms>/set     {"level": "idle|child|slow|danger", "text": "멈추세요", "sub": "보행자 앞 차량 접근", "ts": ms}
      (보존 메시지라 나중에 켜져도 마지막 문구를 바로 받는다)
상태  streetlight/vms/<vms>/status  "online" / "offline" (연결이 끊기면 브로커가 offline을 남긴다)

전광판 제조사마다 통신 방식(RS-485 시리얼, TCP, 제조사 HTTP API)이 달라서 실제 출력은 Controller.show()에 채운다.
지금은 터미널에 문구를 크게 찍는다. 태블릿·모니터를 전광판으로 쓸 때는 브라우저로 /vms?broker=ws://<브로커>:9001 을 연다.

안전장치: --stale-after 초(기본 60초) 넘게 새 문구가 없으면 기본 문구("어린이 보호구역 / 서행")로 돌아간다.
관제 서버·통신이 끊겼을 때 "멈추세요" 같은 경고가 계속 떠 있지 않게 하기 위해서다.
"""

import argparse
import json
import time

import paho.mqtt.client as mqtt

DEFAULT = {"level": "idle", "text": "어린이 보호구역", "sub": "서행"}
COLOR = {"idle": "\033[93m", "child": "\033[92m", "slow": "\033[33m", "danger": "\033[91m"}


class Controller:
    """실제 전광판 출력. 제조사 프로토콜에 맞춰 show()를 바꾼다 (예: pyserial로 RS-485 프레임 전송)."""

    def show(self, sign: dict):
        color = COLOR.get(sign.get("level", "idle"), "")
        print(f"\033[2J\033[H{color}\n\n    ███  {sign.get('text', '')}  ███\n\n    {sign.get('sub', '')}\033[0m\n", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vms", default="vms-zone")
    ap.add_argument("--broker", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--stale-after", type=float, default=60)
    args = ap.parse_args()

    out = Controller()
    status = f"streetlight/vms/{args.vms}/status"
    last = {"at": 0.0, "sign": DEFAULT}

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"vms-{args.vms}")
    client.will_set(status, "offline", qos=1, retain=True)

    def on_connect(c, *_):
        c.publish(status, "online", qos=1, retain=True)
        c.subscribe(f"streetlight/vms/{args.vms}/set", qos=1)

    def on_message(_c, _u, msg):
        try:
            sign = json.loads(msg.payload)
        except ValueError:
            return
        last["at"], last["sign"] = time.time(), sign
        out.show(sign)

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(args.broker, args.port, keepalive=30)
    client.loop_start()
    out.show(DEFAULT)
    try:
        while True:
            time.sleep(1)
            if last["sign"] is not DEFAULT and time.time() - last["at"] > args.stale_after:
                last["sign"] = DEFAULT
                out.show(DEFAULT)
    except KeyboardInterrupt:
        pass
    finally:
        client.publish(status, "offline", qos=1, retain=True)
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
