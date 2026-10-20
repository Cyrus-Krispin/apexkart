import * as THREE from 'three';
import { TrackModel } from './track';
import { buildTrackScene, type TrackScene } from './trackMesh';
import { buildGhost, buildKart, KartPhysics, type KartVisual } from './kart';
import { availableSchemes, controlsPref, Input, saveControlsPref, SCHEME_LABEL, type ControlScheme } from './input';
import { KartAudio } from './audio';
import { KartFx, type FxFrame } from './fx';
import { Haptics } from './haptics';
import { Atmosphere, resolveTime, type TimePref } from './atmosphere';
import { awardMedal, earnedMedal, MEDAL_NAME, MEDALS, medalFor, targets } from './medals';
import { recordDailyLap } from '../shared/daily';
import { floodlit, floodTextures } from './floodlights';
import { RenderPipeline, autoQuality, initialQuality, loadAutoTier, maxRatio, MIN_RATIO, saveAutoTier, texturesUnder, type AutoTier, type Quality, type QualitySetting } from './render';
import { buildWorld, fetchLiveEnv, type World } from './world';
import { Hud, type SectorColor } from './hud';
import { RaceIntro } from '../ui/intro';
import { rotationLabel } from '../ui/trackArt';
import { analyzeShape } from '../track/shape';
import { decodeGhost, encodeGhost, sampleGhost, GHOST_DT, type GhostData, type GhostFrame } from '../shared/ghost';
import type { TrackData } from '../track/osm';
import { api, formatMs, type BoardResponse, type Dir, type Driver } from '../net/api';
import { gridPose, type RaceContext, type RaceMode } from './raceMode';

export interface RaceOptions {
  track: TrackData;
  dir: Dir;
  driver: Driver;
  container: HTMLElement;
  onExit: () => void;
  /** Multiplayer and other add-ons (src/game/raceMode.ts). Omit for a time trial. */
  mode?: RaceMode;
  /** Today's daily circuit: your best lap of the day also goes on the day's board. */
  daily?: boolean;
  /** A challenge: race this driver's leaderboard lap as a ghost (their public id). */
  rival?: string;
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
  private world: World | null = null;
  private atmos!: Atmosphere;
  /** Live, Day or Night; a shared session (multiplayer room) fixes it for everyone. */
  private timeSetting: TimePref;
  private worldBuild = 0; // rebuilds can overlap (surroundings arriving late); only the newest is kept
  private rival: { name: string; ms: number; beaten: boolean } | null = null;
  private liveEnvAsked = false;
  /** Auto's verdict for this GPU and screen, from an earlier race or this one's warm-up. */
  private autoRec: AutoTier | null = null;
  /** The pixel ratio the grid settled on: in the race Auto only goes below it, and back up to it. */
  private ratioCap = 1;
  /** Auto's in-race frame-time window (time-based, so 120 Hz screens aren't judged twice as fast). */
  private perf = { start: 0, t: 0, dts: [] as number[], slow: 0, fast: 0, changed: 0, quietUntil: 0, raised: false, noRaise: false, ghosts: 0 };
  /** Work to run inside the next frame, just before its own render (warm-up views). */
  private frameJobs: (() => void)[] = [];
  private warmGen = 0; // a newer warm-up (time of day, quality, a rebuilt world) supersedes an older one
  private warming = false;
  /** Surroundings that arrived mid-race, waiting for a calm moment to go in (the lap count then). */
  private envPending: { lap: number } | null = null;
  private rebuilding = false;
  private camera = new THREE.PerspectiveCamera(62, 1, 0.1, 5000);
  private track: TrackModel;
  private trackScene!: TrackScene;
  private kart: KartVisual;
  private phys: KartPhysics;
  private input: Input;
  private audio = new KartAudio();
  private haptics = new Haptics(() => this.audio.muted);
  private pbSeen: number | null | undefined; // a new personal best buzzes once
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
  private lapOdo = 0; // phys.odo when this lap started
  private lapNo = 0;
  private lastS = 0;
  private sectorsHit = [false, false];
  private sectorTimes: number[] = [];
  private sectorColors: SectorColor[] = [];
  private invalid = false;
  private wrongWayT = 0;
  private grassT = 0; // seconds on the grass in a row
  private stuckShown = false; // the Reset button is up
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
  /** Camera springs: impact kick offset (o, v), FOV punch, smooth shake, corner look-ahead, eased FOV. */
  private cam = { ox: 0, oy: 0, oz: 0, vx: 0, vy: 0, vz: 0, fov: 0, fovV: 0, shake: 0, side: 0, fovBase: 62 };
  private showGhosts = localStorage.getItem('ak:ghosts') !== '0';
  private ghosts: Ghost[] = [];
  private board: BoardResponse | null = null;
  private boardTimer = 0;
  private hintShown = false;
  private hintPending = false; // controls changed in the pause menu: show the hint again on resume
  private throttle = 0;
  private nextSyncAt = 0;
  private minimap!: { bg: HTMLCanvasElement; map: (x: number, z: number) => [number, number] };
  private fx!: KartFx; // particles and skid marks
  autopilot = false;

