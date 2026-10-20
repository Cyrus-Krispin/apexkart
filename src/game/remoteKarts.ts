// Other players' karts: solid karts with name tags, driven by ~20 Hz network poses.
//
// Each pose carries the sender's server-synced timestamp, so we know how old it is. We
// dead-reckon every kart forward to the instant the frame shows (velocity + yaw rate, i.e.
// along an arc) instead of interpolating in the past: in a race, who's ahead must match
// what you see. Corrections when a new pose arrives are blended in over ~120 ms.
//
// Karts are cloned from one template per colour (shared geometry and materials), and they
// wait visibly on their grid slots from the start, so the race's shader warm-up
// (compileAsync after the world loads) already covers them: no hitch when poses arrive. Each
// kart also has a translucent twin (the ghost material, which the warm-up compiles too), shown
// while contact with it is off.
//
// Contact (collide) is resolved by each player for their own kart against what they see, with
// half of the push-out and half of the impulse each, so the pair together behaves like one
// mostly inelastic collision (restitution 0.2). A kart is a ghost (no contact, drawn translucent) whenever what we see of
// it can't be trusted, or it isn't racing: see `ghostly()`. Every rule uses local facts only
// (pose age, finish events, jumps, speed), so no protocol change was needed.
import * as THREE from 'three';
import { buildKart, poseDriver, type KartPhysics, type KartVisual } from './kart';
import type { PoseTuple } from '../shared/room';

const MAX_EXTRAPOLATE = 0.35; // s; beyond this we just hold the last known motion
const STALE_HIDE = 3; // s without a pose before a kart that was moving disappears
const SNAP_DIST = 8; // m; bigger corrections teleport instead of sliding
// Kart footprint for contact, as an ellipse: half-width, half-length (metres).
const HALF_W = 0.66;
const HALF_L = 0.98;

// Contact response, per side (both players resolve their own kart, so the totals double).
const PUSH = 0.5; // share of the overlap each kart moves out
const IMPULSE = 0.6; // share of the closing speed each kart takes: (1 + e) / 2 with restitution e = 0.2
const RUB = 0.15; // share of the sliding (tangential) speed rubbed off on contact...
const RUB_MU = 0.5; // ...but never more than this times the normal impulse (a light touch barely rubs)
const YAW_KICK = 0.5; // yaw rate (rad/s) per m·(m/s) of angular impulse about the kart's centre
const YAW_MAX = 0.6; // rad/s: a side swipe turns you a little, never round
const HIT_MIN = 0.5; // m/s closing speed for a contact to count as a hit (kartHit, camera bump)
// After an impulse, the other player's half only shows in their poses a pose interval plus the
// network later (about the age of their pose plus 100 ms): until then keep the karts apart
// (push-out) but don't take more of the closing speed, or both sides would take all of it.
const IMPULSE_GAP = 150; // ms, at least
// A contact that still closes after this many impulses isn't being resolved on the other side
// (to them you're a ghost, e.g. your poses reach them late): let them through rather than be shoved.
const MAX_IMPULSES = 2;
// Ghost rules: no contact with a kart (and it's drawn translucent) when any of these holds.
const MAX_AGE = 250; // ms: its pose is older than this (dead-reckoned too far to be fair to hit)
const LATE_HOLD = 500; // ms: after a late pose it stays a ghost this long, so it doesn't flicker
const JUMP_DIST = 3; // m: a new pose this far from where the last one put the kart is a reset or a jump
const JUMP_HOLD = 2000; // ms: a ghost this long after a reset or jump (theirs or yours)
const CRAWL_SPEED = 3; // m/s: below this for longer than CRAWL_T (theirs or yours)...
const CRAWL_T = 2; // s ...a kart is stuck or beached, not racing: it isn't a wall
const CLEAR = 0.15; // m: a kart that was a ghost while overlapping stays one until this far apart
const GHOST_OPACITY = 0.45;
// Slipstream (tow): behind another kart, within TOW_LEN of it and TOW_HALF_W of its line, both
// faster than TOW_SPEED. Strength 0..1 falls off linearly with distance and with the side offset.
const TOW_LEN = 14; // m behind its centre
const TOW_MIN = 1.5; // m: any nearer and you're touching
const TOW_HALF_W = 1.4; // m either side of its line
const TOW_SPEED = 14; // m/s, both karts; full strength from TOW_SPEED + 2

