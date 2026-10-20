// What the kart does, made visible: grass and dust spray off the track, sparks and a puff of smoke on
// wall hits, tyre smoke under hard braking and big slides, and skid marks that fade away.
//
// Everything is one pooled point-sprite system (one draw call) plus one skid-mark mesh. Both are in the
// scene from the start with nothing to draw, so their shaders compile with the rest during the warm-up.
// Physics is only read here, never changed.
import * as THREE from 'three';
import type { Controls, KartPhysics } from './kart';
import type { Quality } from './render';
import type { TrackModel } from './track';

/** Pool sizes and emission rates per graphics tier (phones run Low). */
const TIER: Record<Quality, { particles: number; rate: number; skids: number; maxPx: number }> = {
  low: { particles: 96, rate: 0.45, skids: 1200, maxPx: 0.18 }, // maxPx: largest sprite, × buffer height
  medium: { particles: 256, rate: 1, skids: 3000, maxPx: 0.3 },
  high: { particles: 384, rate: 1.25, skids: 4000, maxPx: 0.3 },
};
const MAX_PARTICLES = 384;
const MAX_SKIDS = 4000;

/** Wheel contact points in kart space: [right, forward]. */
const WHEELS: [number, number][] = [
  [-0.56, 0.62],
  [0.56, 0.62],
  [-0.6, -0.62],
  [0.6, -0.62],
];
const REAR = [2, 3];

interface Spec {
  life: [number, number];
  size: [number, number]; // start size range (m)
  grow: number; // end size = start × grow
  alpha: number;
  color: THREE.Color;
  color2?: THREE.Color; // random mix between color and color2
  additive: boolean;
  drag: number; // 1/s
  grav: number; // m/s², negative rises
  hard: number; // 0 soft puff .. 1 crisp disc
  bounce: number; // ground restitution (0 = stays down)
}

const col = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);

const SPECS = {
  smoke: { life: [0.9, 1.5], size: [0.3, 0.5], grow: 3.4, alpha: 0.32, color: col(0xdcdcd8), color2: col(0xbfc1c4), additive: false, drag: 2.6, grav: -0.35, hard: 0, bounce: 0 },
  puff: { life: [0.7, 1.2], size: [0.5, 0.8], grow: 2.6, alpha: 0.42, color: col(0xb7aa95), color2: col(0x8e8a84), additive: false, drag: 2.4, grav: -0.2, hard: 0, bounce: 0 },
  dust: { life: [0.7, 1.2], size: [0.28, 0.45], grow: 2.6, alpha: 0.5, color: col(0xcdb68c), color2: col(0xa8936c), additive: false, drag: 2.2, grav: -0.1, hard: 0, bounce: 0 },
  clod: { life: [0.45, 0.75], size: [0.07, 0.12], grow: 0.8, alpha: 0.95, color: col(0x3d6a20), color2: col(0x4a3423), additive: false, drag: 0.6, grav: 11, hard: 1, bounce: 0.15 },
  spark: { life: [0.22, 0.42], size: [0.06, 0.1], grow: 0.4, alpha: 1, color: col(0xffd27a, 2.6), color2: col(0xff8a2a, 1.9), additive: true, drag: 1.2, grav: 9.8, hard: 0.6, bounce: 0.35 },
} satisfies Record<string, Spec>;

const VERT = /* glsl */ `
attribute vec4 aColor; // rgb, additive 0..1
attribute vec3 aInfo;  // size (m), alpha, hardness
uniform float uScale;  // drawing-buffer px per metre at 1 m
uniform float uMaxPx;
varying vec4 vColor;
varying vec2 vInfo;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Fade out right in front of the lens, where a puff would only be a big blur (and costs the most).
  float near = smoothstep(0.7, 2.6, -mv.z);
  gl_PointSize = near > 0.0 ? min(uMaxPx, aInfo.x * uScale / -mv.z) : 0.0;
  vColor = aColor;
  vInfo = vec2(aInfo.y * near, aInfo.z);
}`;

const FRAG = /* glsl */ `
uniform float uLight;
varying vec4 vColor;
varying vec2 vInfo;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float soft = 1.0 - d;
  float m = mix(soft * soft, smoothstep(0.0, 0.3, soft), vInfo.y);
  float a = m * vInfo.x;
  gl_FragColor = vec4(mix(vColor.rgb * uLight, vColor.rgb, vColor.a), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Premultiplied: additive sparks write no alpha, smoke and dust blend normally. One draw for both.
  gl_FragColor = vec4(gl_FragColor.rgb * a, a * (1.0 - vColor.a));
}`;

