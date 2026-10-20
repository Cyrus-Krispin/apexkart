// Night floodlights. Every pole's light is baked into a top-down irradiance map
// that ground, road and trackside materials add to their emissive term (so even
// distant lamps light the circuit). A handful of real SpotLights follow the poles
// nearest the kart for proper lighting on the kart and nearby walls; the shader
// subtracts their share from the baked map so a pole never lights twice.
import * as THREE from 'three';

export interface Lamp {
  pos: THREE.Vector3; // lamp head
  dir: THREE.Vector3; // unit aim, towards the track
  beam?: boolean; // false: something (a building) stands in the beam, so draw no light cone for it
}

/** One floodlight, shared by the baked map and the real lights so they match exactly. */
export const LAMP = {
  color: 0xffe8c8, // warm, but not so amber that lit grass turns neon under Neutral tone mapping
  intensity: 150, // candela
  angle: 1.15, // cone half-angle (rad)
  penumbra: 0.6,
  decay: 1.25, // softer than physical: a floodlight's beam carries further than a bulb
  distance: 52, // light cutoff (m)
};

const BAKE_RES = 0.8; // metres per texel
const BAKE_MAX = 1536;
const MAX_SLOTS = 6;

/** Global switch read when materials compile: off by day, so day shaders are untouched. */
const state = {
  night: false,
  slots: 1,
  uniforms: {
    akFloodMap: { value: null as THREE.Texture | null },
    akFloodRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    akFloodColor: { value: new THREE.Color() },
    akFloodCone: { value: new THREE.Vector4() },
    akFloodPos: { value: Array.from({ length: MAX_SLOTS }, () => new THREE.Vector4(0, -1e4, 0, 0)) },
    akFloodDir: { value: Array.from({ length: MAX_SLOTS }, () => new THREE.Vector3(0, -1, 0)) },
  },
};

const coneCos = () => Math.cos(LAMP.angle);
const penumbraCos = () => Math.cos(LAMP.angle * (1 - LAMP.penumbra));

/** Spot attenuation for one lamp at ground point (gx, 0, gz), times the unit vector to the lamp. Mirrors three's SpotLight. */
function lampAt(l: Lamp, gx: number, gz: number, out: THREE.Vector3): boolean {
  const lx = l.pos.x - gx;
  const ly = l.pos.y;
  const lz = l.pos.z - gz;
  const r = Math.hypot(lx, ly, lz);
  if (r >= LAMP.distance) return false;
  const ux = lx / r;
  const uy = ly / r;
  const uz = lz / r;
  const c0 = coneCos();
  const c1 = penumbraCos();
  const t = Math.min(1, Math.max(0, (-(ux * l.dir.x + uy * l.dir.y + uz * l.dir.z) - c0) / (c1 - c0)));
  if (t <= 0) return false;
  const win = Math.max(0, 1 - (r / LAMP.distance) ** 4) ** 2;
  const a = ((t * t * (3 - 2 * t)) / Math.max(r ** LAMP.decay, 0.01)) * win;
  out.set(ux * a, uy * a, uz * a);
  return true;
}