  constructor(private opts: RaceOptions) {
    this.track = new TrackModel(opts.track, opts.dir === 'rev');
    const shape = analyzeShape(opts.track.points);
    const rot = rotationLabel(shape, opts.dir === 'rev');
    this.pbKey = `ak:pb:${opts.track.id}:${opts.dir}`;
    localStorage.removeItem('ak:style'); // the satellite world is gone; every world is the stylised one
    if (opts.mode?.ghosts === false) this.showGhosts = false;
    this.pb = this.loadPB();
    this.bestSectors = this.pb?.sectors.slice() ?? [];

    this.root = document.createElement('div');
    this.root.className = 'race';
    opts.container.appendChild(this.root);

    this.pipeline = new RenderPipeline(this.scene, this.camera, 'medium');
    this.autoRec = loadAutoTier(this.pipeline.gpu);
    this.pipeline.quality = this.qualitySetting === 'auto' ? this.autoTier() : this.qualitySetting;
    this.root.appendChild(this.pipeline.renderer.domElement);

    this.hud = new Hud(this.root, { trackName: opts.track.name, dirLabel: rot.label, dirIcon: rot.icon, color: opts.driver.color }, (a) => this.action(a));
    this.hud.setVisible(false);
    this.hud.best(this.pb?.ms ?? null);
    this.input = new Input(this.hud.touch, controlsPref());
    this.hud.setControls(this.input.scheme);
    this.syncToggles();

    this.phys = new KartPhysics(this.track);
    this.kart = buildKart(opts.driver.color, { number: 7 });
    this.scene.add(this.kart.root);

    this.timeSetting = opts.mode?.time ?? 'live'; // every race starts at the real time of day there
    this.intro = new RaceIntro({
      container: this.root,
      track: opts.track,
      shape,
      dir: opts.dir,
      driver: opts.driver,
      pb: this.pb?.ms ?? null,
      time: this.timeSetting,
      liveNow: resolveTime('live', opts.track.center).time,
      controls: this.input.scheme,
      schemes: availableSchemes(),
      onTime: (t) => this.setTime(t),
      onControls: (s) => this.setControls(s),
      onStart: () => this.begin(),
      onBack: () => opts.onExit(),
    });

    this.buildWorld();
    if (opts.rival && !opts.mode) this.loadRival(opts.rival);
    this.syncToggles();
    this.buildMinimap();
    this.fx = new KartFx(this.scene, this.track);
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
    this.setTier(this.pipeline.quality);
    // Sky, fog, sun or moon, and the floodlights at night.
    const look = resolveTime(this.timeSetting, this.opts.track.center);
    this.atmos = new Atmosphere(s, this.pipeline, this.kart.root, look.time, look.sun);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x7da457 }));
    this.ground.position.y = -0.08;
    this.ground.receiveShadow = true;
    s.add(this.ground);

    const aniso = this.pipeline.renderer.capabilities.getMaxAnisotropy();
    this.trackScene = buildTrackScene(this.track, aniso);
    // Start lights: a pure red that stays red through tone mapping when lit (the grid drives them at 4).
    for (const m of this.trackScene.lights) m.emissive.setRGB(0.3, 0.004, 0.004);
    s.add(this.trackScene.group);
    floodlit(this.ground);
    floodlit(this.trackScene.group);
    this.rebuildWorld();
  }

  /**
   * Build the world around the circuit. The first build goes straight in. A later one (surroundings
   * arriving from Overpass once the race is under way, on circuits without baked ones) waits for a
   * calm moment: at once on the grid screen (START waits for it) or while paused, otherwise the next
   * time you complete a lap, under the lap card. Never mid-corner.
   */
  rebuildWorld() {
    if (!this.world) return void this.buildAndSwap();
    this.envPending = { lap: this.lapNo };
    this.maybeRebuild();
  }

  /** Each frame: start a waiting rebuild if now is a calm moment. */
  private maybeRebuild() {
    const p = this.envPending;
    if (!p || this.rebuilding) return;
    p.lap = Math.min(p.lap, this.lapNo); // a restart reset the lap count
    if (this.state === 'intro' || this.state === 'paused' || (this.state === 'racing' && this.lapNo > Math.max(1, p.lap))) {
      this.envPending = null;
      this.buildAndSwap();
    }
  }

  private async buildAndSwap() {
    const build = ++this.worldBuild;
    const first = !this.world;
    const onGrid = this.state === 'intro';
    const hold = !first && onGrid;
    let warmed = false;
    if (hold) {
      this.intro.hold('Adding the surroundings');
      this.warmGen++; // a warm-up still running must not unlock START under the rebuild
      this.warming = true;
    }
    this.rebuilding = true;
    const stale = () => this.disposed || build !== this.worldBuild;
    try {
      const world = await buildWorld({
        track: this.track,
        data: this.opts.track,
        quality: this.pipeline.quality,
        aniso: this.pipeline.renderer.capabilities.getMaxAnisotropy(),
        onStage: (label, f) => (first || onGrid) && this.intro.stage(label, f),
        isDisposed: () => this.disposed,
      }).catch((e) => {
        console.error(e);
        if (first) this.intro.failed();
        return null;
      });
      if (!world) return;
      if (stale()) return disposeTree(world.group); // a newer build replaced it
      floodlit(world.group);
      if (!first) {
        // Compile it against the live scene while the old world still holds its shaders: every program
        // the two share (nearly all) is reused rather than rebuilt. Then upload its textures (the
        // ground canvas alone is tens of MB with mipmaps) before anything draws it.
        await Promise.race([this.pipeline.compile(world.group).catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
        if (stale()) return disposeTree(world.group);
        for (const t of texturesUnder(world.group)) this.pipeline.renderer.initTexture(t);
      }
      const old = this.world;
      if (old) this.scene.remove(old.group);
      this.world = world;
      this.scene.add(world.group);
      this.atmos.setWorld([world.group], world.lamps, world.emissive);
      for (const t of floodTextures()) this.pipeline.renderer.initTexture(t);
      (this.ground.material as THREE.MeshLambertMaterial).color.copy(world.groundColor);
      if (old) disposeTree(old.group); // only now: the shaders the new world shares stay alive
      this.perf.quietUntil = performance.now() + 1500;
      // No baked surroundings: race now, and add the buildings and trees when Overpass delivers them.
      if (!world.stats.env && !this.liveEnvAsked) {
        this.liveEnvAsked = true;
        fetchLiveEnv(this.opts.track).then((got) => {
          if (got && !this.disposed) this.rebuildWorld();
        });
      }
      // On the grid screen, settle everything (again) before START.
      if (first || this.state === 'intro') {
        warmed = true;
        await this.warmUp(hold ? 'Adding the surroundings' : undefined);
      }
    } finally {
      this.rebuilding = false;
      if (hold && !warmed && !stale()) {
        this.warming = false;
        this.intro.stage('Ready', 1); // the rebuild fell through: give START back
      }
    }
  }

  // ------------------------------------------------------------------ warm-up

  /**
   * Settle everything before START, behind the grid screen: compile every shader for the real render
   * target (and, at night, the next tier down's light rig), upload every texture, then render a view
   * from above with the shadow cameras opened over the whole world and a dozen chase views round the
   * lap, so shadow shaders, buffers, ghosts and the skid mesh are all on the GPU before lights out.
   * START unlocks when it's done. A newer warm-up (new time of day, quality or world) replaces it.
   */
  private async warmUp(label = 'Warming up') {
    const gen = ++this.warmGen;
    const live = () => !this.disposed && gen === this.warmGen;
    this.warming = true;
    // Your best lap's ghost (same template as any ghost of your colour) rides along for the warm-up.
    const ghost = this.ghostVisual(this.opts.driver.color).root;
    ghost.visible = false;
    this.scene.add(ghost);
    try {
      this.intro.stage(label, 0.9);
      await this.compileScene();
      if (!live()) return;
      await this.warmLowerRig();
      if (!live()) return;
      this.intro.stage(label, 0.93);
      await this.uploadTextures(texturesUnder(this.scene).concat(floodTextures()), live);
      if (!live()) return;
      await this.inFrame(() => this.renderOverview());
      const times = await this.tour(12, ghost, live, (f) => this.intro.stage(label, 0.94 + 0.04 * f));
      if (!live()) return;
      await this.calibrate(times.slice(4), ghost, live); // the first views still pay first-draw costs
    } catch (e) {
      console.warn('warm-up', e); // best effort: anything missed compiles on first sight, as before
    } finally {
      this.scene.remove(ghost);
      if (gen === this.warmGen && !this.disposed) {
        this.warming = false;
        this.intro.stage('Ready', 1);
      }
    }
  }

  /** `n` chase views spread round the lap, one per frame; each one's synced render time in ms. */
  private async tour(n: number, ghost: THREE.Object3D, live: () => boolean, progress?: (f: number) => void) {
    const times: number[] = [];
    for (let k = 0; k < n && live(); k++) {
      times.push(await this.inFrame(() => this.renderPose(((k + 0.5) / n) * this.track.length, ghost)));
      progress?.((k + 1) / n);
    }
    return times;
  }

  /**
   * Auto, once per device: judge the tier on the warm-up's timed frames (render plus a GPU sync, so an
   * upper bound) and remember it for this GPU and screen. Medium stays if its frames take 9 ms or
   * less, else Low. Low then takes the sharpest pixel ratio that still fits, up to 2 on phones.
   * Only on the grid: a tier change recompiles everything, so it never happens in the race.
   */
  private async calibrate(times: number[], ghost: THREE.Object3D, live: () => boolean) {
    if (this.qualitySetting !== 'auto' || this.autoRec || !times.length || (this.state !== 'intro' && this.state !== 'grid')) return;
    let ms = median(times);
    let q = this.pipeline.quality;
    // A second look before demoting, in case something else had the machine busy for a moment.
    if (q === 'medium' && ms > 9) ms = Math.min(ms, median((await this.tour(6, ghost, live)).slice(1)));
    if (!live()) return;
    if (q === 'medium' && ms > 9) {
      this.intro.stage('Tuning the graphics', 0.985);
      q = 'low';
      this.setTier(q);
      await this.compileScene();
      if (!live()) return;
      await this.inFrame(() => this.renderOverview());
      ms = median((await this.tour(5, ghost, live)).slice(1));
      if (!live()) return;
    }
    if (q === 'low') {
      // Low at ratio 1 on a 3x phone is a soft, 375-pixel-wide picture; many can afford more.
      // Fill cost grows with pixels, the rest doesn't: estimate, then check.
      let pr = 1;
      for (let r = maxRatio('low'); r > 1; r -= 0.25)
        if (ms * (0.35 + 0.65 * r * r) <= 6.5) {
          pr = r;
          break;
        }
      if (pr > 1) {
        this.pipeline.setPixelRatio(pr);
        const check = median((await this.tour(4, ghost, live)).slice(1));
        if (!live()) return;
        if (check > 9) this.pipeline.setPixelRatio(1);
      }
    }
    this.autoRec = saveAutoTier({ tier: q, pixelRatio: this.pipeline.pixelRatio, gpu: this.pipeline.gpu, ms: Math.round(ms * 100) / 100 });
    this.ratioCap = this.pipeline.pixelRatio;
    this.syncToggles();
  }

  /** Compile every material in the scene for the target it renders into (bounded, in case the driver never answers). */
  private compileScene(q?: Quality) {
    return Promise.race([this.pipeline.compile(this.scene, this.scene, q).catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
  }

  /** Night: compile the next tier down's light rig too (it has fewer lights, so different shaders). */
  private async warmLowerRig() {
    const q = this.pipeline.quality;
    const lower: Quality | null = q === 'high' ? 'medium' : q === 'medium' ? 'low' : null;
    if (this.atmos.time !== 'night' || !lower) return;
    const undo = this.atmos.useRig(lower);
    let done: Promise<unknown>;
    try {
      done = this.compileScene(lower); // the programs are created synchronously in here
    } finally {
      undo(); // before any frame renders with the wrong rig
      this.atmos.snap(this.phys.x, this.phys.z);
    }
    await done;
  }

  /** Upload textures a few milliseconds' worth per frame (the ground canvas alone is tens of MB with mipmaps). */
  private async uploadTextures(list: THREE.Texture[], live: () => boolean) {
    let i = 0;
    while (i < list.length && live())
      await this.inFrame(() => {
        const t0 = performance.now();
        do this.pipeline.renderer.initTexture(list[i++]);
        while (i < list.length && performance.now() - t0 < 8);
      });
  }

  /** Run `fn` inside the next frame, just before that frame's own render, so the screen never shows what it drew. */
  private inFrame<T>(fn: () => T): Promise<T> {
    return new Promise((resolve, reject) =>
      this.frameJobs.push(() => {
        try {
          resolve(fn());
        } catch (e) {
          reject(e);
        }
      }),
    );
  }

  private runFrameJobs() {
    if (!this.frameJobs.length) return;
    const jobs = this.frameJobs;
    this.frameJobs = [];
    for (const j of jobs) j();
  }

  /** Swap the camera for a warm-up view, run `draw`, and put the camera back. */
  private withCamera<T>(set: (cam: THREE.PerspectiveCamera) => void, draw: () => T): T {
    const cam = this.camera;
    const pos = cam.position.clone();
    const rot = cam.quaternion.clone();
    const { fov, far } = cam;
    try {
      set(cam);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      return draw();
    } finally {
      cam.position.copy(pos);
      cam.quaternion.copy(rot);
      cam.fov = fov;
      cam.far = far;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    }
  }

  /** One frame from high above with the shadow cameras opened over everything: every mesh and every
   *  kind of shadow caster draws once, whatever the chase views happen to frame. */
  private renderOverview() {
    const box = new THREE.Box3().setFromObject(this.trackScene.group);
    if (this.world) box.union(new THREE.Box3().setFromObject(this.world.group));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z) / 2 + 10;
    const undo = this.atmos.wideShadows(c.x, c.z, r);
    try {
      this.withCamera(
        (cam) => {
          cam.fov = 70;
          const h = r / Math.tan(THREE.MathUtils.degToRad(35)) + 20;
          cam.far = Math.max(cam.far, h + 100);
          cam.position.set(c.x, h, c.z + h * 0.02);
          cam.lookAt(c.x, 0, c.z);
        },
        () => this.pipeline.render(),
      );
    } finally {
      undo();
      this.atmos.snap(this.phys.x, this.phys.z);
    }
  }

  /** One chase view s metres round the lap, with every ghost in shot so their buffers upload too. */
  private renderPose(s: number, ghost: THREE.Object3D) {
    const t = this.track;
    const a = t.at(s);
    const fx = Math.sin(a.heading);
    const fz = Math.cos(a.heading);
    const shown = [ghost, ...this.ghosts.map((g) => g.visual?.root).filter((o): o is THREE.Group => !!o)];
    shown.forEach((o, k) => {
      o.visible = true;
      o.position.set(a.x + fx * (5 + k * 2.5), 0, a.z + fz * (5 + k * 2.5));
      o.rotation.y = a.heading;
    });
    this.atmos.snap(a.x, a.z);
    try {
      return this.withCamera(
        (cam) => {
          cam.fov = 64;
          cam.position.set(a.x - fx * 5.2, 2.3, a.z - fz * 5.2);
          cam.lookAt(a.x + fx * 3.5, 0.7, a.z + fz * 3.5);
        },
        () => this.pipeline.timedRender(),
      );
    } finally {
      // The frame's own render follows straight after: back to where the kart really is.
      shown.forEach((o) => (o.visible = false));
      this.atmos.snap(this.phys.x, this.phys.z);
    }
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
    g.strokeStyle = 'rgba(242,243,245,0.14)';
    g.lineWidth = 18;
    g.stroke();
    path();
    g.strokeStyle = '#f2f3f5';
    g.lineWidth = 6;
    g.stroke();
    for (const frac of [1 / 3, 2 / 3]) {
      const i = Math.floor(frac * t.n);
      const [x, y] = map(t.px[i], t.pz[i]);
      const [nx, nz] = t.normal(i);
      g.strokeStyle = '#ffd60a';
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
          g.fillStyle = (k + r) % 2 ? '#0b0c10' : '#ffffff';
          g.fillRect(k * 4, -4 + r * 4, 4, 4);
        }
      g.restore();
    }
    this.minimap = { bg, map };
  }

  // ------------------------------------------------------------------ flow

  private begin() {
    this.audio.start();
    this.hud.setVisible(true);
    this.resetToGrid();
    if (this.rival) this.hud.banner(`Chasing ${this.rival.name} · ${formatMs(this.rival.ms)}`, 'info', 3);
  }

  /** A challenge: their lap joins as a ghost and stays for the whole session. */
  private async loadRival(pid: string) {
    try {
      const r = await api.ghost(this.opts.track.id, this.opts.dir, pid);
      if (!r.ghost || this.disposed) return;
      this.rival = { name: r.name, ms: r.ms, beaten: false };
      this.setGhost('rival', `${r.name} · challenge`, r.color, r.ghost);
    } catch {
      /* race on without it */
    }
  }

  private action(a: string) {
    if (a === 'resume') this.togglePause(false);
    if (a === 'restart') {
      this.togglePause(false);
      this.resetToGrid();
    }
    if (a === 'exit') this.opts.onExit();
    if (a === 'reset' && this.state === 'racing') this.recover();
    if (a === 'pause') this.togglePause();
    if (a === 'mute') this.audio.toggleMute();
    if (a === 'ghosts') this.toggleGhosts();
    if (a === 'cam') this.camMode = (this.camMode + 1) % CAMS.length;
    if (a === 'quality') {
      const order: QualitySetting[] = ['auto', 'high', 'medium', 'low'];
      this.qualitySetting = order[(order.indexOf(this.qualitySetting) + 1) % order.length];
      localStorage.setItem('ak:quality', this.qualitySetting);
      this.applyQuality(this.qualitySetting === 'auto' ? this.autoTier() : this.qualitySetting);
    }
    if (a === 'time') this.setTime(({ live: 'day', day: 'night', night: 'live' } as const)[this.timeSetting], true);
    if (a === 'controls') {
      const all = availableSchemes();
      this.setControls(all[(all.indexOf(this.input.scheme) + 1) % all.length]);
    }
    this.syncToggles();
  }

  /** From the briefing or the pause menu. */
  private setControls(s: ControlScheme) {
    if (s === this.input.scheme) return;
    this.input.setScheme(s);
    saveControlsPref(s);
    this.hud.setControls(s);
    this.intro.setControls(s);
    if (this.state === 'paused') this.hintPending = true;
    else if (this.state !== 'intro') this.hud.hint(true, 4000);
    this.syncToggles();
  }

  private setTime(t: TimePref, toast = false) {
    if (t === this.timeSetting || this.opts.mode?.time) return; // a shared session's time is fixed
    this.timeSetting = t; // for this race only: the next one starts at Live again
    const look = resolveTime(t, this.opts.track.center);
    const flip = look.time !== this.atmos.time;
    this.atmos.set(look.time, look.sun); // every material recompiles
    if (this.world && flip) {
      // Light counts changed: new shaders. On the grid, START waits for them.
      const label = look.time === 'night' ? 'Switching on the floodlights' : 'Bringing the daylight';
      if (this.state === 'intro') this.intro.hold(label);
      this.warmUp(label);
    }
    if (toast) {
      const night = look.time === 'night';
      this.hud.toast(t === 'live' ? `Live · ${night ? 'night at the circuit, floodlights on' : 'the sun where it is right now'}` : night ? 'Night session · floodlights on' : 'Day session');
    }
    this.syncToggles();
  }

  /** Auto's tier: what it measured on this device before, else its first guess. */
  private autoTier(): Quality {
    return this.autoRec?.tier ?? autoQuality();
  }

  /** Switch tier: render path, pixel ratio and night light rig. Never mid-race: on the grid or from the pause menu. */
  private setTier(q: Quality) {
    const rec = this.qualitySetting === 'auto' && this.autoRec?.tier === q ? this.autoRec : null;
    if (this.atmos && q !== this.pipeline.quality) this.atmos.setQuality(q);
    this.pipeline.setQuality(q, rec?.pixelRatio);
    this.ratioCap = this.pipeline.pixelRatio;
  }

  /** From the pause menu. */
  private applyQuality(q: Quality) {
    if (q === this.pipeline.quality) return;
    this.setTier(q);
    // Each tier renders into a different target (and at night has its own lights): new shaders.
    if (this.world) this.warmUp();
  }

  private syncToggles() {
    const q = this.qualitySetting === 'auto' ? `Auto · ${this.pipeline.quality}` : this.qualitySetting;
    const night = this.atmos?.time === 'night';
    const time = this.timeSetting === 'live' ? `Live · ${night ? 'Night' : 'Day'}` : night ? 'Night' : 'Day';
    this.hud.toggles({ controls: SCHEME_LABEL[this.input.scheme], muted: this.audio.muted, ghosts: this.showGhosts, cam: CAMS[this.camMode].label, quality: q, night, time });
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
    this.hintPending = false;
    this.trackScene.lights.forEach((m) => (m.emissiveIntensity = 0));
    this.hud.lights(0);
    this.hud.lap(null);
    this.hud.lapTime(0, false);
    this.hud.delta(null);
    this.hud.sectors([], [], -1, 0);
    this.hud.hint(true);
    this.showStuck(false);
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
      if (this.hintPending) this.hud.hint(true, 4000);
      this.hintPending = false;
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
    this.runFrameJobs(); // warm-up views: drawn before the frame's own render, so never on screen
    this.render(dt);
    this.adaptQuality(dt);
    this.maybeRebuild();
  };

  /**
   * Auto in the race: the tier never changes (that recompiles every shader, and at night changes
   * the lights); only the pixel ratio moves, in 1/8 steps, judged on the frame rate over 1-second
   * windows (the mean, as vsync makes the median jump between 16.7 and 33.3 ms).
   * Nothing moves before lap 1 is done, at most once every 2 s, and windows that saw a known hitch
   * (a world swap, a ghost arriving, a tab switch) don't count.
   */
  private adaptQuality(dt: number) {
    const w = this.perf;
    const now = performance.now();
    if (this.ghosts.length !== w.ghosts) {
      w.ghosts = this.ghosts.length;
      w.quietUntil = now + 1000;
    }
    if (document.hidden || dt >= 0.1) w.quietUntil = now + 1000;
    if (this.qualitySetting !== 'auto' || this.state !== 'racing' || this.lapNo < 2 || this.warming) {
      w.dts.length = 0;
      return;
    }
    if (!w.dts.length) {
      w.start = now;
      w.t = 0;
    }
    w.dts.push(dt);
    w.t += dt;
    if (w.t < 1) return;
    const clean = w.quietUntil <= w.start;
    const fps = w.dts.length / w.t;
    w.dts.length = 0;
    if (!clean) {
      w.slow = w.fast = 0;
      return;
    }
    w.slow = fps < 45 ? w.slow + 1 : 0;
    w.fast = fps > 57 ? w.fast + 1 : 0;
    if (now - w.changed < 2000) return;
    const pr = this.pipeline.pixelRatio;
    let next = pr;
    if (w.slow >= 2 && pr > MIN_RATIO) {
      next = pr - 0.125;
      if (w.raised) w.noRaise = true; // it went up and it didn't hold: stay down for this race
    } else if (w.fast >= 8 && !w.noRaise && pr < this.ratioCap) {
      next = Math.min(this.ratioCap, pr + 0.125);
      w.raised = true;
    }
    if (next === pr) return;
    this.pipeline.setPixelRatio(next);
    w.changed = now;
    w.slow = w.fast = 0;
    w.quietUntil = now + 500; // the resize itself
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
        this.haptics.light(false);
      }
      if (this.gridT >= this.goAt) {
        this.state = 'racing';
        this.goTime = this.simT;
        this.trackScene.lights.forEach((m) => (m.emissiveIntensity = 0));
        this.hud.lights(null);
        this.audio.beep(true);
        this.haptics.light(true);
        this.hud.banner('Go', 'go', 1.1);
        this.hud.hint(true, 4000);
      }
      // Held on the grid: no throttle (Simple would otherwise drive off) and no brake (reverse).
      c.throttle = c.brake = 0;
    }
    this.simT += dt;
    this.phys.step(dt, c);
    if (this.state === 'racing') this.timing(dt);
    this.sectorFlash();
    this.fx.sense(this.phys, c, dt, this.simT);
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
    // Progress is continuous; leaving for another part of the lap is reported. Forward is a cut.
    // In a multiplayer race there's no lap to void: the kart goes back to where it left.
    const rejoin = this.phys.rejoin;
    if (rejoin && rejoin.gain > 0) {
      if (this.opts.mode) {
        this.lastS = prev;
        this.recover(this.phys.goodS - 2, 'Cut the track');
        this.hud.banner('Cut the track · back where you left it', 'warn', 2.2);
        return;
      }
      this.invalidate('Cut the track', true);
    }
    if (crossedBack && this.lapStart !== null) {
      // Back over the line: this lap never happened. The next forward crossing starts it again
      // (no lap card, no lap counted).
      this.invalidate('Reversed over the line');
      this.lapStart = null;
      this.lapNo = Math.max(0, this.lapNo - 1);
      this.hud.lap(null);
      this.hud.lapTime(0, false);
      this.hud.delta(null);
      this.hud.sectors([], [], -1, 0);
    }
    if (crossedFwd) {
      // Interpolate the exact crossing moment inside this step.
      const before = L - prev;
      const frac = before / Math.max(1e-6, before + s);
      const tCross = this.simT - dt + dt * frac;
      // Every sector gate passed (by driving through it, not jumping), and no lap shorter than the
      // shortest line inside the limits (a backstop).
      if (this.lapStart !== null && !(this.sectorsHit[0] && this.sectorsHit[1])) this.invalidate('Missed a sector');
      if (this.lapStart !== null && this.phys.odo - this.lapOdo < this.track.minLapLength) this.invalidate('Cut the track', true);
      if (this.lapStart !== null) this.finishLap(tCross);
      this.lapStart = tCross;
      this.lapOdo = this.phys.odo;
      void this.track.minLapLength; // computed once, here (a few ms), rather than at the end of the lap
      this.lapNo++;
      this.sectorsHit = [false, false];
      this.sectorTimes = [];
      this.sectorColors = [];
      this.invalid = false;
      this.ghostRec = [];
      this.splits = [];
      this.hud.lap(this.lapNo);
    }
    // Wrong way: moving backwards along the part of the lap the kart is on. The continuous progress
    // index keeps that the leg being driven, never a neighbouring one. The out-lap counts too.
    const tr = this.track;
    const i = this.phys.hint;
    const along = this.phys.vx * tr.tx[i] + this.phys.vz * tr.tz[i];
    this.wrongWayT = along < -3 && !rejoin ? this.wrongWayT + dt : 0;
    if (this.wrongWayT > 1.2) this.hud.banner('Wrong way', 'warn', 0.4);

    // Stuck (wedged with the pedals pressed), lost on the grass, or facing the wrong way: offer
    // Reset (R on a keyboard) until the kart is properly under way again. In a multiplayer race a
    // kart wedged for 5 s is reset for you.
    const p = this.phys;
    this.grassT = p.surface === 'grass' ? this.grassT + dt : 0;
    if (!this.autopilot && (p.stuckT > 1.2 || this.grassT > 4 || this.wrongWayT > 2.5)) this.showStuck(true);
    else if (this.stuckShown && (this.autopilot || (p.speed > 6 && p.surface !== 'grass' && this.wrongWayT === 0))) this.showStuck(false);
    if (this.opts.mode && !this.autopilot && p.stuckT > 5) this.recover();

    if (this.lapStart === null) return;

    const lapT = (this.simT - this.lapStart) * 1000;
    for (let k = 0; k < 2; k++) {
      const b = (L * (k + 1)) / 3;
      // Progress is continuous (clean laps step < 3.1 m), so a gate only counts when driven through.
      if (!this.sectorsHit[k] && prev < b && s >= b && s - prev < 10 && !rejoin) {
        if (k === 1 && !this.sectorsHit[0]) this.invalidate('Missed a sector');
        this.sectorsHit[k] = true;
        const total = this.sectorTimes.reduce((a, x) => a + x, 0);
        const t = lapT - total;
        this.sectorTimes.push(t);
        this.sectorColors.push(this.sectorColor(k, t));
      }
    }
    if (!this.invalid && Math.abs(this.phys.offset) > this.track.limit) this.invalidate('Track limits'); // four wheels off

    while (this.ghostRec.length * GHOST_DT * 1000 <= lapT) this.ghostRec.push({ x: this.phys.x, z: this.phys.z, h: this.phys.heading });
    const si = Math.floor(s / SPLIT);
    if (s < L - 5) while (this.splits.length <= si) this.splits.push(lapT);
  }

  // What timing() had at the end of the previous step, so a sector completed in this one can be shown.
  private secSeen = { lap: 0, n: 0, start: null as number | null, invalid: false, times: [0, 0], best: [0, 0, 0] };

  /** A sector just completed on a clean lap: flash its chip with the gap to your best sector, chime on purple. */
  private sectorFlash() {
    const s = this.secSeen;
    const n = this.sectorTimes.length;
    let k = -1;
    let t = 0;
    let color: SectorColor = '';
    if (this.lapNo !== s.lap) {
      // A new lap began, so timing() has already reset the sectors: S3 = lap time − S1 − S2.
      if (s.start !== null && this.lapStart !== null && s.n === 2 && !s.invalid) {
        k = 2;
        t = (this.lapStart - s.start) * 1000 - s.times[0] - s.times[1];
        const lead = this.board?.entries[0]?.sectors?.[2];
        color = !s.best[2] || t <= s.best[2] ? (!lead || t <= lead ? 'purple' : 'green') : 'yellow';
      }
    } else if (n > s.n && !this.invalid) {
      k = n - 1;
      t = this.sectorTimes[k];
      color = this.sectorColors[k];
    }
    if (k >= 0 && s.best[k] && !this.autopilot) {
      this.hud.sectorFlash(k, color, (t - s.best[k]) / 1000);
      if (color === 'purple') this.audio.chime();
    }
    s.lap = this.lapNo;
    s.n = n;
    s.start = this.lapStart;
    s.invalid = this.invalid;
    for (let i = 0; i < 2; i++) s.times[i] = this.sectorTimes[i] ?? 0;
    for (let i = 0; i < 3; i++) s.best[i] = this.bestSectors[i] ?? 0;
  }

  private sectorColor(k: number, t: number): SectorColor {
    const mine = this.bestSectors[k];
    const leader = this.board?.entries[0]?.sectors?.[k];
    if ((!mine || t <= mine) && (!leader || t <= leader)) return 'purple';
    if (!mine || t <= mine) return 'green';
    return 'yellow';
  }

  /** `again`: say so even if the lap is already invalid (a cut usually crosses the limits first). */
  private invalidate(reason: string, again = false) {
    if ((this.invalid && !again) || this.lapStart === null) return;
    this.invalid = true;
    this.hud.banner(`Lap invalid · ${reason}`, 'warn', 2);
  }

  /** Back on the track: a little behind the last place the kart was on its own asphalt. */
  private recover(at = this.phys.goodS - 2, reason = 'Reset') {
    this.phys.place(at);
    this.invalidate(reason, true);
    this.grassT = this.wrongWayT = 0;
    this.showStuck(false);
    this.snapCamera();
  }

  private showStuck(show: boolean) {
    this.stuckShown = show;
    this.hud.stuck(show);
  }

  private finishLap(tCross: number) {
    if (this.autopilot) return; // the cool-down lap after a multiplayer flag is the game driving, not you
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
    // The daily circuit: a best-of-the-day lap goes on the day's board even if it isn't a PB
    // (a PB is submitted above, and the server files it on both boards).
    if (this.opts.daily && !this.opts.mode && recordDailyLap(ms) && !isPb) {
      this.ghostRec.push({ x: this.phys.x, z: this.phys.z, h: this.phys.heading });
      this.submitDaily({ ms, sectors, ghost: encodeGhost(this.ghostRec) });
    }
    if (this.rival && !this.rival.beaten && ms < this.rival.ms) {
      this.rival.beaten = true;
      this.hud.toast(`You beat ${this.rival.name}'s ${formatMs(this.rival.ms)}`, 'gold');
    }
    // Medals in time trials, against the record on the live board (once it has loaded).
    if (!this.opts.mode && this.board) {
      const m = medalFor(ms, targets(this.board.entries[0]?.ms, this.opts.track.lengthM));
      if (m && awardMedal(this.opts.track.id, this.opts.dir, m)) this.hud.banner(`${MEDAL_NAME[m]} medal`, 'medal', 2.8);
      this.showTarget();
    }
  }

  /** Time trials: the next medal to chase, under Last and Best. */
  private showTarget() {
    if (this.opts.mode || !this.board) return this.hud.target(null, null);
    const have = earnedMedal(this.opts.track.id, this.opts.dir);
    const next = MEDALS[(have ? MEDALS.indexOf(have) : -1) + 1] ?? null;
    this.hud.target(next, next ? targets(this.board.entries[0]?.ms, this.opts.track.lengthM)[next] : null);
  }

  /** A best-of-the-day lap on the daily circuit that isn't your all-time best. */
  private async submitDaily(lap: { ms: number; sectors: number[]; ghost: GhostData }) {
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
        ...lap,
        points: this.opts.track.points,
        width: this.opts.track.width,
      });
      if (res.daily) this.hud.toast(`Daily circuit · P${res.daily.rank} of ${res.daily.total} today`, res.daily.rank === 1 ? 'gold' : undefined);
    } catch {
      /* the day's best is kept on this device; the next one will try again */
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
        else if (res.daily?.improved) this.hud.toast(`Daily circuit · P${res.daily.rank} of ${res.daily.total} today`, res.daily.rank === 1 ? 'gold' : undefined);
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
      const t = this.opts.track;
      const presence =
        this.state === 'intro' ? undefined : { pid: d.pid, name: d.name, color: d.color, tn: t.name, c: `${t.center[0].toFixed(5)},${t.center[1].toFixed(5)}` };
      const b = await api.board(this.opts.track.id, this.opts.dir, presence);
      if (this.disposed) return;
      this.board = b;
      this.intro.board(b);
      this.showTarget();
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
    const top = (this.board?.entries ?? []).filter((e) => e.pid !== me && e.pid !== this.opts.rival).slice(0, 3);
    const wanted = new Set(top.map((e) => `${e.pid}:${e.ms}`));
    for (const g of this.ghosts.filter((g) => g.key !== 'pb' && g.key !== 'rival' && !wanted.has(g.key))) this.removeGhost(g.key);
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

  /** Ghost karts are cloned from one template per colour: shared geometry and materials, no rebuild hitch.
   *  Every template shares one geometry too, so a ghost of a new colour uploads nothing. */
  private ghostVisual(color: string): KartVisual {
    let tpl = this.ghostTemplates.get(color);
    if (!tpl) {
      tpl = buildGhost(color, this.ghostTemplates.values().next().value).root;
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
    Object.assign(this.cam, { ox: 0, oy: 0, oz: 0, vx: 0, vy: 0, vz: 0, fov: 0, fovV: 0, shake: 0, side: 0 });
  }

  /** A wall hit kicks the camera away from the wall, punches the FOV and starts a short shake. */
  private kickCamera(speed: number, nx: number, nz: number) {
    const k = Math.min(1, speed / 8);
    const c = this.cam;
    c.vx -= nx * 3 * k;
    c.vz -= nz * 3 * k;
    c.vy += 1.3 * k;
    c.fovV += 55 * k;
    c.shake = Math.min(1, c.shake + 0.8 * k);
  }

  /** Advance the camera springs; returns the shake offset to add this frame (deterministic in simT). */
  private springCamera(dt: number, fb: FxFrame, out: THREE.Vector3) {
    const c = this.cam;
    // Damped springs: the kick at ω 18 rad/s, ζ 0.5; the FOV punch softer at ω 12, ζ 0.6.
    for (let left = dt; left > 1e-6; ) {
      const h = Math.min(left, 1 / 120);
      left -= h;
      c.vx += (-324 * c.ox - 18 * c.vx) * h;
      c.vy += (-324 * c.oy - 18 * c.vy) * h;
      c.vz += (-324 * c.oz - 18 * c.vz) * h;
      c.ox += c.vx * h;
      c.oy += c.vy * h;
      c.oz += c.vz * h;
      c.fovV += (-144 * c.fov - 14.4 * c.fovV) * h;
      c.fov += c.fovV * h;
    }
    c.shake *= Math.exp(-dt / 0.22);
    const t = this.simT;
    const sh = c.shake;
    // Two smooth octaves instead of per-frame white noise; then a few millimetres of kerb buzz at the
    // stripe rate and a grass rumble.
    const kerb = fb.kerb * 0.004 * (Math.sin((Math.PI * this.phys.s) / 0.8) > 0 ? 1 : -1);
    const grass = fb.grass * 0.005 * (Math.sin(53 * t) + Math.sin(71 * t + 1));
    out.set(
      c.ox + sh * (0.1 * Math.sin(41 * t) + 0.04 * Math.sin(97 * t + 1.3)),
      c.oy + sh * (0.08 * Math.sin(37 * t + 0.7) + 0.03 * Math.sin(89 * t + 2.1)) + kerb + grass,
      c.oz,
    );
    return out;
  }

  // Scratch objects reused every frame (no per-frame allocations, so no GC hitches).
  private readonly v = { fwd: new THREE.Vector3(), pos: new THREE.Vector3(), look: new THREE.Vector3(), tmp: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  private prev = { x: 0, z: 0, h: 0 };
  private body = { vf: 0, acc: 0 }; // low-passed longitudinal acceleration for the body pitch
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
    // Body motion from the real accelerations (render only): dive under braking, squat on the power,
    // roll that only saturates near 3 g, and on the kerb a bob at the stripe rate that follows speed.
    const vf = p.forwardSpeed;
    if (dt > 0) this.body.acc += (THREE.MathUtils.clamp((vf - this.body.vf) / dt, -40, 40) - this.body.acc) * (1 - Math.exp(-dt * 50));
    this.body.vf = vf;
    k.body.rotation.z += (THREE.MathUtils.clamp(p.yawRate * vf * 0.0028, -0.08, 0.08) - k.body.rotation.z) * Math.min(1, dt * 8);
    k.body.rotation.x += (THREE.MathUtils.clamp(-0.0035 * this.body.acc, -0.025, 0.04) - k.body.rotation.x) * Math.min(1, dt * 8);
    const stripe = Math.sin((Math.PI * p.s) / 0.8) > 0 ? 1 : -1;
    k.body.position.y = p.surface === 'grass' ? Math.sin(this.simT * 40) * 0.012 : p.onKerb ? stripe * 0.014 * Math.min(1, p.speed / 10) : 0;
    for (const f of k.frontPivots) f.rotation.y = -p.steerAngle * 1.2;
    for (const w of k.wheels) w.rotation.x = p.wheelSpin;
    const live = this.state === 'grid' || this.state === 'racing';
    const fb = this.fx.frame(live ? dt : 0, this.camera, this.pipeline.renderer, this.pipeline.quality, this.atmos.time === 'night');
    if (live) {
      if (fb.impact) {
        this.audio.impact(fb.impact);
        this.haptics.impact(fb.impact);
        this.kickCamera(fb.impact, fb.nx, fb.nz);
      }
      this.haptics.kerb(fb.kerb, p.speed);
      const pb = this.pb?.ms ?? null;
      if (pb !== this.pbSeen && this.pbSeen !== undefined && pb !== null) this.haptics.personalBest();
      this.pbSeen = pb;
      const cockpit = CAMS[this.camMode].id === 'hood';
      this.audio.update({ speed: p.speed, vmax: p.vmax, throttle: this.throttle, squeal: fb.squeal, kerb: fb.kerb, grass: fb.grass, scrape: fb.scrape, cockpit });
    }

    const { fwd, pos, look, tmp, up } = this.v;
    fwd.set(Math.sin(heading), 0, Math.cos(heading));
    const mode = CAMS[this.camMode].id;
    const cam = this.cam;
    // Portrait phones (0 at aspect 0.8 or wider, 1 at 0.48 and taller): with the wider view below, the
    // chase camera sits higher and looks down a little more, so the road ahead fills the screen between
    // the timing panels and the speedometer instead of sky.
    const tall = THREE.MathUtils.clamp((0.8 - this.camera.aspect) / 0.32, 0, 1);
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
      // Look a little into the corner, toward the apex (yawRate > 0 turns left).
      const side = THREE.MathUtils.clamp(-p.yawRate * p.forwardSpeed * 0.04, -1, 1);
      cam.side += (side - cam.side) * (1 - Math.exp(-dt * 3));
      tmp.set(-fwd.z, 0, fwd.x); // right of travel
      pos.set(x, far ? 4.2 + 0.8 * tall : 2.3 + 1.5 * tall, z).addScaledVector(fwd, far ? -9.5 : -5.2 - 0.4 * tall);
      look.set(x, 0.7 - 0.3 * tall, z).addScaledVector(fwd, 3.5 + 0.5 * tall).addScaledVector(tmp, cam.side);
    }
    this.camPos.lerp(pos, lerp);
    this.camLook.lerp(look, Math.min(1, lerp * 1.6));
    const shake = this.springCamera(live ? dt : 0, fb, tmp);
    const amount = this.state === 'intro' || mode === 'tv' ? 0 : mode === 'hood' ? 0.5 : 1;
    this.camera.position.copy(this.camPos).addScaledVector(shake, amount);
    this.camera.lookAt(this.camLook);
    // FOV: wider with speed; never narrower than 44-50° across (portrait phones), at most 100° tall;
    // plus the impact punch.
    const base = this.state === 'intro' ? 42 : (mode === 'hood' ? 70 : 60) + p.speed * 0.38;
    const across = this.state === 'intro' ? 0 : 44 + 6 * Math.min(1, p.speed / p.vmax);
    const floor = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(across / 2)) / this.camera.aspect));
    cam.fovBase += (Math.min(100, Math.max(base, floor)) - cam.fovBase) * Math.min(1, dt * 4);
    const fov = cam.fovBase + cam.fov * amount;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
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
        g.strokeStyle = '#0b0c10';
        g.stroke();
      }
    });
    const [mx, my] = map(kx, kz);
    g.beginPath();
    g.arc(mx, my, 9, 0, Math.PI * 2);
    g.fillStyle = this.opts.driver.color;
    g.fill();
    g.lineWidth = 3.5;
    g.strokeStyle = '#f2f3f5';
    g.stroke();
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

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
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

export { localPB } from './prefs';
