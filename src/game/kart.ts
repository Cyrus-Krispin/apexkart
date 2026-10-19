import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { TrackModel } from './track';

export interface KartVisual {
  root: THREE.Group;
  body: THREE.Group; // rolls/pitches
  frontPivots: THREE.Group[];
  wheels: THREE.Mesh[];
  materials: THREE.Material[];
}

function tyreGeometry(r: number, w: number): THREE.BufferGeometry {
  // Lathe a rounded tyre profile around the axle (lathe axis = y, rotated to x later).
  const pts: THREE.Vector2[] = [];
  const rim = r * 0.62;
  const s = 0.35; // sidewall roundness
  pts.push(new THREE.Vector2(rim, -w / 2));
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - w * s * (1 - Math.sin(a)), -w / 2 + w * s * (1 - Math.cos(a))));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - w * s * (1 - Math.cos(a)), w / 2 - w * s * (1 - Math.sin(a))));
  }
  pts.push(new THREE.Vector2(rim, w / 2));
  return new THREE.LatheGeometry(pts, 20).rotateZ(Math.PI / 2);
}

/** Low-poly racing kart facing +z, origin on the ground at the kart's centre. */
export function buildKart(color: string, opts: { ghost?: boolean; number?: number } = {}): KartVisual {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const materials: THREE.Material[] = [];
  const mat = (c: THREE.ColorRepresentation, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.05, ...extra });
    if (opts.ghost) {
      m.transparent = true;
      m.opacity = 0.34;
      m.depthWrite = false;
      m.emissive = new THREE.Color(color);
      m.emissiveIntensity = 0.25;
    }
    materials.push(m);
    return m;
  };
  const paint = mat(color, { roughness: 0.32, metalness: 0.15 });
  const ink = mat(0x18181a, { roughness: 0.75 });
  const paper = mat(0xf2eee5, { roughness: 0.45 });
  const steel = mat(0xa7abb0, { metalness: 0.85, roughness: 0.3 });
  const rubber = mat(0x151515, { roughness: 0.92 });
  const suit = mat(color, { roughness: 0.8 });
  const visor = mat(0x0b0b10, { roughness: 0.08, metalness: 0.7 });

  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = !opts.ghost;
    parent.add(mesh);
    return mesh;
  };
  const rbox = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r);

  // Chassis: floor tray, side rails, axles
  add(rbox(0.7, 0.04, 1.45, 0.015), ink, 0, 0.1, 0);
  for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.022, 0.022, 1.5, 8).rotateX(Math.PI / 2), steel, sx * 0.36, 0.12, 0);
  add(new THREE.CylinderGeometry(0.025, 0.025, 1.18, 8).rotateZ(Math.PI / 2), steel, 0, 0.14, -0.62);

  // Nose cone: extruded rounded trapezoid (top view), bevelled
  const nose = new THREE.Shape();
  nose.moveTo(-0.28, -0.62);
  nose.lineTo(0.28, -0.62);
  nose.quadraticCurveTo(0.5, -0.7, 0.5, -0.9);
  nose.quadraticCurveTo(0.5, -1.02, 0.38, -1.02);
  nose.lineTo(-0.38, -1.02);
  nose.quadraticCurveTo(-0.5, -1.02, -0.5, -0.9);
  nose.quadraticCurveTo(-0.5, -0.7, -0.28, -0.62);
  const noseGeo = new THREE.ExtrudeGeometry(nose, { depth: 0.1, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 3, curveSegments: 10 });
  noseGeo.rotateX(-Math.PI / 2); // shape y = -z, extrusion goes up
  add(noseGeo, paint, 0, 0.1, 0);
  // Front panel ahead of the driver's legs, with a paper number board
  const panel = add(rbox(0.46, 0.3, 0.07, 0.03), paint, 0, 0.3, 0.52);
  panel.rotation.x = -0.55;
  // Side pods with a paper stripe
  for (const sx of [-1, 1]) {
    const pod = add(rbox(0.22, 0.17, 0.8, 0.06), paint, sx * 0.6, 0.19, -0.04);
    pod.rotation.z = sx * -0.08;
    add(rbox(0.225, 0.035, 0.6, 0.015), paper, sx * 0.6, 0.235, -0.04).rotation.z = sx * -0.08;
  }
  // Rear bumper
  add(rbox(1.28, 0.07, 0.1, 0.03), ink, 0, 0.21, -0.98);
  for (const sx of [-1, 1]) add(rbox(0.06, 0.07, 0.3, 0.02), ink, sx * 0.4, 0.21, -0.85);
  // Engine block, cylinder head and silencer (right rear)
  add(rbox(0.24, 0.26, 0.3, 0.03), steel, 0.32, 0.3, -0.48);
  add(new THREE.CylinderGeometry(0.075, 0.09, 0.12, 12), steel, 0.32, 0.48, -0.48);
  add(new THREE.CylinderGeometry(0.065, 0.065, 0.36, 12).rotateX(Math.PI / 2), ink, 0.47, 0.3, -0.76);
  // Seat
  const seat = add(rbox(0.42, 0.42, 0.12, 0.05), ink, 0, 0.36, -0.33);
  seat.rotation.x = -0.32;
  // Steering column + wheel
  add(new THREE.CylinderGeometry(0.018, 0.018, 0.46, 6).rotateX(Math.PI / 2 - 0.92), steel, 0, 0.33, 0.3);
  const sw = add(new THREE.TorusGeometry(0.13, 0.02, 8, 20), ink, 0, 0.5, 0.15);
  sw.rotation.x = -0.6;

  // Driver: torso, arms, helmet with visor and livery stripe
  const torso = add(new THREE.CapsuleGeometry(0.17, 0.26, 4, 10), suit, 0, 0.62, -0.22);
  torso.rotation.x = -0.35;
  add(new THREE.CapsuleGeometry(0.172, 0.04, 4, 10), paper, 0, 0.5, -0.18).rotation.x = -0.35;
  for (const sx of [-1, 1]) {
    const arm = add(new THREE.CapsuleGeometry(0.045, 0.32, 4, 8), suit, sx * 0.16, 0.62, -0.02);
    arm.rotation.x = Math.PI / 2 - 0.55;
    arm.rotation.z = sx * 0.28;
  }
  add(new THREE.SphereGeometry(0.155, 20, 16), paper, 0, 0.99, -0.16);
  add(new THREE.SphereGeometry(0.157, 20, 10, -Math.PI / 2.6, Math.PI / 1.3, Math.PI / 2.75, Math.PI / 4.2), visor, 0, 0.99, -0.16);
  const stripe = add(new THREE.TorusGeometry(0.153, 0.022, 6, 24), paint, 0, 0.99, -0.16);
  stripe.rotation.y = Math.PI / 2;

  // Number board on the front panel
  if (opts.number !== undefined && !opts.ghost) {
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f2eee5';
    g.fillRect(0, 0, 96, 64);
    g.fillStyle = '#141414';
    g.font = '800 48px Archivo, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(opts.number), 48, 36);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.2), new THREE.MeshBasicMaterial({ map: t }));
    plate.position.set(0, 0.0, 0.037);
    panel.add(plate);
  }

  // Wheels with rounded tyres and paper rims
  const wheels: THREE.Mesh[] = [];
  const frontPivots: THREE.Group[] = [];
  const mk = (x: number, z: number, r: number, w: number, front: boolean) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    root.add(pivot);
    const wheel = new THREE.Mesh(tyreGeometry(r, w), rubber);
    wheel.castShadow = !opts.ghost;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, w * 0.9, 14).rotateZ(Math.PI / 2), paper);
    wheel.add(hub);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.2, r * 0.2, w * 0.95, 8).rotateZ(Math.PI / 2), ink);
    wheel.add(cap);
    pivot.add(wheel);
    wheels.push(wheel);
    if (front) frontPivots.push(pivot);
  };
  mk(-0.56, 0.62, 0.13, 0.13, true);
  mk(0.56, 0.62, 0.13, 0.13, true);
  mk(-0.6, -0.62, 0.14, 0.2, false);
  mk(0.6, -0.62, 0.14, 0.2, false);

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
