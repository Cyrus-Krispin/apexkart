import * as THREE from 'three';
import type { LatLon, TrackData } from '../track/osm';
import { analyzeShape } from '../track/shape';

const R = 6378137;
const SPACING = 1; // metres between centreline samples
const CELL = 12; // spatial grid cell, metres

/** The kerb band beyond the asphalt edge, metres. */
export const KERB = 1.1;
/** How far past the asphalt edge the kart's centre may go before the lap is invalid. */
export const LIMIT_GRACE = 2.4;

export interface Projection {
  lat0: number;
  lon0: number;
  toLocal(lat: number, lon: number): { x: number; z: number };
}

export function makeProjection(center: LatLon): Projection {
  const [lat0, lon0] = center;
  const k = Math.cos((lat0 * Math.PI) / 180);
  return {
    lat0,
    lon0,
    toLocal: (lat, lon) => ({
      x: (((lon - lon0) * Math.PI) / 180) * R * k,
      z: -(((lat - lat0) * Math.PI) / 180) * R,
    }),
  };
}

export interface Nearest {
  i: number; // sample index
  s: number; // distance along the lap, 0..length
  offset: number; // signed lateral offset from centreline (+ = right of travel)
  dist: number; // |offset| essentially
}

/** The kart left its own part of the lap and turned up on another one (KartPhysics.rejoin). */
export interface Rejoin {
  from: number; // sample index it left
  to: number; // sample index it turned up on
  gain: number; // metres along the lap: + = forward (a cut), - = backward
}

/** Centreline sampled every metre, oriented in race direction, index 0 = start/finish. */
export class TrackModel {
  readonly proj: Projection;
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array; // unit tangent
  readonly tz: Float32Array;
  readonly curv: Float32Array; // signed curvature (1/m), + = turning right
  readonly n: number;
  readonly length: number;
  readonly halfWidth: number;
  readonly runoff = 6.5; // barrier distance beyond the track edge
  private grid = new Map<string, number[]>();

