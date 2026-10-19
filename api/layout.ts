// Community-corrected circuit layouts.
// GET  /api/layout          -> { [baseTrackId]: { id, points, lengthM, by, at } }
// POST /api/layout          -> save a corrected centreline for a track (new id, fresh leaderboard)
import { getStore, K, json, bad, TRACK_RE, cleanName, publicId } from './_lib/store.js';
import { clientIp, FEATURED, osmGeometry, sameCircuit, storedGeometry } from './_lib/osmRef.js';
import { centroid, loopLength, type LatLon } from '../src/track/osm.js';

const LAYOUTS = 'ak:layouts';
const hist = (base: string) => `ak:layout-hist:${base}`;

function hash6(points: LatLon[]): string {
  let h = 2166136261;
  for (const [a, b] of points) {
    const s = `${a.toFixed(6)},${b.toFixed(6)};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

export async function GET() {
  const all = await getStore().hgetall(LAYOUTS);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) out[k] = JSON.parse(v);
  return json(out, 200, 'public, s-maxage=15, stale-while-revalidate=60');
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 200_000) return bad('payload too large', 413);
  let b: any;
  try {
    b = JSON.parse(raw);
  } catch {
    return bad('invalid json');
  }
  const base = String(b?.base ?? '');
  if (!TRACK_RE.test(base) || base.includes('-l')) return bad('bad track');
  if (FEATURED.has(base)) return bad('featured circuits are curated, so their layout can’t be replaced', 403);
  if (typeof b.driverId !== 'string' || b.driverId.length < 16 || b.driverId.length > 64) return bad('bad driver');
  const center = Array.isArray(b.center) && b.center.length === 2 && b.center.every((x: unknown) => typeof x === 'number') ? (b.center as LatLon) : null;
  if (!center) return bad('bad center');
  const pts = b.points;
  if (!Array.isArray(pts) || pts.length < 6 || pts.length > 2000) return bad('bad points');
  const points: LatLon[] = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((x: unknown) => typeof x === 'number' && isFinite(x as number))) return bad('bad point');
    // Must stay at the same venue.
    if (Math.abs(p[0] - center[0]) > 0.02 || Math.abs(p[1] - center[1]) > 0.02) return bad('point too far from the circuit');
    points.push([+p[0].toFixed(7), +p[1].toFixed(7)]);
  }
  const lengthM = Math.round(loopLength(points));
  if (lengthM < 150 || lengthM > 8000) return bad('layout length out of range');

  const db = getStore();
  const pid = await publicId(b.driverId);
  if (!(await db.set(K.rate(pid) + ':layout', '1', { ex: 10, nx: true }))) return bad('slow down', 429);
  // Driver ids are free to mint, so also limit by network.
  if (!(await db.set(`ak:rl:ip:${clientIp(req)}:layout`, '1', { ex: 30, nx: true }))) return bad('slow down', 429);

  // A correction has to be the same circuit: where the server (or OpenStreetMap) says it is, about
  // the same size. The client's own claim about the centre doesn't count.
  const ref = (await storedGeometry(db, base)) ?? (await osmGeometry(base));
  if (ref === 'unavailable') return bad('can’t check this circuit against OpenStreetMap right now, try again in a minute', 503);
  if (!ref) return bad('unknown circuit');
  if (!sameCircuit(ref, centroid(points), lengthM, { m: 400, ratio: [0.4, 2.5] })) return bad('that layout isn’t at this circuit', 422);

  const id = `${base}-l${hash6(points)}`;
  const name = String(b.trackName ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'Kart track';
  const width = Math.min(20, Math.max(4, Number(b.width) || 8));
  const entry = { id, points, lengthM, by: cleanName(b.name), pid, at: Date.now() };
  await Promise.all([
    db.hset(LAYOUTS, base, JSON.stringify(entry)),
    db.lpush(hist(base), JSON.stringify(entry), 10),
    // Geometry for /api/track so shared links and the live feed resolve the new id.
    db.set(K.track(id), JSON.stringify({ name, lengthM, center: centroid(points), points, width })),
  ]);
  return json({ id, lengthM });
}
