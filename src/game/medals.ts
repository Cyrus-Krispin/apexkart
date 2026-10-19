// Medals: four target times per circuit and direction, set from the track record so they stay
// worth chasing as the leaderboard gets faster. Medals you've earned are kept on this device.
import type { Dir } from '../net/api';

export type Medal = 'bronze' | 'silver' | 'gold' | 'platinum';
export const MEDALS: Medal[] = ['bronze', 'silver', 'gold', 'platinum'];
export const MEDAL_NAME: Record<Medal, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

/** How far off the record each medal is. Platinum is within a percent: record pace. */
const FACTOR: Record<Medal, number> = { bronze: 1.17, silver: 1.09, gold: 1.04, platinum: 1.01 };
/** Average speed of a quick lap, for circuits nobody has set a record on yet. */
const REF_SPEED = 22; // m/s

export type Targets = Record<Medal, number>;

export function targets(recordMs: number | null | undefined, lengthM: number): Targets {
  const ref = recordMs && recordMs > 0 ? recordMs : (lengthM / REF_SPEED) * 1000;
  return Object.fromEntries(MEDALS.map((m) => [m, Math.round(ref * FACTOR[m])])) as Targets;
}

/** The best medal a lap time earns against these targets. */
export function medalFor(ms: number | null | undefined, t: Targets): Medal | null {
  if (ms == null) return null;
  for (const m of [...MEDALS].reverse()) if (ms <= t[m]) return m;
  return null;
}

const key = (track: string, dir: Dir) => `ak:medal:${track}:${dir}`;
const rank = (m: Medal | null) => (m ? MEDALS.indexOf(m) : -1);

/** The best medal you've won on this circuit and direction. */
export function earnedMedal(track: string, dir: Dir): Medal | null {
  try {
    const m = localStorage.getItem(key(track, dir)) as Medal | null;
    return m && MEDALS.includes(m) ? m : null;
  } catch {
    return null;
  }
}

/** Keep a medal if it beats the one you had. True when it's new. */
export function awardMedal(track: string, dir: Dir, m: Medal): boolean {
  if (rank(m) <= rank(earnedMedal(track, dir))) return false;
  try {
    localStorage.setItem(key(track, dir), m);
  } catch {
    /* private mode: it still shows this session */
  }
  return true;
}

/** Every medal on this device, by kind (for the profile summary). */
export function medalCounts(): Record<Medal, number> {
  const out: Record<Medal, number> = { bronze: 0, silver: 0, gold: 0, platinum: 0 };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (!k.startsWith('ak:medal:')) continue;
      const m = localStorage.getItem(k) as Medal;
      if (MEDALS.includes(m)) out[m]++;
    }
  } catch {
    /* ignore */
  }
  return out;
}