  constructor(
    readonly data: TrackData,
    readonly reverse: boolean,
  ) {
    this.proj = makeProjection(data.center);
    this.halfWidth = Math.max(data.width, 8.5) / 2;

    // Project + drop near-duplicate points.
    const raw: THREE.Vector3[] = [];
    for (const [lat, lon] of data.points) {
      const p = this.proj.toLocal(lat, lon);
      const v = new THREE.Vector3(p.x, 0, p.z);
      if (!raw.length || raw[raw.length - 1].distanceTo(v) > 0.5) raw.push(v);
    }
    if (raw.length > 2 && raw[0].distanceTo(raw[raw.length - 1]) < 0.5) raw.pop();

    const curve = new THREE.CatmullRomCurve3(raw, true, 'centripetal');
    const count = Math.max(64, Math.round(curve.getLength() / SPACING));
    let pts = curve.getSpacedPoints(count).slice(0, count);

    // OSM centrelines are often a bit jagged; two light smoothing passes.
    for (let pass = 0; pass < 2; pass++) {
      const w = 3;
      pts = pts.map((_, i) => {
        const acc = new THREE.Vector3();
        for (let k = -w; k <= w; k++) acc.add(pts[(i + k + count) % count]);
        return acc.divideScalar(2 * w + 1);
      });
    }

    // Same start line as the 2D track art (both are parametrised by arc length).
    let start = Math.round(analyzeShape(data.points).startFrac * count) % count;
    if (reverse) {
      pts = pts.slice().reverse();
      start = count - 1 - start;
    }
    pts = pts.slice(start).concat(pts.slice(0, start));

    this.n = count;
    this.px = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.tx = new Float32Array(count);
    this.tz = new Float32Array(count);
    this.curv = new Float32Array(count);
    pts.forEach((p, i) => {
      this.px[i] = p.x;
      this.pz[i] = p.z;
    });
    let L = 0;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const dx = this.px[j] - this.px[i];
      const dz = this.pz[j] - this.pz[i];
      const d = Math.hypot(dx, dz) || 1;
      L += d;
      this.tx[i] = dx / d;
      this.tz[i] = dz / d;
    }
    this.length = L;
    const rawCurv = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      // cross(t_prev, t) in the x/z plane; positive = clockwise from above = right turn
      const cross = this.tx[a] * this.tz[i] - this.tz[a] * this.tx[i];
      rawCurv[i] = cross / SPACING;
    }
    for (let i = 0; i < count; i++) {
      let acc = 0;
      for (let k = -4; k <= 4; k++) acc += rawCurv[(i + k + count) % count];
      this.curv[i] = acc / 9;
    }

    for (let i = 0; i < count; i++) {
      const key = this.cell(this.px[i], this.pz[i]);
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key)!.push(i);
    }
  }

  private cell(x: number, z: number) {
    return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  }

  /** Lateral unit normal pointing to the right of travel. */
  normal(i: number): [number, number] {
    return [-this.tz[i], this.tx[i]];
  }

  /** (x, z) measured from sample i: distance along the lap and signed offset. */
  private project(i: number, x: number, z: number): Nearest {
    const dx = x - this.px[i];
    const dz = z - this.pz[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    const offset = dx * -this.tz[i] + dz * this.tx[i];
    let s = i * (this.length / this.n) + along;
    s = ((s % this.length) + this.length) % this.length;
    return { i, s, offset, dist: Math.abs(offset) };
  }

  private d2(i: number, x: number, z: number) {
    const dx = x - this.px[i];
    const dz = z - this.pz[i];
    return dx * dx + dz * dz;
  }

  /** Metres along the lap from sample a to sample b, wrapped to ±length/2 (+ = forward). */
  gain(a: number, b: number): number {
    let g = (b - a) * (this.length / this.n);
    if (g > this.length / 2) g -= this.length;
    else if (g < -this.length / 2) g += this.length;
    return g;
  }

  /**
   * Continuous progress: walk from sample `from` to the nearest centreline sample along the lap.
   * It stays on the part of the lap the kart is on however close another part comes (hairpin
   * infields, crossings), so cutting across shows as distance from this part, never as a jump.
   */
  follow(x: number, z: number, from: number): Nearest {
    const n = this.n;
    let i = ((from % n) + n) % n;
    let d = this.d2(i, x, z);
    // Samples can bunch up (uneven OSM spacing), so allow a long walk; a kart moves < 0.3 m a step.
    for (let k = 0; k < 256; k++) {
      const a = i + 1 === n ? 0 : i + 1;
      const b = i === 0 ? n - 1 : i - 1;
      const da = this.d2(a, x, z);
      const db = this.d2(b, x, z);
      if (da < d && da <= db) {
        i = a;
        d = da;
      } else if (db < d) {
        i = b;
        d = db;
      } else break;
    }
    return this.project(i, x, z);
  }

  /**
   * Could a kart at sample `from` be on sample `i`? Always, on today's flat tracks. A bridge's
   * elevation profile plugs in here (e.g. |elev[i] - elev[from]| < 1.8 m), so a kart under the
   * deck never rejoins onto it; closest() already asks.
   */
  sameLevel(_from: number, _i: number): boolean {
    return true;
  }

  /** The nearest centreline point anywhere on the lap (that a kart at sample `from` could be on). */
  closest(x: number, z: number, from = -1): Nearest {
    let best = -1;
    let bestD = Infinity;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    // Grow the searched block until the best hit is provably the nearest: anything outside a block
    // of radius r cells is more than r * CELL away.
    for (let r = 1; r <= 63; r = r * 2 + 1) {
      for (let gx = cx - r; gx <= cx + r; gx++)
        for (let gz = cz - r; gz <= cz + r; gz++) {
          const cell = this.grid.get(`${gx},${gz}`);
          if (!cell) continue;
          for (const i of cell) {
            const d = this.d2(i, x, z);
            if (d < bestD && (from < 0 || this.sameLevel(from, i))) {
              bestD = d;
              best = i;
            }
          }
        }
      if (bestD <= (r * CELL) ** 2) return this.project(best, x, z);
    }
    for (let i = 0; i < this.n; i++) {
      const d = this.d2(i, x, z);
      if (d < bestD && (from < 0 || this.sameLevel(from, i))) {
        bestD = d;
        best = i;
      }
    }
    return this.project(best < 0 ? Math.max(0, from) : best, x, z);
  }

  /** Half-width plus the grace: beyond this offset from its own part of the lap, the lap is invalid. */
  get limit(): number {
    return this.halfWidth + LIMIT_GRACE;
  }

  private minLap = 0;
  /**
   * The shortest a lap can legally be (the kart's centre kept inside the track limits), less a
   * margin: a backstop that catches any shortcut or teleport the progress rules miss.
   */
  get minLapLength(): number {
    if (!this.minLap) this.minLap = shortestLine(this, this.limit) * 0.97 - 5;
    return this.minLap;
  }

  /**
   * Nearest centreline point. With `hint` (the last index) it looks within 40 samples of it, to
   * stay on the same part of the lap at crossovers, and re-acquires from the whole lap when the
   * point is past that part's limits and on another part's road, or nowhere near it. Karts use
   * follow() instead (continuous progress with flagged rejoins).
   */
  nearest(x: number, z: number, hint = -1): Nearest {
    if (hint >= 0) {
      let best = hint;
      let bestD = Infinity;
      for (let k = -40; k <= 40; k++) {
        const i = (hint + k + this.n) % this.n;
        const d = this.d2(i, x, z);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (bestD <= this.limit ** 2) return this.project(best, x, z);
      const other = this.closest(x, z);
      if (other.dist > this.halfWidth + KERB && bestD <= (this.halfWidth + this.runoff + 4) ** 2) return this.project(best, x, z);
      return other;
    }
    return this.closest(x, z);
  }

  /** Position + heading at distance s along the lap. */
  at(s: number): { x: number; z: number; heading: number; i: number } {
    const f = ((((s / this.length) * this.n) % this.n) + this.n) % this.n;
    const i = Math.floor(f);
    const j = (i + 1) % this.n;
    const t = f - i;
    return {
      x: this.px[i] + (this.px[j] - this.px[i]) * t,
      z: this.pz[i] + (this.pz[j] - this.pz[i]) * t,
      heading: Math.atan2(this.tx[i], this.tz[i]),
      i,
    };
  }

  /** True if some other part of the track passes within `r` of (x,z) (used to keep scenery off the road). */
  clearOfTrack(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / 12);
    const cz = Math.floor(z / 12);
    const span = Math.ceil(r / 12);
    for (let gx = cx - span; gx <= cx + span; gx++)
      for (let gz = cz - span; gz <= cz + span; gz++)
        for (const i of this.grid.get(`${gx},${gz}`) ?? []) {
          if ((x - this.px[i]) ** 2 + (z - this.pz[i]) ** 2 < r * r) return false;
        }
    return true;
  }
}

