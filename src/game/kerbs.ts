// Where a kart circuit has kerbs, as data (no three.js), so the renderer and the physics
// agree on it: an inside kerb from turn-in to just past the apex, an outside kerb on the exit
// (and around the apex of hairpins), nothing on kinks, nothing lying on another section of the
// lap. Everything is derived from the lap in its race direction, so reverse gets its own kerbs.
import type { TrackModel } from './track';
import { trackQuery } from './trackQuery';

export type KerbKind = 'apex' | 'exit' | 'outside';

/** A kerb strip along samples i0..i1 (inclusive; i1 may run past n - 1 and wraps). */
export interface KerbRun {
  side: -1 | 1; // -1 = left of travel, 1 = right
  i0: number; // 0 <= i0 < n
  i1: number; // i0 <= i1 < i0 + n
  kind: KerbKind;
  corner: number; // index into corners()
}

export interface Corner {
  i0: number; // first and last sample (i1 may run past n - 1)
  i1: number;
  turnIn: number; // where 10% of the turn is done (sample index, may run past n - 1, like i1)
  apex: number; // 55% (racing apexes sit a little late)
  exit: number; // 92%
  turn: number; // signed total turn in radians (+ = right)
  minR: number; // tightest radius (m)
}

/** Kerb profile: offset from the asphalt edge (m) and height (m), inner lip to outer lip. */
export const KERB_PROFILE: [number, number][] = [
  [-0.05, 0.035],
  [0.35, 0.1],
  [1.0, 0.08],
  [1.15, 0.02],
];
export const KERB_WIDTH = 1.15; // outer edge, metres beyond the asphalt edge
export const APRON_WIDTH = 1.1; // concrete apron beyond the asphalt edge where there's no kerb

const K_ON = 1 / 75; // a corner needs a radius under 75 m somewhere...
const K_OFF = 1 / 110; // ...and lasts while it stays under 110 m (same direction)
const MIN_TURN = (25 * Math.PI) / 180; // anything that turns less is a kink: no kerb
const EXIT_TURN = (35 * Math.PI) / 180; // corners this big get an exit kerb
const HAIRPIN = (120 * Math.PI) / 180; // and these an outside kerb round the apex too
const MIN_LEN = 4; // metres: shorter scraps are dropped

const wrap = (i: number, n: number) => ((i % n) + n) % n;

const cornerCache = new WeakMap<TrackModel, Corner[]>();
const runCache = new WeakMap<TrackModel, KerbRun[]>();
const maskCache = new WeakMap<TrackModel, Uint8Array>();

/** The lap's corners (sustained bends of at least 20°), in lap order. */
export function corners(t: TrackModel): Corner[] {
  const cached = cornerCache.get(t);
  if (cached) return cached;
  const n = t.n;
  const ds = t.length / n;
  // Curvature per metre, smoothed over ±6 samples more than TrackModel's ±4, so OSM jitter
  // on a straight doesn't read as a corner.
  const k = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let d = -6; d <= 6; d++) acc += t.curv[wrap(i + d, n)];
    k[i] = acc / 13 / ds;
  }
  const out: Corner[] = [];
  // Start scanning on a straight so no corner straddles the scan start.
  let start = 0;
  let quiet = Infinity;
  for (let i = 0; i < n; i++)
    if (Math.abs(k[i]) < quiet) {
      quiet = Math.abs(k[i]);
      start = i;
    }
  const turnOf = (a: number, b: number) => {
    let turn = 0;
    for (let q = a; q <= b; q++) turn += t.curv[wrap(q, n)];
    return turn;
  };
  const absK = (q: number) => Math.abs(k[wrap(q, n)]);
  // A compound bend (a corner, an almost straight bit, then more corner the same way) is two
  // corners with two apexes: split at a dip in curvature well below the peaks either side.
  const splitAtDips = (a: number, b: number): [number, number][] => {
    let best = -1;
    let bestRatio = 0.4;
    for (let q = a + 3; q <= b - 3; q++) {
      if (absK(q) > absK(q - 1) || absK(q) > absK(q + 1)) continue;
      let left = 0;
      let right = 0;
      for (let p = a; p < q; p++) left = Math.max(left, absK(p));
      for (let p = q + 1; p <= b; p++) right = Math.max(right, absK(p));
      const ratio = absK(q) / Math.min(left, right);
      if (ratio < bestRatio && Math.abs(turnOf(a, q)) >= MIN_TURN && Math.abs(turnOf(q + 1, b)) >= MIN_TURN) {
        bestRatio = ratio;
        best = q;
      }
    }
    return best < 0 ? [[a, b]] : [...splitAtDips(a, best), ...splitAtDips(best + 1, b)];
  };
  const addCorner = (a: number, b: number) => {
    const turn = turnOf(a, b);
    if (Math.abs(turn) < MIN_TURN) return;
    let peak = 0;
    for (let q = a; q <= b; q++) peak = Math.max(peak, absK(q));
    // Turn-in, apex and exit from the share of the turn done, so long tails don't matter.
    const at = (f: number) => {
      let acc = 0;
      for (let q = a; q <= b; q++) {
        acc += t.curv[wrap(q, n)];
        if (Math.abs(acc) >= Math.abs(turn) * f) return q;
      }
      return b;
    };
    const i0 = wrap(a, n);
    const rel = (q: number) => i0 + (q - a);
    out.push({ i0, i1: rel(b), turnIn: rel(at(0.1)), apex: rel(at(0.55)), exit: rel(at(0.92)), turn, minR: 1 / Math.max(peak, 1e-6) });
  };
  const used = new Uint8Array(n);
  for (let m = 0; m < n; m++) {
    const i = wrap(start + m, n);
    if (used[i] || Math.abs(k[i]) < K_ON) continue;
    const sign = Math.sign(k[i]);
    const inCorner = (q: number) => Math.sign(k[wrap(q, n)]) === sign && Math.abs(k[wrap(q, n)]) >= K_OFF && !used[wrap(q, n)];
    let a = i;
    while (inCorner(a - 1) && i - a < n) a--;
    let b = i;
    while (inCorner(b + 1) && b - a < n - 1) b++;
    for (let q = a; q <= b; q++) used[wrap(q, n)] = 1;
    for (const [p0, p1] of splitAtDips(a, b)) addCorner(p0, p1);
  }
  out.sort((p, q) => p.i0 - q.i0);
  cornerCache.set(t, out);
  return out;
}

