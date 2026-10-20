// Time of day: sky, fog, sun or moon, fill light and, at night, the circuit floodlights.
import * as THREE from 'three';
import { driftSky, makeNightSky, makeSky, NIGHT_SKY, setHillsLook, SKY } from './sky';
import { Floodlights, floodlit, type Lamp, type RigOptions } from './floodlights';
import type { Quality, RenderPipeline } from './render';
import { sunPosition } from './sun';

import type { TimeOfDay, TimePref } from './prefs';

export { saveTimePref, timePref, type TimeOfDay, type TimePref } from './prefs';

/**
 * The look for a setting at a circuit. "Live" puts the sun where it really is (kept between 12°
 * and 62° so shadows stay readable) and turns the floodlights on once it's 4° below the horizon.
 */
export function resolveTime(pref: TimePref, center: [number, number], date = new Date()): { time: TimeOfDay; sun: THREE.Vector3 | null } {
  if (pref !== 'live') return { time: pref, sun: null };
  const { elevation, azimuth } = sunPosition(center[0], center[1], date);
  if (elevation < -4) return { time: 'night', sun: null };
  const el = (Math.min(62, Math.max(12, elevation)) * Math.PI) / 180;
  const az = (azimuth * Math.PI) / 180;
  // World axes: +x east, +z south (see game/track.ts).
  return { time: 'day', sun: new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)) };
}

interface Preset {
  dir: THREE.Vector3; // towards the sun or moon
  key: [number, number]; // colour, intensity
  hemi: [number, number, number]; // sky, ground, intensity
  fog: [THREE.Color, number, number];
  exposure: number;
  env: number;
  bloom: { strength: number; radius: number; threshold: number };
  lampHeads: number; // floodlight lens emissive intensity
  blob: number; // opacity of the soft shadow under the kart
}

const PRESETS: Record<TimeOfDay, Preset> = {
  // Golden-hour sun from the side for long, readable shadows. Warm key, cool sky fill and a green
  // bounce from the grass: warm light against cool shadows is what gives the stylised look its depth.
  day: {
    dir: new THREE.Vector3(0.55, 0.5, 0.35).normalize(),
    key: [0xfff0d6, 3.4],
    hemi: [0xbcd4f0, 0x5b6b3a, 0.8],
    fog: [SKY.horizon, 340, 1800],
    exposure: 1,
    env: 0.55,
    bloom: { strength: 0.32, radius: 0.45, threshold: 0.93 },
    lampHeads: 0.6,
    blob: 0.5,
  },
  // Dim moonlight and a low blue fill; the floodlights do the real work.
  night: {
    dir: new THREE.Vector3(-0.35, 0.72, -0.6).normalize(),
    key: [0xa8bcff, 0.32],
    hemi: [0x3a4a70, 0x15130f, 0.42],
    fog: [NIGHT_SKY.horizon, 180, 1400],
    exposure: 1, // Neutral keeps more of the midtones than ACES did: no need to push it
    env: 0.35,
    bloom: { strength: 0.62, radius: 0.55, threshold: 1.1 },
    lampHeads: 16,
    blob: 0.6,
  },
};

// Real lights only add what the baked pools can't (light on the kart, nearby walls,
// the floodlight shadow), so a few are enough. One shadow caster, none on Low.
const RIGS: Record<Quality, RigOptions> = {
  high: { pool: 3, shadow: 2048, glare: 0.55, cones: true },
  medium: { pool: 2, shadow: 1024, glare: 0.65, cones: true },
  low: { pool: 2, shadow: 0, glare: 0.9, cones: false },
};

