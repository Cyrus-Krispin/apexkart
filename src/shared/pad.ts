// Phone-as-wheel pairing protocol, shared by the client (src/net/pad.ts) and the API (api/pad.ts).
// A screen (the laptop running the game) opens a pairing with a 4-character code; one phone joins it.
// The two then talk over the same WebRTC mesh multiplayer uses (src/net/mesh.ts): the phone streams
// its steering on the unreliable channel and sends button presses on the reliable one.
// See MULTIPLAYER.md, "Phone as a wheel".
import type { SignalMsg } from './room';

/** Pairing keys expire this long after the last heartbeat. */
export const PAD_TTL_S = 120;
/** A screen or phone that hasn't sent a heartbeat for this long is dropped. */
export const PAD_STALE_MS = 45_000;

export interface PadMember {
  mid: string;
  joined: number;
}

export interface PadPollResponse {
  now: number;
  /** The screen first, then the phone if one has joined. Null when the pairing is gone. */
  members: PadMember[] | null;
  /** Why we're out: the pairing expired or was closed, or another phone took the wheel. */
  closed?: 'gone' | 'replaced';
  mail: SignalMsg[];
  mailN: number;
  /** create only: the new pairing's code. */
  code?: string;
}

/** Steering packet, phone to screen, ~60 Hz on the unreliable channel: [seq, steer -1..1, brake 0..1, gas 0..1]. */
export type PadTuple = [number, number, number, number];

/** Keys the phone's buttons press on the screen (the game's own shortcuts: pause / start, reset onto the track). */
export const PAD_KEYS = ['p', 'r'] as const;
export type PadKey = (typeof PAD_KEYS)[number];

/** Reliable messages between the two ends of a pairing (ride on the mesh's ctl channel). */
export type PadCtlMsg =
  | { k: 'key'; key: PadKey } // phone -> screen: press a key
  | { k: 'scheme'; s: 'simple' | 'classic' } // screen -> phone: which pedals to show
  | { k: 'buzz'; p: number | number[] }; // screen -> phone: vibrate (wall hits, lights out)
