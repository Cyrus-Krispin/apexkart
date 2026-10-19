// GET /api/daily: today's daily circuit (one featured circuit per UTC day) and its board.
import { getStore, K, json } from './_lib/store.js';
import { FEATURED_IDS } from './_lib/featured.js';
import { dailyTrack, dayOf, msLeftToday } from '../src/shared/daily.js';

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
  const day = dayOf(now);
  const [top, total] = await Promise.all([db.zrange(K.daily(day), 0, 9), db.zcard(K.daily(day))]);
  const names = top.length ? await db.hmget(K.names, top.map((e) => e.member)) : [];
  const entries = top.map((e, i) => ({ rank: i + 1, pid: e.member, ms: e.score, name: parse(names[i])?.name ?? 'Driver', color: parse(names[i])?.color ?? '#888888' }));
  return json(
    { day, track: dailyTrack(day, FEATURED_IDS), dir: 'fwd', endsAt: now + msLeftToday(now), total, entries },
    200,
    'public, s-maxage=5, stale-while-revalidate=20',
  );
}