export class Atmosphere {
  time: TimeOfDay;
  private sun: THREE.Vector3 | null = null; // real sun direction in "Live"; null = the preset's
  private sky: THREE.Mesh | null = null;
  private hemi = new THREE.HemisphereLight();
  /** Sun by day (the one shadow caster), moon by night. */
  private key = new THREE.DirectionalLight();
  private headlight = new THREE.SpotLight(0xfff0dc, 160, 40, 0.42, 0.75, 1.3);
  private flood: Floodlights;
  /** A soft dark blob under the kart that seats it on the ground on every tier (one quad). */
  private blob: THREE.Mesh;
  private lampHeads: THREE.MeshStandardMaterial[] = [];
  private quality: Quality;

  constructor(
    private scene: THREE.Scene,
    private pipeline: RenderPipeline,
    private kart: THREE.Object3D,
    time: TimeOfDay,
    sun: THREE.Vector3 | null = null,
  ) {
    this.time = time;
    this.sun = sun;
    this.quality = pipeline.quality;
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -38;
    sc.right = sc.top = 38;
    sc.near = 10;
    sc.far = 320;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.03;
    // Shadows keep some of the sky's colour instead of going grey-black.
    this.key.shadow.intensity = 0.85;
    this.setShadowSize();
    scene.add(this.hemi, this.key, this.key.target);
    // A subtle kart headlight so the next braking point is never pitch black.
    this.headlight.position.set(0, 0.75, 0.55);
    this.headlight.target.position.set(0, 0, 16);
    kart.add(this.headlight.target);
    this.flood = new Floodlights(RIGS[this.quality]);
    this.blob = kartBlob();
    kart.add(this.blob);
    this.set(time, sun);
  }

  private get dir() {
    return (this.time === 'day' && this.sun) || PRESETS[this.time].dir;
  }

  /** Switch the whole look. Light counts change, so materials recompile once. */
  set(time: TimeOfDay, sun: THREE.Vector3 | null = null) {
    this.time = time;
    this.sun = sun;
    const p = PRESETS[time];
    const night = time === 'night';
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
    }
    this.sky = night ? makeNightSky(this.dir) : makeSky(this.dir);
    this.scene.add(this.sky);
    setHillsLook(night, this.dir);
    this.scene.fog = new THREE.Fog(p.fog[0], p.fog[1], p.fog[2]);
    this.hemi.color.set(p.hemi[0]);
    this.hemi.groundColor.set(p.hemi[1]);
    this.hemi.intensity = p.hemi[2];
    this.key.color.set(p.key[0]);
    this.key.intensity = p.key[1];
    this.key.castShadow = !night;
    this.pipeline.renderer.toneMappingExposure = p.exposure;
    this.pipeline.setBloom(p.bloom);
    this.pipeline.bakeEnvironment(this.sky, p.env);
    this.lampHeads.forEach((m) => (m.emissiveIntensity = p.lampHeads));
    (this.blob.material as THREE.MeshBasicMaterial).opacity = p.blob;

