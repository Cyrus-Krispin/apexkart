import type { LatLon } from '../../track/osm';
import type { TrackModel } from '../track';

export type Pt = [number, number]; // local metres: x east, z south

export function projectRing(track: TrackModel, ring: LatLon[]): Pt[] {
  return ring.map(([la, lo]) => {
    const p = track.proj.toLocal(la, lo);
    return [p.x, p.z];
  });
}

export function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
  }
  return a / 2; // sign depends on winding
}

export function pointInPolygon(x: number, z: number, p: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i];
    const [xj, zj] = p[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(p: Pt[]): Pt {
  let x = 0;
  let z = 0;
  for (const q of p) {
    x += q[0];
    z += q[1];
  }
  return [x / p.length, z / p.length];
}

/** Small deterministic PRNG so a track always looks the same. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** World extent covered by the painted ground (track bounds plus a margin). */
export interface Extent {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export function trackExtent(track: TrackModel, margin: number): Extent {
  let x0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < track.n; i++) {
    x0 = Math.min(x0, track.px[i]);
    x1 = Math.max(x1, track.px[i]);
    z0 = Math.min(z0, track.pz[i]);
    z1 = Math.max(z1, track.pz[i]);
  }
  return { x0: x0 - margin, z0: z0 - margin, x1: x1 + margin, z1: z1 + margin };
}

/** Land classes stored in the ground raster, used to keep trees and buildings sensible. */
export const Land = {
  Grass: 0,
  Forest: 1,
  Park: 2,
  Water: 3,
  Paved: 4, // roads, parking, industrial yards
  Building: 5,
  Track: 6, // circuit + runoff + apron
  Farm: 7,
  Sand: 8,
} as const;
export type LandClass = (typeof Land)[keyof typeof Land];
