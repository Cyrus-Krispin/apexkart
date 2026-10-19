// The world kart index (public/tracks/world.json, baked by scripts/build-world.ts): every kart
// venue on OpenStreetMap with its country. The atlas draws it as the world map's dots and
// builds the country filter from it; a venue becomes a raceable track on first click.
import type { LatLon } from '../track/osm';

export interface Venue {
  i: number;
  at: LatLon;
  cc: string; // ISO alpha-3, '' offshore
  name: string; // '' when unnamed on OpenStreetMap
}

export interface Country {
  cc: string;
  name: string;
  cc2: string;
}

export interface WorldIndex {
  venues: Venue[];
  countries: Map<string, Country>;
}

export async function loadWorld(): Promise<WorldIndex> {
  const raw: { venues: [number, number, string, string][]; countries: Record<string, [string, string]> } = await fetch('/tracks/world.json').then((r) => {
    if (!r.ok) throw new Error(`world index ${r.status}`);
    return r.json();
  });
  return {
    venues: raw.venues.map(([la, lo, cc, name], i) => ({ i, at: [la, lo], cc, name })),
    countries: new Map(Object.entries(raw.countries).map(([cc, [name, cc2]]) => [cc, { cc, name, cc2 }])),
  };
}

/** The visitor's country from the browser locale (en-SG -> SGP), if the index has it. */
export function localeCountry(w: WorldIndex): string | null {
  const regions = (navigator.languages ?? [navigator.language]).map((l) => l.split('-')[1]?.toUpperCase()).filter(Boolean);
  for (const r of regions) for (const c of w.countries.values()) if (c.cc2 === r) return c.cc;
  return null;
}

export const distM = (a: LatLon, b: LatLon) =>
  Math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180));

/** The bulk of a set of points: drops far-flung outliers (Hawaii, overseas territories). */
export function coreBounds(pts: LatLon[]): [LatLon, LatLon] | null {
  if (!pts.length) return null;
  if (pts.length < 8) {
    const la = pts.map((p) => p[0]);
    const lo = pts.map((p) => p[1]);
    return [
      [Math.min(...la), Math.min(...lo)],
      [Math.max(...la), Math.max(...lo)],
    ];
  }
  const q = (xs: number[], f: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.max(0, Math.round(f * (xs.length - 1))))];
  const la = pts.map((p) => p[0]);
  const lo = pts.map((p) => p[1]);
  return [
    [q(la, 0.04), q(lo, 0.04)],
    [q(la.slice(), 0.96), q(lo.slice(), 0.96)],
  ];
}