/** Bake Σ attenuation · L for every lamp into an RGB half-float map over the lamps' reach. */
function bake(lamps: Lamp[]): { tex: THREE.DataTexture; rect: THREE.Vector4 } {
  let x0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    z1 = -Infinity;
  for (const l of lamps) {
    x0 = Math.min(x0, l.pos.x);
    x1 = Math.max(x1, l.pos.x);
    z0 = Math.min(z0, l.pos.z);
    z1 = Math.max(z1, l.pos.z);
  }
  const m = LAMP.distance + 2;
  x0 -= m;
  z0 -= m;
  x1 += m;
  z1 += m;
  const res = Math.max(BAKE_RES, (x1 - x0) / BAKE_MAX, (z1 - z0) / BAKE_MAX);
  const w = Math.ceil((x1 - x0) / res) + 1;
  const h = Math.ceil((z1 - z0) / res) + 1;
  const acc = new Float32Array(w * h * 3);
  const v = new THREE.Vector3();
  const reach = Math.ceil(LAMP.distance / res);
  for (const l of lamps) {
    const ci = Math.round((l.pos.x - x0) / res);
    const cj = Math.round((l.pos.z - z0) / res);
    for (let j = Math.max(1, cj - reach); j <= Math.min(h - 2, cj + reach); j++)
      for (let i = Math.max(1, ci - reach); i <= Math.min(w - 2, ci + reach); i++) {
        if (!lampAt(l, x0 + i * res, z0 + j * res, v)) continue;
        const k = (j * w + i) * 3;
        acc[k] += v.x;
        acc[k + 1] += v.y;
        acc[k + 2] += v.z;
      }
  }
  const data = new Uint16Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    data[p * 4] = THREE.DataUtils.toHalfFloat(acc[p * 3]);
    data[p * 4 + 1] = THREE.DataUtils.toHalfFloat(acc[p * 3 + 1]);
    data[p * 4 + 2] = THREE.DataUtils.toHalfFloat(acc[p * 3 + 2]);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  // Texel centres sit on the sample points.
  const rect = new THREE.Vector4(x0 - res / 2, z0 - res / 2, 1 / (w * res), 1 / (h * res));
  return { tex, rect };
}

const VERT_DECL = /* glsl */ `
varying vec3 vAkFlood;`;
const VERT_BODY = /* glsl */ `
{
  vec4 akW = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    akW = batchingMatrix * akW;
  #endif
  #ifdef USE_INSTANCING
    akW = instanceMatrix * akW;
  #endif
  vAkFlood = ( modelMatrix * akW ).xyz;
}`;
const FRAG_DECL = /* glsl */ `
varying vec3 vAkFlood;
uniform sampler2D akFloodMap;
uniform vec4 akFloodRect;
uniform vec3 akFloodColor;
uniform vec4 akFloodCone; // cone cos, penumbra cos, cutoff, decay
uniform vec4 akFloodPos[ AK_FLOOD_SLOTS ]; // xyz lamp, w weight of the real light standing in for it
uniform vec3 akFloodDir[ AK_FLOOD_SLOTS ];`;
const FRAG_BODY = /* glsl */ `
{
  vec2 akG = vAkFlood.xz;
  vec3 akE = texture2D( akFloodMap, ( akG - akFloodRect.xy ) * akFloodRect.zw ).xyz;
  for ( int i = 0; i < AK_FLOOD_SLOTS; i ++ ) {
    float w = akFloodPos[ i ].w;
    if ( w <= 0.0 ) continue;
    vec3 L = akFloodPos[ i ].xyz - vec3( akG.x, 0.0, akG.y );
    float r = length( L );
    L /= r;
    float a = smoothstep( akFloodCone.x, akFloodCone.y, dot( L, -akFloodDir[ i ] ) ) / max( pow( r, akFloodCone.w ), 0.01 );
    akE -= w * a * pow2( saturate( 1.0 - pow4( r / akFloodCone.z ) ) ) * L;
  }
  vec3 akN = inverseTransformDirection( normal, viewMatrix );
  // Exact on the ground; walls get a little wrap so lamps on both sides still read.
  float akI = max( dot( akN, akE ), 0.0 ) + 0.25 * ( 1.0 - abs( akN.y ) ) * max( akE.y, 0.0 );
  akI *= saturate( 1.0 - vAkFlood.y * 0.08 );
  totalEmissiveRadiance += diffuseColor.rgb * ( RECIPROCAL_PI * akI ) * akFloodColor;
}`;

