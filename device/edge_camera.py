"""엣지 카메라: 라즈베리파이에서 사람·차를 인식해 인식 결과만 MQTT로 보낸다. 영상은 기기 밖으로 나가지 않는다.

라즈베리파이 실물:
    python device/edge_camera.py --camera cam-1 --broker 192.168.0.10 --source picamera2   # CSI 카메라 모듈
    python device/edge_camera.py --camera cam-1 --broker 192.168.0.10 --source 0           # USB 웹캠
노트북에서 시험:
    python device/edge_camera.py --camera cam-1 --source 0                                 # 노트북 웹캠
    python device/edge_camera.py --camera cam-1 --demo-image person.jpg                    # 사진이 좌우로 지나가는 가짜 영상

보냄  streetlight/camera/<camera>/detections
      {"ts": ms, "w": 폭, "h": 높이, "detections": [{"label": "person", "score": 0.8, "x": 0~1, "y": 0~1, "w": 0~1, "h": 0~1}]}
추적(번호·속도)과 이동 예측은 관제 화면이 한다 (lib/tracker.ts, lib/predictive.ts). 기기는 인식만 한다.

모델: TensorFlow Lite SSD MobileNet v1 (COCO, 8비트 양자화). 라즈베리파이 4에서 CPU만으로 초당 수 회.
"""

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
import paho.mqtt.client as mqtt
from ai_edge_litert.interpreter import Interpreter

HERE = Path(__file__).resolve().parent
WANTED = {"person", "bicycle", "car", "motorcycle", "bus", "truck", "cell phone"}  # 관제 화면 LABELS와 같게
MIN_SCORE = 0.6  # SSD MobileNet v1은 몸 일부에 점수 0.5 안팎의 박스를 덧붙이는 경우가 많아 브라우저(0.45)보다 높게 둔다


class Detector:
    def __init__(self):
        self.it = Interpreter(model_path=str(HERE / "models/detect.tflite"), num_threads=4)
        self.it.allocate_tensors()
        self.inp = self.it.get_input_details()[0]
        self.out = self.it.get_output_details()
        self.labels = (HERE / "models/labelmap.txt").read_text().splitlines()
        _, self.h, self.w, _ = self.inp["shape"]

    def __call__(self, frame_bgr: np.ndarray):
        x = cv2.resize(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB), (self.w, self.h))[None].astype(np.uint8)
        self.it.set_tensor(self.inp["index"], x)
        self.it.invoke()
        boxes, classes, scores, n = (self.it.get_tensor(d["index"]) for d in self.out)
        dets = []
        for (y0, x0, y1, x1), c, s in zip(boxes[0][: int(n[0])], classes[0], scores[0]):
            label = self.labels[int(c) + 1]  # 첫 줄 "???"는 배경
            if s >= MIN_SCORE and label in WANTED:
                dets.append({"label": label, "score": float(s), "x": float(x0), "y": float(y0), "w": float(x1 - x0), "h": float(y1 - y0)})
        return nms(dets)


def overlap(a, b):
    """(IoU, 작은 박스 중 겹친 비율)"""
    ix = max(0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    iy = max(0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    inter = ix * iy
    return inter / (a["w"] * a["h"] + b["w"] * b["h"] - inter + 1e-9), inter / (min(a["w"] * a["h"], b["w"] * b["h"]) + 1e-9)


def nms(dets, iou_thr=0.4, inside_thr=0.5):
    """같은 대상에 겹쳐 나온 박스는 점수가 높은 하나만 남긴다.
    IoU가 크거나, 작은 박스가 큰 박스 안에 절반 넘게 들어가 있으면 같은 대상으로 본다 (몸 일부에 붙은 박스)."""
    keep = []
    for d in sorted(dets, key=lambda d: -d["score"]):
        same = any(d["label"] == k["label"] and (o[0] >= iou_thr or o[1] >= inside_thr) for k in keep for o in [overlap(d, k)])
        if not same:
            keep.append(d)
    return keep


def frames(args):
    if args.demo_image:
        img = cv2.imread(args.demo_image)
        h, w = img.shape[:2]
        person = cv2.resize(img[:, int(w * 0.55) :], (200, 260))  # 사진 오른쪽의 사람
        t0 = time.time()
        while True:
            t = (time.time() - t0) % 5.5  # 4초 동안 지나가고 1.5초 비움
            canvas = np.full((480, 640, 3), 85, np.uint8)
            if t < 4:
                x = int(-200 + t / 4 * 840)
                a, b = max(0, x), min(640, x + 200)
                if b > a:
                    canvas[110:370, a:b] = person[:, a - x : b - x]
            yield canvas
    elif args.source == "picamera2":
        from picamera2 import Picamera2  # 라즈베리파이 OS에만 있음

        cam = Picamera2()
        cam.configure(cam.create_video_configuration(main={"size": (640, 480), "format": "RGB888"}))
        cam.start()
        while True:
            yield cam.capture_array()
    else:
        cap = cv2.VideoCapture(int(args.source) if args.source.isdigit() else args.source)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        while True:
            ok, frame = cap.read()
            if not ok:
                raise SystemExit("카메라에서 영상을 읽지 못했습니다")
            yield frame


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", default="cam-1")
    ap.add_argument("--broker", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--source", default="0", help="웹캠 번호, 영상 파일 경로, 또는 picamera2")
    ap.add_argument("--demo-image", help="카메라 대신 이 사진 속 사람이 좌우로 지나가는 가짜 영상을 쓴다")
    ap.add_argument("--fps", type=float, default=10)
    ap.add_argument("--seconds", type=float, default=0, help="이 시간만큼 돌고 끝냄 (0 = 계속)")
    args = ap.parse_args()

    detect = Detector()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"camera-{args.camera}")
    topic = f"streetlight/camera/{args.camera}"
    client.will_set(f"{topic}/status", "offline", qos=1, retain=True)
    client.connect(args.broker, args.port, keepalive=30)
    client.loop_start()
    client.publish(f"{topic}/status", "online", qos=1, retain=True)
    print(f"[{args.camera}] 브로커 연결됨, 인식 시작", flush=True)

    start = last_log = time.time()
    n = 0
    for frame in frames(args):
        t = time.time()
        dets = detect(frame)
        h, w = frame.shape[:2]
        client.publish(f"{topic}/detections", json.dumps({"ts": int(t * 1000), "w": w, "h": h, "detections": dets}))
        n += 1
        if t - last_log > 5:
            print(f"[{args.camera}] {n / (t - start):.1f} fps · 이번 프레임 {len(dets)}건", flush=True)
            last_log = t
        if args.seconds and t - start > args.seconds:
            break
        time.sleep(max(0, 1 / args.fps - (time.time() - t)))
    client.publish(f"{topic}/status", "offline", qos=1, retain=True).wait_for_publish(2)
    client.loop_stop()


if __name__ == "__main__":
    main()