/** Kerb width at sample q on a side: narrower on the inside of a tight bend, where it would fold. */
export function kerbWidthAt(t: TrackModel, q: number, side: number): number {
  const n = t.n;
  const c = t.curv[wrap(q, n)] / (t.length / n);
  if (Math.sign(c) !== side || c === 0) return KERB_WIDTH; // outside of the bend: no fold
  const room = 1 / Math.abs(c) - t.halfWidth; // inside radius of the asphalt edge
  return Math.max(0.6, Math.min(KERB_WIDTH, room * 0.8));
}

/** Every kerb strip on the lap, clipped where it would lie on another section's road. */
export function kerbRuns(t: TrackModel): KerbRun[] {
  const cached = runCache.get(t);
  if (cached) return cached;
  const n = t.n;
  const ds = t.length / n;
  const m = (metres: number) => Math.max(1, Math.round(metres / ds));
  const cs = corners(t);
  const hw = t.halfWidth;
  type Raw = { side: -1 | 1; a: number; b: number; kind: KerbKind; corner: number };
  const raw: Raw[] = [];
  cs.forEach((c, ci) => {
    const dir = (c.turn > 0 ? 1 : -1) as -1 | 1; // inside of the corner
    // Share of the corner's turn done by sample q (0 at i0, 1 at i1).
    const at = (f: number) => {
      let acc = 0;
      for (let q = c.i0; q <= c.i1; q++) {
        acc += t.curv[wrap(q, n)];
        if (Math.abs(acc) >= Math.abs(c.turn) * f) return q;
      }
      return c.i1;
    };
    // Inside: from turn-in to a little past the apex (a quarter to three quarters of the turn),
    // at least 8 m round the apex.
    const long = Math.abs(c.turn) > (150 * Math.PI) / 180;
    let a = at(long ? 0.12 : 0.22);
    let b = at(0.78);
    // The inside of a tight bend is short: widen the run until the kerb itself is 7 m long.
    const kerbLen = () => {
      let L = 0;
      for (let q = a; q < b; q++) L += Math.max(0.05, ds - dir * t.curv[wrap(q, n)] * (hw + 0.55));
      return L;
    };
    while (kerbLen() < 7 && (a > c.turnIn || b < c.exit)) {
      if (a > c.turnIn) a--;
      if (b < c.exit) b++;
    }
    if (b - a < m(8)) {
      a = Math.min(a, c.apex - m(4));
      b = Math.max(b, c.apex + m(4));
    }
    raw.push({ side: dir, a, b, kind: 'apex', corner: ci });
    // Outside: on the exit of anything but a gentle bend, unless the next corner carries on the
    // same way straight away (one long corner with two apexes). Hairpins get it round the apex.
    const next = cs[(ci + 1) % cs.length];
    const gap = cs.length > 1 ? wrap(next.i0 - c.exit, n) : n;
    const sameWay = cs.length > 1 && Math.sign(next.turn) === Math.sign(c.turn) && wrap(next.turnIn - c.exit, n) * ds < 15;
    const runOut = Math.min(m(3), Math.floor(gap / 2));
    if (Math.abs(c.turn) >= HAIRPIN) {
      raw.push({ side: (-dir) as -1 | 1, a: at(0.58), b: c.exit + runOut, kind: 'outside', corner: ci });
    } else if (Math.abs(c.turn) >= EXIT_TURN && !sameWay) {
      raw.push({ side: (-dir) as -1 | 1, a: at(0.72), b: c.exit + runOut, kind: 'exit', corner: ci });
    }
  });

  // Merge strips on the same side that overlap or nearly touch (S-bends: one corner's exit
  // kerb is the next one's inside kerb), so nothing is drawn twice.
  const rank: Record<KerbKind, number> = { apex: 3, outside: 2, exit: 1 };
  const merged: Raw[] = [];
  for (const side of [-1, 1] as const) {
    const list = raw
      .filter((r) => r.side === side)
      .map((r) => ({ ...r, a: wrap(r.a, n), b: wrap(r.a, n) + (r.b - r.a) }))
      .sort((p, q) => p.a - q.a);
    const res: Raw[] = [];
    for (const r of list) {
      const last = res[res.length - 1];
      if (last && r.a <= last.b + m(4)) {
        last.b = Math.max(last.b, r.b);
        if (rank[r.kind] > rank[last.kind]) {
          last.kind = r.kind;
          last.corner = r.corner;
        }
      } else res.push({ ...r });
    }
    // The last strip may wrap round onto the first.
    if (res.length > 1) {
      const first = res[0];
      const last = res[res.length - 1];
      if (last.b + m(4) >= first.a + n) {
        last.b = Math.max(last.b, first.b + n);
        if (rank[first.kind] > rank[last.kind]) {
          last.kind = first.kind;
          last.corner = first.corner;
        }
        res.shift();
      }
    }
    for (const r of res) if (r.b - r.a >= n) r.b = r.a + n - 1;
    merged.push(...res);
  }

  // Clip: no kerb on another section's road.
  const tq = trackQuery(t);
  const ok = (q: number, side: number) => {
    const w = kerbWidthAt(t, q, side);
    const [nx, nz] = t.normal(q);
    for (const o of [hw - 0.05, hw + w * 0.5, hw + w]) {
      const x = t.px[q] + nx * side * o;
      const z = t.pz[q] + nz * side * o;
      if (tq.nearestOther(x, z, q, hw + 0.2, 20)) return false;
    }
    return true;
  };
  let runs: KerbRun[] = [];
  const split = (r: Raw, keep: (k: number) => boolean) => {
    let s = -1;
    for (let k = r.a; k <= r.b + 1; k++) {
      const good = k <= r.b && keep(k);
      if (good && s < 0) s = k;
      if (!good && s >= 0) {
        if ((k - s) * ds >= MIN_LEN) runs.push({ side: r.side, i0: wrap(s, n), i1: wrap(s, n) + (k - 1 - s), kind: r.kind, corner: r.corner });
        s = -1;
      }
    }
  };
  for (const r of merged) split(r, (k) => ok(wrap(k, n), r.side));

  // Where two sections run side by side, two kerbs can meet: keep the one met first in the lap.
  const pts: { x: number; z: number; q: number; run: number }[] = [];
  runs.forEach((r, ri) => {
    for (let k = r.i0; k <= r.i1; k++) {
      const q = wrap(k, n);
      const [nx, nz] = t.normal(q);
      const o = hw + kerbWidthAt(t, q, r.side) * 0.5;
      pts.push({ x: t.px[q] + nx * r.side * o, z: t.pz[q] + nz * r.side * o, q, run: ri });
    }
  });
  const drop = new Set<string>();
  const grid = new Map<string, number[]>();
  pts.forEach((p, pi) => {
    const key = `${Math.floor(p.x / 4)},${Math.floor(p.z / 4)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(pi);
  });
  for (const p of pts) {
    const gx = Math.floor(p.x / 4);
    const gz = Math.floor(p.z / 4);
    for (let x = gx - 1; x <= gx + 1; x++)
      for (let z = gz - 1; z <= gz + 1; z++)
        for (const qi of grid.get(`${x},${z}`) ?? []) {
          const o = pts[qi];
          if (o.run === p.run || o.q <= p.q || tq.lapSep(o.q, p.q) < 20) continue;
          if ((o.x - p.x) ** 2 + (o.z - p.z) ** 2 < 1.3 ** 2) drop.add(`${o.run}:${o.q}`);
        }
  }
  if (drop.size) {
    const before = runs;
    runs = [];
    before.forEach((r, ri) => split({ side: r.side, a: r.i0, b: r.i1, kind: r.kind, corner: r.corner }, (k) => !drop.has(`${ri}:${wrap(k, n)}`)));
  }
  runs.sort((p, q) => p.i0 - q.i0 || p.side - q.side);
  runCache.set(t, runs);
  return runs;
}

/** Per-sample kerb flags: bit 0 = kerb on the left, bit 1 = kerb on the right. */
export function kerbMask(t: TrackModel): Uint8Array {
  const cached = maskCache.get(t);
  if (cached) return cached;
  const mask = new Uint8Array(t.n);
  for (const r of kerbRuns(t)) for (let k = r.i0; k <= r.i1; k++) mask[wrap(k, t.n)] |= r.side > 0 ? 2 : 1;
  maskCache.set(t, mask);
  return mask;
}

/** True if sample i has a kerb on that side (-1 left, 1 right). */
export function hasKerb(t: TrackModel, i: number, side: number): boolean {
  return (kerbMask(t)[wrap(i, t.n)] & (side > 0 ? 2 : 1)) !== 0;
}

/** A corner that needs a big stop: worth braking boards and braking marks. */
export interface BigStop {
  corner: number; // index into corners()
  turnIn: number; // sample index (may run past n - 1)
  side: -1 | 1; // outside of the corner, where karts line up before turning in
  brakeFrom: number; // sample where braking starts (rough speed model), before turnIn
  dv: number; // speed shed, m/s
  approach: number; // metres of run-up from the previous corner's exit
}

const stopCache = new WeakMap<TrackModel, BigStop[]>();

/**
 * Corners reached at speed and taken slowly, from a rough speed model of a kart round the lap
 * (top speed 27 m/s, ~1.5 G in corners, ~1 G braking, ~0.35 G accelerating).
 */
export function bigStops(t: TrackModel): BigStop[] {
  const cached = stopCache.get(t);
  if (cached) return cached;
  const n = t.n;
  const ds = t.length / n;
  const cs = corners(t);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let d = -6; d <= 6; d++) acc += t.curv[wrap(i + d, n)];
    const k = Math.abs(acc / 13 / ds);
    v[i] = Math.min(27, Math.sqrt(15 / Math.max(k, 1e-6)));
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let m = 2 * n - 1; m >= 0; m--) {
      const i = m % n;
      v[i] = Math.min(v[i], Math.sqrt(v[(i + 1) % n] ** 2 + 2 * 10 * ds));
    }
    for (let m = 0; m < 2 * n; m++) {
      const i = m % n;
      v[i] = Math.min(v[i], Math.sqrt(v[(i - 1 + n) % n] ** 2 + 2 * 3.5 * ds));
    }
  }
  const out: BigStop[] = [];
  cs.forEach((c, ci) => {
    const prev = cs[(ci - 1 + cs.length) % cs.length];
    const approach = cs.length > 1 ? wrap(c.turnIn - prev.exit, n) * ds : t.length;
    let vMin = Infinity;
    for (let q = c.turnIn; q <= c.exit; q++) vMin = Math.min(vMin, v[wrap(q, n)]);
    // Braking starts at the speed peak before the corner.
    let peak = c.turnIn;
    const back = Math.min(Math.round(approach / ds), Math.round(80 / ds));
    for (let q = c.turnIn; q >= c.turnIn - back; q--) if (v[wrap(q, n)] > v[wrap(peak, n)] + 0.01) peak = q;
    const dv = v[wrap(peak, n)] - vMin;
    if (dv < 10 || approach < 50 || (c.turnIn - peak) * ds < 15) return;
    out.push({ corner: ci, turnIn: c.turnIn, side: (c.turn > 0 ? -1 : 1) as -1 | 1, brakeFrom: peak, dv, approach });
  });
  // The biggest few only: boards and marks at every corner would be clutter.
  const big = out.sort((p, q) => q.dv - p.dv).slice(0, 4).sort((p, q) => wrap(p.turnIn, n) - wrap(q.turnIn, n));
  stopCache.set(t, big);
  return big;
}