/** Pooled point sprites, simulated on the CPU (a few hundred at most). */
class Particles {
  readonly points: THREE.Points;
  readonly uniforms = { uScale: { value: 800 }, uMaxPx: { value: 256 }, uLight: { value: 1 } };
  private geo = new THREE.BufferGeometry();
  private aPos = new Float32Array(MAX_PARTICLES * 3);
  private aCol = new Float32Array(MAX_PARTICLES * 4);
  private aInf = new Float32Array(MAX_PARTICLES * 3);
  private pos = new Float32Array(MAX_PARTICLES * 3);
  private vel = new Float32Array(MAX_PARTICLES * 3);
  private rgba = new Float32Array(MAX_PARTICLES * 4);
  private age = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private s0 = new Float32Array(MAX_PARTICLES);
  private s1 = new Float32Array(MAX_PARTICLES);
  private a0 = new Float32Array(MAX_PARTICLES);
  private drag = new Float32Array(MAX_PARTICLES);
  private grav = new Float32Array(MAX_PARTICLES);
  private hard = new Float32Array(MAX_PARTICLES);
  private bounce = new Float32Array(MAX_PARTICLES);
  private drawn = 0;
  n = 0;
  cap = TIER.medium.particles;

  constructor() {
    const attr = (a: Float32Array, size: number) => new THREE.BufferAttribute(a, size).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', attr(this.aPos, 3));
    this.geo.setAttribute('aColor', attr(this.aCol, 4));
    this.geo.setAttribute('aInfo', attr(this.aInf, 3));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3; // after the skid marks and the opaque world
  }

  spawn(s: Spec, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    let i = this.n;
    if (i >= this.cap) i = (Math.random() * this.cap) | 0; // pool full: recycle a random one
    else this.n++;
    const r = Math.random;
    const i3 = i * 3;
    const i4 = i * 4;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    const c2 = s.color2 ?? s.color;
    const m = r();
    this.rgba[i4] = s.color.r + (c2.r - s.color.r) * m;
    this.rgba[i4 + 1] = s.color.g + (c2.g - s.color.g) * m;
    this.rgba[i4 + 2] = s.color.b + (c2.b - s.color.b) * m;
    this.rgba[i4 + 3] = s.additive ? 1 : 0;
    this.age[i] = 0;
    this.life[i] = s.life[0] + (s.life[1] - s.life[0]) * r();
    this.s0[i] = s.size[0] + (s.size[1] - s.size[0]) * r();
    this.s1[i] = this.s0[i] * s.grow;
    this.a0[i] = s.alpha * (0.75 + 0.25 * r());
    this.drag[i] = s.drag;
    this.grav[i] = s.grav;
    this.hard[i] = s.hard;
    this.bounce[i] = s.bounce;
  }

  private kill(i: number) {
    const j = --this.n;
    if (i === j) return;
    const c = (a: Float32Array, k: number) => {
      for (let q = 0; q < k; q++) a[i * k + q] = a[j * k + q];
    };
    c(this.pos, 3);
    c(this.vel, 3);
    c(this.rgba, 4);
    for (const a of [this.age, this.life, this.s0, this.s1, this.a0, this.drag, this.grav, this.hard, this.bounce]) a[i] = a[j];
  }

  update(dt: number) {
    if (dt > 0) {
      let i = 0;
      while (i < this.n) {
        const age = (this.age[i] += dt);
        if (age >= this.life[i]) {
          this.kill(i);
          continue;
        }
        const i3 = i * 3;
        const k = Math.exp(-this.drag[i] * dt);
        this.vel[i3] *= k;
        this.vel[i3 + 2] *= k;
        this.vel[i3 + 1] = this.vel[i3 + 1] * k - this.grav[i] * dt;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        if (this.pos[i3 + 1] < 0.03) {
          this.pos[i3 + 1] = 0.03;
          this.vel[i3 + 1] = Math.abs(this.vel[i3 + 1]) * this.bounce[i];
          this.vel[i3] *= 0.5;
          this.vel[i3 + 2] *= 0.5;
        }
        i++;
      }
    }
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const t = this.age[i] / this.life[i];
      const i3 = i * 3;
      this.aPos[i3] = this.pos[i3];
      this.aPos[i3 + 1] = this.pos[i3 + 1];
      this.aPos[i3 + 2] = this.pos[i3 + 2];
      for (let q = 0; q < 4; q++) this.aCol[i * 4 + q] = this.rgba[i * 4 + q];
      const ease = 1 - (1 - t) * (1 - t);
      this.aInf[i3] = this.s0[i] + (this.s1[i] - this.s0[i]) * ease;
      this.aInf[i3 + 1] = this.a0[i] * Math.min(1, t * 10) * (1 - t) * (1 - t * 0.5);
      this.aInf[i3 + 2] = this.hard[i];
    }
    if (n || this.drawn) {
      for (const [name, size] of [['position', 3], ['aColor', 4], ['aInfo', 3]] as const) {
        const a = this.geo.getAttribute(name) as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, Math.max(1, n) * size);
        a.needsUpdate = true;
      }
      this.geo.setDrawRange(0, n);
      this.drawn = n;
    }
  }
}

