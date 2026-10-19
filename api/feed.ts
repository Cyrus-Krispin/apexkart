// GET /api/feed: latest laps worldwide, the record on every track, live driver counts, and
// who is on track right now (and where). Identical for every caller, so the CDN can absorb polling.
import { getStore, K, json, LIVE_WINDOW_MS } from './_lib/store.js';

const ON_TRACK_MAX = 24;

const parse = (v: string | null) => {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};

export async function GET() {
  const db = getStore();
  const now = Date.now();
  await db.zremrangebyscore(K.liveAll, 0, now - LIVE_WINDOW_MS);
  const [laps, recs, live] = await Promise.all([db.lrange(K.feed, 0, 24), db.hgetall(K.records), db.zrange(K.liveAll, 0, -1)]);
  const records: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(recs)) records[k] = typeof v === 'string' ? JSON.parse(v) : v;
  const counts: Record<string, number> = {};
  const sessions: { track: string; dir: string; pid: string; at: number }[] = [];
  for (const { member, score } of live) {
    const [t, d, pid] = member.split('|');
    counts[`${t}|${d}`] = (counts[`${t}|${d}`] ?? 0) + 1;
    if (pid) sessions.push({ track: t, dir: d, pid, at: score });
  }
  // Most recent heartbeat first; one row per driver.
  sessions.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const rows = sessions.filter((s) => !seen.has(s.pid) && seen.add(s.pid)).slice(0, ON_TRACK_MAX);
  const tracks = [...new Set(rows.map((r) => r.track))];
  const [names, infos] = rows.length
    ? await Promise.all([db.hmget(K.names, rows.map((r) => r.pid)), db.hmget(K.trackInfo, tracks)])
    : [[], []];
  const info = new Map(tracks.map((t, i) => [t, parse(infos[i]) as { name?: string; center?: [number, number] } | null]));
  const onTrack = rows.map((r, i) => {
    const who = parse(names[i]) ?? {};
    const where = info.get(r.track);
    return { track: r.track, dir: r.dir, name: who.name ?? 'Driver', color: who.color ?? '#888888', trackName: where?.name ?? null, center: where?.center ?? null };
  });
  return json(
    { laps: laps.map((l) => (typeof l === 'string' ? JSON.parse(l) : l)), records, live: counts, onTrack },
    200,
    'public, s-maxage=3, stale-while-revalidate=10',
  );
}
