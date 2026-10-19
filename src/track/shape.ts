// Lightweight 2D analysis of a track loop: resampled outline, start/finish
// position, rotation sense and corners. No three.js, so the UI can use it.
import type { LatLon } from './osm';

const R = 6378137;
const STEP = 2; // metres between samples

export interface Corner {
  frac: number; // apex position along the lap (point order), 0..1
  right: boolean; // turns right when driven in point order
  angle: number; // total heading change, radians (positive)
}

export interface TrackShape {
  x: Float64Array; // local metres, x east
  y: Float64Array; // local metres, y SOUTH (screen / SVG orientation)
  n: number;
  length: number;
  startFrac: number; // start/finish line position along the lap
  clockwise: boolean; // rotation sense when driven in point order
  corners: Corner[];
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function analyzeShape(points: LatLon[]): TrackShape {
  const m = points.length;
  let lat0 = 0;
  let lon0 = 0;
  for (const p of points) {
    lat0 += p[0] / m;
    lon0 += p[1] / m;
  }
  const k = Math.cos((lat0 * Math.PI) / 180);
  const px = points.map((p) => (((p[1] - lon0) * Math.PI) / 180) * R * k);
  const py = points.map((p) => -(((p[0] - lat0) * Math.PI) / 180) * R);

  // Resample the closed polyline at uniform arc length.
  const cum = [0];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    cum.push(cum[i] + Math.hypot(px[j] - px[i], py[j] - py[i]));
  }
  const length = cum[m];
  const n = Math.max(48, Math.round(length / STEP));
  let x = new Float64Array(n);
  let y = new Float64Array(n);
  for (let s = 0, seg = 0; s < n; s++) {
    const d = (s / n) * length;
    while (seg < m - 1 && cum[seg + 1] < d) seg++;
    const j = (seg + 1) % m;
    const t = (d - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    x[s] = px[seg] + (px[j] - px[seg]) * t;
    y[s] = py[seg] + (py[j] - py[seg]) * t;
  }
  // Two light smoothing passes (matches the 3D track's treatment).
  for (let pass = 0; pass < 2; pass++) {
    const nx = new Float64Array(n);
    const ny = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let ax = 0;
      let ay = 0;
      for (let w = -2; w <= 2; w++) {
        const q = (i + w + n) % n;
        ax += x[q];
        ay += y[q];
      }
      nx[i] = ax / 5;
      ny[i] = ay / 5;
    }
    x = nx;
    y = ny;
  }

  const heading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    heading[i] = Math.atan2(y[j] - y[i], x[j] - x[i]);
  }

  // Start/finish: ~65% of the way down the longest straight.
  const straight: boolean[] = [];
  for (let i = 0; i < n; i++) straight.push(Math.abs(wrap(heading[(i + 3) % n] - heading[(i - 3 + n) % n])) < 0.12);
  let bestLen = 0;
  let bestStart = 0;
  for (let i = 0; i < n; i++) {
    if (!straight[i] || straight[(i - 1 + n) % n]) continue;
    let len = 0;
    while (straight[(i + len) % n] && len < n) len++;
    if (len > bestLen) {
      bestLen = len;
      bestStart = i;
    }
  }
  const startFrac = bestLen ? ((bestStart + Math.floor(bestLen * 0.65)) % n) / n : 0;

  // Rotation sense: with y pointing south, a positive shoelace sum is clockwise on screen.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += x[i] * y[j] - x[j] * y[i];
  }

  // Corners: runs of meaningful curvature with enough total turn.
  const step = length / n;
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = wrap(heading[i] - heading[(i - 1 + n) % n]) / step;
  const curv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let w = -3; w <= 3; w++) a += raw[(i + w + n) % n];
    curv[i] = a / 7;
  }
  const THRESH = 1 / 45;
  const corners: Corner[] = [];
  const firstCalm = Array.from(curv).findIndex((c) => Math.abs(c) < THRESH);
  if (firstCalm >= 0) {
    let i = 0;
    while (i < n) {
      const idx = (firstCalm + i) % n;
      if (Math.abs(curv[idx]) < THRESH) {
        i++;
        continue;
      }
      const sign = Math.sign(curv[idx]);
      let total = 0;
      let peak = 0;
      let apex = idx;
      let gap = 0;
      while (i < n) {
        const q = (firstCalm + i) % n;
        const c = curv[q];
        if (Math.sign(c) === sign && Math.abs(c) >= THRESH) {
          gap = 0;
          total += c * step;
          if (Math.abs(c) > peak) {
            peak = Math.abs(c);
            apex = q;
          }
        } else if (++gap > 4 || (Math.sign(c) !== sign && Math.abs(c) >= THRESH)) break;
        i++;
      }
      if (Math.abs(total) > (22 * Math.PI) / 180) corners.push({ frac: apex / n, right: sign > 0, angle: Math.abs(total) });
    }
  }

  return { x, y, n, length, startFrac, clockwise: area > 0, corners };
}

/** Corners in race order for a direction, starting after the start/finish line. */
export function cornersInRaceOrder(shape: TrackShape, reverse: boolean): Corner[] {
  const rel = (c: Corner) => {
    const d = reverse ? shape.startFrac - c.frac : c.frac - shape.startFrac;
    return ((d % 1) + 1) % 1;
  };
  return [...shape.corners].sort((a, b) => rel(a) - rel(b));
}