const SKID_VERT = /* glsl */ `
attribute vec3 aSkid; // birth time, alpha, tint (0 rubber, 1 earth)
varying vec3 vSkid;
void main() {
  vSkid = aSkid;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKID_FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uFade; // fully there until x seconds, gone at y
varying vec3 vSkid;
void main() {
  float a = vSkid.y * (1.0 - smoothstep(uFade.x, uFade.y, uTime - vSkid.x));
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(vec3(0.004), vec3(0.075, 0.045, 0.016), vSkid.z), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.a = a;
}`;

/** Ring buffer of skid quads; each fades with age, so the oldest are gone before the ring wraps. */
class SkidMarks {
  readonly mesh: THREE.Mesh;
  readonly uniforms = { uTime: { value: 0 }, uFade: { value: new THREE.Vector2(10, 34) } };
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(MAX_SKIDS * 4 * 3);
  private info = new Float32Array(MAX_SKIDS * 4 * 3);
  private count = 0; // quads written in total
  cap = TIER.medium.skids;
  // Per rear wheel: the last point of the current strip.
  private last = [
    { on: false, x: 0, z: 0, tint: 0 },
    { on: false, x: 0, z: 0, tint: 0 },
  ];

  constructor() {
    const index = new Uint16Array(MAX_SKIDS * 6);
    for (let q = 0; q < MAX_SKIDS; q++) index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 1, q * 4 + 3, q * 4 + 2], q * 6);
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSkid', new THREE.BufferAttribute(this.info, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKID_VERT,
      fragmentShader: SKID_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Continue wheel w's strip to (x, z). alpha 0 lifts the wheel (ends the strip). */
  mark(w: number, x: number, z: number, alpha: number, tint: number, time: number) {
    const l = this.last[w];
    if (alpha <= 0) {
      l.on = false;
      return;
    }
    const dx = x - l.x;
    const dz = z - l.z;
    const d2 = dx * dx + dz * dz;
    // Start a new strip after a lift, a change of surface or a jump (reset, respawn).
    if (!l.on || l.tint !== tint || d2 > 9) {
      Object.assign(l, { on: true, x, z, tint });
      return;
    }
    if (d2 < 0.04) return; // one quad per 20 cm
    const len = Math.sqrt(d2);
    const hw = tint ? 0.13 : 0.1;
    const nx = (-dz / len) * hw;
    const nz = (dx / len) * hw;
    const y = tint ? 0.005 : 0.05; // grass sits just below the road surface
    const q = this.count % this.cap;
    const p = this.pos;
    const o = q * 12;
    p.set([l.x - nx, y, l.z - nz, l.x + nx, y, l.z + nz, x - nx, y, z - nz, x + nx, y, z + nz], o);
    for (let v = 0; v < 4; v++) this.info.set([time, alpha, tint], o + v * 3);
    for (const name of ['position', 'aSkid']) {
      const a = this.geo.getAttribute(name) as THREE.BufferAttribute;
      a.addUpdateRange(o, 12);
      a.needsUpdate = true;
    }
    this.count++;
    this.geo.setDrawRange(0, Math.min(this.count, this.cap) * 6);
    l.x = x;
    l.z = z;
  }

  /** Marks fade on simulation time, so they hold still while paused. */
  frame(time: number) {
    this.uniforms.uTime.value = time;
  }

  setCap(cap: number) {
    if (cap === this.cap) return;
    // Keep what's drawn sensible: restart the ring at the new size.
    this.cap = cap;
    this.count = Math.min(this.count, cap);
    this.geo.setDrawRange(0, this.count * 6);
  }
}

