// 물체 인식 결과(프레임마다 따로 나오는 박스)를 "같은 대상"끼리 이어 붙여
// 번호·방향·속도를 붙이고, 몇 초 뒤 위치를 예측한다.
// 좌표는 모두 화면 폭·높이 기준 0~1이고, 거울처럼 좌우 반전된 값이다.

export type Detection = { label: string; score: number; x: number; y: number; w: number; h: number };

export type Track = {
  id: number;
  label: string;
  kind: "person" | "vehicle";
  score: number;
  box: { x: number; y: number; w: number; h: number };
  cx: number;
  cy: number;
  vx: number; // 화면 폭 / 초
  vy: number;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  trail: { x: number; y: number }[];
  confirmed: boolean;
};

const PERSON = new Set(["보행자"]);
const kindOf = (label: string): Track["kind"] => (PERSON.has(label) ? "person" : "vehicle");

const CONFIRM_HITS = 3; // 3프레임 연속으로 보여야 진짜 대상으로 인정 (깜빡이는 오인식 제거)
const LOST_MS = 700; // 이 시간 동안 안 보이면 사라진 것으로 처리
const MAX_JUMP = 0.25; // 한 프레임에 이 이상 튀면 다른 대상
const V_SMOOTH = 0.35;

function iou(a: Track["box"], b: Track["box"]) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

export function predict(t: Track, seconds: number) {
  return { x: t.cx + t.vx * seconds, y: t.cy + t.vy * seconds };
}

export function isMoving(t: Track) {
  return Math.abs(t.vx) > 0.06;
}

export class Tracker {
  tracks: Track[] = [];
  private nextId = 1;

  // 새 프레임의 인식 결과를 넣으면 확정된 추적 목록과, 이번 프레임에 새로 확정되거나 사라진 대상을 돌려준다.
  update(dets: Detection[], now: number) {
    const born: Track[] = [];
    const lost: Track[] = [];
    const used = new Set<number>();

    // 기존 대상마다 "지금쯤 여기 있겠지" 하는 예측 위치와 가장 잘 맞는 박스를 고른다.
    const pairs: { t: Track; d: number; cost: number }[] = [];
    for (const t of this.tracks) {
      const dt = (now - t.lastSeen) / 1000;
      const px = t.cx + t.vx * dt;
      const py = t.cy + t.vy * dt;
      const moved = { ...t.box, x: t.box.x + (px - t.cx), y: t.box.y + (py - t.cy) };
      dets.forEach((det, i) => {
        if (kindOf(det.label) !== t.kind) return;
        const dist = Math.hypot(det.x + det.w / 2 - px, det.y + det.h / 2 - py);
        if (dist > MAX_JUMP) return;
        pairs.push({ t, d: i, cost: dist - iou(moved, det) * 0.5 });
      });
    }
    pairs.sort((a, b) => a.cost - b.cost);

    const matched = new Set<Track>();
    for (const p of pairs) {
      if (matched.has(p.t) || used.has(p.d)) continue;
      matched.add(p.t);
      used.add(p.d);
      const det = dets[p.d];
      const t = p.t;
      const cx = det.x + det.w / 2;
      const cy = det.y + det.h / 2;
      const dt = Math.max(0.03, (now - t.lastSeen) / 1000);
      // 두 번째로 보인 순간은 실측 속도로 바로 시작하고, 이후엔 흔들림을 줄이려 부드럽게 따라간다
      const k = t.hits === 1 ? 1 : V_SMOOTH;
      t.vx += ((cx - t.cx) / dt - t.vx) * k;
      t.vy += ((cy - t.cy) / dt - t.vy) * k;
      t.cx = cx;
      t.cy = cy;
      t.box = { x: det.x, y: det.y, w: det.w, h: det.h };
      t.label = det.label;
      t.score = det.score;
      t.hits++;
      t.lastSeen = now;
      t.trail.push({ x: cx, y: cy });
      if (t.trail.length > 20) t.trail.shift();
      if (!t.confirmed && t.hits >= CONFIRM_HITS) {
        t.confirmed = true;
        born.push(t);
      }
    }

    this.tracks = this.tracks.filter((t) => {
      if (now - t.lastSeen <= LOST_MS) return true;
      if (t.confirmed) lost.push(t);
      return false;
    });

    dets.forEach((det, i) => {
      if (used.has(i)) return;
      const cx = det.x + det.w / 2;
      const cy = det.y + det.h / 2;
      this.tracks.push({
        id: this.nextId++,
        label: det.label,
        kind: kindOf(det.label),
        score: det.score,
        box: { x: det.x, y: det.y, w: det.w, h: det.h },
        cx,
        cy,
        vx: 0,
        vy: 0,
        hits: 1,
        firstSeen: now,
        lastSeen: now,
        trail: [{ x: cx, y: cy }],
        confirmed: false,
      });
    });

    return { active: this.tracks.filter((t) => t.confirmed && now - t.lastSeen < 250), born, lost };
  }
}