    Floodlights.setNight(night);
    if (night) {
      this.scene.add(this.flood.group);
      this.kart.add(this.headlight);
    } else {
      this.scene.remove(this.flood.group);
      this.kart.remove(this.headlight);
    }
    this.recompile();
  }

  private recompile() {
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
    });
  }

  /** Register a freshly built world: floodlight poles and the materials their pools should light. */
  setWorld(roots: THREE.Object3D[], lamps: Lamp[], lampHeads: THREE.MeshStandardMaterial[]) {
    roots.forEach((r) => floodlit(r));
    this.flood.setLamps(lamps);
    this.lampHeads = lampHeads;
    lampHeads.forEach((m) => (m.emissiveIntensity = PRESETS[this.time].lampHeads));
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.setShadowSize();
    this.flood.setRig(RIGS[q]);
    if (this.time === 'night') this.recompile(); // new light count
  }

  private setShadowSize() {
    const s = this.quality === 'low' ? 1024 : 2048;
    this.key.shadow.mapSize.set(s, s);
    // r186's PCF: 5 rotated taps of hardware 2x2 PCF over this many texels. Soft edges, same cost.
    this.key.shadow.radius = this.quality === 'low' ? 1.5 : 2.5;
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
  }

  private snapX = new THREE.Vector3();
  private snapY = new THREE.Vector3();
  private snapP = new THREE.Vector3();

  /**
   * Follow the kart: keep the sun's shadow box centred on it and the real floodlights nearby.
   * The box moves in whole shadow-map texels (in the light's own frame), so shadow edges stay put
   * on the ground while you drive instead of crawling and shimmering.
   */
  update(x: number, z: number, dt: number) {
    if (this.sky) driftSky(this.sky, dt);
    const d = this.dir; // unit, towards the sun: the shadow camera looks along -d with +y up
    const sx = this.snapX.set(0, 1, 0).cross(d).normalize();
    const sy = this.snapY.copy(d).cross(sx);
    const sc = this.key.shadow.camera;
    const texel = (sc.right - sc.left) / this.key.shadow.mapSize.x;
    const p = this.snapP.set(x, 0, z);
    const u = p.dot(sx);
    const v = p.dot(sy);
    p.addScaledVector(sx, Math.round(u / texel) * texel - u).addScaledVector(sy, Math.round(v / texel) * texel - v);
    this.key.target.position.copy(p);
    this.key.position.copy(p).addScaledVector(d, 100);
    if (this.time === 'night') this.flood.update(x, z, dt);
  }

  /** Jump straight to (x, z): shadow box and floodlights, no cross-fade (warm-up views and back). */
  snap(x: number, z: number) {
    this.update(x, z, 0);
    if (this.time === 'night') this.flood.snap(x, z);
  }

  /**
   * Open the shadow camera (the sun by day, the shadow floodlight at night) over a circle of
   * radius r for one warm-up frame, so every kind of caster compiles its shadow shader whatever
   * the warm-up views happen to frame. Returns the undo; the next update() re-centres it.
   */
  wideShadows(cx: number, cz: number, r: number): () => void {
    if (this.time === 'night') return this.flood.wideShadow(cx, cz, r);
    const sc = this.key.shadow.camera;
    const was = [sc.left, sc.right, sc.top, sc.bottom, sc.near, sc.far] as const;
    const d = this.dir;
    const back = r + 60;
    this.key.position.set(cx + d.x * back, d.y * back, cz + d.z * back);
    this.key.target.position.set(cx, 0, cz);
    sc.left = sc.bottom = -r;
    sc.right = sc.top = r;
    sc.near = 1;
    sc.far = back + r + 60;
    sc.updateProjectionMatrix();
    return () => {
      [sc.left, sc.right, sc.top, sc.bottom, sc.near, sc.far] = was;
      sc.updateProjectionMatrix();
    };
  }

  /**
   * Night: put another tier's light rig up for a moment (to compile its shaders), and return
   * the undo. The caller must undo before the next frame renders.
   */
  useRig(q: Quality): () => void {
    if (this.time !== 'night' || q === this.quality) return () => {};
    this.flood.setRig(RIGS[q]);
    return () => this.flood.setRig(RIGS[this.quality]);
  }

  dispose() {
    this.blob.removeFromParent();
    this.blob.geometry.dispose();
    const bm = this.blob.material as THREE.MeshBasicMaterial;
    bm.alphaMap?.dispose();
    bm.dispose();
    this.flood.dispose();
    this.headlight.dispose();
    Floodlights.setNight(false);
  }
}

/** The kart's contact shadow: a soft ellipse on a quad just above the road, black with an alpha ramp. */
function kartBlob(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.45, '#c8c8c8');
  grd.addColorStop(1, '#000000');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    alphaMap: tex,
    transparent: true,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 2.2).rotateX(-Math.PI / 2), mat);
  mesh.position.set(0, 0.045, 0.05); // just above the asphalt (0.04); the kart's nose is +z
  mesh.renderOrder = -0.5; // before the other see-through things (ghosts, glare)
  mesh.name = 'kart-blob';
  return mesh;
}
