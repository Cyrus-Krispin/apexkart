import * as THREE from 'three';
import { TrackModel } from './track';
import { buildTrackScene, type TrackScene } from './trackMesh';
import { buildKart, KartPhysics, type KartVisual } from './kart';
import { Input } from './input';
import { KartAudio } from './audio';
import { Atmosphere, initialTimeOfDay, saveTimeOfDay, type TimeOfDay } from './atmosphere';
import { floodlit } from './floodlights';
import { RenderPipeline, autoQuality, initialQuality, type Quality, type QualitySetting } from './render';
import { buildWorld, initialStyle, type World, type WorldStyle } from './world';
import { Hud, type SectorColor } from './hud';
import { RaceIntro } from '../ui/intro';
import { rotationLabel } from '../ui/trackArt';
import { analyzeShape } from '../track/shape';
import { decodeGhost, encodeGhost, sampleGhost, GHOST_DT, type GhostData, type GhostFrame } from '../shared/ghost';
import type { TrackData } from '../track/osm';
import { api, type BoardResponse, type Dir, type Driver } from '../net/api';
import { gridPose, type RaceContext, type RaceMode } from './raceMode';

export interface RaceOptions {
  track: TrackData;
  dir: Dir;
  driver: Driver;
  container: HTMLElement;
  onExit: () => void;
  /** Multiplayer and other add-ons (src/game/raceMode.ts). Omit for a time trial. */
  mode?: RaceMode;
}

interface LocalPB {
  ms: number;
  sectors: number[];
  splits: number[]; // lap time (ms) at every SPLIT metres
  ghost: GhostData;
  synced?: boolean;
}

interface Ghost {
  key: string;
  label: string;
  color: string;
  frames: GhostFrame[];
  dt: number;
  visual: KartVisual;
  tag: HTMLDivElement;
}

const STEP = 1 / 120;
const SPLIT = 10;
const CAMS = [
  { id: 'chase', label: 'Chase' },
  { id: 'far', label: 'Far chase' },
  { id: 'hood', label: 'Cockpit' },
  { id: 'tv', label: 'TV' },
] as const;

type State = 'intro' | 'grid' | 'racing' | 'paused';
const SYNC_GO = 4.4; // with a synchronised start (mode.startAt), lights go out this long into the grid phase

export class Race {
  private pipeline: RenderPipeline;
  private scene = new THREE.Scene();
  private qualitySetting: QualitySetting = initialQuality();
  private style: WorldStyle = initialStyle();
  private world: World | null = null;
  private atmos!: Atmosphere;
  private frameTimes: number[] = [];
  private camera = new THREE.PerspectiveCamera(62, 1, 0.1, 5000);
  private track: TrackModel;
  private trackScene!: TrackScene;
  private kart: KartVisual;
  private phys: KartPhysics;
  private input: Input;
  private audio = new KartAudio();
  private ground!: THREE.Mesh;
  private root: HTMLElement;
  private hud: Hud;
  private intro: RaceIntro;
  private raf = 0;
  private lastFrame = 0;
  private acc = 0;
  private disposed = false;

  // race state
  private state: State = 'intro';
  private prevState: Exclude<State, 'paused'> = 'intro';
  private simT = 0;
  private realT = 0;
  private gridT = 0;
  private goAt = 0;
  private goTime = 0;
  private lightsLit = 0;
  private lapStart: number | null = null;
  private lapNo = 0;
  private lastS = 0;
  private sectorsHit = [false, false];
  private sectorTimes: number[] = [];
  private sectorColors: SectorColor[] = [];
  private invalid = false;
  private wrongWayT = 0;
  private ghostRec: GhostFrame[] = [];
  private splits: number[] = [];
  private sessionBest: number | null = null;
  private lapsDone = 0;
  private validLaps = 0;
  private pb: LocalPB | null;
  private pbKey: string;
  private bestSectors: number[];
  private camMode = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private showGhosts = localStorage.getItem('ak:ghosts') !== '0';
  private ghosts: Ghost[] = [];
  private board: BoardResponse | null = null;
  private boardTimer = 0;
  private hintShown = false;
  private throttle = 0;
  private nextSyncAt = 0;
  private minimap!: { bg: HTMLCanvasElement; map: (x: number, z: number) => [number, number] };
  private skid!: { geo: THREE.BufferGeometry; pos: Float32Array; i: number; prev: (THREE.Vector3 | null)[] };
  autopilot = false;

