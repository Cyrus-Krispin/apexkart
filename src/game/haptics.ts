// Haptics: the Vibration API on Android phones (iOS Safari has none) and rumble on gamepads that have it.
// Calls are throttled, and everything stays off while the sound is muted or the system asks for
// reduced motion.
import { touchDevice } from './input';

type Pad = Gamepad & {
  vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> } | null;
};

export class Haptics {
  private last = 0;
  private lastKerb = 0;
  private touch = touchDevice();
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private muted: () => boolean) {}

  private get on() {
    return !this.muted() && !this.reduced.matches && document.hasFocus();
  }

  /** A wall hit at `speed` m/s into the barrier. */
  impact(speed: number) {
    const k = Math.min(1, speed / 8);
    this.fire(Math.round(15 + 45 * k), 90, k, 0.3 * k, true);
  }

  /** On the kerb: a tick per few stripes, re-armed at most every 110 ms, only at speed. */
  kerb(level: number, speed: number) {
    if (level <= 0 || speed < 8) return;
    const now = performance.now();
    if (now - this.lastKerb < 110) return;
    if (this.fire([6, 30], 60, 0, 0.35)) this.lastKerb = now;
  }

  /** A red light coming on, or lights out. */
  light(out: boolean) {
    this.fire(out ? 45 : 10, out ? 120 : 40, out ? 0.6 : 0, out ? 0.4 : 0.25, true);
  }

  personalBest() {
    this.fire([30, 60, 30], 200, 0.4, 0.6, true);
  }

  /** At most one call per 50 ms unless it matters (impacts, lights). Returns whether it fired. */
  private fire(pattern: number | number[], ms: number, strong: number, weak: number, priority = false): boolean {
    if (!this.on) return false;
    const now = performance.now();
    if (now - this.last < (priority ? 15 : 50)) return false;
    this.last = now;
    try {
      if (this.touch && 'vibrate' in navigator) navigator.vibrate(pattern);
      const pad = navigator.getGamepads?.().find((p) => p?.connected && (p as Pad).vibrationActuator) as Pad | undefined;
      pad?.vibrationActuator?.playEffect?.('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak })?.catch(() => {});
    } catch {
      /* not supported here */
    }
    return true;
  }
}
