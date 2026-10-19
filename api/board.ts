// GET /api/board?track=&dir=&limit=&pid=&name=&color=
// Top lap times for one track/direction, plus who is on track right now.
// Passing pid/name/color also registers the caller as "on track" (a heartbeat).
import { getStore, K, json, bad, TRACK_RE, PID_RE, isDir, cleanName, cleanColor, LIVE_WINDOW_MS } from './_lib/store';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const track = q.get('track') ?? '';
  const dir = q.get('dir');
  if (!TRACK_RE.test(track) || !isDir(dir)) return bad('bad track/dir');
  const limit = Math.min(25, Math.max(1, Number(q.get('limit')) || 10));
  const db = getStore();
  const now = Date.now();
  const pid = q.get('pid');

  if (pid && PID_RE.test(pid)) {
    await Promise.all([
      db.zadd(K.live(track, dir), now, pid),
      db.zadd(K.liveAll, now, `${track}|${dir}|${pid}`),
      db.hset(K.names, pid, JSON.stringify({ name: cleanName(q.get('name')), color: cleanColor(q.get('color')) })),
    ]);
  }
  await db.zremrangebyscore(K.live(track, dir), 0, now - LIVE_WINDOW_MS);

  const [top, total, live] = await Promise.all([
    db.zrange(K.board(track, dir), 0, limit - 1),
    db.zcard(K.board(track, dir)),
    db.zrange(K.live(track, dir), 0, -1),
  ]);
  const [pbs, names] = await Promise.all([
    db.hmget(K.pb(track, dir), top.map((e) => e.member)),
    db.hmget(K.names, live.map((e) => e.member)),
  ]);

  const entries = top.map((e, i) => {
    const pb = pbs[i] ? JSON.parse(pbs[i]!) : {};
    return { rank: i + 1, pid: e.member, ms: e.score, name: pb.name ?? 'Driver', color: pb.color ?? '#ff5a1f', sectors: pb.sectors, at: pb.at ?? 0 };
  });
  const onTrack = live.map((e, i) => ({ pid: e.member, ...(names[i] ? JSON.parse(names[i]!) : { name: 'Driver', color: '#888888' }) }));
  return json({ entries, total, onTrack, storage: db.kind });
}