  constructor(private opts: RaceOptions) {
    this.track = new TrackModel(opts.track, opts.dir === 'rev');
    const shape = analyzeShape(opts.track.points);
    const rot = rotationLabel(shape, opts.dir === 'rev');
    this.pbKey = `ak:pb:${opts.track.id}:${opts.dir}`;
    if (opts.mode?.ghosts === false) this.showGhosts = false;
    this.pb = this.loadPB();
    this.bestSectors = this.pb?.sectors.slice() ?? [];

    this.root = document.createElement('div');
    this.root.className = 'race';
    opts.container.appendChild(this.root);

    this.pipeline = new RenderPipeline(this.scene, this.camera, this.qualitySetting === 'auto' ? autoQuality() : this.qualitySetting);
    this.root.appendChild(this.pipeline.renderer.domElement);

    this.hud = new Hud(this.root, { trackName: opts.track.name, dirLabel: rot.label, dirIcon: rot.icon, color: opts.driver.color }, (a) => this.action(a));
    this.hud.setVisible(false);
    this.hud.best(this.pb?.ms ?? null);
    this.syncToggles();

    this.input = new Input(this.hud.touch);
    this.phys = new KartPhysics(this.track);
    this.kart = buildKart(opts.driver.color, { number: 7 });
    this.scene.add(this.kart.root);

    this.intro = new RaceIntro({
      container: this.root,
      track: opts.track,
      shape,
      dir: opts.dir,
      driver: opts.driver,
      pb: this.pb?.ms ?? null,
      time: opts.mode?.time ?? initialTimeOfDay(),
      onTime: (t) => this.setTime(t),
      onStart: () => this.begin(),
      onBack: () => opts.onExit(),
    });

    this.buildWorld();
    this.syncToggles();
    this.buildMinimap();
    this.buildSkids();
    this.resetToGrid();
    this.state = 'intro';
    this.applyMode();

    addEventListener('resize', this.onResize);
    this.onResize();
    if (import.meta.env.DEV) (window as any).__race = this;
    this.refreshBoard();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ setup

  private buildWorld() {
    const s = this.scene;
    this.pipeline.setQuality(this.pipeline.quality);
    // Sky, fog, sun or moon, and the floodlights at night.
    this.atmos = new Atmosphere(s, this.pipeline, this.kart.root, this.opts.mode?.time ?? initialTimeOfDay());

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x7da457 }));
    this.ground.position.y = -0.08;
    this.ground.receiveShadow = true;
    s.add(this.ground);

    const aniso = this.pipeline.renderer.capabilities.getMaxAnisotropy();
    this.trackScene = buildTrackScene(this.track, aniso);
    s.add(this.trackScene.group);
    floodlit(this.ground);
    floodlit(this.trackScene.group);
    this.rebuildWorld();
  }

  private async rebuildWorld() {
    if (this.world) {
      this.scene.remove(this.world.group);
      disposeTree(this.world.group);
      this.world = null;
    }
    const world = await buildWorld({
      track: this.track,
      data: this.opts.track,
      style: this.style,
      quality: this.pipeline.quality,
      aniso: this.pipeline.renderer.capabilities.getMaxAnisotropy(),
      onStage: (label, f) => this.intro.stage(label, f),
      isDisposed: () => this.disposed,
    }).catch((e) => {
      console.error(e);
      this.intro.failed();
      return null;
    });
    if (!world || this.disposed) return;
    this.world = world;
    this.scene.add(world.group);
    this.atmos.setWorld([world.group], world.lamps, world.emissive);
    (this.ground.material as THREE.MeshLambertMaterial).color.copy(world.groundColor);
    await this.warmShaders();
  }

  /** Compile every shader now (including a ghost kart's) so nothing compiles mid-lap. */
  private async warmShaders() {
    const warm = this.ghostVisual(this.opts.driver.color).root;
    warm.position.set(this.phys.x, -50, this.phys.z);
    this.scene.add(warm);
    try {
      await this.pipeline.renderer.compileAsync(this.scene, this.camera);
    } catch {
      /* best effort */
    }
    this.scene.remove(warm);
  }

  private buildMinimap() {
    const canvas = this.hud.minimap;
    const size = 360;
    canvas.width = canvas.height = size;
    const t = this.track;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < t.n; i++) {
      minX = Math.min(minX, t.px[i]);
      maxX = Math.max(maxX, t.px[i]);
      minZ = Math.min(minZ, t.pz[i]);
      maxZ = Math.max(maxZ, t.pz[i]);
    }
    const scale = (size - 56) / Math.max(maxX - minX, maxZ - minZ);
    const ox = (size - (maxX - minX) * scale) / 2;
    const oz = (size - (maxZ - minZ) * scale) / 2;
    const map = (x: number, z: number): [number, number] => [ox + (x - minX) * scale, oz + (z - minZ) * scale];
    const bg = document.createElement('canvas');
    bg.width = bg.height = size;
    const g = bg.getContext('2d')!;
    g.lineJoin = g.lineCap = 'round';
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= t.n; i += 2) {
        const [x, y] = map(t.px[i % t.n], t.pz[i % t.n]);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
    };
    path();
    g.strokeStyle = 'rgba(242,238,229,0.16)';
    g.lineWidth = 18;
    g.stroke();
    path();
    g.strokeStyle = '#f2eee5';
    g.lineWidth = 6;
    g.stroke();
    for (const frac of [1 / 3, 2 / 3]) {
      const i = Math.floor(frac * t.n);
      const [x, y] = map(t.px[i], t.pz[i]);
      const [nx, nz] = t.normal(i);
      g.strokeStyle = '#ff4d00';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x - nx * 11, y - nz * 11);
      g.lineTo(x + nx * 11, y + nz * 11);
      g.stroke();
    }
    // Chequered start line
    {
      const [x, y] = map(t.px[0], t.pz[0]);
      const [nx, nz] = t.normal(0);
      g.save();
      g.translate(x, y);
      g.rotate(Math.atan2(nz, nx));
      for (let k = -3; k < 3; k++)
        for (let r = 0; r < 2; r++) {
          g.fillStyle = (k + r) % 2 ? '#141414' : '#ffffff';
          g.fillRect(k * 4, -4 + r * 4, 4, 4);
        }
      g.restore();
    }
    this.minimap = { bg, map };
  }

  private buildSkids() {
    const max = 3000;
    const pos = new Float32Array(max * 6 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.skid = { geo, pos, i: 0, prev: [null, null] };
  }

  // ------------------------------------------------------------------ flow

  private begin() {
    this.audio.start();
    this.hud.setVisible(true);
    this.resetToGrid();
  }

  private action(a: string) {
    if (a === 'resume') this.togglePause(false);
    if (a === 'restart') {
      this.togglePause(false);
      this.resetToGrid();
    }
    if (a === 'exit') this.opts.onExit();
    if (a === 'pause') this.togglePause();
    if (a === 'mute') this.audio.toggleMute();
    if (a === 'ghosts') this.toggleGhosts();
    if (a === 'cam') this.camMode = (this.camMode + 1) % CAMS.length;
    if (a === 'quality') {
      const order: QualitySetting[] = ['auto', 'high', 'medium', 'low'];
      this.qualitySetting = order[(order.indexOf(this.qualitySetting) + 1) % order.length];
      localStorage.setItem('ak:quality', this.qualitySetting);
      this.applyQuality(this.qualitySetting === 'auto' ? autoQuality() : this.qualitySetting);
    }
    if (a === 'style') {
      this.style = this.style === 'stylised' ? 'satellite' : 'stylised';
      localStorage.setItem('ak:style', this.style);
      this.hud.toast(this.style === 'stylised' ? 'Stylised world' : 'Satellite world');
      this.rebuildWorld();
    }
    if (a === 'time') this.setTime(this.atmos.time === 'day' ? 'night' : 'day', true);
    this.syncToggles();
  }

  private setTime(t: TimeOfDay, toast = false) {
    if (t === this.atmos.time || this.opts.mode?.time) return; // a shared session's time is fixed
    saveTimeOfDay(t);
    this.atmos.set(t); // light counts change, so every material recompiles
    if (this.world) this.warmShaders();
    if (toast) this.hud.toast(t === 'night' ? 'Night session · floodlights on' : 'Day session');
    this.syncToggles();
  }

  private applyQuality(q: Quality) {
    if (q === this.pipeline.quality) return;
    this.pipeline.setQuality(q);
    this.atmos.setQuality(q);
    if (this.world && this.atmos.time === 'night') this.warmShaders();
  }

  private syncToggles() {
    const q = this.qualitySetting === 'auto' ? `Auto · ${this.pipeline.quality}` : this.qualitySetting;
    this.hud.toggles({ muted: this.audio.muted, ghosts: this.showGhosts, cam: CAMS[this.camMode].label, quality: q, style: this.style === 'stylised' ? 'Stylised' : 'Satellite', night: this.atmos?.time === 'night' });
  }

  private resetToGrid() {
    const g = gridPose(this.track, this.opts.mode?.gridSlot);
    this.phys.place(g.s);
    this.phys.x = g.x;
    this.phys.z = g.z;
    this.lastS = this.phys.s = g.s;
    this.state = 'grid';
    this.gridT = 0;
    this.goAt = this.opts.mode?.startAt !== undefined ? SYNC_GO : 3.6 + 0.4 + Math.random() * 0.9;
    this.lightsLit = 0;
    this.lapStart = null;
    this.lapNo = 0;
    this.invalid = false;
    this.hintShown = false;
    this.trackScene.lights.forEach((m) => (m.emissiveIntensity = 0));
    this.hud.lights(0);
    this.hud.lap(null);
    this.hud.lapTime(0, false);
    this.hud.delta(null);
    this.hud.sectors([], [], -1, 0);
    this.hud.coach(true);
    this.snapCamera();
  }

  private togglePause(force?: boolean) {
    if (this.state === 'intro') return;
    const pause = force ?? this.state !== 'paused';
    if (pause && this.state !== 'paused') {
      this.prevState = this.state as Exclude<State, 'paused'>;
      this.state = 'paused';
      this.audio.silence();
      const mine = this.board?.entries.find((e) => e.pid === this.opts.driver.pid);
      this.hud.pause(true, {
        laps: this.lapsDone,
        valid: this.validLaps,
        best: this.sessionBest,
        pb: this.pb?.ms ?? null,
        rank: mine?.rank ?? null,
        total: this.board?.total ?? 0,
      });
    } else if (!pause && this.state === 'paused') {
      this.state = this.prevState;
      this.hud.pause(false);
    }
  }

  private toggleGhosts() {
    this.showGhosts = !this.showGhosts;
    localStorage.setItem('ak:ghosts', this.showGhosts ? '1' : '0');
    this.hud.toast(this.showGhosts ? 'Ghosts on' : 'Ghosts off');
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.realT += dt;

    if (this.state !== 'intro') {
      if (this.input.consume('Escape') || this.input.consume('p')) this.togglePause();
      if (this.input.consume('c')) this.action('cam');
      if (this.input.consume('m')) this.action('mute');
      if (this.input.consume('g')) this.action('ghosts');
      if (this.input.consume('r') && this.state === 'racing') this.recover();
    } else {
      // Keys pressed on the intro screen shouldn't leak into the race.
      ['Escape', 'p', 'c', 'm', 'g', 'r'].forEach((k) => this.input.consume(k));
    }

    if (this.state === 'grid' || this.state === 'racing') {
      this.acc += dt;
      while (this.acc >= STEP) {
        this.prev.x = this.phys.x;
        this.prev.z = this.phys.z;
        this.prev.h = this.phys.heading;
        this.tick(STEP);
        this.acc -= STEP;
      }
      this.alpha = this.acc / STEP;
    } else {
      this.alpha = 1;
    }
    this.boardTimer -= dt;
    if (this.boardTimer <= 0) this.refreshBoard();
    this.render(dt);
    this.adaptQuality(dt);
  };

  /** In auto mode, step quality down if the frame rate can't keep up. */
  private adaptQuality(dt: number) {
    if (this.qualitySetting !== 'auto' || this.state !== 'racing' || document.hidden) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 120) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    this.frameTimes = [];
    // Step down on a low average *or* on frequent spikes (the spikes are what read as stutter).
    if ((p50 > 1 / 45 || p90 > 1 / 30) && this.pipeline.quality !== 'low') {
      this.applyQuality(this.pipeline.quality === 'high' ? 'medium' : 'low');
      this.syncToggles();
    }
  }

  private tick(dt: number) {
    const c = this.autopilot ? this.autoControls() : this.input.read(dt);
    if (this.state === 'grid') {
      const syncAt = this.opts.mode?.startAt;
      this.gridT = syncAt !== undefined ? this.goAt - (syncAt - performance.now()) / 1000 : this.gridT + dt;
      const lit = Math.min(5, Math.floor((this.gridT - 0.9) / 0.7) + 1);
      if (lit > this.lightsLit && this.gridT >= 0.9) {
        this.lightsLit = lit;
        this.trackScene.lights.forEach((m, k) => (m.emissiveIntensity = k < lit ? 4 : 0));
        this.hud.lights(lit);
        this.audio.beep(false);
      }
      if (this.gridT >= this.goAt) {
        this.state = 'racing';
        this.goTime = this.simT;
        this.trackScene.lights.forEach((m) => (m.emissiveIntensity = 0));
        this.hud.lights(null);
        this.audio.beep(true);
        this.hud.banner('Go', 'go', 1.1);
        this.hud.coach(true, 6000);
      }
      c.throttle = c.brake = 0;
    }
    this.simT += dt;
    this.phys.step(dt, c);
    this.audio.update(this.phys.speed, c.throttle, this.phys.slip, this.phys.surface === 'grass');
    if (this.state === 'racing') this.timing(dt);
    this.updateSkids(c.drift);
    this.throttle = c.throttle;
    this.opts.mode?.addon?.tick?.(dt);
  }

  /** Pure-pursuit driver: steer at a look-ahead point, brake for curvature ahead. */
  private autoControls() {
    const p = this.phys;
    const t = this.track;
    const look = t.at(p.s + 5 + p.speed * 0.45);
    let ang = Math.atan2(look.x - p.x, look.z - p.z) - p.heading;
    ang = Math.atan2(Math.sin(ang), Math.cos(ang));
    let k = 0;
    for (let d = 0; d < 35; d += 2) k = Math.max(k, Math.abs(t.curv[t.at(p.s + d + p.speed * 0.3).i]));
    const vTarget = Math.min(p.vmax, Math.sqrt((2.1 * 9.81) / Math.max(k, 1e-3)));
    return { throttle: p.speed < vTarget ? 1 : 0, brake: p.speed > vTarget + 1.5 ? 1 : 0, steer: THREE.MathUtils.clamp(-ang * 3, -1, 1), drift: false };
  }

  private timing(dt: number) {
    const L = this.track.length;
    const s = this.phys.s;
    const prev = this.lastS;
    this.lastS = s;
    const crossedFwd = prev > L - 40 && s < 40;
    const crossedBack = prev < 40 && s > L - 40;

    if (!this.hintShown && this.lapStart === null && this.simT - this.goTime > 1.3) {
      this.hintShown = true;
      this.hud.banner('Cross the line to start the clock', 'info', 2.6);
    }
    if (crossedBack && this.lapStart !== null) this.invalidate('Reversed over the line');
    if (crossedFwd) {
      // Interpolate the exact crossing moment inside this step.
      const before = L - prev;
      const frac = before / Math.max(1e-6, before + s);
      const tCross = this.simT - dt + dt * frac;
      if (this.lapStart !== null) this.finishLap(tCross);
      this.lapStart = tCross;
      this.lapNo++;
      this.sectorsHit = [false, false];
      this.sectorTimes = [];
      this.sectorColors = [];
      this.invalid = false;
      this.ghostRec = [];
      this.splits = [];
      this.hud.lap(this.lapNo);
    }
    if (this.lapStart === null) return;

    const lapT = (this.simT - this.lapStart) * 1000;
    for (let k = 0; k < 2; k++) {
      const b = (L * (k + 1)) / 3;
      if (!this.sectorsHit[k] && prev < b && s >= b && s - prev < 30) {
        if (k === 1 && !this.sectorsHit[0]) this.invalidate('Missed a sector');
        this.sectorsHit[k] = true;
        const total = this.sectorTimes.reduce((a, x) => a + x, 0);
        const t = lapT - total;
        this.sectorTimes.push(t);
        this.sectorColors.push(this.sectorColor(k, t));
      }
    }
    if (!this.invalid && Math.abs(this.phys.offset) > this.track.halfWidth + 2.4) this.invalidate('Track limits');

    const t = this.track;
    const i = this.phys.hint;
    const along = this.phys.vx * t.tx[i] + this.phys.vz * t.tz[i];
    this.wrongWayT = along < -3 ? this.wrongWayT + dt : 0;
    if (this.wrongWayT > 1.2) this.hud.banner('Wrong way', 'warn', 0.4);

    while (this.ghostRec.length * GHOST_DT * 1000 <= lapT) this.ghostRec.push({ x: this.phys.x, z: this.phys.z, h: this.phys.heading });
    const si = Math.floor(s / SPLIT);
    if (s < L - 5) while (this.splits.length <= si) this.splits.push(lapT);
  }

  private sectorColor(k: number, t: number): SectorColor {
    const mine = this.bestSectors[k];
    const leader = this.board?.entries[0]?.sectors?.[k];
    if ((!mine || t <= mine) && (!leader || t <= leader)) return 'purple';
    if (!mine || t <= mine) return 'green';
    return 'yellow';
  }

  private invalidate(reason: string) {
    if (this.invalid || this.lapStart === null) return;
    this.invalid = true;
    this.hud.banner(`Lap invalid · ${reason}`, 'warn', 2);
  }

  private recover() {
    this.phys.place(this.phys.s);
    this.invalidate('Reset');
    this.snapCamera();
  }

  private finishLap(tCross: number) {
    const ms = Math.round((tCross - (this.lapStart ?? tCross)) * 1000);
    const s1 = Math.round(this.sectorTimes[0] ?? 0);
    const s2 = Math.round(this.sectorTimes[1] ?? 0);
    const sectors = this.sectorTimes.length === 2 ? [s1, s2, ms - s1 - s2] : [];
    const valid = !this.invalid && this.sectorsHit[0] && this.sectorsHit[1] && sectors.length === 3;
    this.lapsDone++;
    this.hud.last(ms, valid);
    if (!valid) {
      this.hud.lapCard({ lap: this.lapNo, ms, valid: false, delta: null, sectors: [], colors: [], pb: false });
      return;
    }
    this.validLaps++;
    const colors = [...this.sectorColors, this.sectorColor(2, sectors[2])];
    sectors.forEach((v, k) => {
      if (!this.bestSectors[k] || v < this.bestSectors[k]) this.bestSectors[k] = v;
    });
    if (this.sessionBest === null || ms < this.sessionBest) this.sessionBest = ms;

    const prevPb = this.pb?.ms ?? null;
    const isPb = prevPb === null || ms < prevPb;
    this.hud.lapCard({ lap: this.lapNo, ms, valid: true, delta: prevPb === null ? null : (ms - prevPb) / 1000, sectors, colors, pb: isPb });
    if (isPb) {
      this.ghostRec.push({ x: this.phys.x, z: this.phys.z, h: this.phys.heading });
      this.pb = { ms, sectors, splits: this.splits.slice(), ghost: encodeGhost(this.ghostRec) };
      this.savePB();
      this.hud.best(ms);
      this.hud.banner(prevPb === null ? 'First timed lap' : 'Personal best', 'pb', 2.2);
      this.setGhost('pb', 'Your best', this.opts.driver.color, this.pb.ghost);
      this.nextSyncAt = 0;
      this.submit();
    }
  }

  private async submit() {
    if (!this.pb || performance.now() < this.nextSyncAt) return;
    this.nextSyncAt = performance.now() + 30000; // also blocks overlapping submits
    const d = this.opts.driver;
    try {
      const res = await api.submit({
        track: this.opts.track.id,
        dir: this.opts.dir,
        trackName: this.opts.track.name,
        trackLength: Math.round(this.track.length),
        center: this.opts.track.center,
        name: d.name,
        color: d.color,
        driverId: d.id,
        ms: this.pb.ms,
        sectors: this.pb.sectors,
        ghost: this.pb.ghost,
        points: this.opts.track.points,
        width: this.opts.track.width,
      });
      this.pb.synced = true;
      this.savePB();
      this.nextSyncAt = 0;
      if (res.improved) {
        this.hud.lapCardRank(res.rank, res.total);
        if (res.rank === 1) this.hud.toast('Fastest lap on the live board', 'gold');
      }
      this.refreshBoard();
    } catch (e) {
      const msg = (e as Error).message;
      if (/^(bad|lap too|ghost|sectors)/.test(msg)) {
        this.pb.synced = true;
        this.savePB();
        this.hud.toast(`Lap not accepted by the leaderboard: ${msg}`, 'warn');
      } else this.hud.toast('Leaderboard offline · lap saved on this device', 'warn');
    }
  }

  // ------------------------------------------------------------------ leaderboard + ghosts

  private async refreshBoard() {
    this.boardTimer = 4;
    if (this.opts.mode?.leaderboard === false) return;
    const d = this.opts.driver;
    try {
      const presence = this.state === 'intro' ? undefined : { pid: d.pid, name: d.name, color: d.color };
      const b = await api.board(this.opts.track.id, this.opts.dir, presence);
      if (this.disposed) return;
      this.board = b;
      this.hud.board(b, d.pid);
      if (this.pb && !this.pb.synced) {
        const mine = b.entries.find((e) => e.pid === d.pid);
        if (!mine || mine.ms > this.pb.ms) this.submit();
        else {
          this.pb.synced = true;
          this.savePB();
        }
      }
      this.syncBoardGhosts();
    } catch {
      this.hud.board(null, d.pid, true);
    }
  }

  private async syncBoardGhosts() {
    const me = this.opts.driver.pid;
    const top = (this.board?.entries ?? []).filter((e) => e.pid !== me).slice(0, 3);
    const wanted = new Set(top.map((e) => `${e.pid}:${e.ms}`));
    for (const g of this.ghosts.filter((g) => g.key !== 'pb' && !wanted.has(g.key))) this.removeGhost(g.key);
    if (this.pb && !this.ghosts.some((g) => g.key === 'pb')) this.setGhost('pb', 'Your best', this.opts.driver.color, this.pb.ghost);
    for (const e of top) {
      const key = `${e.pid}:${e.ms}`;
      if (this.ghosts.some((g) => g.key === key)) continue;
      this.ghosts.push({ key } as Ghost); // reserve to avoid duplicate fetches
      try {
        const r = await api.ghost(this.opts.track.id, this.opts.dir, e.pid);
        this.ghosts = this.ghosts.filter((g) => g.key !== key);
        if (r.ghost && !this.disposed) this.setGhost(key, `P${e.rank} ${e.name}`, e.color, r.ghost);
      } catch {
        this.ghosts = this.ghosts.filter((g) => g.key !== key);
      }
    }
  }

  private ghostTemplates = new Map<string, THREE.Group>();

  /** Ghost karts are cloned from one template per colour: shared geometry and materials, no rebuild hitch. */
  private ghostVisual(color: string): KartVisual {
    let tpl = this.ghostTemplates.get(color);
    if (!tpl) {
      tpl = buildKart(color, { ghost: true }).root;
      this.ghostTemplates.set(color, tpl);
    }
    const root = tpl.clone();
    return { root, body: root, frontPivots: [], wheels: [], materials: [] };
  }

  private setGhost(key: string, label: string, color: string, data: GhostData) {
    this.removeGhost(key);
    const visual = this.ghostVisual(color);
    this.scene.add(visual.root);
    const tag = document.createElement('div');
    tag.className = 'ghost-tag';
    const dot = document.createElement('i');
    dot.style.background = color;
    tag.append(dot, label);
    this.hud.tags.appendChild(tag);
    this.ghosts.push({ key, label, color, frames: decodeGhost(data), dt: data.dt, visual, tag });
  }

  private removeGhost(key: string) {
    const g = this.ghosts.find((x) => x.key === key);
    if (!g) return;
    if (g.visual) this.scene.remove(g.visual.root);
    g.tag?.remove();
    this.ghosts = this.ghosts.filter((x) => x !== g);
  }

  // ------------------------------------------------------------------ render

  private snapPrev() {
    this.prev.x = this.phys.x;
    this.prev.z = this.phys.z;
    this.prev.h = this.phys.heading;
  }

  private snapCamera() {
    this.snapPrev();
    this.camPos.set(this.phys.x - Math.sin(this.phys.heading) * 6, 2.6, this.phys.z - Math.cos(this.phys.heading) * 6);
    this.camLook.set(this.phys.x, 0.6, this.phys.z);
  }

  // Scratch objects reused every frame (no per-frame allocations, so no GC hitches).
  private readonly v = { fwd: new THREE.Vector3(), pos: new THREE.Vector3(), look: new THREE.Vector3(), tmp: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  private prev = { x: 0, z: 0, h: 0 };
  private alpha = 1; // how far between the last two physics steps this frame sits
  private viewW = 1;
  private viewH = 1;

  private render(dt: number) {
    const p = this.phys;
    const k = this.kart;
    // Interpolate between the previous and current physics state so motion is smooth
    // regardless of the display's refresh rate.
    const a = this.alpha;
    const x = this.prev.x + (p.x - this.prev.x) * a;
    const z = this.prev.z + (p.z - this.prev.z) * a;
    let dh = p.heading - this.prev.h;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const heading = this.prev.h + dh * a;
    k.root.position.set(x, 0, z);
    k.root.rotation.y = heading;
    k.body.rotation.z += (THREE.MathUtils.clamp(p.yawRate * p.forwardSpeed * 0.004, -0.07, 0.07) - k.body.rotation.z) * Math.min(1, dt * 8);
    k.body.rotation.x += ((this.throttle ? -0.012 : 0.01) - k.body.rotation.x) * Math.min(1, dt * 5);
    k.body.position.y = p.surface === 'grass' ? Math.sin(this.simT * 40) * 0.012 : p.surface === 'kerb' ? Math.sin(this.simT * 70) * 0.02 : 0;
    for (const f of k.frontPivots) f.rotation.y = -p.steerAngle * 1.2;
    for (const w of k.wheels) w.rotation.x = p.wheelSpin;

    const { fwd, pos, look, tmp, up } = this.v;
    fwd.set(Math.sin(heading), 0, Math.cos(heading));
    const mode = CAMS[this.camMode].id;
    let lerp = 1 - Math.exp(-dt * 7);
    if (this.state === 'intro') {
      // Slow cinematic orbit; tight so the camera stays on the circuit (real pit buildings often sit beside the grid).
      const ang = this.realT * 0.18 + 2.2;
      pos.set(x + Math.sin(ang) * 4.6, 1.45 + Math.sin(this.realT * 0.3) * 0.25, z + Math.cos(ang) * 4.6);
      look.set(x, 0.55, z);
      if (this.viewW > 900) {
        // Frame the kart in the open right half, clear of the intro panel.
        tmp.copy(look).sub(pos).normalize().cross(up).normalize();
        look.addScaledVector(tmp, -2.4);
      }
      lerp = 1;
    } else if (mode === 'hood') {
      pos.set(x, 1.12, z).addScaledVector(fwd, 0.1);
      look.set(x, 0.9, z).addScaledVector(fwd, 10);
      lerp = 1;
    } else if (mode === 'tv') {
      pos.set(x, 34, z).addScaledVector(fwd, -18);
      look.set(x, 0, z).addScaledVector(fwd, 6);
      lerp = 1 - Math.exp(-dt * 3);
    } else {
      const far = mode === 'far';
      pos.set(x, far ? 4.2 : 2.3, z).addScaledVector(fwd, far ? -9.5 : -5.2);
      look.set(x, 0.7, z).addScaledVector(fwd, 3.5);
    }
    this.camPos.lerp(pos, lerp);
    this.camLook.lerp(look, Math.min(1, lerp * 1.6));
    this.camera.position.copy(this.camPos);
    if (p.bump > 0.02) {
      this.camera.position.x += (Math.random() - 0.5) * p.bump * 0.4;
      this.camera.position.y += (Math.random() - 0.5) * p.bump * 0.3;
    }
    this.camera.lookAt(this.camLook);
    const fov = this.state === 'intro' ? 42 : (mode === 'hood' ? 70 : 60) + p.speed * 0.38;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
    }
    k.root.visible = mode !== 'hood' || this.state === 'intro';

    this.atmos.update(x, z, dt);

    // Ghost time matches the interpolated kart (one step behind simT, plus the fraction).
    const lapT = this.lapStart !== null && this.state !== 'grid' ? this.simT - STEP * (1 - a) - this.lapStart : -1;
    for (const g of this.ghosts) {
      if (!g.visual) continue;
      const pose = this.showGhosts && lapT >= 0 ? sampleGhost(g.frames, g.dt, lapT) : null;
      g.visual.root.visible = !!pose;
      if (!pose) {
        if (g.tag.style.display !== 'none') g.tag.style.display = 'none';
        continue;
      }
      g.visual.root.position.set(pose.x, 0, pose.z);
      g.visual.root.rotation.y = pose.h;
      tmp.set(pose.x, 1.55, pose.z).project(this.camera);
      const dist = this.camera.position.distanceTo(g.visual.root.position);
      if (tmp.z < 1 && dist < 150 && dist > 2.5) {
        g.tag.style.display = '';
        g.tag.style.transform = `translate(${((tmp.x + 1) / 2) * this.viewW}px, ${((1 - tmp.y) / 2) * this.viewH}px) translate(-50%, -100%)`;
      } else if (g.tag.style.display !== 'none') g.tag.style.display = 'none';
    }

    this.opts.mode?.addon?.frame?.(dt);
    this.pipeline.render();
    this.drawHud(lapT, x, z);
  }

  private drawHud(lapT: number, kx: number, kz: number) {
    const p = this.phys;
    this.hud.speed(p.speed * 3.6, p.speed / p.vmax);
    const L = this.track.length;
    if (lapT >= 0) {
      this.hud.lapTime(lapT * 1000, this.invalid);
      const si = Math.floor(p.s / SPLIT);
      if (this.pb?.splits[si] !== undefined && si < this.splits.length && si > 1) this.hud.delta((lapT * 1000 - this.pb.splits[si]) / 1000);
      else this.hud.delta(null);
      const cur = this.sectorTimes.length;
      const prog = THREE.MathUtils.clamp((p.s - (cur * L) / 3) / (L / 3), 0, 1);
      this.hud.sectors(this.sectorTimes, this.sectorColors, cur, prog);
    }
    const g = this.hud.minimap.getContext('2d')!;
    const { bg, map } = this.minimap;
    g.clearRect(0, 0, bg.width, bg.height);
    g.drawImage(bg, 0, 0);
    for (const gh of this.ghosts) {
      if (!gh.visual?.root.visible) continue;
      const [gx, gy] = map(gh.visual.root.position.x, gh.visual.root.position.z);
      g.beginPath();
      g.arc(gx, gy, 7, 0, Math.PI * 2);
      g.lineWidth = 3;
      g.strokeStyle = gh.color;
      g.stroke();
    }
    this.opts.mode?.addon?.minimap?.((x, z, color, r, ring) => {
      const [dx, dy] = map(x, z);
      g.beginPath();
      g.arc(dx, dy, r, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      if (ring) {
        g.lineWidth = 2.5;
        g.strokeStyle = '#111110';
        g.stroke();
      }
    });
    const [mx, my] = map(kx, kz);
    g.beginPath();
    g.arc(mx, my, 9, 0, Math.PI * 2);
    g.fillStyle = this.opts.driver.color;
    g.fill();
    g.lineWidth = 3.5;
    g.strokeStyle = '#f2eee5';
    g.stroke();
  }

  private updateSkids(drift: boolean) {
    const p = this.phys;
    const skidding = p.surface !== 'grass' && p.speed > 4 && (p.slip > 2.6 || (drift && Math.abs(p.yawRate) > 0.6));
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    const sk = this.skid;
    [-0.6, 0.6].forEach((side, w) => {
      const cx = p.x + fz * side - fx * 0.62;
      const cz = p.z - fx * side - fz * 0.62;
      const prev = sk.prev[w];
      const cur = this.v.tmp.set(cx, 0.05, cz);
      if (skidding && prev && prev.distanceToSquared(cur) > 0.04) {
        const dx = cur.x - prev.x;
        const dz = cur.z - prev.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = (-dz / len) * 0.1;
        const nz = (dx / len) * 0.1;
        const quad = [prev.x - nx, prev.z - nz, prev.x + nx, prev.z + nz, cur.x - nx, cur.z - nz, cur.x + nx, cur.z + nz];
        const tri = [0, 1, 2, 1, 3, 2];
        const base = (sk.i % 3000) * 18;
        tri.forEach((v, n) => {
          sk.pos[base + n * 3] = quad[v * 2];
          sk.pos[base + n * 3 + 1] = 0.05;
          sk.pos[base + n * 3 + 2] = quad[v * 2 + 1];
        });
        sk.i++;
        sk.geo.setDrawRange(0, Math.min(sk.i, 3000) * 6);
        (sk.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        prev.set(cx, 0.05, cz);
      } else if (!skidding) sk.prev[w] = null;
      else if (!prev) sk.prev[w] = new THREE.Vector3(cx, 0.05, cz); // once per skid, not per tick
    });
  }

  private onResize = () => {
    const w = this.root.clientWidth || innerWidth;
    const h = this.root.clientHeight || innerHeight;
    this.viewW = w;
    this.viewH = h;
    this.pipeline.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  // ------------------------------------------------------------------ persistence

  private loadPB(): LocalPB | null {
    try {
      return JSON.parse(localStorage.getItem(this.pbKey) || 'null');
    } catch {
      return null;
    }
  }

  private savePB() {
    try {
      localStorage.setItem(this.pbKey, JSON.stringify(this.pb));
    } catch {
      /* storage full: not fatal */
    }
  }

  /** Multiplayer (and other add-ons): skip the briefing, trim the HUD, hand over a context. */
  private applyMode() {
    const mode = this.opts.mode;
    if (!mode) return;
    const q = (sel: string) => this.hud.root.querySelector<HTMLElement>(sel);
    if (mode.leaderboard === false) q('[data-el="tower"]')!.hidden = true;
    if (mode.restart === false) q('[data-act="restart"]')!.hidden = true;
    if (mode.exitLabel) q('[data-act="exit"]')!.textContent = mode.exitLabel;
    if (mode.time) q('[data-act="time"]')!.hidden = true;
    if (mode.startAt !== undefined) {
      // A synchronised start can't wait for "press any key": go straight to the grid.
      this.intro.dispose();
      this.begin();
    }
    mode.addon?.attach?.(this.context());
  }

  /** What add-ons get to see and do (src/game/raceMode.ts). */
  private context(): RaceContext {
    const race = this;
    return {
      scene: this.scene,
      camera: this.camera,
      track: this.track,
      phys: this.phys,
      hud: this.hud.root,
      get state() {
        return race.state;
      },
      get simT() {
        return race.simT;
      },
      // The kart on screen is interpolated one physics step behind the newest state.
      get viewTime() {
        return race.lastFrame - STEP * 1000;
      },
      get physTime() {
        return race.lastFrame - race.acc * 1000;
      },
      get viewW() {
        return race.viewW;
      },
      get viewH() {
        return race.viewH;
      },
      toast: (text, kind) => this.hud.toast(text, kind),
      banner: (text, kind, secs) => this.hud.banner(text, kind, secs),
      setAutopilot: (on) => (this.autopilot = on),
      exit: () => this.opts.onExit(),
    };
  }

  dispose() {
    this.opts.mode?.addon?.dispose?.();
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize);
    this.intro.dispose();
    this.hud.dispose();
    this.input.dispose();
    this.audio.dispose();
    this.atmos.dispose();
    disposeTree(this.scene);
    for (const tpl of this.ghostTemplates.values()) disposeTree(tpl);
    this.scene.environment?.dispose();
    this.pipeline.dispose();
    this.pipeline.renderer.forceContextLoss(); // free the GL context now; multiplayer starts a race every round
    this.root.remove();
  }
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    mats.forEach((x) => {
      (x as THREE.MeshStandardMaterial).map?.dispose();
      x.dispose();
    });
  });
}

/** Local personal best for a track (used by the atlas). */
export function localPB(trackId: string, dir: Dir): number | null {
  try {
    return JSON.parse(localStorage.getItem(`ak:pb:${trackId}:${dir}`) || 'null')?.ms ?? null;
  } catch {
    return null;
  }
}
