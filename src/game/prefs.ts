// Small player settings and records the home screen reads, kept free of Three.js so the home
// screen doesn't have to load the 3D engine (the race loads it on demand).
import type { Dir } from '../net/api';

export type TimeOfDay = 'day' | 'night';
/** The player's setting: a fixed time of day, or "live" (whatever it is at the circuit right now). */
export type TimePref = TimeOfDay | 'live';

export function timePref(): TimePref {
  const v = localStorage.getItem('ak:time');
  return v === 'day' || v === 'night' ? v : 'live';
}

export function saveTimePref(t: TimePref) {
  localStorage.setItem('ak:time', t);
}

/** Local personal best for a track. */
export function localPB(trackId: string, dir: Dir): number | null {
  try {
    return JSON.parse(localStorage.getItem(`ak:pb:${trackId}:${dir}`) || 'null')?.ms ?? null;
  } catch {
    return null;
  }
}