/** What the camera, sound and haptics need from the last frame's physics steps. */
export interface FxFrame {
  /** Wall impact speed into the barrier (m/s), 0 when there was none since the last frame. */
  impact: number;
  /** Unit normal pointing into the wall that was hit. */
  nx: number;
  nz: number;
  /** 0..1 while sliding along a barrier. */
  scrape: number;
  /** 0..1 on the kerb (scaled by speed). */
  kerb: number;
  /** 0..1 wheels in the grass (scaled by speed). */
  grass: number;
  /** 0..1 tyres at or past the grip limit, or locking under brakes. */
  squeal: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class KartFx {
  private parts = new Particles();
  private skids = new SkidMarks();
  private quality: Quality | null = null;
  private rate = 1;
  private acc = new Float32Array(16); // fractional emission carried between steps
  private time = 0;
  private gather: FxFrame = { impact: 0, nx: 0, nz: 0, scrape: 0, kerb: 0, grass: 0, squeal: 0 };
  private view: FxFrame = { ...this.gather };
  private bufSize = new THREE.Vector2();
  private maxPoint = 256;

  constructor(
    scene: THREE.Scene,
    private track: TrackModel,
  ) {
    scene.add(this.skids.mesh, this.parts.points);
  }

  /** Live particles (for measurements). */
  get active() {
    return this.parts.n;
  }

  private setQuality(q: Quality) {
    this.quality = q;
    const t = TIER[q];
    this.parts.cap = t.particles;
    if (this.parts.n > t.particles) this.parts.n = t.particles;
    this.skids.setCap(t.skids);
    this.rate = t.rate;
  }

  /** Emit `perSecond × dt` of spec, keeping the fraction for the next step (slot k). */
  private emit(k: number, perSecond: number, dt: number, s: Spec, x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number) {
    this.acc[k] += perSecond * this.rate * dt;
    while (this.acc[k] >= 1) {
      this.acc[k] -= 1;
      const r = Math.random;
      this.parts.spawn(s, x + (r() - 0.5) * 0.2, y, z + (r() - 0.5) * 0.2, vx + (r() - 0.5) * spread, vy * (0.5 + r()), vz + (r() - 0.5) * spread);
    }
  }

  private burst(n: number, s: Spec, x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number) {
    const count = Math.max(1, Math.round(n * this.rate));
    for (let k = 0; k < count; k++) {
      const r = Math.random;
      this.parts.spawn(s, x, y, z, vx + (r() - 0.5) * spread, vy * (0.4 + r()), vz + (r() - 0.5) * spread);
    }
  }

  /** Once per physics step, after KartPhysics.step: read what the kart did and emit. */
  sense(p: KartPhysics, c: Controls, dt: number, simT: number) {
    this.time = simT;
    const g = this.gather;
    const t = this.track;
    const hw = t.halfWidth;
    const h = p.heading;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const rx = -fz;
    const rz = fx;
    const [nx, nz] = t.normal(p.hint);
    const side = p.offset >= 0 ? 1 : -1;
    const wnx = nx * side; // into the nearer barrier
    const wnz = nz * side;
    const speed = p.speed;
    const vf = p.forwardSpeed;

    // ---- wall contact: the wall model publishes `impact` for the one step a contact starts.
    const hit = p.impact && p.impact.speed > 0.8 ? p.impact.speed : 0;
    const atWall = p.onWall;
    const cx = p.x + wnx * 0.55;
    const cz = p.z + wnz * 0.55;
    if (hit > 0) {
      const k = clamp01(hit / 8);
      if (hit > g.impact) Object.assign(g, { impact: hit, nx: wnx, nz: wnz });
      this.burst(8 + 26 * k, SPECS.spark, cx, 0.25, cz, p.vx * 0.45 - wnx * 2, 2.2 + 2.5 * k, p.vz * 0.45 - wnz * 2, 5);
      this.burst(2 + 4 * k, SPECS.puff, cx, 0.35, cz, -wnx * 1.2 + p.vx * 0.2, 0.6, -wnz * 1.2 + p.vz * 0.2, 1.2);
    }
    const scrape = atWall && speed > 3 ? clamp01(speed / 18) : 0;
    if (scrape) {
      g.scrape = Math.max(g.scrape, scrape);
      this.emit(0, 45 * scrape, dt, SPECS.spark, cx, 0.2, cz, p.vx * 0.6 - wnx, 1.6, p.vz * 0.6 - wnz, 3);
      this.emit(1, 5 * scrape, dt, SPECS.puff, cx, 0.3, cz, p.vx * 0.2, 0.4, p.vz * 0.2, 0.8);
    }

    // ---- surfaces, wheel by wheel (two wheels off is a dust trail on one side only)
    let grassWheels = 0;
    const onGrass = [false, false, false, false];
    for (let w = 0; w < 4 && p.surface !== 'track'; w++) {
      const [wx, wz] = WHEELS[w];
      const ox = fx * wz + rx * wx;
      const oz = fz * wz + rz * wx;
      const off = Math.abs(p.offset + ox * nx + oz * nz);
      if (off <= hw + 1.1) continue;
      onGrass[w] = true;
      grassWheels++;
      if (speed < 2) continue;
      const rear = wz < 0;
      const x = p.x + ox;
      const z = p.z + oz;
      // Clods thrown up and back, a lighter dust cloud that hangs behind.
      this.emit(2 + w, (rear ? 1.1 : 0.5) * speed, dt, SPECS.clod, x, 0.08, z, p.vx * 0.45, 1.6 + speed * 0.12, p.vz * 0.45, 2.4);
      this.emit(6 + w, (rear ? 0.38 : 0.15) * speed, dt, SPECS.dust, x, 0.15, z, p.vx * 0.55, 0.5, p.vz * 0.55, 1.2);
    }
    g.grass = Math.max(g.grass, (grassWheels / 4) * clamp01(speed / 15));
    g.kerb = Math.max(g.kerb, p.surface === 'kerb' ? clamp01(speed / 10) : 0);

    // ---- the tyres: at the grip limit (read from the same bicycle model the physics uses), locked
    // under hard braking, spinning at the launch, or sliding after a hit.
    const gripG = p.surface === 'grass' ? 0.75 : p.surface === 'kerb' ? 2.0 : 2.35;
    const latG = Math.abs(p.yawRate * vf) / 9.81;
    const demand = Math.abs((vf * Math.tan(p.steerAngle)) / p.wheelbase) / ((gripG * 9.81) / Math.max(Math.abs(vf), 2));
    const limit = speed > 8 ? clamp01((latG / gripG - 0.86) / 0.1) * clamp01((demand - 1.05) / 0.6) : 0;
    const slide = Math.max(limit, clamp01((p.slip - 1.5) / 3));
    const brake = p.surface !== 'grass' && c.brake > 0.5 && vf > 11 ? c.brake * (0.25 + 0.75 * clamp01((vf - 11) / 14)) : 0;
    const spin = p.surface === 'track' && c.throttle > 0.5 && vf >= 0 && vf < 4.5 ? 1 - vf / 4.5 : 0;
    g.squeal = Math.max(g.squeal, p.surface === 'grass' ? 0 : Math.max(slide, brake * 0.45));
    const smoke = slide * 16 + brake * 6 + spin * 12;
    REAR.forEach((w, k) => {
      const [wx, wz] = WHEELS[w];
      const x = p.x + fx * wz + rx * wx;
      const z = p.z + fz * wz + rz * wx;
      if (smoke > 0.5 && !onGrass[w]) this.emit(10 + k, smoke, dt, SPECS.smoke, x, 0.15, z, p.vx * 0.65, 0.35, p.vz * 0.65, 0.8);
      // Skid marks: black rubber on tarmac when sliding or braking hard, a brown rut in the grass.
      let alpha = 0;
      let tint = 0;
      if (onGrass[w]) {
        alpha = speed > 2 ? 0.34 * clamp01(speed / 8) : 0;
        tint = 1;
      } else if (slide > 0.2 || brake > 0) alpha = 0.45 * Math.max(slide, brake * 0.65);
      this.skids.mark(k, x, z, alpha, tint, simT);
    });
  }

  /** Once per frame: simulate the particles and hand back what happened since the last frame. */
  frame(dt: number, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, quality: Quality, night: boolean): FxFrame {
    if (quality !== this.quality) {
      this.setQuality(quality);
      this.maxPoint = renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE)?.[1] ?? 256;
    }
    this.parts.update(dt);
    const hpx = renderer.getDrawingBufferSize(this.bufSize).y;
    const u = this.parts.uniforms;
    u.uScale.value = hpx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    u.uMaxPx.value = Math.min(this.maxPoint, hpx * TIER[quality].maxPx);
    u.uLight.value = night ? 0.42 : 1;
    this.skids.frame(this.time);
    Object.assign(this.view, this.gather);
    const g = this.gather;
    g.impact = g.scrape = g.kerb = g.grass = g.squeal = 0;
    return this.view;
  }
}
