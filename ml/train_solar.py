"""태양광 가로등 내일 발전량 예측.

실행: ml/.venv/bin/python ml/train_solar.py
출력: ml/results/solar.json         채점 결과
      public/models/solar-gbr.json  브라우저·서버용 모델 (Gradient Boosting 나무)
      ml/results/solar-parity.json  TS 구현이 Python과 같은 답을 내는지 확인용

데이터
- 날씨: Open-Meteo 과거 관측(재분석) 2022~2025년, 설치 지점 1곳 (SITE_LAT, SITE_LON)
- 과거 발전량: 실제 발전 기록이 없어서, 관측 일사량에 패널 물리식을 적용해 만든다 (pv_wh).
  현장 데이터가 생기면 pv_wh 자리에 실측값을 넣고 다시 학습하면 된다.
- 입력 특징은 기상청 단기예보에도 있는 값만 쓴다: 하늘상태(SKY), 강수 여부(PTY), 기온(TMP), 습도(REH)
  + 날짜·시각으로 계산하는 맑은 하늘 일사량.

평가: 2022~2024년으로 학습하고 2025년으로 시험한다. 시험 입력은 두 가지로 넣는다.
- 실제 날씨: 날씨를 완벽히 안다면 얼마나 맞는지 (모델의 상한)
- 과거 예보: 그날 실제로 나왔던 예보를 넣었을 때 (실전 성능)
"""

import json
import math
import os
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

ROOT = Path(__file__).resolve().parent.parent
LAT = float(os.environ.get("SITE_LAT", 37.5665))  # 기본값: 서울시청
LON = float(os.environ.get("SITE_LON", 126.9780))
PANEL_WP = 150  # 가로등 패널 정격 (W)
PERF_RATIO = 0.8  # 배선·인버터·먼지 손실
FEATURES = ["clear_ghi", "sky", "rain", "temp", "humidity", "hour"]
HOURLY = "shortwave_radiation,cloud_cover,temperature_2m,relative_humidity_2m,precipitation"
CACHE = ROOT / "ml/data"


def fetch(kind: str, start: str, end: str) -> pd.DataFrame:
    path = CACHE / f"weather-{kind}-{start}-{end}.csv"
    if path.exists():
        return pd.read_csv(path, parse_dates=["time"])
    host = "archive-api.open-meteo.com/v1/archive" if kind == "actual" else "historical-forecast-api.open-meteo.com/v1/forecast"
    url = f"https://{host}?latitude={LAT}&longitude={LON}&start_date={start}&end_date={end}&hourly={HOURLY}&timezone=Asia%2FSeoul"
    with urllib.request.urlopen(url, timeout=60) as r:
        h = json.load(r)["hourly"]
    df = pd.DataFrame(h).assign(time=lambda d: pd.to_datetime(d.time))
    CACHE.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    return df


def clear_sky_ghi(time: pd.Series) -> np.ndarray:
    """맑은 하늘 수평면 일사량 (W/m², Haurwitz 식). lib/solar.ts의 clearSkyGhi와 같은 식.
    Open-Meteo 시간값은 '직전 1시간 평균'이라 30분 앞을 기준으로 계산한다."""
    t = time - pd.Timedelta(minutes=30)
    doy = t.dt.dayofyear.to_numpy()
    hour = (t.dt.hour + t.dt.minute / 60).to_numpy()
    decl = np.radians(23.45 * np.sin(2 * np.pi * (284 + doy) / 365))
    b = 2 * np.pi * (doy - 81) / 364
    eot = 9.87 * np.sin(2 * b) - 7.53 * np.cos(b) - 1.5 * np.sin(b)  # 균시차 (분)
    solar_time = hour + (4 * (LON - 135) + eot) / 60  # 한국 표준시 기준 자오선 135°E
    ha = np.radians(15 * (solar_time - 12))
    lat = math.radians(LAT)
    cos_z = np.sin(lat) * np.sin(decl) + np.cos(lat) * np.cos(decl) * np.cos(ha)
    return np.where(cos_z > 0, 1098 * cos_z * np.exp(-0.059 / np.maximum(cos_z, 1e-6)), 0.0)


def to_sky(cloud_pct: pd.Series) -> np.ndarray:
    """운량(%) → 기상청 하늘상태: 0~5할 맑음(1), 6~8할 구름많음(3), 9~10할 흐림(4)."""
    tenths = np.round(cloud_pct.to_numpy() / 10)
    return np.select([tenths <= 5, tenths <= 8], [1, 3], 4)


def pv_wh(ghi: pd.Series, temp: pd.Series) -> np.ndarray:
    """1시간 발전량 (Wh). 셀 온도가 25°C보다 1도 오를 때마다 효율 0.4% 감소."""
    cell = temp + ghi * (45 - 20) / 800
    return np.maximum(0, PANEL_WP * ghi / 1000 * PERF_RATIO * (1 - 0.004 * (cell - 25)))


def features(w: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "clear_ghi": clear_sky_ghi(w.time),
            "sky": to_sky(w.cloud_cover),
            "rain": (w.precipitation >= 0.1).astype(int).to_numpy(),
            "temp": w.temperature_2m.to_numpy(),
            "humidity": w.relative_humidity_2m.to_numpy(),
            "hour": w.time.dt.hour.to_numpy(),
        }
    )


