# 연동 안내: 통합관제센터 · 전광판 · 엣지 장비

관제센터, 전광판 제조사, 현장 설치 업체 담당자용 문서입니다. DAMO 안심 가로등과 무엇을 주고받는지 정리했습니다.

## 1. 통합관제센터 (웹훅)

위험 사건이 생기면 DAMO 서버가 관제센터 주소로 HTTP POST를 보냅니다. 2초마다 최대 50건씩 묶어 보내고, 실패하면 다시 보냅니다. 서버 쪽 대기열은 최대 200건입니다.

### 설정 (서버 환경변수)

| 변수 | 필수 | 설명 |
|---|---|---|
| `CONTROL_CENTER_WEBHOOK_URL` | 예 | 사건을 받을 주소. https를 권장합니다. 비어 있으면 전송하지 않습니다. |
| `CONTROL_CENTER_TOKEN` | 아니오 | 있으면 `Authorization: Bearer <토큰>` 헤더를 붙입니다. |
| `CONTROL_CENTER_SECRET` | 아니오 | 있으면 `X-Damo-Timestamp: <유닉스 초>`와, `"<timestamp>.<본문>"`의 HMAC-SHA256 서명 `X-Damo-Signature: sha256=<hex>`를 붙입니다. |

주소는 서버 환경변수로만 정합니다. 브라우저가 임의의 주소를 지정할 수는 없습니다.

중계 서버(`/api/events`)는 로그인 없이 열려 있습니다. 서버는 허용한 필드만으로 사건을 다시 만들고, 현장 정보(`site`)를 서버 값으로 덮어써요. 또 IP별 횟수 제한, 다른 사이트에서 보낸 요청 차단, 같은 사건 ID 재전송 차단, 10분 지난 사건 거부를 합니다. 그래도 누구나 형식에 맞는 사건을 만들어 보낼 수는 있으니 다음을 지켜 주세요.
- 관제센터는 이 사건을 **참고 정보**로 다루고, 출동 같은 조치 전에 영상이나 현장으로 확인하세요.
- 공개 시연 사이트에는 웹훅 주소를 넣지 마세요.

### 본문

```json
{
  "sentAt": "2026-10-01T05:12:03.120Z",
  "events": [
    {
      "type": "damo.zone.event",
      "version": 1,
      "id": "zone-damo-es-1790000000000-17",
      "occurredAt": "2026-10-01T05:12:01.004Z",
      "site": { "id": "zone-damo-es", "name": "다모초등학교 앞 어린이보호구역" },
      "kind": "speeding",
      "label": "과속",
      "severity": "warning",
      "source": "camera",
      "message": "차량 #12 43km/h (제한 30)",
      "speedKmh": 43,
      "limitKmh": 30,
      "clip": true
    }
  ]
}
```

| 필드 | 값 |
|---|---|
| `kind` | `speeding` 과속, `conflict` 보행자 충돌 위험, `parking` 불법 주정차, `rightturn` 우회전 위험. `crossing`(보행자 횡단)은 보내지 않습니다. |
| `severity` | `warning` 또는 `critical`. 충돌 위험과 우회전 위험이 `critical`입니다. |
| `source` | `camera`는 실측, `sim`은 시뮬레이션입니다. `sim`은 화면에서 "시뮬레이션 사건도 보내기"를 켰을 때만 옵니다. |
| `speedKmh` | 화면 이동 거리로 환산한 **추정값**입니다. 단속 근거로 쓸 수 없습니다. |
| `clip` | 현장 기기에 사건 전후 영상(모자이크 처리)이 저장됐는지 여부입니다. 영상 자체는 보내지 않습니다. |

`id`는 사건마다 고유하므로 중복 수신을 거르는 키로 쓰세요. 응답이 2xx가 아니면 실패로 보고 다시 보냅니다.

### 서명 확인 예시 (Node.js)

받는 쪽은 서명과 함께 시각도 확인해야 가로챈 요청을 나중에 다시 보내는 공격(재전송)을 막을 수 있습니다.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret) {
  const ts = Number(headers["x-damo-timestamp"]);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false; // 5분 넘게 차이 나면 거부
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex"));
  const got = Buffer.from(String(headers["x-damo-signature"] ?? ""));
  return got.length === expected.length && timingSafeEqual(got, expected); // 길이가 다르면 timingSafeEqual이 예외를 낸다
}
```

`rawBody`는 JSON으로 다시 직렬화한 값이 아니라 받은 바이트 그대로여야 합니다. 같은 사건 `id`가 다시 오면 무시하세요.

## 2. 현장 MQTT

노트북 한 대 시연은 `mosquitto -c device/mosquitto.conf`로 브로커를 띄웁니다. 이 설정은 이 컴퓨터 안(127.0.0.1)에서만 접속을 받습니다. 포트 1883은 기기 프로그램용, 9001은 브라우저용(WebSocket)입니다. 화면에서는 시설 점검 → 실제 장비 연결로 접속합니다.

### MQTT 보안 (현장 설치)

다른 기기(라즈베리파이)를 붙이는 현장에서는 `device/mosquitto.secure.conf`를 씁니다. 익명 브로커를 그대로 쓰면 같은 네트워크의 누구나 가로등을 끄거나 전광판 문구를 바꿀 수 있기 때문입니다.

1. **계정:** 계정 이름은 기기 이름과 같게 만듭니다.
   ```bash
   mosquitto_passwd -c device/passwd dashboard
   mosquitto_passwd device/passwd L-05      # 가로등마다
   mosquitto_passwd device/passwd cam-1     # 카메라마다
   mosquitto_passwd device/passwd vms-zone  # 전광판마다
   ```
2. **인증서:** `device/certs/`에 `ca.crt`, `server.crt`, `server.key`를 둡니다. 기기에는 `ca.crt`만 배포합니다.
3. **권한:** `device/mosquitto.acl`이 정합니다. 밝기 명령과 전광판 문구는 `dashboard`만 보낼 수 있고, 각 기기는 자기 토픽에만 씁니다.
4. **기기 실행:** 비밀번호는 명령줄 대신 환경변수로 넘깁니다(명령줄은 `ps`로 보입니다).
   ```bash
   MQTT_PASSWORD=... python device/sensor_agent.py --lamp L-05 --broker 192.168.0.10 --port 8883 --tls --cafile ca.crt --username L-05
   ```
5. **관제 화면:** 브로커 주소에 계정을 넣습니다. 예: `wss://dashboard:<비밀번호>@192.168.0.10:9443`.

