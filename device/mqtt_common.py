"""기기 프로그램(sensor_agent, edge_camera, vms_agent) 공통 MQTT 연결과 안전한 메시지 처리.

현장 설치(브로커가 device/mosquitto.secure.conf일 때)는 계정과 TLS를 쓴다:
    python device/sensor_agent.py --lamp L-05 --broker 192.168.0.10 --port 8883 --tls --cafile ca.crt --username L-05
    비밀번호는 명령줄(ps로 보임) 대신 환경변수 MQTT_PASSWORD로 넘긴다.
"""

import json
import math
import os
import re
import ssl
from typing import Any, Callable

import paho.mqtt.client as mqtt

MAX_PAYLOAD = 4096  # 명령·문구 메시지는 수백 바이트. 이보다 크면 버린다
# 터미널 조작 문자(ESC 등), 줄바꿈 외 제어 문자, 양방향 텍스트 조작 문자
_CONTROL = re.compile(r"[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]")


def add_mqtt_args(ap) -> None:
    ap.add_argument("--broker", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--username", default=os.environ.get("MQTT_USERNAME"), help="브로커 계정 (기본: 환경변수 MQTT_USERNAME)")
    ap.add_argument("--tls", action="store_true", help="TLS로 접속 (현장 설치 시 필수, 보통 --port 8883)")
    ap.add_argument("--cafile", help="브로커 인증서를 서명한 CA 파일 (자체 서명 인증서일 때)")


def make_client(args, client_id: str, will_topic: str) -> mqtt.Client:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    if args.username:
        client.username_pw_set(args.username, os.environ.get("MQTT_PASSWORD"))
    if args.tls:
        client.tls_set(ca_certs=args.cafile, cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLS_CLIENT)
    elif args.username and args.broker not in ("localhost", "127.0.0.1"):
        print("경고: 비밀번호를 암호화 없이 보냅니다. 현장에서는 --tls를 쓰세요.", flush=True)
    client.will_set(will_topic, "offline", qos=1, retain=True)
    return client


def safe_handler(name: str, handler: Callable[..., None]) -> Callable[..., None]:
    """메시지 처리 중 예외가 나도 MQTT 통신 스레드가 죽지 않게 감싼다 (paho 2.x는 예외가 나면 루프가 멈춘다)."""

    def wrapped(*a):
        try:
            handler(*a)
        except Exception as e:  # noqa: BLE001 - 어떤 메시지가 와도 기기는 계속 돌아야 한다
            print(f"[{name}] 잘못된 메시지를 버림: {type(e).__name__}", flush=True)

    return wrapped


def parse_object(payload: bytes) -> dict[str, Any] | None:
    """JSON 객체만 받는다. 너무 크거나, JSON이 아니거나, 객체가 아니면 None."""
    if len(payload) > MAX_PAYLOAD:
        return None
    try:
        v = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return None
    return v if isinstance(v, dict) else None


def finite_in(v: Any, lo: float, hi: float) -> float | None:
    """숫자이고 유한하며 [lo, hi] 안이면 그 값, 아니면 None. 문자열 "0.5"나 bool은 받지 않는다."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) and lo <= f <= hi else None


def clean_text(v: Any, max_len: int) -> str:
    """전광판·터미널에 그대로 찍을 문자열: 제어 문자를 지우고 길이를 자른다."""
    return _CONTROL.sub("", v)[:max_len] if isinstance(v, str) else ""