actual = pd.concat([fetch("actual", f"{y}-01-01", f"{y}-12-31") for y in (2022, 2023, 2024, 2025)], ignore_index=True)
actual = actual.dropna().reset_index(drop=True)
actual["target"] = pv_wh(actual.shortwave_radiation, actual.temperature_2m)
actual["date"] = (actual.time - pd.Timedelta(minutes=30)).dt.date

forecast = fetch("forecast", "2025-01-01", "2025-12-31").dropna().reset_index(drop=True)

train = actual[actual.time.dt.year < 2025]
test = actual[actual.time.dt.year == 2025].reset_index(drop=True)
# 과거 예보를 같은 시각의 실제 발전량에 붙인다
test_fc = forecast.merge(test[["time", "target", "date"]], on="time")

X_train = features(train)
gbr = GradientBoostingRegressor(n_estimators=300, max_depth=3, learning_rate=0.05, random_state=0)
gbr.fit(X_train.to_numpy(np.float32), train.target)

# 비교 기준 1: 맑은 하늘 일사량 × 하늘상태별 평균 비율 (학습 기간에서 계산)
ratio = (
    pd.DataFrame({"sky": X_train.sky, "r": train.shortwave_radiation / X_train.clear_ghi.where(X_train.clear_ghi > 50)})
    .dropna()
    .groupby("sky")
    .r.median()
)


def physics(w: pd.DataFrame) -> np.ndarray:
    f = features(w)
    return pv_wh(f.clear_ghi * f.sky.map(ratio).to_numpy() * np.where(f.rain == 1, 0.5, 1.0), w.temperature_2m)


def daily_score(df: pd.DataFrame, pred: np.ndarray) -> dict:
    d = pd.DataFrame({"date": df.date, "y": df.target, "p": pred}).groupby("date").sum()
    err = (d.p - d.y).abs()
    return {
        "days": int(len(d)),
        "mean_daily_wh": float(d.y.mean()),
        "mae_wh": float(err.mean()),
        "nmae": float(err.mean() / d.y.mean()),
        # 배터리 판단에 중요한 흐린 날: 실제 발전량이 평균의 절반 미만인 날
        "mae_wh_dark_days": float(err[d.y < d.y.mean() / 2].mean()),
    }


daily_actual = test.groupby("date").target.sum()
persist = daily_actual.shift(1).dropna()  # 비교 기준 2: 내일도 오늘과 같다
persist_err = (persist - daily_actual.loc[persist.index]).abs()

results = {
    "site": {"lat": LAT, "lon": LON, "panel_wp": PANEL_WP},
    "train_hours": int(len(train)),
    "test": {
        "gbr_actual_weather": daily_score(test, gbr.predict(features(test).to_numpy(np.float32))),
        "gbr_forecast_weather": daily_score(test_fc, gbr.predict(features(test_fc).to_numpy(np.float32))),
        "physics_forecast_weather": daily_score(test_fc, physics(test_fc)),
        "persistence": {"days": int(len(persist)), "mae_wh": float(persist_err.mean()), "nmae": float(persist_err.mean() / daily_actual.mean())},
    },
    "sky_ratio": {int(k): float(v) for k, v in ratio.items()},
    "feature_importance": dict(zip(FEATURES, map(float, gbr.feature_importances_))),
}
(ROOT / "ml/results").mkdir(exist_ok=True)
(ROOT / "ml/results/solar.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
for k, v in results["test"].items():
    print(f"{k:26s} 일 발전량 오차 {v['mae_wh']:.0f}Wh ({v['nmae']:.0%})" + (f" · 흐린 날 {v['mae_wh_dark_days']:.0f}Wh" if "mae_wh_dark_days" in v else ""))
print("2025년 일평균 실제 발전량", round(results["test"]["gbr_actual_weather"]["mean_daily_wh"]), "Wh")

trees = []
for est in gbr.estimators_[:, 0]:
    t = est.tree_
    trees.append(
        {
            "left": t.children_left.tolist(),
            "right": t.children_right.tolist(),
            "feature": t.feature.tolist(),
            "threshold": [float(v) for v in t.threshold],
            "value": [float(v) for v in t.value[:, 0, 0]],
        }
    )
(ROOT / "public/models/solar-gbr.json").write_text(
    json.dumps(
        {
            "features": FEATURES,
            "site": {"lat": LAT, "lon": LON},
            "panelWp": PANEL_WP,
            "init": float(gbr.init_.constant_[0][0]),
            "learningRate": gbr.learning_rate,
            "trees": trees,
        },
        separators=(",", ":"),
    )
)
sample = test_fc.sample(300, random_state=0)
(ROOT / "ml/results/solar-parity.json").write_text(
    json.dumps(
        {
            "time": sample.time.dt.strftime("%Y-%m-%dT%H:%M").tolist(),
            "clear_ghi": features(sample).clear_ghi.tolist(),
            "x": features(sample).to_numpy(float).tolist(),
            "pred": gbr.predict(features(sample).to_numpy(np.float32)).tolist(),
        }
    )
)
print("모델 저장:", f"{(ROOT / 'public/models/solar-gbr.json').stat().st_size / 1024:.0f}KB")
