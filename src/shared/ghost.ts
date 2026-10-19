// Compact ghost-lap encoding shared by client and API.
// Samples every DT seconds: x, z in decimetres and heading in centiradians, delta-encoded.

export const GHOST_DT = 0.05;

export interface GhostData {
  dt: number;
  d: number[]; // [x0, z0, h0, dx1, dz1, dh1, ...]
}

export interface GhostFrame {
  x: number;
  z: number;
  h: number;
}

export function encodeGhost(frames: GhostFrame[]): GhostData {
  const d: number[] = [];
  let px = 0, pz = 0, ph = 0;
  for (const f of frames) {
    const x = Math.round(f.x * 10);
    const z = Math.round(f.z * 10);
    const h = Math.round(f.h * 100);
    d.push(x - px, z - pz, h - ph);
    px = x;
    pz = z;
    ph = h;
  }
  return { dt: GHOST_DT, d };
}

export function decodeGhost(g: GhostData): GhostFrame[] {
  const out: GhostFrame[] = [];
  let x = 0, z = 0, h = 0;
  for (let i = 0; i + 2 < g.d.length; i += 3) {
    x += g.d[i];
    z += g.d[i + 1];
    h += g.d[i + 2];
    out.push({ x: x / 10, z: z / 10, h: h / 100 });
  }
  return out;
}

/** Interpolated pose at time t (seconds) into the lap. */
export function sampleGhost(frames: GhostFrame[], dt: number, t: number): GhostFrame | null {
  const f = t / dt;
  const i = Math.floor(f);
  if (i < 0 || i + 1 >= frames.length) return null;
  const a = frames[i];
  const b = frames[i + 1];
  const k = f - i;
  let dh = b.h - a.h;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, h: a.h + dh * k };
}

export function ghostPathLength(frames: GhostFrame[]): number {
  let L = 0;
  for (let i = 1; i < frames.length; i++) L += Math.hypot(frames[i].x - frames[i - 1].x, frames[i].z - frames[i - 1].z);
  return L;
}
