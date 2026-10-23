// The phone wheel as seen by the game: the latest steering from a paired phone (src/net/pad.ts
// writes it, Input reads it), plus a way back to the phone for the pedal layout and vibration.
// Kept free of networking so the race code doesn't pull the mesh in.
import type { ControlScheme } from './input';

/** Steering older than this is ignored (phone asleep, link dropped): the keyboard takes over. */
const FRESH_MS = 400;

export interface PadSink {
  scheme(s: ControlScheme): void;
  buzz(pattern: number | number[]): void;
}

class RemotePad {
  private steer = 0;
  private brake = 0;
  private gas = 0;
  private at = -Infinity;
  private sink: PadSink | null = null;
  private lastScheme: ControlScheme | null = null;

  /** From the link: a fresh steering packet. */
  set(steer: number, brake: number, gas: number) {
    this.steer = Math.max(-1, Math.min(1, steer));
    this.brake = Math.max(0, Math.min(1, brake));
    this.gas = Math.max(0, Math.min(1, gas));
    this.at = performance.now();
  }

  /** The current phone controls, or null when no phone is steering right now. */
  read(): { steer: number; brake: number; gas: number } | null {
    if (performance.now() - this.at > FRESH_MS) return null;
    return { steer: this.steer, brake: this.brake, gas: this.gas };
  }

  /** The link connects (sink) or goes away (null). A new phone is told the current scheme. */
  attach(sink: PadSink | null) {
    this.sink = sink;
    if (!sink) this.at = -Infinity;
    else if (this.lastScheme) sink.scheme(this.lastScheme);
  }

  get connected() {
    return !!this.sink;
  }

  /** The race's control scheme changed: Classic shows a gas pedal on the phone. */
  scheme(s: ControlScheme) {
    this.lastScheme = s;
    this.sink?.scheme(s);
  }

  buzz(pattern: number | number[]) {
    this.sink?.buzz(pattern);
  }
}

export const remotePad = new RemotePad();
