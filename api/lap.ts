// POST /api/lap: submit a lap. Keeps each driver's personal best per track/direction,
// stores its ghost, and posts to the global live feed.
import { getStore, K, json, bad, TRACK_RE, isDir, cleanName, cleanColor, publicId } from './_lib/store.js';
import { decodeGhost, ghostPathLength, GHOST_DT } from '../src/shared/ghost.js';

const KART_TOP_SPEED = 30; // m/s, a bit above the game's real top speed

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

  // First submission for a track defines its metadata; later ones can't change it.
  const lengthIn = Number(b.trackLength);
  const center = Array.isArray(b.center) && b.center.length === 2 && b.center.every((x: unknown) => typeof x === 'number') ? b.center : null;
  if (!(lengthIn >= 150 && lengthIn <= 8000) || !center) return bad('bad track meta');
  const trackName = String(b.trackName ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'Kart track';
  // Keep the geometry so the track can be served without OpenStreetMap later.
  const points =
    Array.isArray(b.points) && b.points.length >= 6 && b.points.length <= 3000 &&
    b.points.every((p: unknown) => Array.isArray(p) && p.length === 2 && Math.abs(p[0] - center[0]) < 0.05 && Math.abs(p[1] - center[1]) < 0.05)
      ? b.points.map((p: number[]) => [+p[0].toFixed(7), +p[1].toFixed(7)])
      : null;
  const width = Math.min(20, Math.max(4, Number(b.width) || 8));
  const meta = { name: trackName, lengthM: Math.round(lengthIn), center, points, width };
  await db.set(K.track(track), JSON.stringify(meta), { nx: true });
  const stored = JSON.parse((await db.get(K.track(track))) ?? JSON.stringify(meta));

  // Plausibility checks (not bullet-proof, but stops casual nonsense).
  const frames = decodeGhost(ghost);
  if (ms < (stored.lengthM / KART_TOP_SPEED) * 1000) return bad('lap too fast to be real', 422);
  if (Math.abs(frames.length * GHOST_DT * 1000 - ms) > 1500) return bad('ghost does not match lap time', 422);
  const path = ghostPathLength(frames);
  if (path < stored.lengthM * 0.85 || path > stored.lengthM * 1.4 + 60) return bad('ghost does not match track', 422);

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
  return json({ improved, rank, pbMs: improved ? ms : prev, total });
}
