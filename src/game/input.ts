import type { Controls } from './kart';
import { phonePad, type PadButton, type PadSource } from '../net/pad';

/** Simple accelerates by itself (brake and steer only); Classic is throttle and brake. */
export type ControlScheme = 'simple' | 'classic';

export const SCHEME_LABEL: Record<ControlScheme, string> = { simple: 'Simple', classic: 'Classic' };

type TouchKey = 'left' | 'right' | 'gas' | 'brake';

/** Phones and tablets: the same test that shows the on-screen controls. */
export function touchDevice(): boolean {
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/** The schemes, in toggle order. */
export function availableSchemes(): ControlScheme[] {
  return ['simple', 'classic'];
}

/** The player's scheme; Simple until they pick another (a saved "tilt" from v0.14 falls back to Simple). */
export function controlsPref(): ControlScheme {
  const v = localStorage.getItem('ak:controls') as ControlScheme | null;
  return v && availableSchemes().includes(v) ? v : 'simple';
}

export function saveControlsPref(s: ControlScheme) {
  localStorage.setItem('ak:controls', s);
}

/** Phone controller buttons act as these keys (Start is handled by the briefing's own key listener). */
const PAD_KEY: Record<Exclude<PadButton, 'go'>, string> = { pause: 'Escape', reset: 'r' };

/**
 * Keyboard + gamepad + touch + a paired phone (src/net/pad.ts), merged into one Controls value per frame.
 * A party kart (src/party.ts) has only its own phone: `pad`.
 */
export class Input {
  private keys = new Set<string>();
  private fingers = new Map<number, TouchKey | null>(); // pointerId -> the control under that finger
  private keySteer = 0;
  private pressed = new Set<string>();
  private cleanup: (() => void)[] = [];
  private padPrev: Record<number, boolean> = {};

  constructor(
    private touchRoot: HTMLElement,
    public scheme: ControlScheme,
    private pad?: PadSource,
  ) {
    if (pad) return; // the party handles the keyboard and the phones' buttons for every kart
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Backspace'].includes(e.key)) e.preventDefault();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    const blur = () => {
      this.keys.clear();
      this.releaseFingers();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });
    this.cleanup.push(phonePad.on('button', (b) => b !== 'go' && this.pressed.add(PAD_KEY[b])));
    this.bindTouch();
  }

  /**
   * On-screen controls. Each finger is tracked by its pointer id and can slide from one control to
   * the next (or off and back on). The layer never starts a browser gesture: no scroll, zoom, text
   * selection or long-press menu that would swallow the other fingers' touches.
   */
  private bindTouch() {
    const root = this.touchRoot;
    const under = (e: PointerEvent) =>
      (document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-touch]')?.dataset.touch as TouchKey | undefined) ?? null;
    root.addEventListener('pointerdown', (e) => {
      const el = e.target as HTMLElement;
      if (el.closest('[data-act]')) return; // a real button: let it click
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId); // keep this finger's moves and release coming here
      this.fingers.set(e.pointerId, under(e));
      this.paintTouch();
    });
    root.addEventListener('pointermove', (e) => {
      if (!this.fingers.has(e.pointerId)) return;
      const key = under(e);
      if (key === this.fingers.get(e.pointerId)) return;
      this.fingers.set(e.pointerId, key);
      this.paintTouch();
    });
    const lift = (e: PointerEvent) => {
      if (this.fingers.delete(e.pointerId)) this.paintTouch();
    };
    root.addEventListener('pointerup', lift);
    root.addEventListener('pointercancel', lift);
    root.addEventListener('lostpointercapture', lift);
    // iOS starts text selection and the loupe from touchstart; pointer events still arrive.
    root.addEventListener(
      'touchstart',
      (e) => {
        if (!(e.target as HTMLElement).closest('[data-act]')) e.preventDefault();
      },
      { passive: false },
    );
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private touching(key: TouchKey) {
    for (const k of this.fingers.values()) if (k === key) return true;
    return false;
  }

  private paintTouch() {
    this.touchRoot.querySelectorAll<HTMLElement>('[data-touch]').forEach((el) => el.classList.toggle('on', this.touching(el.dataset.touch as TouchKey)));
  }

  private releaseFingers() {
    this.fingers.clear();
    this.paintTouch();
  }

  /** Switch schemes. */
  setScheme(s: ControlScheme) {
    this.scheme = s;
    this.releaseFingers(); // the on-screen layout changes under any finger that's down
  }

  /** One-shot key press (consumed on read). */
  consume(key: string): boolean {
    const had = this.pressed.has(key);
    this.pressed.delete(key);
    return had;
  }

  read(dt: number): Controls {
    if (this.pad) return this.readPad();
    const k = this.keys;
    const classic = this.scheme === 'classic';
    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    const dpad = (b: number) => !classic && !!pad?.buttons[b]?.pressed; // Classic keeps its original pad mapping
    let throttle = classic && (k.has('ArrowUp') || k.has('w') || this.touching('gas')) ? 1 : 0;
    let brake = k.has('ArrowDown') || k.has('s') || k.has(' ') || this.touching('brake') ? 1 : 0;
    const l = k.has('ArrowLeft') || k.has('a') || this.touching('left') || dpad(14);
    const r = k.has('ArrowRight') || k.has('d') || this.touching('right') || dpad(15);
    const target = (r ? 1 : 0) - (l ? 1 : 0);
    // Ramp keyboard steering so taps are gentle and holds are full lock.
    const rate = target === 0 ? 9 : Math.sign(target) !== Math.sign(this.keySteer) ? 10 : 4.5;
    this.keySteer += Math.max(-rate * dt, Math.min(rate * dt, target - this.keySteer));
    let steer = this.keySteer;

    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steer = Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) ** 1.4;
      if (classic) throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0, pad.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0, pad.buttons[1]?.pressed ? 1 : 0);
      // Start pauses, Y resets onto the track, Select (Back) restarts the lap in a time trial.
      for (const [btn, key] of [[9, 'Escape'], [3, 'r'], [8, 'Backspace']] as const) {
        const now = !!pad.buttons[btn]?.pressed;
        if (now && !this.padPrev[btn]) this.pressed.add(key);
        this.padPrev[btn] = now;
      }
    }
    // A paired phone: its tilt steers unless a key or the stick is steering; its pedals add to the rest.
    const phone = phonePad.input();
    if (phone) {
      if (target === 0 && !(pad && Math.abs(pad.axes[0] ?? 0) > 0.12)) steer = phone.steer;
      brake = Math.max(brake, phone.brake);
      if (classic) throttle = Math.max(throttle, phone.gas);
    }
    // Simple: always on the throttle except while braking. Brake held at a standstill
    // reverses (KartPhysics), so a player can back off a wall.
    if (!classic) throttle = 1 - brake;
    return { throttle, brake, steer, drift: false }; // no drift: the field stays for the physics and ghosts
  }

  /** A party kart: its phone alone, read as below. A phone that isn't steering lets the kart roll to a stop. */
  private readPad(): Controls {
    const p = this.pad!.input();
    if (!p) return { throttle: 0, brake: 0, steer: 0, drift: false };
    return { throttle: this.scheme === 'classic' ? p.gas : 1 - p.brake, brake: p.brake, steer: p.steer, drift: false };
  }

  dispose() {
    this.cleanup.forEach((f) => f());
  }
}
