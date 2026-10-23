// Phone controller pairing, shared by the client (src/net/pad.ts) and the API (api/pad.ts).
// A screen (the laptop running the game) opens a pairing code; a phone joins it by scanning the
// QR code (or typing the code), and the two connect peer-to-peer over WebRTC, signaling through
// /api/pad exactly like room players do through /api/room. See docs/phone-controller.md.
import type { SignalMsg } from './room';

/** A pairing code lives this long after the screen's last poll. */
export const PAD_TTL_S = 15 * 60;

/** Phones a party code (split screen, src/party.ts) seats. */
export const PARTY_MAX = 4;

export interface PadPollResponse {
  now: number;
  /** false: the code has expired or was closed (the screen opens a new one), or another phone took it. */
  open: boolean;
  /** The paired phone's id, or null while no phone has joined. */
  pad: string | null;
  /** A party code: the phone in each seat (PARTY_MAX of them), or null for an empty seat. */
  seats?: (string | null)[];
  mail: SignalMsg[];
}

/** Steering frames, phone -> screen, ~60 Hz on the unreliable channel: [seq, steer -1..1, brake 0..1, gas 0..1]. */
export type PadFrame = [number, number, number, number];

/** Buttons on the phone. They act on the game as the matching key would. */
export type PadButton = 'pause' | 'reset' | 'go';

/** What the screen is showing, so the phone can offer the right buttons. */
export type PadView = 'menu' | 'brief' | 'race' | 'paused';

/** Reliable messages in either direction. */
export type PadCtl =
  | { k: 'btn'; b: PadButton } // phone -> screen
  | { k: 'hello'; tilt: boolean } // phone -> screen: whether it steers by tilt or by buttons
  | { k: 'view'; view: PadView; scheme: 'simple' | 'classic'; mp: boolean } // screen -> phone
  | { k: 'buzz'; p: number | number[] } // screen -> phone: vibrate (Android)
  | { k: 'seat'; n: number; color: string } // screen -> phone, in a party: which kart it drives (0 = P1)
  | { k: 'ping'; t: number }
  | { k: 'pong'; t: number }
  | { k: 'bye' };
