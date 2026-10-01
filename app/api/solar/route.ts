// 내일 날씨 예보를 받아 시간별 태양광 발전량을 예측한다.
// 예보 출처: KMA_SERVICE_KEY 환경변수가 있으면 기상청 단기예보, 없으면 Open-Meteo(인증키 불필요).
// 설치 지점은 모델을 학습한 지점(public/models/solar-gbr.json의 site)을 쓴다.

import { rateLimit } from "@/lib/server/guard";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cloudToSky, latLonToGrid, predictHourWh, type HourWeather, type SolarModel } from "@/lib/solar";

const KMA_KEY = process.env.KMA_SERVICE_KEY;

// 한국 시각 기준 날짜 (YYYY-MM-DD), offsetDays일 뒤
function kstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 864e5).toISOString().slice(0, 10);
}

async function fromKma(lat: number, lon: number, date: string): Promise<HourWeather[]> {
  const { nx, ny } = latLonToGrid(lat, lon);
  // 발표 시각 02·05·08·11·14·17·20·23시, 발표 10분 뒤부터 조회 가능
  const now = new Date(Date.now() + 9 * 3600_000 - 10 * 60_000);
  let baseDate = now.toISOString().slice(0, 10).replaceAll("-", "");
  const h = now.getUTCHours();
  let base = [23, 20, 17, 14, 11, 8, 5, 2].find((b) => b <= h);
  if (base === undefined) {
    base = 23;
    baseDate = new Date(now.getTime() - 864e5).toISOString().slice(0, 10).replaceAll("-", "");
  }
  // 공공데이터포털 키는 "인코딩" 키(%가 들어 있음)와 "디코딩" 키 두 가지를 준다. 어느 쪽이든 받는다.
  const key = KMA_KEY!.includes("%") ? KMA_KEY! : encodeURIComponent(KMA_KEY!);
  const url =
    `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=${key}` +
    `&pageNo=1&numOfRows=1500&dataType=JSON&base_date=${baseDate}&base_time=${String(base).padStart(2, "0")}00&nx=${nx}&ny=${ny}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json().catch(() => null);
  const items = json?.response?.body?.items?.item as { category: string; fcstDate: string; fcstTime: string; fcstValue: string }[] | undefined;
  if (!items) throw new Error(`기상청 응답 오류: ${json?.response?.header?.resultMsg ?? res.status}`);

  const want = date.replaceAll("-", "");
  const byTime = new Map<string, Record<string, string>>();
  for (const it of items) {
    if (it.fcstDate !== want || !["SKY", "PTY", "TMP", "REH"].includes(it.category)) continue;
    const row = byTime.get(it.fcstTime) ?? {};
    row[it.category] = it.fcstValue;
    byTime.set(it.fcstTime, row);
  }
  return [...byTime.entries()]
    .filter(([, r]) => r.SKY && r.PTY && r.TMP && r.REH)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, r]) => ({
      time: `${date}T${t.slice(0, 2)}:00`,
      sky: (Number(r.SKY) >= 4 ? 4 : Number(r.SKY) >= 3 ? 3 : 1) as HourWeather["sky"],
      rain: (Number(r.PTY) > 0 ? 1 : 0) as HourWeather["rain"],
      temp: Number(r.TMP),
      humidity: Number(r.REH),
    }));
}

async function fromOpenMeteo(lat: number, lon: number, date: string): Promise<HourWeather[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=cloud_cover,temperature_2m,relative_humidity_2m,precipitation&forecast_days=3&timezone=Asia%2FSeoul`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Open-Meteo 응답 오류 ${res.status}`);
  const h = (await res.json()).hourly as Record<string, (number | null)[]> & { time: string[] };
  return h.time.flatMap((time, i) => {
    const [cc, temp, rh, pr] = [h.cloud_cover[i], h.temperature_2m[i], h.relative_humidity_2m[i], h.precipitation[i]];
    if (!time.startsWith(date) || cc === null || temp === null || rh === null || pr === null) return [];
    return [{ time, sky: cloudToSky(cc), rain: (pr >= 0.1 ? 1 : 0) as HourWeather["rain"], temp, humidity: rh }];
  });
}

// 내일 예보는 몇 시간 단위로만 바뀐다. 30분 동안 같은 답을 돌려줘 외부 API를 아끼고, 요청이 몰려도 버틴다
const TTL_MS = 30 * 60_000;
let memo: { at: number; date: string; body: unknown } | null = null;

export async function GET(req: Request) {
  const limited = rateLimit(req, "solar", 30, 60_000);
  if (limited) return limited;
  const today = kstDate(1);
  if (memo && memo.date === today && Date.now() - memo.at < TTL_MS) return Response.json(memo.body);
  const model: SolarModel = JSON.parse(await readFile(path.join(process.cwd(), "public/models/solar-gbr.json"), "utf8"));
  const { lat, lon } = model.site;
  const date = kstDate(1);
  let source = KMA_KEY ? "기상청 단기예보" : "Open-Meteo 예보 (기상청 인증키 없음)";
  let hours: HourWeather[];
  try {
    hours = KMA_KEY ? await fromKma(lat, lon, date) : await fromOpenMeteo(lat, lon, date);
  } catch (e) {
    console.error("[api solar] 예보 조회 실패", e);
    if (!KMA_KEY) return Response.json({ error: "기상 예보를 받지 못했어요. 잠시 뒤 다시 시도하세요." }, { status: 502 });
    // 기상청이 안 되면 Open-Meteo로 대신하고 그 사실을 알린다
    try {
      hours = await fromOpenMeteo(lat, lon, date);
    } catch (e2) {
      console.error("[api solar] Open-Meteo도 실패", e2);
      return Response.json({ error: "기상 예보를 받지 못했어요. 잠시 뒤 다시 시도하세요." }, { status: 502 });
    }
    source = "Open-Meteo 예보 (기상청 조회 실패로 대체)";
  }
  const hourly = hours.map((w) => ({ ...w, wh: predictHourWh(model, w) }));
  const body = { date, source, site: model.site, panelWp: model.panelWp, totalWh: hourly.reduce((s, h) => s + h.wh, 0), hourly };
  memo = { at: Date.now(), date, body };
  return Response.json(body);
}
