"""가로등 고장 탐지: 규칙 vs 비지도(Isolation Forest, 로버스트 z) vs 지도(Random Forest).

실행: ml/.venv/bin/python ml/train_fault.py
입력: ml/data/train.csv, ml/data/test.csv  (npx tsx scripts/export-dataset.ts 로 생성)
출력: ml/results/fault.json          채점 결과
      public/models/fault-zscore.json 브라우저용 이상 탐지 (정상 데이터의 중앙값·MAD)
      public/models/fault-rf.json     브라우저용 고장 종류 분류 모델
      ml/results/fault-parity.json    브라우저 구현이 Python과 같은 답을 내는지 확인용

Isolation Forest는 비교용으로만 학습한다. 학습 범위를 벗어난 값(강한 고장)을 정상 데이터의
가장 끝값과 같은 점수로 매기는 한계 때문에, 이 데이터에서는 로버스트 z보다 나빴다.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import classification_report

ROOT = Path(__file__).resolve().parent.parent
FEATURES = ["v_std", "v_range", "temp_gap", "temp_gap_slope", "cur_ratio", "cur_ratio_slope", "brightness"]
KINDS = ["driver", "overheat", "voltage"]
SIGNALS = FEATURES[:-1]  # 밝기는 고장 신호가 아니라 운전 조건이라 이상 점수에서 뺀다
FALSE_ALARM_RATE = 0.001  # 비지도 방법의 경보 기준: 정상 데이터의 0.1%만 넘도록
Z_PERSIST = 5  # 로버스트 z: 5분 연속 이상일 때만 경보
RF_PERSIST = 3  # Random Forest: 3분 연속 같은 종류일 때만 경보

train = pd.read_csv(ROOT / "ml/data/train.csv")
test = pd.read_csv(ROOT / "ml/data/test.csv").sort_values(["run", "lamp", "minute"]).reset_index(drop=True)
X_train, X_test = train[FEATURES].to_numpy(np.float32), test[FEATURES].to_numpy(np.float32)

# 1) Isolation Forest: 정상 데이터만으로 학습 (고장 데이터가 없어도 쓸 수 있는 방법)
iforest = IsolationForest(n_estimators=100, max_samples=256, random_state=0)
normal_train = X_train[train.label == "normal"]
iforest.fit(normal_train)
threshold = float(np.quantile(iforest.score_samples(normal_train), FALSE_ALARM_RATE))  # 이보다 낮으면 이상

# 2) 로버스트 z: 특징마다 정상 데이터의 중앙값과 MAD(중앙 절대 편차)를 배우고, 가장 크게 벗어난 특징의 z를 점수로
normal_df = train.loc[train.label == "normal", SIGNALS]
median = normal_df.median()
mad = (normal_df - median).abs().median() * 1.4826  # 정규분포면 표준편차와 같아지도록


def zscore(df: pd.DataFrame) -> np.ndarray:
    return ((df[SIGNALS] - median) / mad).abs().max(axis=1).to_numpy()


z_threshold = float(np.quantile(zscore(normal_df), 1 - FALSE_ALARM_RATE))


def persist(flag: np.ndarray, k: int) -> np.ndarray:
    """k분 연속으로 참일 때만 참. 브라우저(lib/ml.ts)도 같은 방식으로 센다."""
    s = pd.Series(flag.astype(int), index=test.index)
    return (s.groupby([test.run, test.lamp]).transform(lambda x: x.rolling(k, min_periods=k).sum()) == k).to_numpy()


# 3) Random Forest: 정상 + 고장 종류 라벨로 학습
rf = RandomForestClassifier(n_estimators=40, max_depth=10, min_samples_leaf=5, n_jobs=-1, random_state=0)
rf.fit(X_train, train.label)

rf_pred = rf.predict(X_test)
rf_same = np.ones(len(test), dtype=bool)
for k in range(1, RF_PERSIST):  # 같은 가로등에서 k분 전과 같은 종류로 판정했는지
    prev = pd.Series(rf_pred, index=test.index).groupby([test.run, test.lamp]).shift(k)
    rf_same &= (prev == rf_pred).to_numpy()
test = test.assign(
    iforest=np.where(iforest.score_samples(X_test) < threshold, "anomaly", "normal"),
    zscore=np.where(persist(zscore(test) > z_threshold, Z_PERSIST), "anomaly", "normal"),
    rf_raw=rf_pred,
    rf=np.where(rf_same, rf_pred, "normal"),
)


def score(df: pd.DataFrame, col: str) -> dict:
    """사건 단위 채점. 한 가로등의 고장 한 건 = 사건 하나."""
    alarm = df[col] != "normal"
    faults = df[df.label != "normal"]
    events = []
    for (run, lamp), g in faults.groupby(["run", "lamp"]):
        hits = g[g[col] != "normal"]
        right_kind = hits if col in ("iforest", "zscore") else hits[hits[col] == g.label.iloc[0]]
        first = right_kind.fault_age.min() if len(right_kind) else None
        events.append({"kind": g.label.iloc[0], "severity": g.severity.iloc[0], "latency": first})
    ev = pd.DataFrame(events)
    caught = ev.latency.notna()

    # 오경보: 정상 가로등에서 경보가 새로 켜진 횟수, 가로등 1대·1일(24시간) 기준
    normal = df[df.label == "normal"].sort_values(["run", "lamp", "minute"])
    on = normal[col] != "normal"
    starts = on & ~on.groupby([normal.run, normal.lamp]).shift(fill_value=False)
    lamp_days = len(normal) / 60 / 24

    sev_bins = pd.cut(ev.severity, [0.35, 0.55, 0.75, 1.0], include_lowest=True, labels=["약함", "중간", "강함"])
    return {
        "events": int(len(ev)),
        "detected": int(caught.sum()),
        "detection_rate": float(caught.mean()),
        "median_latency_min": float(ev.latency.median()) if caught.any() else None,
        "false_alarms_per_lamp_day": float(starts.sum() / lamp_days),
        "detection_rate_by_kind": {k: float(caught[ev.kind == k].mean()) for k in KINDS},
        "median_latency_by_kind": {k: float(ev.latency[(ev.kind == k) & caught].median()) for k in KINDS},
        "detection_rate_by_severity": {str(b): float(caught[sev_bins == b].mean()) for b in sev_bins.cat.categories},
        "row_alarm_rate_on_faults": float(alarm[df.label != "normal"].mean()),
    }


results = {
    "rows": {"train": int(len(train)), "test": int(len(test))},
    "methods": {c: score(test, c) for c in ["rule", "iforest", "zscore", "rf_raw", "rf"]},
    "rf_feature_importance": dict(zip(FEATURES, map(float, rf.feature_importances_))),
    "iforest_threshold": threshold,
    "zscore_threshold": z_threshold,
    "persist": {"zscore": Z_PERSIST, "rf": RF_PERSIST},
}
(ROOT / "ml/results").mkdir(exist_ok=True)
(ROOT / "ml/results/fault.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))

print(classification_report(test.label, test.rf_raw, digits=3))
for name, r in results["methods"].items():
    print(
        f"{name:8s} 탐지 {r['detected']}/{r['events']} ({r['detection_rate']:.0%}) "
        f"중앙 지연 {r['median_latency_min']}분  오경보 {r['false_alarms_per_lamp_day']:.2f}회/대·일  "
        f"강도별 {r['detection_rate_by_severity']}"
    )


# 브라우저용으로 나무 구조를 그대로 내보낸다 (lib/trees.ts가 같은 방식으로 계산)
def export_tree(t, with_value: bool):
    tr = t.tree_
    out = {
        "left": tr.children_left.tolist(),
        "right": tr.children_right.tolist(),
        "feature": tr.feature.tolist(),
        "threshold": [round(float(v), 6) for v in tr.threshold],
    }
    if with_value:
        v = tr.value[:, 0, :]
        v = v / v.sum(axis=1, keepdims=True)
        out["value"] = [[round(float(p), 5) for p in row] if l == -1 else [] for row, l in zip(v, tr.children_left)]
    else:
        out["samples"] = tr.n_node_samples.tolist()
    return out


models = ROOT / "public/models"
(models / "fault-zscore.json").write_text(
    json.dumps(
        {
            "signals": SIGNALS,
            "median": median.tolist(),
            "mad": mad.tolist(),
            "threshold": z_threshold,
            "persist": Z_PERSIST,
        }
    )
)
(models / "fault-rf.json").write_text(
    json.dumps(
        {
            "features": FEATURES,
            "classes": rf.classes_.tolist(),
            "persist": RF_PERSIST,
            "trees": [export_tree(t, True) for t in rf.estimators_],
        },
        separators=(",", ":"),
    )
)

sample = X_test[np.random.default_rng(0).choice(len(X_test), 500, replace=False)]
(ROOT / "ml/results/fault-parity.json").write_text(
    json.dumps(
        {
            "x": sample.astype(float).tolist(),
            "zscore": zscore(pd.DataFrame(sample, columns=FEATURES)).tolist(),
            "rf": rf.predict_proba(sample).tolist(),
        }
    )
)
print("모델 저장:", *(f"{p.name} {p.stat().st_size / 1024:.0f}KB" for p in models.glob("fault-*.json")))
