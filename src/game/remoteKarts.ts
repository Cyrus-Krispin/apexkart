// Other players' karts: solid karts with name tags, driven by ~20 Hz network poses.
//
// Each pose carries the sender's server-synced timestamp, so we know how old it is. We
// dead-reckon every kart forward to the instant the frame shows (velocity + yaw rate, i.e.
// along an arc) instead of interpolating in the past: in a race, who's ahead must match
// what you see. Corrections when a new pose arrives are blended in over ~120 ms.
//
// Karts are cloned from one template per colour (shared geometry and materials), and they
// wait visibly on their grid slots from the start, so the race's shader warm-up
// (compileAsync after the world loads) already covers them: no hitch when poses arrive.
import * as THREE from 'three';
import { buildKart, type KartPhysics, type KartVisual } from './kart';
import type { PoseTuple } from '../shared/room';

const MAX_EXTRAPOLATE = 0.35; // s; beyond this we just hold the last known motion
const STALE_HIDE = 3; // s without a pose before a kart that was moving disappears
const SNAP_DIST = 8; // m; bigger corrections teleport instead of sliding
// Kart footprint for contact, as an ellipse: half-width, half-length (metres).
const HALF_W = 0.66;
const HALF_L = 0.98;

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

  constructor(
    readonly mid: string,
    name: string,
    readonly color: string,
    readonly visual: KartVisual,
    tags: HTMLElement,
  ) {
    visual.root.visible = false;
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
  private tags: HTMLElement;
  private tmp = new THREE.Vector3();

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

  /** Make sure a kart exists for this player, parked at `park` until its first pose. */
  add(mid: string, name: string, color: string, park?: { x: number; z: number; heading: number }) {
    if (this.karts.has(mid)) return;
    const k = new Kart(mid, name, color, this.visual(color), this.tags);
    this.scene.add(k.visual.root);
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
      const v = k.visual;
      const live = !k.gone && (s ? perf - k.recvAt < STALE_HIDE * 1000 : k.parked);
      if (!live) {
        if (v.root.visible) v.root.visible = false;
        if (k.tag.style.display !== 'none') k.tag.style.display = 'none';
        k.shown = false;
        continue;
      }
      if (s) {
        const tg = target(s, now);
        if (!k.shown || k.parked || Math.hypot(tg.x - k.x, tg.z - k.z) > SNAP_DIST) {
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
        const op = THREE.MathUtils.clamp(1.4 - dist / 160, 0.35, 1).toFixed(2);
        if (op !== k.tagOpacity) k.tag.style.opacity = k.tagOpacity = op;
        const far = dist > 60;
        if (far !== k.tagFar) k.tag.classList.toggle('far', (k.tagFar = far));
      } else if (k.tag.style.display !== 'none') k.tag.style.display = 'none';
    }
  }

  /**
   * Kart-to-kart contact, resolved for the local kart only (every player resolves their
   * own kart against what they see, so contact is roughly symmetric without a server).
   */
  collide(phys: KartPhysics) {
    let hit = 0;
    for (const r of this.karts.values()) {
      if (!r.shown || r.gone) continue;
      const dx = phys.x - r.x;
      const dz = phys.z - r.z;
      if (dx * dx + dz * dz > 2.4 * 2.4) continue;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) continue;
      const nx = dx / d;
      const nz = dz / d;
      const reach = ellipseRadius(nx, nz, r.h) + ellipseRadius(-nx, -nz, phys.heading);
      if (d >= reach) continue;
      const push = (reach - d) * 0.8;
      phys.x += nx * push;
      phys.z += nz * push;
      // Remove the closing speed along the contact normal, with a little bounce.
      const closing = (phys.vx - r.vx) * nx + (phys.vz - r.vz) * nz;
      if (closing < 0) {
        phys.vx -= nx * closing * 1.25;
        phys.vz -= nz * closing * 1.25;
        hit = Math.max(hit, -closing);
      }
    }
    if (hit) phys.bump = Math.min(1, phys.bump + hit / 12);
  }

  dispose() {
    for (const k of this.karts.values()) {
      this.scene.remove(k.visual.root);
      k.tag.remove();
    }
    this.karts.clear();
    for (const tpl of this.templates.values()) disposeTree(tpl.root);
    this.templates.clear();
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