/**
 * Length of the shortest closed line that keeps within `w` of the centreline: an elastic band
 * pulled tight through every fourth sample, each point sliding along its sample's normal. The
 * chords between points can shave corners, so it comes out a little short: safe for a minimum.
 * About 1-4 ms on the presets.
 */
function shortestLine(t: TrackModel, w: number): number {
  const stride = 4;
  const m = Math.floor(t.n / stride);
  const cx = new Float64Array(m);
  const cz = new Float64Array(m);
  const nx = new Float64Array(m);
  const nz = new Float64Array(m);
  const o = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const i = k * stride;
    cx[k] = t.px[i];
    cz[k] = t.pz[i];
    nx[k] = -t.tz[i];
    nz[k] = t.tx[i];
  }
  for (let it = 0; it < 2000; it++) {
    let moved = 0;
    for (let k = 0; k < m; k++) {
      const a = k === 0 ? m - 1 : k - 1;
      const b = k === m - 1 ? 0 : k + 1;
      const ax = cx[a] + nx[a] * o[a];
      const az = cz[a] + nz[a] * o[a];
      const ex = cx[b] + nx[b] * o[b] - ax;
      const ez = cz[b] + nz[b] * o[b] - az;
      // Where the chord from a to b crosses this sample's normal, clamped to the corridor.
      const den = ex * nz[k] - ez * nx[k];
      if (Math.abs(den) < 1e-9) continue;
      const v = Math.max(-w, Math.min(w, ((ax - cx[k]) * -ez + (az - cz[k]) * ex) / den));
      moved = Math.max(moved, Math.abs(v - o[k]));
      o[k] = v;
    }
    if (moved < 1e-3) break;
  }
  let len = 0;
  for (let k = 0; k < m; k++) {
    const b = k === m - 1 ? 0 : k + 1;
    len += Math.hypot(cx[b] + nx[b] * o[b] - cx[k] - nx[k] * o[k], cz[b] + nz[b] * o[b] - cz[k] - nz[k] * o[k]);
  }
  return len;
}
