// Multiplayer room protocol shared by the client (src/net/room.ts) and the API (api/room.ts).
// See MULTIPLAYER.md for the design.

export const ROOM_MAX = 8;
/** Screens watching a room without racing (a TV in the room, a friend following along). */
export const WATCH_MAX = 8;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
export const MID_RE = /^[0-9a-f]{12}$/;
export const SECRET_RE = /^[0-9a-f]{32}$/;
export const LAPS_MIN = 1;
export const LAPS_MAX = 20;
export const LAPS_DEFAULT = 3;

/** Lights go out this long after the host presses Start. */
export const START_DELAY_MS = 7000;
/** A player who hasn't sent a heartbeat for this long is dropped from the room. */
export const STALE_MS = 35_000;
/** Rooms with no activity (joins, settings, races) for this long are closed. */
export const IDLE_MS = 30 * 60_000;
/** Room keys expire this long after the last heartbeat from anyone. */
export const ROOM_TTL_S = 120;
/** After the winner finishes, everyone else has this long before they're marked DNF. */
export const FINISH_GRACE_MS = 45_000;

/** Kart liveries (same list as LIVERIES in src/ui/profile.ts; colours are unique within a room). */
export const KART_COLORS = ['#ff4d00', '#141414', '#f2eee5', '#e5383b', '#ffc600', '#16a34a', '#0ea5e9', '#2f4bff', '#8b5cf6', '#ec4899'];

/** Snap any colour to the closest livery, so "taken" colours can't be near-duplicates. */
export function nearestLivery(hex: string): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = rgb(hex);
  let best = KART_COLORS[0];
  let bestD = Infinity;
  for (const c of KART_COLORS) {
    const [r2, g2, b2] = rgb(c);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}

export type Dir = 'fwd' | 'rev';
/** Time of day for the whole room. Rooms created before this setting existed have none: treat as day. */
export type RoomTime = 'day' | 'night';
export const isRoomTime = (t: unknown): t is RoomTime => t === 'day' || t === 'night';
export const roomTime = (cfg: { time?: RoomTime }): RoomTime => cfg.time ?? 'day';

export interface RaceResult {
  race: number;
  track: string;
  trackName: string;
  dir: Dir;
  laps: number;
  /** Finishing order; ms = null means DNF (retired, left, or out of time). */
  rows: { mid: string; name: string; color: string; ms: number | null }[];
}

export interface RoomCfg {
  code: string;
  host: string; // mid of the host
  track: string; // track id; full geometry is served by GET /api/room?code=&trk=1
  trackName: string;
  lengthM: number;
  dir: Dir;
  laps: number;
  /** Day or night for everyone (host setting). Missing on older rooms: use roomTime(). */
  time?: RoomTime;
  /** Settings version. A player is ready when their ready value equals v. */
  v: number;
  phase: 'lobby' | 'racing';
  race: number; // increments every start
  startAt: number; // server epoch ms when the lights go out
  grid: GridSlot[]; // grid order (pole first), fixed when the race starts
  created: number;
  active: number; // last activity, for idle expiry
  last: RaceResult | null;
}

export interface GridSlot {
  mid: string;
  name: string;
  color: string;
}

export interface RoomPlayer {
  mid: string;
  name: string;
  color: string;
  joined: number;
  seen: number;
  ready: number; // = cfg.v when ready
  /** Finish for race `r`: ms from lights-out to the line, or null for DNF. */
  fin: { r: number; ms: number | null } | null;
}

/** A screen watching the room: not on the grid, never ready, never host. Players send it their poses. */
export interface RoomWatcher {
  mid: string;
  name: string;
  joined: number;
  seen: number;
}

export interface RoomState {
  cfg: RoomCfg;
  players: RoomPlayer[];
  /** Missing from rooms served before watching existed. */
  watchers?: RoomWatcher[];
}

/** Signaling message relayed through the room (WebRTC offer/answer). */
export interface SignalMsg {
  from: string;
  k: 'offer' | 'answer';
  id: number; // connection attempt id
  sdp: string;
}

export interface PollResponse {
  now: number;
  state: RoomState | null; // null = room closed / expired
  closed?: 'gone' | 'idle' | 'kicked';
  mail: SignalMsg[];
  mailN: number; // total signals ever sent to me; poll again with this as `mailN` to skip the inbox read
}

/** Network pose: [t, x, z, heading, vx, vz, yawRate, steer, progress, race]. t = sender's server-synced clock (ms). */
export type PoseTuple = [number, number, number, number, number, number, number, number, number, number];

export function isReady(p: RoomPlayer, cfg: RoomCfg) {
  return p.ready === cfg.v;
}

/** Results for the current race from what's in the room: finishers by time, then DNFs. */
export function raceResult(state: RoomState): RaceResult {
  const { cfg } = state;
  const byMid = new Map(state.players.map((p) => [p.mid, p]));
  const rows = cfg.grid.map((g) => {
    const fin = byMid.get(g.mid)?.fin;
    return { mid: g.mid, name: g.name, color: g.color, ms: fin?.r === cfg.race ? fin.ms : null };
  });
  rows.sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  return { race: cfg.race, track: cfg.track, trackName: cfg.trackName, dir: cfg.dir, laps: cfg.laps, rows };
}
