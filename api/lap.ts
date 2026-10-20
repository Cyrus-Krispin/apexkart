// POST /api/lap: submit a lap. Keeps each driver's personal best per track/direction,
// stores its ghost, and posts to the global live feed.
import { getStore, K, json, bad, TRACK_RE, isDir, cleanName, cleanColor, publicId } from './_lib/store.js';
import { osmGeometry, sameCircuit, storedGeometry } from './_lib/osmRef.js';
import { FEATURED_IDS } from './_lib/featured.js';
import { dailyTrack, dayOf } from '../src/shared/daily.js';
import { decodeGhost, ghostPathLength, GHOST_DT, type GhostFrame } from '../src/shared/ghost.js';
import { centroid, distM, loopLength, type LatLon, type TrackData } from '../src/track/osm.js';

const KART_TOP_SPEED = 30; // m/s, a bit above the game's real top speed

/**
 * src/game/track.ts's judgeLap() on the lap's ghost. Loaded on demand (it brings in three for the
 * centreline spline); if it can't load or throws, the lap is judged by the checks above alone
 * rather than every lap failing.
 */
async function replay(data: TrackData, reverse: boolean, frames: GhostFrame[], sectors: number[]): Promise<string | null> {
  try {
    const { TrackModel, judgeLap } = await import('../src/game/track.js');
    return judgeLap(new TrackModel(data, reverse), frames, GHOST_DT, sectors);
  } catch (e) {
    console.error('lap replay unavailable', e);
    return null;
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 400_000) return bad('payload too large', 413);
  let b: any;
  try {
    b = JSON.parse(raw);
  } catch {
    return bad('invalid json');
  }

  const { track, dir, driverId, ms, sectors, ghost } = b ?? {};
  if (typeof track !== 'string' || !TRACK_RE.test(track) || !isDir(dir)) return bad('bad track/dir');
  if (typeof driverId !== 'string' || driverId.length < 16 || driverId.length > 64) return bad('bad driver');
  if (!Number.isInteger(ms) || ms < 5000 || ms > 30 * 60 * 1000) return bad('bad time');
  if (!Array.isArray(sectors) || sectors.length !== 3 || !sectors.every((s: unknown) => Number.isInteger(s) && (s as number) > 0)) return bad('bad sectors');
  if (Math.abs(sectors.reduce((a: number, x: number) => a + x, 0) - ms) > 10) return bad('sectors do not add up');
  if (!ghost || ghost.dt !== GHOST_DT || !Array.isArray(ghost.d) || ghost.d.length % 3 || ghost.d.length > 90_000 || !ghost.d.every(Number.isInteger))
    return bad('bad ghost');

  const db = getStore();
  const pid = await publicId(driverId);
  if (!(await db.set(K.rate(pid), '1', { ex: 3, nx: true }))) return bad('slow down', 429);

  // The lap's own circuit geometry: it has to hang together before anything is checked or kept.
  const lengthIn = Number(b.trackLength);
  const center = Array.isArray(b.center) && b.center.length === 2 && b.center.every((x: unknown) => typeof x === 'number' && isFinite(x)) ? (b.center as LatLon) : null;
  if (!(lengthIn >= 150 && lengthIn <= 8000) || !center) return bad('bad track meta');
  const points: LatLon[] | null =
    Array.isArray(b.points) && b.points.length >= 6 && b.points.length <= 3000 &&
    b.points.every((p: unknown) => Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0] - center[0]) < 0.05 && Math.abs(p[1] - center[1]) < 0.05)
      ? b.points.map((p: number[]) => [+p[0].toFixed(7), +p[1].toFixed(7)] as LatLon)
      : null;
  if (!points) return bad('bad track geometry');
  const lengthM = Math.round(loopLength(points));
  // The game's length is the smoothed racing line, a little shorter than the raw polyline.
  if (Math.abs(lengthM - lengthIn) > Math.max(40, lengthM * 0.2) || distM(centroid(points), center) > 300) return bad('track meta does not match its geometry');
  const trackName = String(b.trackName ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'Kart track';
  const width = Math.min(20, Math.max(4, Number(b.width) || 8));

  // The first lap on a track stores its geometry (so shared links work without OpenStreetMap).
  // For an OpenStreetMap id that claim is checked against OpenStreetMap, and only remembered once
  // it could be: while Overpass is down the lap still counts, but the geometry waits for a later lap.
  let stored = await storedGeometry(db, track);
  if (!stored) {
    const osm = await osmGeometry(track);
    if (osm && osm !== 'unavailable' && !sameCircuit(osm, centroid(points), lengthM, { m: 400, ratio: [0.75, 1.35] }))
      return bad('track does not match OpenStreetMap', 422);
    const meta = { name: trackName, lengthM, center: centroid(points), points, width };
    if (osm !== 'unavailable') await db.set(K.track(track), JSON.stringify(meta), { nx: true });
    stored = (await storedGeometry(db, track)) ?? meta;
  }

  // Plausibility checks against this lap's own circuit (not bullet-proof, but stops casual nonsense,
  // and a bad first submission can't lock everyone else out).
  const shortest = Math.min(lengthM, lengthIn);
  const longest = Math.max(lengthM, lengthIn);
  const frames = decodeGhost(ghost);
  if (ms < (shortest / KART_TOP_SPEED) * 1000) return bad('lap too fast to be real', 422);
  if (Math.abs(frames.length * GHOST_DT * 1000 - ms) > 1500) return bad('ghost does not match lap time', 422);
  const path = ghostPathLength(frames);
  if (path < shortest * 0.85 || path > longest * 1.4 + 60) return bad('ghost does not match track', 422);
  // Replay the ghost on the circuit it was driven on, under the game's own rules (continuous lap
  // progress, track limits, the whole lap, matching sectors), so a cut lap doesn't reach the board.
  const verdict = await replay({ id: track, name: trackName, location: '', center, points: b.points, width: Number(b.width) || 8, lengthM, osmWays: [], source: '' }, dir === 'rev', frames, sectors);
  if (verdict) return bad(`ghost leaves the track (${verdict})`, 422);

  const name = cleanName(b.name);
  const color = cleanColor(b.color);
  const prev = await db.zscore(K.board(track, dir), pid);
  const improved = prev === null || ms < prev;
  if (improved) {
    const at = Date.now();
    await db.zadd(K.board(track, dir), ms, pid);
    await Promise.all([
      db.hset(K.pb(track, dir), pid, JSON.stringify({ name, color, ms, sectors, at })),
      db.set(K.ghost(track, dir, pid), JSON.stringify({ dt: ghost.dt, d: ghost.d })),
    ]);
  }
  const [rank0, total] = await Promise.all([db.zrank(K.board(track, dir), pid), db.zcard(K.board(track, dir))]);
  const rank = (rank0 ?? 0) + 1;
  if (improved) {
    const item = { track, trackName: stored.name, dir, name, color, ms, rank, at: Date.now(), center: stored.center };
    await Promise.all([
      db.lpush(K.feed, JSON.stringify(item), 50),
      rank === 1 ? db.hset(K.records, `${track}|${dir}`, JSON.stringify({ name, ms, color })) : Promise.resolve(),
    ]);
  }
  // Today's daily circuit keeps its own board: each driver's best lap of the (UTC) day.
  let daily: { improved: boolean; rank: number; total: number } | undefined;
  const day = dayOf();
  if (dir === 'fwd' && track === dailyTrack(day, FEATURED_IDS)) {
    const prevDay = await db.zscore(K.daily(day), pid);
    const better = prevDay === null || ms < prevDay;
    if (better) {
      await Promise.all([db.zadd(K.daily(day), ms, pid), db.hset(K.names, pid, JSON.stringify({ name, color })), db.expire(K.daily(day), 8 * 86400)]);
    }
    const [dRank, dTotal] = await Promise.all([db.zrank(K.daily(day), pid), db.zcard(K.daily(day))]);
    daily = { improved: better, rank: (dRank ?? 0) + 1, total: dTotal };
  }
  return json({ improved, rank, pbMs: improved ? ms : prev, total, daily });
}