interface Snap {
  t: number; // sender's server-synced ms
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  yaw: number;
  steer: number;
  prog: number;
}

/** A remote kart as currently displayed. */
export interface RemoteKart {
  readonly mid: string;
  readonly color: string;
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  shown: boolean;
}

class Kart implements RemoteKart {
  tag: HTMLDivElement;
  label: HTMLElement;
  snap: Snap | null = null;
  recvAt = 0; // local performance.now() of the latest pose
  x = 0;
  z = 0;
  h = 0;
  vx = 0;
  vz = 0;
  shown = false;
  parked = false; // waiting on the grid, no pose yet
  gone = false;
  wheelSpin = 0;
  tagOpacity = '';
  tagFar = false;
  // Contact state (see the ghost rules above).
  age = Infinity; // ms: how old the pose we're showing is (dead-reckoning time)
  lateUntil = 0; // performance.now() until which a late pose keeps it a ghost
  jumpAt = -Infinity; // performance.now() of its last reset / jump
  crawlT = 0; // s below CRAWL_SPEED while racing
  finished = false; // took the flag (it's on its cool-down lap)
  relayed = false; // its poses come through the slow server relay
  ghost = false; // no contact, from its own state (set in update)
  clearing = false; // was a ghost while overlapping you: stays one until you're apart
  touching = false; // in contact with you last step
  impulseAt = -Infinity; // server ms of the last contact impulse against it
  impulses = 0; // impulses in the current contact (it ends when you're apart)
  drawnGhost = false; // which of the two visuals is showing

  constructor(
    readonly mid: string,
    name: string,
    readonly color: string,
    readonly visual: KartVisual,
    readonly ghostVisual: KartVisual,
    tags: HTMLElement,
  ) {
    visual.root.visible = false;
    ghostVisual.root.visible = false;
    this.tag = document.createElement('div');
    this.tag.className = 'mp-tag';
    this.tag.style.setProperty('--c', color);
    this.tag.innerHTML = `<b></b><span></span>`;
    this.label = this.tag.firstChild as HTMLElement;
    (this.tag.lastChild as HTMLElement).textContent = name;
    this.tag.style.display = 'none';
    tags.appendChild(this.tag);
  }
}

// Scratch for dead reckoning (no per-frame allocations).
const T = { x: 0, z: 0, h: 0, vx: 0, vz: 0 };

/** Pose at server time `now`, integrated along the arc in a few steps. Writes into T. */
function target(s: Snap, now: number) {
  const dt = Math.min(MAX_EXTRAPOLATE, Math.max(0, (now - s.t) / 1000));
  let { x, z, h, vx, vz } = s;
  const steps = Math.max(1, Math.ceil(dt / 0.05));
  const sub = dt / steps;
  const a = s.yaw * sub;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  for (let i = 0; i < steps; i++) {
    x += vx * sub;
    z += vz * sub;
    const nvx = vx * c + vz * sn;
    vz = vz * c - vx * sn;
    vx = nvx;
    h += a;
  }
  T.x = x;
  T.z = z;
  T.h = h;
  T.vx = vx;
  T.vz = vz;
  return T;
}

