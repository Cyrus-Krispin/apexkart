// Other players' karts: solid karts with name tags, driven by ~20 Hz network poses.
//
// Each pose carries the sender's server-synced timestamp, so we know how old it is. We
// dead-reckon every kart forward to "now" (velocity + yaw rate, i.e. along an arc) instead
// of interpolating in the past: in a race, who's ahead must match what you see. Corrections
// when a new pose arrives are blended in over ~120 ms rather than snapped.
import * as THREE from 'three';
import { buildKart, type KartPhysics, type KartVisual } from './kart';
import type { PoseTuple } from '../shared/room';

const MAX_EXTRAPOLATE = 0.35; // s; beyond this we just hold the last known motion
const STALE_HIDE = 3; // s without a pose before a kart disappears
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

export interface RemotePose {
  mid: string;
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  color: string;
  prog: number; // laps + fraction, extrapolated
  visible: boolean;
}

class RemoteKart {
  visual: KartVisual;
  tag: HTMLDivElement;
  snap: Snap | null = null;
  recvAt = 0; // local performance.now() of the latest pose
  // Displayed state
  x = 0;
  z = 0;
  h = 0;
  shown = false;
  wheelSpin = 0;

  constructor(
    readonly mid: string,
    public name: string,
    public color: string,
    number: number,
    scene: THREE.Scene,
    tags: HTMLElement,
  ) {
    this.visual = buildKart(color, { number });
    this.visual.root.visible = false;
    scene.add(this.visual.root);
    this.tag = document.createElement('div');
    this.tag.className = 'mp-tag';
    this.tag.style.setProperty('--c', color);
    this.tag.innerHTML = `<b></b><span></span>`;
    (this.tag.lastChild as HTMLElement).textContent = name;
    this.tag.style.display = 'none';
    tags.appendChild(this.tag);
  }

  setLabel(pos: string) {
    const b = this.tag.firstChild as HTMLElement;
    if (b.textContent !== pos) b.textContent = pos;
  }

  /** Dead-reckoned pose at server time `now`. */
  target(now: number) {
    const s = this.snap!;
    const dt = Math.min(MAX_EXTRAPOLATE, Math.max(0, (now - s.t) / 1000));
    let { x, z, h, vx, vz } = s;
    // Integrate along the arc in a few steps so a kart mid-corner keeps turning.
    const steps = Math.max(1, Math.ceil(dt / 0.05));
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      x += vx * sub;
      z += vz * sub;
      const a = s.yaw * sub;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      [vx, vz] = [vx * c + vz * sn, vz * c - vx * sn];
      h += a;
    }
    return { x, z, h, vx, vz };
  }
}