화면과 `/vms` 페이지는 이 컴퓨터, 사설망(10.x, 172.16~31.x, 192.168.x), `.local`, 지금 사이트와 같은 주소의 브로커에만 붙습니다. 링크로 바깥 브로커를 지정해 가짜 문구를 띄우는 것을 막기 위해서예요.

기기 프로그램은 형식이 틀린 메시지(4KB 초과, JSON 아님, 숫자 범위 밖)를 버리고 계속 돕니다. 가로등은 명령이 와도 최소 밝기 10%(`--min-brightness`) 아래로 내려가지 않습니다. 전광판은 문구의 제어 문자를 지웁니다.

| 토픽 | 방향 | 내용 |
|---|---|---|
| `streetlight/<lamp>/sensor` | 가로등 → 관제 | `{"ts","voltage","current","temp","brightness"}` |
| `streetlight/<lamp>/command` | 관제 → 가로등 | `{"brightness": 0~1, "reason"}` |
| `streetlight/camera/<cam>/detections` | 엣지 카메라 → 관제 | `{"ts","w","h","detections":[{"label","score","x","y","w","h"}]}`. 스쿨존 판단에도 쓰입니다. |
| `streetlight/vms/<vms>/set` | 관제 → 전광판 | `{"level":"idle\|child\|slow\|danger","text","sub","ts"}`. 보존 메시지라 나중에 켜진 전광판도 마지막 문구를 받습니다. |
| `streetlight/vms/<vms>/status` | 전광판 → 관제 | `online` / `offline` (연결이 끊기면 브로커가 offline을 남김) |
| `streetlight/zone/<site>/event` | 관제 → 현장 기록 장치 | 웹훅과 같은 사건 JSON 한 건 |
| `streetlight/<lamp>/status`, `streetlight/camera/<cam>/status` | 기기 → 관제 | `online` / `offline` |

전광판 ID는 `vms-zone`(보호구역)과 `vms-rightturn`(교차로 우회전 알리미)입니다.

## 3. 전광판

- **실제 전광판:** `python device/vms_agent.py --vms vms-zone --broker <브로커 IP>`. 제조사마다 통신 방식(RS-485, TCP, HTTP)이 다르므로 `Controller.show()`에 출력 코드를 채웁니다. 60초 넘게 새 문구가 없으면 기본 문구로 돌아갑니다.
- **태블릿·모니터:** 브라우저로 `/vms`(보호구역) 또는 `/vms?id=rt`(우회전 알리미)를 엽니다.
  - 같은 브라우저의 관제 화면과는 자동으로 동기화됩니다.
  - 다른 기기와 맞추려면 `/vms?broker=ws://<브로커 IP>:9001`을 붙입니다. 이때 그 화면이 MQTT 전광판 장비로 동작합니다.
  - 화면을 누르면 전체 화면이 되고, 켜 두는 동안 화면이 꺼지지 않습니다.

| level | 뜻 | 예시 문구 |
|---|---|---|
| `idle` | 평상시 | 어린이 보호구역 / 제한속도 30km/h |
| `child` | 보행자 있음 | 어린이 보호 / 보행자가 있어요 · 서행 |
| `slow` | 과속·주정차 | 43km/h / 속도를 줄이세요 · 제한 30 |
| `danger` | 충돌·우회전 위험 | 멈추세요 / 보행자 앞 차량 접근 |

## 4. 사건 영상

- **저장 방식:** 화면 카메라가 위험 사건을 잡으면 사건 전 4초와 후 4초를 초당 6장(320×240)으로 저장합니다. 저장 위치는 그 기기의 브라우저(IndexedDB)입니다.
- **개인정보:** 얼굴·번호판 모자이크는 화면 설정과 상관없이 항상 입히고, 원본은 저장하지 않습니다.
- **보관 기간:** 1, 3, 7, 30일 중에서 고를 수 있고, 지나면 자동으로 지웁니다.
- **전달:** 관제센터에서 요청하면 스쿨존 → 사건 영상에서 동영상(webm 또는 mp4)으로 내려받아 전달합니다.
- **엣지 카메라:** 엣지 카메라 사건은 인식 결과만 오기 때문에 영상이 없습니다(`clip: false`). 현장 영상 보관이 필요하면 엣지 장치에 같은 방식의 저장 기능을 넣어야 합니다.
