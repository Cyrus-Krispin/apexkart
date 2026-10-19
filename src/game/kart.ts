import * as THREE from 'three';
import type { TrackModel } from './track';

export interface KartVisual {
  root: THREE.Group;
  body: THREE.Group; // rolls/pitches
  frontPivots: THREE.Group[];
  wheels: THREE.Mesh[];
  materials: THREE.Material[];
}

/** Low-poly racing kart facing +z, origin on the ground at the kart's centre. */
export function buildKart(color: string, opts: { ghost?: boolean; number?: number } = {}): KartVisual {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const materials: THREE.Material[] = [];
  const mat = (c: THREE.ColorRepresentation, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.1, ...extra });
    if (opts.ghost) {
      m.transparent = true;
      m.opacity = 0.38;
      m.depthWrite = false;
    }
    materials.push(m);
    return m;
  };
  const paint = mat(color, { roughness: 0.35, metalness: 0.2 });
  const dark = mat(0x1d1f24, { roughness: 0.8 });
  const steel = mat(0x9aa0a6, { metalness: 0.8, roughness: 0.3 });
  const tyre = mat(0x141414, { roughness: 0.95 });
  const suit = mat(color, { roughness: 0.7 });
  const white = mat(0xf2f2f2, { roughness: 0.5 });
  const visor = mat(0x0a0a12, { roughness: 0.1, metalness: 0.6 });

  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = !opts.ghost;
    parent.add(mesh);
    return mesh;
  };

  // Chassis tray + rails
  add(new THREE.BoxGeometry(0.72, 0.05, 1.5), dark, 0, 0.12, 0);
  for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.025, 0.025, 1.55, 6).rotateX(Math.PI / 2), steel, s * 0.38, 0.13, 0);
  // Nose cone
  const nose = add(new THREE.BoxGeometry(0.95, 0.18, 0.42), paint, 0, 0.2, 0.92);
  nose.rotation.x = -0.18;
  // Front fairing in front of the driver's feet
  add(new THREE.BoxGeometry(0.42, 0.22, 0.3), paint, 0, 0.3, 0.55).rotation.x = -0.5;
  // Side pods
  for (const s of [-1, 1]) {
    const pod = add(new THREE.BoxGeometry(0.22, 0.17, 0.82), paint, s * 0.58, 0.2, -0.05);
    pod.rotation.z = s * -0.12;
  }
  // Rear bumper
  add(new THREE.BoxGeometry(1.25, 0.09, 0.12), dark, 0, 0.22, -0.98);
  // Engine + exhaust (right side, rear)
  add(new THREE.BoxGeometry(0.26, 0.28, 0.32), steel, 0.32, 0.32, -0.5);
  add(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8).rotateX(Math.PI / 2), dark, 0.45, 0.3, -0.75);
  // Seat
  add(new THREE.BoxGeometry(0.4, 0.4, 0.12), dark, 0, 0.38, -0.32).rotation.x = -0.35;
  // Steering column + wheel
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.45, 6).rotateX(Math.PI / 2 - 0.9), steel, 0, 0.35, 0.3);
  const sw = add(new THREE.TorusGeometry(0.13, 0.022, 6, 16), dark, 0, 0.5, 0.15);
  sw.rotation.x = -0.6;
  // Driver
  add(new THREE.CylinderGeometry(0.17, 0.2, 0.5, 10), suit, 0, 0.62, -0.22).rotation.x = -0.35;
  for (const s of [-1, 1]) {
    const arm = add(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 6), suit, s * 0.17, 0.62, -0.02);
    arm.rotation.x = Math.PI / 2 - 0.5;
    arm.rotation.z = s * 0.25;
  }
  add(new THREE.SphereGeometry(0.16, 16, 12), white, 0, 1.0, -0.15);
  const vis = add(new THREE.SphereGeometry(0.162, 16, 8, -Math.PI / 2.6, Math.PI / 1.3, Math.PI / 2.8, Math.PI / 4), visor, 0, 1.0, -0.15);
  vis.rotation.y = 0;
  const stripe = add(new THREE.TorusGeometry(0.158, 0.018, 6, 20), paint, 0, 1.0, -0.15);
  stripe.rotation.y = Math.PI / 2;

  // Number plate on the nose
  if (opts.number !== undefined && !opts.ghost) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffd60a';
    g.beginPath();
    g.arc(32, 32, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#111';
    g.font = 'bold 34px system-ui';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(opts.number), 32, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const plate = add(new THREE.CircleGeometry(0.11, 20), new THREE.MeshBasicMaterial({ map: t }), 0, 0.3, 1.0);
    plate.rotation.x = -Math.PI / 2 + 0.25;
  }

  // Wheels
  const wheels: THREE.Mesh[] = [];
  const frontPivots: THREE.Group[] = [];
  const rim = new THREE.CylinderGeometry(0.075, 0.075, 0.01, 10).rotateZ(Math.PI / 2);
  const mk = (x: number, z: number, r: number, w: number, front: boolean) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    root.add(pivot);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 16).rotateZ(Math.PI / 2), tyre);
    wheel.castShadow = !opts.ghost;
    const hub = new THREE.Mesh(rim, steel);
    hub.position.x = Math.sign(x) * (w / 2 + 0.002);
    wheel.add(hub);
    pivot.add(wheel);
    wheels.push(wheel);
    if (front) frontPivots.push(pivot);
  };
  mk(-0.55, 0.62, 0.13, 0.13, true);
  mk(0.55, 0.62, 0.13, 0.13, true);
  mk(-0.6, -0.62, 0.14, 0.21, false);
  mk(0.6, -0.62, 0.14, 0.21, false);

  return { root, body, frontPivots, wheels, materials };
}

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  drift: boolean;
}

