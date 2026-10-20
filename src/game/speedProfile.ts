// The centreline's speed profile: at every sample, the fastest the kart can go and still make each
// corner and braking zone ahead, under the game's own physics. The cornering limit first
// (v ≤ √(grip / curvature)), then a forward pass with the engine and a backward pass with the brakes.
// A flying-lap restart starts from it, so it never launches you into a braking zone. Pure numbers
// (no Three.js), so the home bundle could use it too. About a millisecond on the presets.
//
// The constants mirror KartPhysics.step() in kart.ts: keep them in step with it.
const LAT_G = 2.35; // lateral grip on the track surface, in g
const BRAKE = 22; // m/s² of braking above walking pace
const TOP = 26.66; // where the engine curve meets drag: the kart's real top speed (vmax 27 is never reached)
const engineAccel = (v: number) => (v < 27 ? 11 * (1 - Math.max(0, v) / 27) + 2.2 : 0) - 0.0028 * v * v - 0.35;

export interface SpeedProfile {
  /** m/s at each centreline sample. */
  v: Float32Array;
  /** Seconds for a lap of the centreline at that speed everywhere: a lap no one can beat on the centreline. */
  lapTime: number;
}

/** px/pz: a closed centreline (TrackModel's samples, about a metre apart). */
export function speedProfile(px: ArrayLike<number>, pz: ArrayLike<number>): SpeedProfile {
  const n = px.length;
  const seg = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Curvature from the circle through the samples three either side (smooths the sampling noise).
    const a = (i - 3 + n) % n;
    const b = (i + 3) % n;
    const A = Math.hypot(px[i] - px[a], pz[i] - pz[a]);
    const B = Math.hypot(px[b] - px[i], pz[b] - pz[i]);
    const C = Math.hypot(px[b] - px[a], pz[b] - pz[a]);
    const cross = (px[i] - px[a]) * (pz[b] - pz[a]) - (pz[i] - pz[a]) * (px[b] - px[a]);
    const k = (2 * Math.abs(cross)) / Math.max(A * B * C, 1e-6);
    v[i] = Math.min(TOP, Math.sqrt((LAT_G * 9.81) / Math.max(k, 1e-6)));
    const j = (i + 1) % n;
    seg[i] = Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  }
  // Round the lap twice each way so the passes settle across the line.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 2 * n; i++) {
      const a = i % n;
      const b = (i + 1) % n;
      v[b] = Math.min(v[b], Math.sqrt(v[a] * v[a] + 2 * Math.max(0, engineAccel(v[a])) * seg[a]));
    }
    for (let i = 2 * n; i > 0; i--) {
      const b = i % n;
      const a = (i - 1 + n) % n;
      v[a] = Math.min(v[a], Math.sqrt(v[b] * v[b] + 2 * (BRAKE + 0.0028 * v[b] * v[b]) * seg[a]));
    }
  }
  let lapTime = 0;
  for (let i = 0; i < n; i++) lapTime += seg[i] / ((v[i] + v[(i + 1) % n]) / 2);
  return { v: Float32Array.from(v), lapTime };
}
