// The daily circuit: one featured circuit per UTC day, the same for everyone, picked from the date.
// Shared by the API (which keeps the day's board) and the browser.

export const DAY_MS = 86_400_000;

/** The UTC day, as YYYY-MM-DD. */
export const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (day: string, ids: string[]) => hash(`apexkart:${day}`) % ids.length;

/** Today's circuit from the featured ids, never the same as yesterday's. */
export function dailyTrack(day: string, ids: string[]): string | null {
  if (!ids.length) return null;
  const i = pick(day, ids);
  const yesterday = dayOf(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
  return ids[ids.length > 1 && i === pick(yesterday, ids) ? (i + 1) % ids.length : i];
}

/** Milliseconds until the next UTC day (and the next daily circuit). */
export const msLeftToday = (t = Date.now()) => DAY_MS - (t % DAY_MS);

// ---- Browser only: your daily best and streak, kept on this device.

const BEST = 'ak:dailybest';
const STREAK = 'ak:streak';

/** Your best lap on today's circuit, if you've set one today. */
export function dailyBest(day = dayOf()): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(BEST) || 'null');
    return v?.day === day ? v.ms : null;
  } catch {
    return null;
  }
}

/** Record a lap on today's circuit. True if it's your best today (and moves your streak on). */
export function recordDailyLap(ms: number, day = dayOf()): boolean {
  const best = dailyBest(day);
  if (best !== null && ms >= best) return false;
  try {
    localStorage.setItem(BEST, JSON.stringify({ day, ms }));
    const s = JSON.parse(localStorage.getItem(STREAK) || 'null') as { day: string; n: number } | null;
    if (s?.day !== day) {
      const yesterday = dayOf(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
      localStorage.setItem(STREAK, JSON.stringify({ day, n: s?.day === yesterday ? s.n + 1 : 1 }));
    }
  } catch {
    /* private mode */
  }
  return true;
}

/** Days in a row you've set a lap on the daily circuit (today or up to yesterday still counts). */
export function dailyStreak(day = dayOf()): number {
  try {
    const s = JSON.parse(localStorage.getItem(STREAK) || 'null') as { day: string; n: number } | null;
    const yesterday = dayOf(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
    return s && (s.day === day || s.day === yesterday) ? s.n : 0;
  } catch {
    return 0;
  }
}