export class RemoteKarts {
  private karts = new Map<string, RemoteKart>();
  private tags: HTMLElement;
  private tmp = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private hud: HTMLElement,
    private trackLength: number,
  ) {
    this.tags = document.createElement('div');
    this.tags.className = 'mp-tags';
    hud.appendChild(this.tags);
  }

  /** Make sure a kart exists for this player (grid order gives the nose number). */
  ensure(mid: string, name: string, color: string, number: number) {
    let k = this.karts.get(mid);
    if (k && k.color !== color) {
      this.remove(mid);
      k = undefined;
    }
    if (!k) {
      k = new RemoteKart(mid, name, color, number, this.scene, this.tags);
      this.karts.set(mid, k);
    }
    if (k.name !== name) {
      k.name = name;
      (k.tag.lastChild as HTMLElement).textContent = name;
    }
    return k;
  }

  push(mid: string, p: PoseTuple) {
    const k = this.karts.get(mid);
    if (!k) return;
    const [t, x, z, h, vx, vz, yaw, steer, prog] = p;
    if (k.snap && t <= k.snap.t) return; // late / duplicate (unordered channel)
    k.snap = { t, x, z, h, vx, vz, yaw, steer, prog };
    k.recvAt = performance.now();
  }

  remove(mid: string) {
    const k = this.karts.get(mid);
    if (!k) return;
    this.scene.remove(k.visual.root);
    k.visual.root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) {
        (mat as THREE.MeshBasicMaterial).map?.dispose();
        mat.dispose();
      }
    });
    k.tag.remove();
    this.karts.delete(mid);
  }

  setLabel(mid: string, label: string) {
    this.karts.get(mid)?.setLabel(label);
  }

  has(mid: string) {
    return this.karts.has(mid);
  }

  /** Advance every kart to server time `now` and place visuals + tags. */
  update(dt: number, now: number) {
    const blend = 1 - Math.exp(-dt * 9);
    const vw = this.hud.clientWidth || innerWidth;
    const vh = this.hud.clientHeight || innerHeight;
    for (const k of this.karts.values()) {
      const s = k.snap;
      const fresh = s && performance.now() - k.recvAt < STALE_HIDE * 1000;
      if (!s || !fresh) {
        k.visual.root.visible = false;
        k.tag.style.display = 'none';
        k.shown = false;
        continue;
      }
      const tg = k.target(now);
      if (!k.shown || Math.hypot(tg.x - k.x, tg.z - k.z) > SNAP_DIST) {
        k.x = tg.x;
        k.z = tg.z;
        k.h = tg.h;
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
      const v = k.visual;
      v.root.visible = true;
      v.root.position.set(k.x, 0, k.z);
      v.root.rotation.y = k.h;
      const fwd = tg.vx * Math.sin(k.h) + tg.vz * Math.cos(k.h);
      k.wheelSpin += (fwd / 0.135) * dt;
      v.wheels.forEach((w) => (w.rotation.x = k.wheelSpin));
      v.frontPivots.forEach((f) => (f.rotation.y = -s.steer * 1.2));
      v.body.rotation.z += (THREE.MathUtils.clamp(s.yaw * fwd * 0.004, -0.07, 0.07) - v.body.rotation.z) * blend;

      // Name tag
      this.tmp.set(k.x, 1.7, k.z).project(this.camera);
      const dist = this.camera.position.distanceTo(v.root.position);
      if (this.tmp.z < 1 && dist < 220 && dist > 1.5) {
        k.tag.style.display = '';
        k.tag.style.transform = `translate(${((this.tmp.x + 1) / 2) * vw}px, ${((1 - this.tmp.y) / 2) * vh}px) translate(-50%, -100%)`;
        k.tag.style.opacity = String(THREE.MathUtils.clamp(1.4 - dist / 160, 0.35, 1));
        k.tag.classList.toggle('far', dist > 60);
      } else k.tag.style.display = 'none';
    }
  }

  /** Current displayed poses (for the minimap, standings and contact). */
  poses(now: number): RemotePose[] {
    return [...this.karts.values()].map((k) => {
      const s = k.snap;
      const ahead = s ? Math.min(MAX_EXTRAPOLATE, Math.max(0, (now - s.t) / 1000)) : 0;
      const speed = s ? Math.hypot(s.vx, s.vz) : 0;
      return {
        mid: k.mid,
        x: k.x,
        z: k.z,
        h: k.h,
        vx: s?.vx ?? 0,
        vz: s?.vz ?? 0,
        color: k.color,
        prog: s ? s.prog + (speed * ahead) / this.trackLength : -Infinity,
        visible: k.shown && k.visual.root.visible,
      };
    });
  }

  /**
   * Kart-to-kart contact, resolved for the local kart only (every player resolves their
   * own kart against what they see, so contact is roughly symmetric without a server).
   */
  collide(phys: KartPhysics, now: number) {
    let hit = 0;
    for (const r of this.poses(now)) {
      if (!r.visible) continue;
      const dx = phys.x - r.x;
      const dz = phys.z - r.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.4 || d < 1e-4) continue;
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
    for (const mid of [...this.karts.keys()]) this.remove(mid);
    this.tags.remove();
  }
}

/** Distance from a kart's centre to its edge in world direction (dx, dz), for heading h. */
function ellipseRadius(dx: number, dz: number, h: number) {
  // Kart forward is (sin h, cos h); right is (-cos h, sin h).
  const along = dx * Math.sin(h) + dz * Math.cos(h);
  const side = -dx * Math.cos(h) + dz * Math.sin(h);
  return 1 / Math.sqrt((side / HALF_W) ** 2 + (along / HALF_L) ** 2);
}
