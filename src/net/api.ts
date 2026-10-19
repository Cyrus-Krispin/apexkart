import type { GhostData } from '../shared/ghost';
import type { LatLon, TrackData } from '../track/osm';

export type Dir = 'fwd' | 'rev';

export interface BoardEntry {
  rank: number;
  pid: string;
  name: string;
  color: string;
  ms: number;
  sectors?: number[];
  at: number;
}

export interface BoardResponse {
  entries: BoardEntry[];
  total: number;
  onTrack: { pid: string; name: string; color: string }[];
  storage: 'redis' | 'memory';
}

export interface FeedItem {
  track: string;
  trackName: string;
  dir: Dir;
  name: string;
  color: string;
  ms: number;
  rank: number;
  at: number;
  center?: LatLon;
}

export interface FeedResponse {
  laps: FeedItem[];
  records: Record<string, { name: string; ms: number; color: string }>;
  live: Record<string, number>; // "track|dir" -> drivers on track now
}

export interface LapSubmission {
  track: string;
  dir: Dir;
  trackName: string;
  trackLength: number;
  center: LatLon;
  name: string;
  color: string;
  driverId: string;
  ms: number;
  sectors: number[];
  ghost: GhostData;
  points: LatLon[];
  width: number;
}

export interface LapResult {
  improved: boolean;
  rank: number;
  pbMs: number;
  total: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

export const api = {
  board: (track: string, dir: Dir, me?: { pid: string; name: string; color: string }) => {
    const q = new URLSearchParams({ track, dir, limit: '10' });
    if (me) Object.entries(me).forEach(([k, v]) => q.set(k, v));
    return fetch(`/api/board?${q}`).then((r) => json<BoardResponse>(r));
  },
  feed: () => fetch('/api/feed').then((r) => json<FeedResponse>(r)),
  submit: (lap: LapSubmission) =>
    fetch('/api/lap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lap) }).then((r) =>
      json<LapResult>(r),
    ),
  track: (id: string) => fetch(`/api/track?id=${encodeURIComponent(id)}`).then((r) => json<TrackData | null>(r)),
  ghost: (track: string, dir: Dir, pid: string) =>
    fetch(`/api/ghost?${new URLSearchParams({ track, dir, pid })}`).then((r) => json<{ ghost: GhostData | null; name: string; color: string; ms: number }>(r)),
};

// ---- Driver identity: a random secret id in localStorage; the public id is a hash of it.

export interface Driver {
  id: string;
  pid: string;
  name: string;
  color: string;
}

const KART_NAMES = ['Apex', 'Slipstream', 'Kerb', 'Hairpin', 'Chicane', 'Turbo', 'Drift', 'Nitro', 'Pole', 'Rookie'];

export async function publicId(driverId: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(driverId));
  return [...new Uint8Array(buf)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function loadDriver(): Promise<Driver> {
  let id = localStorage.getItem('ak:driverId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('ak:driverId', id);
  }
  const name =
    localStorage.getItem('ak:name') || `${KART_NAMES[Math.floor(Math.random() * KART_NAMES.length)]}${Math.floor(Math.random() * 90 + 10)}`;
  localStorage.setItem('ak:name', name);
  const color = localStorage.getItem('ak:color') || '#ff4d00';
  return { id, pid: await publicId(id), name, color };
}

export function saveDriver(d: Driver) {
  localStorage.setItem('ak:name', d.name);
  localStorage.setItem('ak:color', d.color);
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

export function timeAgo(at: number): string {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
