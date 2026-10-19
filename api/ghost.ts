// GET /api/ghost?track=&dir=&pid=: a driver's personal-best ghost lap.
import { getStore, K, json, bad, TRACK_RE, PID_RE, isDir } from './_lib/store';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const track = q.get('track') ?? '';
  const dir = q.get('dir');
  const pid = q.get('pid') ?? '';
  if (!TRACK_RE.test(track) || !isDir(dir) || !PID_RE.test(pid)) return bad('bad params');
  const db = getStore();
  const [ghost, [pb]] = await Promise.all([db.get(K.ghost(track, dir, pid)), db.hmget(K.pb(track, dir), [pid])]);
  const meta = pb ? JSON.parse(pb) : {};
  return json({ ghost: ghost ? JSON.parse(ghost) : null, name: meta.name ?? 'Driver', color: meta.color ?? '#888888', ms: meta.ms ?? null }, 200, 'public, s-maxage=20');
}
