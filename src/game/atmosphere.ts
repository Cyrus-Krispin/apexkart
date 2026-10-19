// Time of day: sky, fog, sun or moon, fill light and, at night, the circuit floodlights.
import * as THREE from 'three';
import { makeNightSky, makeSky, NIGHT_SKY, SKY } from './sky';
import { Floodlights, floodlit, type Lamp, type RigOptions } from './floodlights';
import type { Quality, RenderPipeline } from './render';
import { sunPosition } from './sun';

export type TimeOfDay = 'day' | 'night';
/** The player's setting: a fixed time of day, or "live" (whatever it is at the circuit right now). */
export type TimePref = TimeOfDay | 'live';

export function timePref(): TimePref {
  const v = localStorage.getItem('ak:time');
  return v === 'day' || v === 'night' ? v : 'live';
}

export function saveTimePref(t: TimePref) {
  localStorage.setItem('ak:time', t);
}

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
}

const PRESETS: Record<TimeOfDay, Preset> = {
  // Golden-hour sun from the side for long, readable shadows.
  day: {
    dir: new THREE.Vector3(0.55, 0.5, 0.35).normalize(),
    key: [0xffe2bd, 3.1],
    hemi: [0xcfe0f2, 0x6a5a42, 0.8],
    fog: [SKY.horizon, 340, 1800],
    exposure: 1.05,
    env: 0.55,
    bloom: { strength: 0.32, radius: 0.45, threshold: 0.93 },
    lampHeads: 0.6,
  },
  // Dim moonlight and a low blue fill; the floodlights do the real work.
  night: {
    dir: new THREE.Vector3(-0.35, 0.72, -0.6).normalize(),
    key: [0xa8bcff, 0.32],
    hemi: [0x3a4a70, 0x15130f, 0.42],
    fog: [NIGHT_SKY.horizon, 180, 1400],
    exposure: 1.1,
    env: 0.35,
    bloom: { strength: 0.62, radius: 0.55, threshold: 1.1 },
    lampHeads: 16,
  },
};

// Real lights only add what the baked pools can't (light on the kart, nearby walls,
// the floodlight shadow), so a few are enough. One shadow caster, none on Low.
const RIGS: Record<Quality, RigOptions> = {
  high: { pool: 3, shadow: 2048, glare: 0.55 },
  medium: { pool: 2, shadow: 1024, glare: 0.65 },
  low: { pool: 2, shadow: 0, glare: 0.9 },
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
    this.setShadowSize();
    scene.add(this.hemi, this.key, this.key.target);
    // A subtle kart headlight so the next braking point is never pitch black.
    this.headlight.position.set(0, 0.75, 0.55);
    this.headlight.target.position.set(0, 0, 16);
    kart.add(this.headlight.target);
    this.flood = new Floodlights(RIGS[this.quality]);
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
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
  }

  /** Follow the kart: keep the sun's shadow box centred on it and the real floodlights nearby. */
  update(x: number, z: number, dt: number) {
    const d = this.dir;
    this.key.position.set(x + d.x * 100, d.y * 100, z + d.z * 100);
    this.key.target.position.set(x, 0, z);
    if (this.time === 'night') this.flood.update(x, z, dt);
  }

  dispose() {
    this.flood.dispose();
    this.headlight.dispose();
    Floodlights.setNight(false);
  }
}
