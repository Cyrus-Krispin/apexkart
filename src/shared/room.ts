// Multiplayer room protocol shared by the client (src/net/room.ts) and the API (api/room.ts).
// See MULTIPLAYER.md for the design.

export const ROOM_MAX = 8;
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

export const KART_COLORS = ['#ff5a1f', '#ffd60a', '#2ee66b', '#22d3ee', '#3b82f6', '#a855f7', '#f43f5e', '#f5f5f5'];

export type Dir = 'fwd' | 'rev';

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

export interface RoomState {
  cfg: RoomCfg;
  players: RoomPlayer[];
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