export class RemoteKarts {
  private karts = new Map<string, Kart>();
  private templates = new Map<string, KartVisual>();
  private ghostTemplates = new Map<string, KartVisual>();
  private tags: HTMLElement;
  private tmp = new THREE.Vector3();
  /** The race is on (lights out): before that nobody moves, so nobody is a ghost. */
  racing = false;
  /** You are a ghost to everyone: you finished, you reset in the last 2 s, or you're crawling (setLocal). */
  localGhost = false;
  private placed = -1;
  private lastX = 0;
  private lastZ = 0;
  private resetT = Infinity; // s since your last reset that moved the kart (a jump others can see)
  private crawlT = 0; // s you've been below CRAWL_SPEED while racing

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    hud: HTMLElement,
    private trackLength: number,
  ) {
    this.tags = document.createElement('div');
    this.tags.className = 'mp-tags';
    hud.appendChild(this.tags);
  }

  /** One template per colour; every kart of that colour is a clone sharing geometry and materials. */
  private visual(color: string): KartVisual {
    let tpl = this.templates.get(color);
    if (!tpl) this.templates.set(color, (tpl = buildKart(color)));
    return cloneKart(tpl);
  }

  /** The translucent twin: the ghost kart material (same shader as time-trial ghosts), a bit more opaque. */
  private ghostVisual(color: string): KartVisual {
    let tpl = this.ghostTemplates.get(color);
    if (!tpl) {
      tpl = buildKart(color, { ghost: true });
      for (const m of tpl.materials) m.opacity = GHOST_OPACITY;
      this.ghostTemplates.set(color, tpl);
    }
    return cloneKart(tpl);
  }

  /** Make sure a kart exists for this player, parked at `park` until its first pose. */
  add(mid: string, name: string, color: string, park?: { x: number; z: number; heading: number }) {
    if (this.karts.has(mid)) return;
    const k = new Kart(mid, name, color, this.visual(color), this.ghostVisual(color), this.tags);
    this.scene.add(k.visual.root);
    this.scene.add(k.ghostVisual.root); // in the scene from the start, so the warm-up compiles it
    if (park) {
      k.x = park.x;
      k.z = park.z;
      k.h = park.heading;
      k.parked = k.shown = true;
      k.visual.root.position.set(k.x, 0, k.z);
      k.visual.root.rotation.y = k.h;
      k.visual.root.visible = true;
    }
    this.karts.set(mid, k);
  }

  push(mid: string, p: PoseTuple) {
    const k = this.karts.get(mid);
    if (!k || k.gone) return;
    const t = p[0];
    if (k.snap && t <= k.snap.t) return; // late / duplicate (unordered channel)
    if (k.snap) {
      // Far from where its last pose said it would be by now: it reset or jumped (or we missed a lot).
      const tg = target(k.snap, t);
      if (Math.hypot(tg.x - p[1], tg.z - p[2]) > JUMP_DIST) k.jumpAt = performance.now();
    }
    const s = (k.snap ??= { t: 0, x: 0, z: 0, h: 0, vx: 0, vz: 0, yaw: 0, steer: 0, prog: 0 });
    s.t = t;
    s.x = p[1];
    s.z = p[2];
    s.h = p[3];
    s.vx = p[4];
    s.vz = p[5];
    s.yaw = p[6];
    s.steer = p[7];
    s.prog = p[8];
    k.recvAt = performance.now();
  }

  /** Player left the room: take their kart off the track (or back on, if they return). */
  setGone(mid: string, gone: boolean) {
    const k = this.karts.get(mid);
    if (k) k.gone = gone;
  }

  /** They took the flag: they're on their cool-down lap, a ghost from now on. */
  setFinished(mid: string) {
    const k = this.karts.get(mid);
    if (k) k.finished = true;
  }

  /** Players whose poses come through the server relay (~3 Hz, ≈1 m off): ghosts. */
  setRelayed(mids: Iterable<string>) {
    const set = new Set(mids);
    for (const k of this.karts.values()) k.relayed = set.has(k.mid);
  }

  /** Your side of the ghost rules, after each physics step (before collide). */
  setLocal(phys: KartPhysics, dt: number, racing: boolean, finished: boolean) {
    this.racing = racing;
    // A reset the others can see as a jump (the same JUMP_DIST test they use on your poses), so
    // both sides agree you're a ghost. A shorter one leaves you crawling, which they see too.
    if (phys.placed !== this.placed) {
      if (this.placed < 0 || Math.hypot(phys.x - this.lastX, phys.z - this.lastZ) > JUMP_DIST) this.resetT = 0;
      this.placed = phys.placed;
    } else this.resetT += dt;
    this.lastX = phys.x;
    this.lastZ = phys.z;
    this.crawlT = racing && phys.speed < CRAWL_SPEED ? this.crawlT + dt : 0;
    this.localGhost = finished || this.resetT * 1000 < JUMP_HOLD || this.crawlT > CRAWL_T;
  }

  /** Is contact with this kart off right now (from its state and yours)? */
  private ghostly(k: Kart) {
    return k.ghost || k.clearing || this.localGhost;
  }

  setLabel(mid: string, label: string) {
    const k = this.karts.get(mid);
    if (k && k.label.textContent !== label) k.label.textContent = label;
  }

  /** Displayed karts (minimap, contact). Iterate immediately; don't keep the iterator. */
  list(): Iterable<RemoteKart> {
    return this.karts.values();
  }

  /** Progress (laps + fraction) for standings, extrapolated to `now`; -1 before the first pose. */
  progress(mid: string, now: number) {
    const s = this.karts.get(mid)?.snap;
    if (!s) return -1;
    const ahead = Math.min(MAX_EXTRAPOLATE, Math.max(0, (now - s.t) / 1000));
    return s.prog + (Math.hypot(s.vx, s.vz) * ahead) / this.trackLength;
  }

  /** Advance every kart to server time `now` (the instant this frame shows) and place visuals + tags. */
  update(dt: number, now: number, viewW: number, viewH: number) {
    const blend = 1 - Math.exp(-dt * 9);
    const perf = performance.now();
    for (const k of this.karts.values()) {
      const s = k.snap;
      const live = !k.gone && (s ? perf - k.recvAt < STALE_HIDE * 1000 : k.parked);
      if (!live) {
        if (k.visual.root.visible) k.visual.root.visible = false;
        if (k.ghostVisual.root.visible) k.ghostVisual.root.visible = false;
        if (k.tag.style.display !== 'none') k.tag.style.display = 'none';
        k.shown = false;
        continue;
      }
      const tg = s ? target(s, now) : null;
      const jump = tg ? Math.hypot(tg.x - k.x, tg.z - k.z) : 0;
      // Turning up after a gap, or somewhere other than its grid slot on its first pose: a jump.
      if (tg && ((!k.shown && !k.parked) || (k.parked && jump > JUMP_DIST))) k.jumpAt = perf;
      // Ghost rules (its side; yours is localGhost). Before the lights go out nobody moves.
      k.age = s ? now - s.t : Infinity;
      if (k.age > MAX_AGE || k.relayed) k.lateUntil = perf + LATE_HOLD;
      const speed = s ? Math.hypot(s.vx, s.vz) : 0;
      k.crawlT = this.racing && speed < CRAWL_SPEED ? k.crawlT + dt : 0;
      k.ghost = this.racing && (perf < k.lateUntil || k.finished || perf - k.jumpAt < JUMP_HOLD || k.crawlT > CRAWL_T);
      const ghost = this.racing && this.ghostly(k);
      if (ghost !== k.drawnGhost) {
        k.drawnGhost = ghost;
        (ghost ? k.visual : k.ghostVisual).root.visible = false;
      }
      const v = ghost ? k.ghostVisual : k.visual;
      if (s && tg) {
        if (!k.shown || k.parked || jump > SNAP_DIST) {
          k.x = tg.x;
          k.z = tg.z;
          k.h = tg.h;
          k.parked = false;
          k.shown = true;
        } else {
          // Move with the kart's own velocity, then pull towards the dead-reckoned target:
          // no steady-state lag, and corrections fade in smoothly.
          k.x += tg.vx * dt;
          k.z += tg.vz * dt;
          k.h += s.yaw * dt;
          k.x += (tg.x - k.x) * blend;
          k.z += (tg.z - k.z) * blend;
          let dh = tg.h - k.h;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          k.h += dh * blend;
        }
        k.vx = tg.vx;
        k.vz = tg.vz;
        const fwd = tg.vx * Math.sin(k.h) + tg.vz * Math.cos(k.h);
        k.wheelSpin += (fwd / 0.135) * dt;
        for (const w of v.wheels) w.rotation.x = k.wheelSpin;
        for (const f of v.frontPivots) f.rotation.y = -s.steer * 1.2;
        poseDriver(v, s.steer, s.yaw * fwd, dt);
        v.body.rotation.z += (THREE.MathUtils.clamp(s.yaw * fwd * 0.004, -0.07, 0.07) - v.body.rotation.z) * blend;
      }
      if (!v.root.visible) v.root.visible = true;
      v.root.position.set(k.x, 0, k.z);
      v.root.rotation.y = k.h;

      // Name tag
      this.tmp.set(k.x, 1.7, k.z).project(this.camera);
      const dist = this.camera.position.distanceTo(v.root.position);
      if (this.tmp.z < 1 && dist < 220 && dist > 1.5) {
        if (k.tag.style.display === 'none') k.tag.style.display = '';
        k.tag.style.transform = `translate(${((this.tmp.x + 1) / 2) * viewW}px, ${((1 - this.tmp.y) / 2) * viewH}px) translate(-50%, -100%)`;
        const op = (THREE.MathUtils.clamp(1.4 - dist / 160, 0.35, 1) * (ghost ? 0.6 : 1)).toFixed(2);
        if (op !== k.tagOpacity) k.tag.style.opacity = k.tagOpacity = op;
        const far = dist > 60;
        if (far !== k.tagFar) k.tag.classList.toggle('far', (k.tagFar = far));
      } else if (k.tag.style.display !== 'none') k.tag.style.display = 'none';
    }
  }

  /**
   * Kart-to-kart contact, resolved for the local kart only (every player resolves their own kart
   * against what they see), right after each physics step. `now` is the server time of that
   * physics state: the other karts are dead-reckoned to exactly that instant (not the smoothed
   * positions drawn last frame), so both players see the contact at the same moment.
   *
   * Each side moves out half the overlap every step and takes 0.6 of the closing speed once per
   * contact, so with both sides doing it the pair separates at 0.2 of the approach speed
   * (restitution 0.2): a 5 m/s rear-end costs the hitter ~3 m/s and gives the leader ~3 m/s.
   * Sliding past each other rubs a little speed off (bounded by the normal impulse), and a hit off
   * the kart's axis (a side swipe at a corner) gives a small yaw kick. Sets `phys.kartHit`.
   */
  collide(phys: KartPhysics, now: number) {
    phys.kartHit = null;
    let hit = 0;
    for (const r of this.karts.values()) {
      if (!r.shown || r.gone || !r.snap) {
        r.touching = r.clearing = false;
        r.impulses = 0;
        continue;
      }
      const age = now - r.snap.t;
      const o = target(r.snap, now);
      const dx = phys.x - o.x;
      const dz = phys.z - o.z;
      if (dx * dx + dz * dz > 2.6 * 2.6) {
        r.touching = r.clearing = false;
        r.impulses = 0;
        continue;
      }
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) continue;
      const nx = dx / d; // from them to you
      const nz = dz / d;
      const mine = ellipseRadius(-nx, -nz, phys.heading);
      const overlap = mine + ellipseRadius(nx, nz, o.h) - d;
      if (r.ghost || r.clearing || this.localGhost) {
        // No contact. If you overlap now, it stays that way until you're apart: no violent
        // separation when the ghost rule ends while you're inside each other.
        r.clearing = overlap > -CLEAR;
        r.touching = false;
        r.impulses = 0;
        continue;
      }
      if (overlap <= 0) {
        r.touching = false;
        r.impulses = 0;
        continue;
      }
      const push = overlap * PUSH;
      phys.x += nx * push;
      phys.z += nz * push;
      const rvx = phys.vx - o.vx;
      const rvz = phys.vz - o.vz;
      const closing = rvx * nx + rvz * nz; // < 0: moving into each other
      if (closing < 0 && now - r.impulseAt >= Math.max(IMPULSE_GAP, age + 100)) {
        if (r.impulses >= MAX_IMPULSES) {
          r.clearing = true; // ghost until you're apart
          r.touching = false;
          r.impulses = 0;
          continue;
        }
        r.impulses++;
        r.impulseAt = now;
        const j = -closing * IMPULSE;
        // Rubbing: friction against the sliding speed, at most RUB_MU times the normal impulse.
        const tvx = rvx - closing * nx;
        const tvz = rvz - closing * nz;
        const vt = Math.hypot(tvx, tvz);
        const jt = vt > 1e-3 ? Math.min(RUB * vt, RUB_MU * j) / vt : 0;
        phys.vx += nx * j - tvx * jt;
        phys.vz += nz * j - tvz * jt;
        // Yaw kick: the impulse acts at the contact point on your outline, along your outline's
        // own normal there; off the kart's axis (a corner) that has a lever arm.
        const fx = Math.sin(phys.heading);
        const fz = Math.cos(phys.heading);
        const cx = -nx * mine; // contact point, from your centre
        const cz = -nz * mine;
        const cs = -cx * fz + cz * fx; // in your frame: right...
        const ca = cx * fx + cz * fz; // ...and forward
        let ms = cs / (HALF_W * HALF_W); // outline normal there (outward), in your frame
        let ma = ca / (HALF_L * HALF_L);
        const ml = Math.hypot(ms, ma) || 1;
        ms /= ml;
        ma /= ml;
        const mx = -ms * fz + ma * fx; // back to world
        const mz = ms * fx + ma * fz;
        const jx = -mx * j - tvx * jt; // the same impulse, its normal part along the outline normal
        const jz = -mz * j - tvz * jt;
        const torque = cz * jx - cx * jz; // + turns left (heading up)
        phys.yawRate += THREE.MathUtils.clamp(torque * YAW_KICK, -YAW_MAX, YAW_MAX);
        if (!r.touching && -closing > HIT_MIN && -closing > (phys.kartHit?.closing ?? 0)) {
          phys.kartHit = { closing: -closing, x: phys.x + cx, z: phys.z + cz, nx, nz };
        }
        hit = Math.max(hit, -closing);
      }
      r.touching = true;
    }
    if (hit > HIT_MIN) phys.bump = Math.min(1, phys.bump + hit / 12);
  }

  /**
   * How much of a slipstream you're in, 0..1, behind the karts you can race against (never a
   * ghost, never a pose older than 250 ms: those are where they were, not where they are). `now`
   * is the server time of your physics state, as for collide().
   */
  tow(phys: KartPhysics, now: number): number {
    if (!this.racing || this.localGhost) return 0;
    const v = phys.speed;
    if (v <= TOW_SPEED) return 0;
    let best = 0;
    for (const r of this.karts.values()) {
      if (!r.shown || r.gone || !r.snap || r.ghost || r.clearing || now - r.snap.t > MAX_AGE) continue;
      const o = target(r.snap, now);
      const pace = THREE.MathUtils.clamp((Math.min(v, Math.hypot(o.vx, o.vz)) - TOW_SPEED) / 2, 0, 1);
      if (pace <= 0) continue;
      const fx = Math.sin(o.h);
      const fz = Math.cos(o.h);
      const dx = phys.x - o.x;
      const dz = phys.z - o.z;
      const behind = -(dx * fx + dz * fz);
      const side = Math.abs(-dx * fz + dz * fx);
      if (behind <= TOW_MIN || behind >= TOW_LEN || side >= TOW_HALF_W) continue;
      best = Math.max(best, (1 - behind / TOW_LEN) * (1 - side / TOW_HALF_W) * pace);
    }
    return best;
  }

  /** Debug / tests: what contact sees of each kart. */
  contactState() {
    return [...this.karts.values()].map((k) => ({ mid: k.mid, x: k.x, z: k.z, h: k.h, vx: k.vx, vz: k.vz, shown: k.shown, age: Math.round(k.age), ghost: k.ghost, clearing: k.clearing, drawnGhost: k.drawnGhost, finished: k.finished, relayed: k.relayed, crawlT: k.crawlT }));
  }

  dispose() {
    for (const k of this.karts.values()) {
      this.scene.remove(k.visual.root);
      this.scene.remove(k.ghostVisual.root);
      k.tag.remove();
    }
    this.karts.clear();
    for (const tpl of [...this.templates.values(), ...this.ghostTemplates.values()]) disposeTree(tpl.root);
    this.templates.clear();
    this.ghostTemplates.clear();
    this.tags.remove();
  }
}

