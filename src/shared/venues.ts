// Pre-stitched kart layouts for every venue on the world map, baked by scripts/build-venues.ts
// into public/tracks/venues/<cell>.json so the home screen opens any track from the CDN instead
// of asking Overpass at click time. Shared by the baker and the browser.

export type LatLon = [number, number];

/** Venues are grouped into CELL_DEG × CELL_DEG degree files. */
export const CELL_DEG = 5;
export const cellOf = (lat: number, lon: number) => `${Math.floor(lat / CELL_DEG)}_${Math.floor(lon / CELL_DEG)}`;
/** A venue's key inside its cell file: its world.json position, as written there (5 decimals). */
export const venueKey = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/** One layout: track id (from its OSM ways), name, width in metres, length in metres, packed centreline. */
export type PackedLayout = [id: string, name: string, width: number, lengthM: number, points: number[]];
/** A cell file: venue key -> layouts, longest first. */
export type VenueCell = Record<string, PackedLayout[]>;

const Q = 1e5; // 1e-5 degrees: about a metre, plenty for a centreline

/** Delta-encoded integer degrees: [lat0, lon0, dLat1, dLon1, ...]. */
export function packPoints(pts: LatLon[]): number[] {
  const out: number[] = [];
  let pa = 0;
  let po = 0;
  for (const [la, lo] of pts) {
    const a = Math.round(la * Q);
    const o = Math.round(lo * Q);
    if (out.length && a === pa && o === po) continue; // collapsed by rounding
    out.push(a - pa, o - po);
    pa = a;
    po = o;
  }
  return out;
}

export function unpackPoints(d: number[]): LatLon[] {
  const out: LatLon[] = [];
  let a = 0;
  let o = 0;
  for (let i = 0; i + 1 < d.length; i += 2) {
    a += d[i];
    o += d[i + 1];
    out.push([a / Q, o / Q]);
  }
  return out;
}
