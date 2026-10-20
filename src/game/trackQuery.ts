// Spatial questions about the lap that only use TrackModel's public samples: "is another
// section of the circuit (not the one I'm on) within r of this point?". Used to keep kerbs,
// posts and road quads from lying on a different part of the lap where the layout runs
// close to itself, merges, or crosses over itself. No three.js, so physics can use it too.
import type { TrackModel } from './track';

export interface OtherHit {
  j: number; // sample index on the other section
  dist: number; // distance from the point to that section's centreline (m)
  offset: number; // signed lateral offset from it (+ = right of its travel)
}

const CELL = 8;

export class TrackQuery {
  readonly ds: number; // mean metres per sample
  private cells = new Map<number, number[]>();

  constructor(readonly track: TrackModel) {
    this.ds = track.length / track.n;
    for (let i = 0; i < track.n; i++) {
      const k = this.key(Math.floor(track.px[i] / CELL), Math.floor(track.pz[i] / CELL));
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(i);
    }
  }

  private key(cx: number, cz: number) {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /** Metres along the lap between two samples, the short way round. */
  lapSep(i: number, j: number): number {
    const n = this.track.n;
    const d = Math.abs((((i - j) % n) + n) % n);
    return Math.min(d, n - d) * this.ds;
  }

  /**
   * Distance from (x, z) to the centreline near sample j: the perpendicular distance to the
   * segment before or after j (whichever is closer), so 1 m sampling doesn't add error.
   */
  distTo(x: number, z: number, j: number): { dist: number; offset: number } {
    const t = this.track;
    const n = t.n;
    let best = Infinity;
    let off = 0;
    for (const a of [(j - 1 + n) % n, j]) {
      const b = (a + 1) % n;
      const ax = t.px[a];
      const az = t.pz[a];
      const dx = t.px[b] - ax;
      const dz = t.pz[b] - az;
      const L2 = dx * dx + dz * dz || 1;
      const f = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const qx = ax + dx * f;
      const qz = az + dz * f;
      const d = Math.hypot(x - qx, z - qz);
      if (d < best) {
        best = d;
        const [nx, nz] = t.normal(a);
        off = (x - qx) * nx + (z - qz) * nz;
      }
    }
    return { dist: best, offset: off };
  }

  /**
   * The closest centreline point within `r` of (x, z) that belongs to another section of the lap:
   * at least `minSep` metres along the lap from sample `i`. Null if there is none.
   * Pass `before` to only consider samples with a lower index than `i` (an earlier pass).
   */
  nearestOther(x: number, z: number, i: number, r: number, minSep = 30, before = false): OtherHit | null {
    const t = this.track;
    const span = Math.ceil((r + 1) / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let bestJ = -1;
    let bestD2 = (r + 1.5) ** 2;
    for (let gx = cx - span; gx <= cx + span; gx++)
      for (let gz = cz - span; gz <= cz + span; gz++) {
        const list = this.cells.get(this.key(gx, gz));
        if (!list) continue;
        for (const j of list) {
          if (before && j >= i) continue;
          const d2 = (x - t.px[j]) ** 2 + (z - t.pz[j]) ** 2;
          if (d2 >= bestD2 || this.lapSep(i, j) < minSep) continue;
          bestD2 = d2;
          bestJ = j;
        }
      }
    if (bestJ < 0) return null;
    const { dist, offset } = this.distTo(x, z, bestJ);
    return dist <= r ? { j: bestJ, dist, offset } : null;
  }

  /** True when (x, z) lies within `r` of a section of the lap at least `minSep` m from sample i. */
  onOther(x: number, z: number, i: number, r: number, minSep = 30): boolean {
    return this.nearestOther(x, z, i, r, minSep) !== null;
  }
}

const cache = new WeakMap<TrackModel, TrackQuery>();

/** Shared query object for a track (built once per TrackModel). */
export function trackQuery(track: TrackModel): TrackQuery {
  let q = cache.get(track);
  if (!q) cache.set(track, (q = new TrackQuery(track)));
  return q;
}

/** Convenience: closest point of another section of the lap within r of (x, z), or null. */
export function nearestOther(track: TrackModel, x: number, z: number, i: number, r: number, minSep = 30): OtherHit | null {
  return trackQuery(track).nearestOther(x, z, i, r, minSep);
}