/** Clone a kart (shared geometry + materials) and find its animated parts in the copy. */
function cloneKart(t: KartVisual): KartVisual {
  const root = t.root.clone();
  const map = new Map<THREE.Object3D, THREE.Object3D>();
  const walk = (a: THREE.Object3D, b: THREE.Object3D) => {
    map.set(a, b);
    a.children.forEach((c, i) => walk(c, b.children[i]));
  };
  walk(t.root, root);
  return {
    root,
    body: map.get(t.body) as THREE.Group,
    frontPivots: t.frontPivots.map((p) => map.get(p) as THREE.Group),
    wheels: t.wheels.map((w) => map.get(w) as THREE.Mesh),
    materials: [],
    steering: t.steering && map.get(t.steering),
    helmet: t.helmet && map.get(t.helmet),
  };
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) {
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    }
  });
}

/** Distance from a kart's centre to its edge in world direction (dx, dz), for heading h. */
function ellipseRadius(dx: number, dz: number, h: number) {
  // Kart forward is (sin h, cos h); right is (-cos h, sin h).
  const along = dx * Math.sin(h) + dz * Math.cos(h);
  const side = -dx * Math.cos(h) + dz * Math.sin(h);
  return 1 / Math.sqrt((side / HALF_W) ** 2 + (along / HALF_L) ** 2);
}
