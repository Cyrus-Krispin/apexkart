import type { Controls } from './kart';
import { Tilt, type TiltFailure } from './tilt';

/** Simple and Tilt accelerate by themselves (brake and steer only); Classic is throttle, brake and drift. */
export type ControlScheme = 'tilt' | 'simple' | 'classic';

export const SCHEME_LABEL: Record<ControlScheme, string> = { tilt: 'Tilt', simple: 'Simple', classic: 'Classic' };

type TouchKey = 'left' | 'right' | 'gas' | 'brake' | 'drift';

/** Phones and tablets: the same test that shows the on-screen controls. */
export function touchDevice(): boolean {
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/** A phone rather than a tablet: a touch screen whose short side is phone-sized. Phones race in landscape. */
export function phone(): boolean {
  return touchDevice() && Math.min(screen.width, screen.height) < 600;
}

/** Schemes this device offers, in toggle order. Tilt needs a touch screen with a motion sensor API. */
export function availableSchemes(): ControlScheme[] {
  return touchDevice() && 'DeviceOrientationEvent' in window ? ['tilt', 'simple', 'classic'] : ['simple', 'classic'];
}

/** The player's scheme; Simple until they pick another (Tilt is opt-in: it asks for motion access and turns the phone sideways). */
export function controlsPref(): ControlScheme {
  const v = localStorage.getItem('ak:controls') as ControlScheme | null;
  return v && availableSchemes().includes(v) ? v : 'simple';
}

export function saveControlsPref(s: ControlScheme) {
  localStorage.setItem('ak:controls', s);
}

/** Keyboard + gamepad + touch (+ tilt), merged into one Controls value per frame. */
export class Input {
  readonly tilt: Tilt;
  private keys = new Set<string>();
  private fingers = new Map<number, TouchKey | null>(); // pointerId -> the control under that finger
  private keySteer = 0;
  private pressed = new Set<string>();
  private cleanup: (() => void)[] = [];
  private padPrev: Record<number, boolean> = {};

  constructor(
    private touchRoot: HTMLElement,
    public scheme: ControlScheme,
    onTiltFail: (why: TiltFailure) => void,
  ) {
    this.tilt = new Tilt(onTiltFail);
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
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
      if (el.closest('[data-act]')) return; // a real button (Recentre): let it click
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

  /** Switch schemes. Switching to Tilt starts the sensor, so call it inside a tap (iOS asks for access). */
  setScheme(s: ControlScheme) {
    this.scheme = s;
    this.releaseFingers(); // the on-screen layout changes under any finger that's down
    if (s === 'tilt') this.tilt.start();
    else this.tilt.stop();
  }

  /** One-shot key press (consumed on read). */
  consume(key: string): boolean {
    const had = this.pressed.has(key);
    this.pressed.delete(key);
    return had;
  }

  read(dt: number): Controls {
    const k = this.keys;
    const classic = this.scheme === 'classic';
    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    const dpad = (b: number) => !classic && !!pad?.buttons[b]?.pressed; // Classic keeps its original pad mapping
    let throttle = classic && (k.has('ArrowUp') || k.has('w') || this.touching('gas')) ? 1 : 0;
    let brake = k.has('ArrowDown') || k.has('s') || (!classic && k.has(' ')) || this.touching('brake') ? 1 : 0;
    const l = k.has('ArrowLeft') || k.has('a') || this.touching('left') || dpad(14);
    const r = k.has('ArrowRight') || k.has('d') || this.touching('right') || dpad(15);
    const target = (r ? 1 : 0) - (l ? 1 : 0);
    // Ramp keyboard steering so taps are gentle and holds are full lock.
    const rate = target === 0 ? 9 : Math.sign(target) !== Math.sign(this.keySteer) ? 10 : 4.5;
    this.keySteer += Math.max(-rate * dt, Math.min(rate * dt, target - this.keySteer));
    let steer = this.keySteer;
    if (this.scheme === 'tilt' && this.tilt.live) {
      const tilt = this.tilt.read(dt);
      if (target === 0) steer = tilt;
    }
    let drift = classic && (k.has(' ') || k.has('Shift') || this.touching('drift'));

    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steer = Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) ** 1.4;
      if (classic) {
        throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0, pad.buttons[0]?.pressed ? 1 : 0);
        drift = drift || !!pad.buttons[2]?.pressed || !!pad.buttons[5]?.pressed;
      }
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0, pad.buttons[1]?.pressed ? 1 : 0);
      for (const [btn, key] of [[9, 'Escape'], [3, 'r']] as const) {
        const now = !!pad.buttons[btn]?.pressed;
        if (now && !this.padPrev[btn]) this.pressed.add(key);
        this.padPrev[btn] = now;
      }
    }
    // Simple and Tilt: always on the throttle except while braking. Brake held at a standstill
    // reverses (KartPhysics), so a player can back off a wall.
    if (!classic) throttle = 1 - brake;
    return { throttle, brake, steer, drift };
  }

  dispose() {
    this.tilt.stop();
    this.cleanup.forEach((f) => f());
  }
}
