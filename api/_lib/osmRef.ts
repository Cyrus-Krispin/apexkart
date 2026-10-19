// Ground truth for a track the server is asked to remember: its geometry as stored by an earlier
// lap or layout, or (for an OpenStreetMap id nobody has raced) straight from Overpass.
import { centroid, distM, findLoops, waysFromId, type LatLon } from '../../src/track/osm.js';
import { K, type Store } from './store.js';

export interface TrackRef {
  center: LatLon;
  lengthM: number;
}

/** Featured circuits (public/tracks/presets.json) are curated: their layouts aren't open to edits. */
export const FEATURED = new Set([
  'osm-736818473',
  'osm-75490872',
  'osm-67660672',
  'osm-240643724_517085040_1208588288_1208588289_1208588290',
  'osm-91850736',
  'osm-157769792_157769810_157769814_157769827_157769828_157769847_157769849_157769861_157769876_157769882_363049742',
]);

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/**
 * Geometry for an OSM-id track from Overpass (two mirrors, ~7 s at most): null if it isn't an OSM id,
 * 'unavailable' if neither answered.
 */
export async function osmGeometry(id: string): Promise<TrackRef | null | 'unavailable'> {
  const ways = waysFromId(id);
  if (!ways || ways.length > 40) return null;
  for (const [i, url] of MIRRORS.entries()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ApexKart/0.5 (github.com/Cyrus-Krispin/apexkart)' },
        body: 'data=' + encodeURIComponent(`[out:json][timeout:6];way(id:${ways.join(',')});out body geom;`),
        signal: AbortSignal.timeout(i === 0 ? 4000 : 3000),
      });
      if (!res.ok) continue;
      const loop = findLoops((await res.json()).elements ?? [], 1)[0];
      if (loop) return { center: centroid(loop.points), lengthM: loop.lengthM };
    } catch {
      /* next mirror */
    }
  }
  return 'unavailable';
}

/** What the server already knows about a track (from a lap or a saved layout), if anything. */
export async function storedGeometry(db: Store, id: string): Promise<(TrackRef & Record<string, unknown>) | null> {
  const raw = await db.get(K.track(id));
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return Array.isArray(m.center) && Number.isFinite(m.lengthM) ? m : null;
  } catch {
    return null;
  }
}

/** Does a claimed layout belong to the same circuit as a reference? */
export function sameCircuit(ref: TrackRef, center: LatLon, lengthM: number, tolerance: { m: number; ratio: [number, number] }) {
  return distM(ref.center, center) < tolerance.m && lengthM >= ref.lengthM * tolerance.ratio[0] && lengthM <= ref.lengthM * tolerance.ratio[1];
}

export function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}