export type Surface = 'track' | 'kerb' | 'grass';

/** Arcade kart dynamics on a flat plane, constrained by the track's barriers. */
export class KartPhysics {
  x = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  steerAngle = 0;
  slip = 0; // lateral speed, m/s (for skid marks / audio)
  surface: Surface = 'track';
  hint = -1;
  offset = 0;
  s = 0;
  wheelSpin = 0;
  bump = 0; // impact intensity for camera shake / sound

  readonly vmax = 27; // ~97 km/h
  readonly wheelbase = 1.05;

  constructor(private track: TrackModel) {}

  place(s: number) {
    const p = this.track.at(s);
    this.x = p.x;
    this.z = p.z;
    this.heading = p.heading;
    this.vx = this.vz = this.yawRate = this.steerAngle = 0;
    this.hint = p.i;
  }

  get speed() {
    return Math.hypot(this.vx, this.vz);
  }

  get forwardSpeed() {
    return this.vx * Math.sin(this.heading) + this.vz * Math.cos(this.heading);
  }

  step(dt: number, c: Controls) {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const rx = -fz; // right vector
    const rz = fx;
    let vf = this.vx * fx + this.vz * fz;
    let vl = this.vx * rx + this.vz * rz;

    const grass = this.surface === 'grass';
    const kerb = this.surface === 'kerb';
    const vmax = grass ? 11 : this.vmax;

    // Longitudinal
    const engine = c.throttle * (vf < vmax ? 11 * (1 - Math.max(0, vf) / vmax) + 2.2 : 0);
    let accel = engine;
    if (c.brake > 0) accel -= vf > 0.5 ? 22 * c.brake : vf > -6 ? 6 * c.brake : 0; // brake, then reverse slowly
    accel -= 0.0028 * vf * Math.abs(vf) + (grass ? 2.5 * Math.sign(vf) + 0.12 * vf : 0.35 * Math.sign(vf));
    if (c.throttle === 0 && c.brake === 0 && Math.abs(vf) < 0.4) vf = 0;
    else vf += accel * dt;

    // Steering: less lock at speed, smoothed.
    const lock = 0.48 / (1 + Math.abs(vf) / 7.5);
    const target = c.steer * lock;
    this.steerAngle += (target - this.steerAngle) * Math.min(1, dt * 14);

    // Yaw: bicycle model, clamped by available lateral grip.
    const gripG = grass ? 0.75 : c.drift ? 1.3 : kerb ? 2.0 : 2.35;
    const maxLat = gripG * 9.81;
    // Positive heading change turns left, so steering right means negative yaw.
    let desiredYaw = -(vf * Math.tan(this.steerAngle)) / this.wheelbase;
    const yawLimit = maxLat / Math.max(Math.abs(vf), 2) + (c.drift ? 0.9 : 0);
    desiredYaw = THREE.MathUtils.clamp(desiredYaw, -yawLimit, yawLimit);
    this.yawRate += (desiredYaw - this.yawRate) * Math.min(1, dt * (c.drift ? 6 : 12));
    this.heading += this.yawRate * dt;

    // Lateral velocity bleeds off according to grip; drifting keeps more slide.
    const lateralGrip = grass ? 2.2 : c.drift ? 1.6 : kerb ? 7 : 11;
    vl *= Math.exp(-lateralGrip * dt);
    if (c.drift && Math.abs(vf) > 8) vf -= 1.2 * dt * Math.sign(vf); // drifting scrubs a little speed
    this.slip = Math.abs(vl) + (c.drift ? Math.abs(this.yawRate) * 1.5 : 0);

    // Re-project onto the new heading.
    const nfx = Math.sin(this.heading);
    const nfz = Math.cos(this.heading);
    this.vx = nfx * vf + -nfz * vl;
    this.vz = nfz * vf + nfx * vl;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.wheelSpin += (vf / 0.135) * dt;

    // Track surface + barriers.
    const near = this.track.nearest(this.x, this.z, this.hint);
    this.hint = near.i;
    this.s = near.s;
    this.offset = near.offset;
    const hw = this.track.halfWidth;
    this.surface = near.dist <= hw ? 'track' : near.dist <= hw + 1.1 ? 'kerb' : 'grass';
    this.bump *= Math.exp(-dt * 6);
    const wall = hw + this.track.runoff;
    if (near.dist > wall) {
      const [nx, nz] = this.track.normal(near.i);
      const side = Math.sign(near.offset);
      const push = near.dist - wall;
      this.x -= nx * side * push;
      this.z -= nz * side * push;
      // Remove velocity into the wall with a small bounce, plus scrub.
      const vn = (this.vx * nx + this.vz * nz) * side;
      if (vn > 0) {
        this.vx -= nx * side * vn * 1.35;
        this.vz -= nz * side * vn * 1.35;
        this.vx *= 0.82;
        this.vz *= 0.82;
        this.bump = Math.min(1, this.bump + vn / 10);
      }
    }
  }
}