/** Let the baked floodlight pools light every lit material under `root` (no-op by day). */
export function floodlit(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const m = mat as THREE.MeshStandardMaterial;
      if (!(m.isMeshStandardMaterial || (m as unknown as THREE.MeshLambertMaterial).isMeshLambertMaterial) || m.userData.akFlood) continue;
      m.userData.akFlood = true;
      const prev = m.onBeforeCompile;
      const prevKey = m.customProgramCacheKey;
      m.onBeforeCompile = (shader, renderer) => {
        prev.call(m, shader, renderer);
        // Attach the uniforms by day too. Three.js reuses a material's night program when you
        // switch back, but keeps the uniform set from the last compile (the day one), so without
        // them the pools read zeros and smoothstep(0, 0, x) turns into NaN that bloom smears everywhere.
        Object.assign(shader.uniforms, state.uniforms);
        if (!state.night) return;
        shader.defines = { ...shader.defines, AK_FLOOD_SLOTS: state.slots };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>${VERT_DECL}`)
          .replace('#include <project_vertex>', `#include <project_vertex>${VERT_BODY}`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>${FRAG_DECL}`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${FRAG_BODY}`);
      };
      m.customProgramCacheKey = () => prevKey.call(m) + (state.night ? `|ak-flood${state.slots}` : '');
      m.needsUpdate = true;
    }
  });
}

/** The textures the floodlight patch samples (the baked pools), for uploading before they're needed. */
export function floodTextures(): THREE.Texture[] {
  const t = state.uniforms.akFloodMap.value;
  return t ? [t] : [];
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,240,215,0.75)');
  grd.addColorStop(0.4, 'rgba(255,220,170,0.16)');
  grd.addColorStop(1, 'rgba(255,210,160,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Slot {
  light: THREE.SpotLight;
  lamp: number;
  w: number;
  want: boolean;
}

export interface RigOptions {
  pool: number; // plain lights following the nearest poles
  shadow: number; // shadow map size for the one shadow-casting floodlight, 0 for none
  glare: number; // lamp-head sprite opacity
  cones: boolean; // faint light cones under the lamp heads (Medium and High)
}

const CONE_ANGLE = 0.42; // the visible beam's half-angle (the light itself spreads much wider)

/** Faint additive beams under the lamp heads: bright at the lens, fading down the cone and at its silhouette. */
function coneMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { coneColor: { value: new THREE.Color(LAMP.color).multiplyScalar(0.06) } },
    vertexShader: /* glsl */ `
      varying float vT;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vT = -position.y; // 0 at the lens, 1 at the end of the beam
        mat4 m = modelMatrix * instanceMatrix;
        vec4 w = m * vec4(position, 1.0);
        vN = normalize(mat3(m) * normal);
        vView = cameraPosition - w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 coneColor;
      varying float vT;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        float d = max(length(vView), 1e-3);
        float facing = abs(dot(normalize(vN), vView / d));
        float t = clamp(vT, 0.0, 1.0); // (pow of a hair below zero is NaN, which bloom smears over the screen)
        float a = facing * facing * pow(1.0 - t, 1.6) * smoothstep(0.0, 0.06, t);
        a *= smoothstep(4.0, 16.0, d) * (1.0 - smoothstep(110.0, 240.0, d)); // never fills the screen, fades far off
        gl_FragColor = vec4(coneColor * a, 1.0);
      }`,
  });
}

