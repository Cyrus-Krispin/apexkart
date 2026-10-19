// GET /api/feed: latest laps worldwide, the record on every track, and live driver counts.
// Identical for every caller, so the CDN can absorb polling.
import { getStore, K, json, LIVE_WINDOW_MS } from './_lib/store.js';

export async function GET() {
  const db = getStore();
  const now = Date.now();
  await db.zremrangebyscore(K.liveAll, 0, now - LIVE_WINDOW_MS);
  const [laps, recs, live] = await Promise.all([db.lrange(K.feed, 0, 24), db.hgetall(K.records), db.zrange(K.liveAll, 0, -1)]);
  const records: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(recs)) records[k] = typeof v === 'string' ? JSON.parse(v) : v;
  const counts: Record<string, number> = {};
  for (const { member } of live) {
    const [t, d] = member.split('|');
    counts[`${t}|${d}`] = (counts[`${t}|${d}`] ?? 0) + 1;
  }
  return json(
    { laps: laps.map((l) => (typeof l === 'string' ? JSON.parse(l) : l)), records, live: counts },
    200,
    'public, s-maxage=3, stale-while-revalidate=10',
  );
}
