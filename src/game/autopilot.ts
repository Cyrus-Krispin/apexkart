// The built-in driver (Race.autoControls): the cool-down lap after a multiplayer flag, and the
// dev console's `__race.autopilot = true`. It follows the centreline (pure pursuit) at a speed
// planned from the real shape of the road ahead, so it stays inside the track limits everywhere.
//
// It works in real metres. Centreline samples are 1 m apart in lap distance, but they bunch up or
// stretch where the OSM points do (Zuera reverse has samples 3 cm apart in a hairpin), and the
// stored per-sample curvature reads low there: the old driver took that hairpin at 16 m/s when
// it needed 12, and ran 7.5 m wide.
import type { Controls, KartPhysics } from './kart';
import type { TrackModel } from './track';

const A_LAT = 2.0 * 9.81; // m/s²: cornering speed target (the tyres hold 2.35 g on asphalt)
const A_BRAKE = 12; // m/s²: planned braking into a corner (the brakes give 22)
const PLAN = 45; // m of road ahead to plan the speed over
const SPAN = 4; // m either side for the curvature (the circle through three points)

interface Geo {
  cum: Float64Array; // real metres from the line to each sample (n + 1 entries; the last = len)
  len: number;
  curv: Float32Array; // 1/m, unsigned
}
const geos = new WeakMap<TrackModel, Geo>();

function geo(t: TrackModel): Geo {
  let g = geos.get(t);
  if (g) return g;
  const { n, px, pz } = t;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    cum[i + 1] = cum[i] + Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  }
  const len = cum[n];
  const curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = sampleAt(cum, len, n, cum[i] - SPAN);
    const c = sampleAt(cum, len, n, cum[i] + SPAN);
    const area2 = Math.abs((px[i] - px[a]) * (pz[c] - pz[a]) - (pz[i] - pz[a]) * (px[c] - px[a]));
    const sides = Math.hypot(px[i] - px[a], pz[i] - pz[a]) * Math.hypot(px[c] - px[i], pz[c] - pz[i]) * Math.hypot(px[c] - px[a], pz[c] - pz[a]);
    curv[i] = sides > 1e-9 ? (2 * area2) / sides : 0;
  }
  g = { cum, len, curv };
  geos.set(t, g);
  return g;
}

/** The sample at or just before real distance r along the lap (wrapped). */
function sampleAt(cum: Float64Array, len: number, n: number, r: number) {
  r = ((r % len) + len) % len;
  let lo = 0;
  let hi = n; // cum[lo] <= r < cum[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= r) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Controls for the kart on track `t`. */
export function autopilot(p: KartPhysics, t: TrackModel): Controls {
  const g = geo(t);
  const { n, px, pz, tx, tz } = t;
  // Where the kart is along the lap, in real metres.
  const h = p.hint < 0 ? 0 : p.hint;
  const r0 = g.cum[h] + (p.x - px[h]) * tx[h] + (p.z - pz[h]) * tz[h];
  const v = p.speed;
  const here = g.curv[sampleAt(g.cum, g.len, n, r0)];

  // Steer at a point on the centreline ahead: further at speed, nearer in a tight corner.
  const look = Math.min(12, 3 + 0.32 * v) / (1 + 5 * here);
  const i = sampleAt(g.cum, g.len, n, r0 + look);
  const j = i + 1 === n ? 0 : i + 1;
  const f = Math.min(1, Math.max(0, (((r0 + look) % g.len) + g.len) % g.len - g.cum[i]) / Math.max(1e-6, g.cum[i + 1] - g.cum[i]));
  const aimX = px[i] + (px[j] - px[i]) * f;
  const aimZ = pz[i] + (pz[j] - pz[i]) * f;
  let ang = Math.atan2(aimX - p.x, aimZ - p.z) - p.heading;
  ang = Math.atan2(Math.sin(ang), Math.cos(ang));

  // Speed: the slowest of "corner speed at d, plus what braking at A_BRAKE from here allows".
  let vT = p.vmax;
  for (let d = 0; d <= PLAN; d += 1.5) {
    const k = g.curv[sampleAt(g.cum, g.len, n, r0 + d)];
    if (k < 1e-4) continue;
    vT = Math.min(vT, Math.sqrt(A_LAT / k + 2 * A_BRAKE * d));
  }
  return {
    throttle: v < vT ? 1 : 0,
    brake: v > vT + 0.8 ? Math.min(1, 0.4 + (v - vT) / 3) : 0,
    steer: Math.max(-1, Math.min(1, -ang * 3)),
    drift: false,
  };
}