/** The night rig: baked pools, real lights near the kart and glare sprites on every lamp head. */
export class Floodlights {
  readonly group = new THREE.Group();
  private lamps: Lamp[] = [];
  private pool: Slot[] = [];
  private shadow: Slot | null = null;
  private glare: THREE.Points | null = null;
  private cones: THREE.InstancedMesh | null = null;
  private coneMat = coneMaterial();
  private conesOn = false;
  private glareMat = new THREE.PointsMaterial({ size: 5.5, map: glowTexture(), color: 0xfff0dc, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  private baked: THREE.DataTexture | null = null;
  private empty = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  private d2: Float32Array = new Float32Array(0);
  private order: number[] = [];

  constructor(opts: RigOptions) {
    this.empty.needsUpdate = true;
    const u = state.uniforms;
    u.akFloodMap.value = this.empty;
    u.akFloodColor.value.set(LAMP.color).multiplyScalar(LAMP.intensity);
    u.akFloodCone.value.set(coneCos(), penumbraCos(), LAMP.distance, LAMP.decay);
    this.setRig(opts);
  }

  /** Compile-time switch for the material patch; call before the scene next renders. */
  static setNight(on: boolean) {
    state.night = on;
  }

  setLamps(lamps: Lamp[]) {
    // A rebuilt world (surroundings arriving late) usually has the same poles: keep the bake.
    const same =
      lamps.length > 0 &&
      lamps.length === this.lamps.length &&
      lamps.every((l, i) => l.pos.distanceToSquared(this.lamps[i].pos) < 1e-4 && l.dir.distanceToSquared(this.lamps[i].dir) < 1e-6);
    this.lamps = lamps;
    if (same) return;
    this.d2 = new Float32Array(lamps.length);
    this.order = lamps.map((_, i) => i);
    this.baked?.dispose();
    this.baked = null;
    const u = state.uniforms;
    if (lamps.length) {
      const b = bake(lamps);
      this.baked = b.tex;
      u.akFloodMap.value = b.tex;
      u.akFloodRect.value.copy(b.rect);
    } else u.akFloodMap.value = this.empty;
    for (const s of this.slots()) {
      s.lamp = -1;
      s.w = 0;
    }
    if (this.glare) {
      this.group.remove(this.glare);
      this.glare.geometry.dispose();
    }
    const pos = new Float32Array(lamps.length * 3);
    lamps.forEach((l, i) => {
      // Just in front of the lens so the sprite isn't clipped by the lamp housing.
      pos[i * 3] = l.pos.x + l.dir.x * 0.4;
      pos[i * 3 + 1] = l.pos.y + l.dir.y * 0.4;
      pos[i * 3 + 2] = l.pos.z + l.dir.z * 0.4;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.glare = new THREE.Points(geo, this.glareMat);
    this.glare.frustumCulled = false;
    this.group.add(this.glare);

    // One instanced, open cone per lamp, apex at the lens, reaching down to the ground along its aim.
    if (this.cones) {
      this.group.remove(this.cones);
      this.cones.geometry.dispose();
      this.cones.dispose();
      this.cones = null;
    }
    const beams = lamps.filter((l) => l.beam !== false);
    if (beams.length) {
      const cone = new THREE.ConeGeometry(Math.tan(CONE_ANGLE), 1, 18, 1, true).translate(0, -0.5, 0);
      cone.deleteAttribute('uv');
      const mesh = new THREE.InstancedMesh(cone, this.coneMat, beams.length);
      const q = new THREE.Quaternion();
      const m = new THREE.Matrix4();
      const down = new THREE.Vector3(0, -1, 0);
      const at = new THREE.Vector3();
      beams.forEach((l, i) => {
        const len = Math.min(LAMP.distance * 0.5, l.pos.y / Math.max(0.2, -l.dir.y)) * 0.92;
        q.setFromUnitVectors(down, l.dir);
        at.copy(l.pos).addScaledVector(l.dir, 0.25);
        mesh.setMatrixAt(i, m.compose(at, q, new THREE.Vector3(len, len, len)));
      });
      mesh.computeBoundingSphere();
      mesh.visible = this.conesOn;
      mesh.renderOrder = 2; // after the glare-free see-through things, before the glare sprites matter
      this.cones = mesh;
      this.group.add(mesh);
    }
  }

  /** Rebuild the real lights for a quality level. Changes light counts, so shaders recompile. */
  setRig(o: RigOptions) {
    for (const s of this.slots()) {
      this.group.remove(s.light, s.light.target);
      s.light.dispose();
    }
    const make = (shadow: number): Slot => {
      const l = new THREE.SpotLight(LAMP.color, 0, LAMP.distance, LAMP.angle, LAMP.penumbra, LAMP.decay);
      if (shadow) {
        l.castShadow = true;
        l.shadow.mapSize.set(shadow, shadow);
        l.shadow.camera.near = 1;
        l.shadow.camera.far = LAMP.distance;
        l.shadow.bias = -0.0006;
        l.shadow.normalBias = 0.03;
        l.shadow.radius = 2;
      }
      this.group.add(l, l.target);
      return { light: l, lamp: -1, w: 0, want: false };
    };
    this.pool = Array.from({ length: o.pool }, () => make(0));
    this.shadow = o.shadow ? make(o.shadow) : null;
    state.slots = THREE.MathUtils.clamp(this.slots().length, 1, MAX_SLOTS);
    this.glareMat.opacity = o.glare;
    this.conesOn = o.cones;
    if (this.cones) this.cones.visible = o.cones;
  }

  private slots(): Slot[] {
    return this.shadow ? [...this.pool, this.shadow] : this.pool;
  }

  /** Hand the real lights to the poles nearest (x, z), cross-fading so nothing pops. */
  update(x: number, z: number, dt: number) {
    const n = this.lamps.length;
    const u = state.uniforms;
    if (!n) return;
    for (let i = 0; i < n; i++) this.d2[i] = (this.lamps[i].pos.x - x) ** 2 + (this.lamps[i].pos.z - z) ** 2;
    this.order.sort((a, b) => this.d2[a] - this.d2[b]);
    const wanted = this.order.slice(0, this.pool.length);
    for (const s of this.pool) s.want = wanted.includes(s.lamp);
    for (const lamp of wanted) {
      if (this.pool.some((s) => s.lamp === lamp)) continue;
      const free = this.pool.find((s) => !s.want && s.w === 0);
      if (free) {
        free.lamp = lamp;
        free.want = true;
      }
    }
    const sh = this.shadow;
    if (sh) {
      const nearest = this.order[0];
      if (sh.lamp !== nearest) {
        sh.want = false;
        if (sh.w === 0) {
          sh.lamp = nearest;
          sh.want = true;
        }
      } else sh.want = true;
    }
    const step = Math.min(1, dt * 5);
    for (const s of this.slots()) s.w = s.lamp < 0 ? 0 : THREE.MathUtils.clamp(s.w + (s.want ? step : -step), 0, 1);

    // A pole held by both the shadow light and a plain one is lit max(w) in total.
    const sw = sh?.w ?? 0;
    this.slots().forEach((s, k) => {
      const eff = s !== sh && sh && s.lamp === sh.lamp ? Math.max(0, s.w - sw) : s.w;
      const l = s.lamp >= 0 ? this.lamps[s.lamp] : null;
      s.light.intensity = l ? LAMP.intensity * eff : 0;
      if (l) {
        s.light.position.copy(l.pos);
        s.light.target.position.copy(l.pos).addScaledVector(l.dir, 10);
      }
      if (k < MAX_SLOTS) {
        u.akFloodPos.value[k].set(l?.pos.x ?? 0, l?.pos.y ?? -1e4, l?.pos.z ?? 0, l ? eff : 0);
        if (l) u.akFloodDir.value[k].copy(l.dir);
      }
    });
  }

  /** Hand the real lights straight to the poles nearest (x, z), with no cross-fade (warm-up views). */
  snap(x: number, z: number) {
    // The first pass releases slots, the second assigns and lights them.
    this.update(x, z, 1);
    this.update(x, z, 1);
  }

  /**
   * Open the shadow-casting floodlight over a circle of radius r around (cx, cz) for one warm-up
   * frame, so every kind of shadow caster compiles its depth shader. Returns the undo.
   */
  wideShadow(cx: number, cz: number, r: number): () => void {
    const l = this.shadow?.light;
    if (!l) return () => {};
    const cam = l.shadow.camera;
    const was = { angle: l.angle, distance: l.distance, far: cam.far, pos: l.position.clone(), aim: l.target.position.clone() };
    const h = Math.max(40, r * 0.25);
    l.position.set(cx, h, cz);
    l.target.position.set(cx, 0, cz);
    l.target.updateMatrixWorld();
    l.angle = Math.min(1.45, Math.atan2(r, h));
    l.distance = 0; // the shadow camera keeps its own far plane
    cam.far = Math.hypot(r, h) + 20;
    return () => {
      l.angle = was.angle;
      l.distance = was.distance;
      cam.far = was.far;
      l.position.copy(was.pos);
      l.target.position.copy(was.aim);
    };
  }

  dispose() {
    for (const s of this.slots()) s.light.dispose();
    this.glare?.geometry.dispose();
    this.cones?.geometry.dispose();
    this.cones?.dispose();
    this.coneMat.dispose();
    this.glareMat.map?.dispose();
    this.glareMat.dispose();
    this.baked?.dispose();
    this.empty.dispose();
    state.uniforms.akFloodMap.value = null;
  }
}
