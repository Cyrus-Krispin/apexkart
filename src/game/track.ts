import * as THREE from 'three';
import type { LatLon, TrackData } from '../track/osm';

const R = 6378137;
const SPACING = 1; // metres between centreline samples

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

    let start = this.findStart(pts);
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

  /** Start/finish line: ~65% of the way down the longest straight. */
  private findStart(pts: THREE.Vector3[]): number {
    const n = pts.length;
    const heading = (i: number) => {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      return Math.atan2(b.x - a.x, b.z - a.z);
    };
    const straight: boolean[] = [];
    for (let i = 0; i < n; i++) {
      let d = heading((i + 6) % n) - heading((i - 6 + n) % n);
      d = Math.atan2(Math.sin(d), Math.cos(d));
      straight.push(Math.abs(d) < 0.12);
    }
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
    return bestLen ? (bestStart + Math.floor(bestLen * 0.65)) % n : 0;
  }

  private cell(x: number, z: number) {
    return `${Math.floor(x / 12)},${Math.floor(z / 12)}`;
  }

  /** Lateral unit normal pointing to the right of travel. */
  normal(i: number): [number, number] {
    return [-this.tz[i], this.tx[i]];
  }

  /** Nearest centreline point; uses `hint` (last index) to stay on the right section at crossovers. */
  nearest(x: number, z: number, hint = -1): Nearest {
    let best = -1;
    let bestD = Infinity;
    const test = (i: number) => {
      const dx = x - this.px[i];
      const dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    };
    if (hint >= 0) {
      for (let k = -40; k <= 40; k++) test((hint + k + this.n) % this.n);
    }
    if (best < 0 || bestD > (this.halfWidth + this.runoff + 4) ** 2) {
      bestD = Infinity;
      const cx = Math.floor(x / 12);
      const cz = Math.floor(z / 12);
      for (let r = 1; r < 40 && best < 0; r += 3) {
        for (let gx = cx - r; gx <= cx + r; gx++)
          for (let gz = cz - r; gz <= cz + r; gz++) this.grid.get(`${gx},${gz}`)?.forEach(test);
      }
      if (best < 0) for (let i = 0; i < this.n; i++) test(i);
    }
    const i = best;
    const dx = x - this.px[i];
    const dz = z - this.pz[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    const [nx, nz] = this.normal(i);
    const offset = dx * nx + dz * nz;
    let s = i * (this.length / this.n) + along;
    s = ((s % this.length) + this.length) % this.length;
    return { i, s, offset, dist: Math.abs(offset) };
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
