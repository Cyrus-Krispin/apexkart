// Tilt steering: the phone, held sideways, is the steering wheel.

const FULL_LOCK = 27; // degrees of tilt for full lock
const DEAD_ZONE = 2.5; // degrees either side of straight ahead that do nothing

export type TiltFailure = 'denied' | 'gesture' | 'silent';

type OrientationPermission = { requestPermission?: () => Promise<'granted' | 'denied'> };

/** Screen rotation from the phone's natural (portrait) orientation, degrees counter-clockwise. */
function screenAngle(): number {
  return screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0;
}

export class Tilt {
  /** off, waiting for the first reading (and on iOS, for permission), then live. */
  state: 'off' | 'waiting' | 'live' = 'off';
  private roll: number | null = null; // wheel angle in degrees, + = right side of the screen lower
  private zero = 0;
  private steer = 0;
  private timer = 0;

  constructor(private onFail: (why: TiltFailure) => void) {}

  get live() {
    return this.state === 'live';
  }

  /** Start reading the sensor. Call it inside a tap or key press: iOS asks for motion access here. */
  start() {
    if (this.state !== 'off') return;
    this.state = 'waiting';
    const DOE = window.DeviceOrientationEvent as unknown as OrientationPermission | undefined;
    if (!DOE?.requestPermission) return this.listen();
    DOE.requestPermission().then(
      (r) => (r === 'granted' ? this.listen() : this.fail('denied')),
      () => this.fail('gesture'), // asked outside a tap; picking Tilt again asks properly
    );
  }

  stop() {
    removeEventListener('deviceorientation', this.onOrient);
    clearTimeout(this.timer);
    this.state = 'off';
    this.roll = null;
    this.steer = 0;
  }

  /** Straight ahead is however the phone is held right now. */
  recentre() {
    if (this.roll !== null) this.zero = this.roll;
  }

  /** Steering -1..1: a small dead zone, full lock at FULL_LOCK degrees, lightly smoothed. */
  read(dt: number): number {
    if (this.roll === null) return 0;
    const d = ((this.roll - this.zero + 540) % 360) - 180;
    const mag = Math.min(1, Math.max(0, Math.abs(d) - DEAD_ZONE) / (FULL_LOCK - DEAD_ZONE));
    this.steer += (Math.sign(d) * mag - this.steer) * Math.min(1, dt * 15);
    return this.steer;
  }

  private listen() {
    if (this.state !== 'waiting') return;
    addEventListener('deviceorientation', this.onOrient);
    // Nothing within a second: no sensor, or the browser blocks it.
    this.timer = window.setTimeout(() => this.fail('silent'), 1000);
  }

  private fail(why: TiltFailure) {
    if (this.state !== 'waiting') return;
    this.stop();
    this.onFail(why);
  }

  private onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    // Gravity in the phone's own axes (x right, y up in portrait), from beta and gamma...
    const b = (e.beta * Math.PI) / 180;
    const g = (e.gamma * Math.PI) / 180;
    const gx = Math.cos(b) * Math.sin(g);
    const gy = -Math.sin(b);
    // ...then along the screen as it's turned now, so both landscape directions work.
    const a = (screenAngle() * Math.PI) / 180;
    const right = gx * Math.cos(a) - gy * Math.sin(a);
    const up = gx * Math.sin(a) + gy * Math.cos(a);
    // Upright or tipped back up to ~65°, this is the wheel angle whatever the tip. Held flatter, it
    // eases into plain left-right tilt instead of jumping about.
    this.roll = (Math.atan2(right, Math.max(-up, 0.4)) * 180) / Math.PI;
    if (this.state === 'waiting') {
      clearTimeout(this.timer);
      this.state = 'live';
    }
  };
}
