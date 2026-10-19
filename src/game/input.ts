import type { Controls } from './kart';

/** Keyboard + gamepad + touch, merged into one Controls value per frame. */
export class Input {
  private keys = new Set<string>();
  private touch = { left: false, right: false, gas: false, brake: false, drift: false };
  private keySteer = 0;
  private pressed = new Set<string>();
  private cleanup: (() => void)[] = [];
  private padPrev: Record<number, boolean> = {};

  constructor(touchRoot?: HTMLElement) {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    const blur = () => this.keys.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });
    if (touchRoot) this.bindTouch(touchRoot);
  }

  private bindTouch(root: HTMLElement) {
    root.querySelectorAll<HTMLElement>('[data-touch]').forEach((el) => {
      const k = el.dataset.touch as keyof Input['touch'];
      const on = (e: Event) => {
        e.preventDefault();
        this.touch[k] = true;
        el.classList.add('on');
      };
      const off = (e: Event) => {
        e.preventDefault();
        this.touch[k] = false;
        el.classList.remove('on');
      };
      el.addEventListener('pointerdown', on);
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('pointerleave', off);
    });
  }

  /** One-shot key press (consumed on read). */
  consume(key: string): boolean {
    const had = this.pressed.has(key);
    this.pressed.delete(key);
    return had;
  }

  read(dt: number): Controls {
    const k = this.keys;
    let throttle = k.has('ArrowUp') || k.has('w') || this.touch.gas ? 1 : 0;
    let brake = k.has('ArrowDown') || k.has('s') || this.touch.brake ? 1 : 0;
    const l = k.has('ArrowLeft') || k.has('a') || this.touch.left;
    const r = k.has('ArrowRight') || k.has('d') || this.touch.right;
    const target = (r ? 1 : 0) - (l ? 1 : 0);
    // Ramp keyboard steering so taps are gentle and holds are full lock.
    const rate = target === 0 ? 9 : Math.sign(target) !== Math.sign(this.keySteer) ? 10 : 4.5;
    this.keySteer += Math.max(-rate * dt, Math.min(rate * dt, target - this.keySteer));
    let steer = this.keySteer;
    let drift = k.has(' ') || k.has('Shift') || this.touch.drift;

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steer = Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) ** 1.4;
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0, pad.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0, pad.buttons[1]?.pressed ? 1 : 0);
      drift = drift || !!pad.buttons[2]?.pressed || !!pad.buttons[5]?.pressed;
      for (const [btn, key] of [[9, 'Escape'], [3, 'r']] as const) {
        const now = !!pad.buttons[btn]?.pressed;
        if (now && !this.padPrev[btn]) this.pressed.add(key);
        this.padPrev[btn] = now;
      }
    }
    return { throttle, brake, steer, drift };
  }

  dispose() {
    this.cleanup.forEach((f) => f());
  }
}
