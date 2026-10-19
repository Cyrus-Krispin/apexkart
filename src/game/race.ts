import * as THREE from 'three';
import { TrackModel } from './track';
import { buildTrackScene, type TrackScene } from './trackMesh';
import { buildSatelliteGround } from './satellite';
import { buildKart, KartPhysics, type KartVisual } from './kart';
import { Input } from './input';
import { KartAudio } from './audio';
import { decodeGhost, encodeGhost, sampleGhost, GHOST_DT, type GhostData, type GhostFrame } from '../shared/ghost';
import type { TrackData } from '../track/osm';
import { api, escapeHtml, formatMs, type BoardResponse, type Dir, type Driver } from '../net/api';

export interface RaceOptions {
  track: TrackData;
  dir: Dir;
  driver: Driver;
  container: HTMLElement;
  onExit: () => void;
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
const CAMS = ['chase', 'far', 'hood', 'tv'] as const;

export class Race {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.1, 5000);
  private track: TrackModel;
  private trackScene!: TrackScene;
  private kart: KartVisual;
  private phys: KartPhysics;
  private input: Input;
  private audio = new KartAudio();
  private sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  private root: HTMLElement;
  private $: Record<string, HTMLElement> = {};
  private raf = 0;
  private lastFrame = 0;
  private acc = 0;
  private disposed = false;

  // race state
  private state: 'grid' | 'racing' | 'paused' = 'grid';
  private simT = 0;
  private gridT = 0;
  private goAt = 0;
  private lightsLit = 0;
  private lapStart: number | null = null;
  private lapNo = 0;
  private lastS = 0;
  private sectorsHit = [false, false];
  private sectorTimes: number[] = [];
  private invalid = false;
  private wrongWayT = 0;
  private ghostRec: GhostFrame[] = [];
  private splits: number[] = [];
  private sessionBest: number | null = null;
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
  private boardSig = '';
  private toastQ: HTMLElement;
  private minimap!: { canvas: HTMLCanvasElement; bg: HTMLCanvasElement; map: (x: number, z: number) => [number, number] };
  private skid!: { geo: THREE.BufferGeometry; pos: Float32Array; i: number; prev: (THREE.Vector3 | null)[] };
  private centerMsgUntil = 0;

  constructor(private opts: RaceOptions) {
    this.track = new TrackModel(opts.track, opts.dir === 'rev');
    this.pbKey = `ak:pb:${opts.track.id}:${opts.dir}`;
    this.pb = this.loadPB();
    this.bestSectors = this.pb?.sectors.slice() ?? [];

    this.root = document.createElement('div');
    this.root.className = 'race';
    this.root.innerHTML = HUD_HTML;
    opts.container.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((el) => (this.$[el.dataset.el!] = el));
    this.toastQ = this.$.toasts;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.root.prepend(this.renderer.domElement);

    this.input = new Input(this.$.touch);
    this.phys = new KartPhysics(this.track);
    this.kart = buildKart(opts.driver.color, { number: 7 });
    this.buildWorld();
    this.scene.add(this.kart.root);
    this.buildMinimap();
    this.buildSkids();

    this.$.trackName.textContent = opts.track.name;
    this.$.dirTag.textContent = opts.dir === 'rev' ? 'REVERSE' : '';
    this.$.dirTag.hidden = opts.dir !== 'rev';
    this.$.best.textContent = formatMs(this.pb?.ms);
    this.bindButtons();
    this.resetToGrid();

    addEventListener('resize', this.onResize);
    this.onResize();
    if (import.meta.env.DEV) (window as any).__race = this;
    this.refreshBoard();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------- setup

  private buildWorld() {
    const s = this.scene;
    s.background = new THREE.Color(0xa9cdee);
    s.fog = new THREE.Fog(0xa9cdee, 300, 1400);
    s.add(new THREE.HemisphereLight(0xdcecff, 0x4a5a3a, 1.1));
    this.sun.position.set(60, 120, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -30;
    sc.right = sc.top = 30;
    sc.near = 10;
    sc.far = 300;
    this.sun.shadow.bias = -0.0004;
    s.add(this.sun, this.sun.target);

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x4f6b3a }),
    );
    grass.position.y = -0.08;
    grass.receiveShadow = true;
    s.add(grass);

    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.trackScene = buildTrackScene(this.track, aniso);
    s.add(this.trackScene.group);

    this.$.loading.hidden = false;
    buildSatelliteGround(this.track, aniso)
      .then((mesh) => {
        if (this.disposed) return;
        if (mesh) {
          mesh.position.y = -0.02;
          s.add(mesh);
        }
      })
      .finally(() => (this.$.loading.hidden = true));
  }

  private buildMinimap() {
    const canvas = this.$.minimap as HTMLCanvasElement;
    const size = 200;
    canvas.width = canvas.height = size * 2;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    const t = this.track;
    for (let i = 0; i < t.n; i++) {
      minX = Math.min(minX, t.px[i]);
      maxX = Math.max(maxX, t.px[i]);
      minZ = Math.min(minZ, t.pz[i]);
      maxZ = Math.max(maxZ, t.pz[i]);
    }
    const scale = (size * 2 - 40) / Math.max(maxX - minX, maxZ - minZ);
    const ox = (size * 2 - (maxX - minX) * scale) / 2;
    const oz = (size * 2 - (maxZ - minZ) * scale) / 2;
    const map = (x: number, z: number): [number, number] => [ox + (x - minX) * scale, oz + (z - minZ) * scale];
    const bg = document.createElement('canvas');
    bg.width = bg.height = size * 2;
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
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 16;
    g.stroke();
    path();
    g.strokeStyle = '#e9edf2';
    g.lineWidth = 7;
    g.stroke();
    // sector ticks
    for (const frac of [0, 1 / 3, 2 / 3]) {
      const i = Math.floor(frac * t.n);
      const [x, y] = map(t.px[i], t.pz[i]);
      const [nx, nz] = t.normal(i);
      g.strokeStyle = frac === 0 ? '#ffd60a' : '#ff5a1f';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(x - nx * 12, y - nz * 12);
      g.lineTo(x + nx * 12, y + nz * 12);
      g.stroke();
    }
    this.minimap = { canvas, bg, map };
  }

  private buildSkids() {
    const max = 3000;
    const pos = new Float32Array(max * 6 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.skid = { geo, pos, i: 0, prev: [null, null] };
  }

  private bindButtons() {
    this.root.querySelectorAll<HTMLElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'resume') this.togglePause(false);
        if (a === 'restart') {
          this.togglePause(false);
          this.resetToGrid();
        }
        if (a === 'exit') this.opts.onExit();
        if (a === 'pause') this.togglePause();
        if (a === 'mute') this.$.muteBtn.textContent = this.audio.toggleMute() ? 'Sound: off' : 'Sound: on';
        if (a === 'ghosts') this.toggleGhosts();
        if (a === 'cam') this.camMode = (this.camMode + 1) % CAMS.length;
      }),
    );
    this.$.muteBtn.textContent = this.audio.muted ? 'Sound: off' : 'Sound: on';
    // Browsers need a gesture before audio can start.
    const unlock = () => this.audio.start();
    addEventListener('keydown', unlock, { once: true });
    addEventListener('pointerdown', unlock, { once: true });
  }

  // ---------- race flow

  private resetToGrid() {
    this.phys.place(this.track.length - 14);
    this.lastS = this.phys.s = this.track.length - 14;
    this.state = 'grid';
    this.gridT = 0;
    this.goAt = 3.4 + 0.4 + Math.random() * 0.9;
    this.lightsLit = 0;
    this.lapStart = null;
    this.lapNo = 0;
    this.invalid = false;
    this.trackScene.lights.forEach((m) => (m.emissiveIntensity = 0));
    this.$.lapTime.textContent = formatMs(0);
    this.$.lap.textContent = '–';
    this.$.delta.textContent = '';
    this.setSectors([]);
    this.snapCamera();
    this.centerMsg('', 0);
  }

  private togglePause(force?: boolean) {
    const pause = force ?? this.state !== 'paused';
    if (pause && this.state !== 'paused') {
      this.prevState = this.state;
      this.state = 'paused';
      this.audio.silence();
    } else if (!pause && this.state === 'paused') {
      this.state = this.prevState;
    }
    this.$.pause.hidden = this.state !== 'paused';
  }
  private prevState: 'grid' | 'racing' = 'grid';

  private toggleGhosts() {
    this.showGhosts = !this.showGhosts;
    localStorage.setItem('ak:ghosts', this.showGhosts ? '1' : '0');
    this.toast(this.showGhosts ? 'Ghosts on' : 'Ghosts off');
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.input.consume('Escape') || this.input.consume('p')) this.togglePause();
    if (this.input.consume('c')) this.camMode = (this.camMode + 1) % CAMS.length;
    if (this.input.consume('m')) this.$.muteBtn.textContent = this.audio.toggleMute() ? 'Sound: off' : 'Sound: on';
    if (this.input.consume('g')) this.toggleGhosts();
    if (this.input.consume('r') && this.state === 'racing') this.recover();

    if (this.state !== 'paused') {
      this.acc += dt;
      while (this.acc >= STEP) {
        this.tick(STEP);
        this.acc -= STEP;
      }
    }
    this.boardTimer -= dt;
    if (this.boardTimer <= 0) this.refreshBoard();
    this.render(dt);
  };

  private tick(dt: number) {
    const c = this.autopilot ? this.autoControls() : this.input.read(dt);
    if (this.state === 'grid') {
      this.gridT += dt;
      const lit = Math.min(5, Math.floor((this.gridT - 0.8) / 0.65) + 1);
      if (lit > this.lightsLit && this.gridT >= 0.8) {
        this.lightsLit = lit;
        this.trackScene.lights.forEach((m, k) => (m.emissiveIntensity = k < lit ? 4 : 0));
        this.audio.beep(false);
        this.$.lights.innerHTML = '<i></i>'.repeat(5).replace(/<i><\/i>/g, (m, off) => (off / 7 < lit ? '<i class="on"></i>' : m));
      }
      if (this.gridT >= this.goAt) {
        this.state = 'racing';
        this.trackScene.lights.forEach((m) => (m.emissiveIntensity = 0));
        this.$.lights.innerHTML = '';
        this.audio.beep(true);
        this.centerMsg('GO!', 1.0, 'go');
      }
      c.throttle = c.brake = 0;
    }
    this.simT += dt;
    this.phys.step(dt, c);
    this.audio.update(this.phys.speed, c.throttle, this.phys.slip, this.phys.surface === 'grass');
    if (this.state === 'racing') this.timing(dt);
    this.updateSkids(c.drift);
    this.throttle = c.throttle;
  }
  private throttle = 0;
  autopilot = false;

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

    if (crossedBack && this.lapStart !== null) {
      this.invalidate('Reversed over the line');
    }
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
      this.invalid = false;
      this.ghostRec = [];
      this.splits = [];
      this.$.lap.textContent = String(this.lapNo);
      this.setSectors([]);
    }
    if (this.lapStart === null) return;

    const lapT = (this.simT - this.lapStart) * 1000;
    // Sectors at 1/3 and 2/3 distance.
    for (let k = 0; k < 2; k++) {
      const b = (L * (k + 1)) / 3;
      if (!this.sectorsHit[k] && prev < b && s >= b && s - prev < 30) {
        if (k === 1 && !this.sectorsHit[0]) this.invalidate('Missed a sector');
        this.sectorsHit[k] = true;
        const total = this.sectorTimes.reduce((a, x) => a + x, 0);
        this.sectorTimes.push(lapT - total);
        this.setSectors(this.sectorTimes);
      }
    }
    // Track limits: all four wheels well off the circuit.
    if (!this.invalid && this.phys.offset !== 0 && Math.abs(this.phys.offset) > this.track.halfWidth + 2.4) this.invalidate('Track limits');

    // Wrong way
    const t = this.track;
    const i = this.phys.hint;
    const along = this.phys.vx * t.tx[i] + this.phys.vz * t.tz[i];
    this.wrongWayT = along < -3 ? this.wrongWayT + dt : 0;
    if (this.wrongWayT > 1.2) this.centerMsg('WRONG WAY', 0.3, 'warn');

    // Ghost samples + distance splits.
    while (this.ghostRec.length * GHOST_DT * 1000 <= lapT) this.ghostRec.push({ x: this.phys.x, z: this.phys.z, h: this.phys.heading });
    const si = Math.floor(s / SPLIT);
    if (s < L - 5) while (this.splits.length <= si) this.splits.push(lapT);
  }

  private invalidate(reason: string) {
    if (this.invalid || this.lapStart === null) return;
    this.invalid = true;
    this.centerMsg(`LAP INVALID · ${reason.toUpperCase()}`, 1.8, 'warn');
    this.$.lapTime.classList.add('invalid');
  }

  private recover() {
    const p = this.track.at(this.phys.s);
    this.phys.place(this.phys.s);
    this.phys.x = p.x;
    this.phys.z = p.z;
    this.invalidate('Reset');
    this.snapCamera();
  }

  private finishLap(tCross: number) {
    const ms = Math.round((tCross - (this.lapStart ?? tCross)) * 1000);
    this.$.lapTime.classList.remove('invalid');
    const s1 = Math.round(this.sectorTimes[0] ?? 0);
    const s2 = Math.round(this.sectorTimes[1] ?? 0);
    const sectors = this.sectorTimes.length === 2 ? [s1, s2, ms - s1 - s2] : [];
    const valid = !this.invalid && this.sectorsHit[0] && this.sectorsHit[1] && sectors.length === 3;
    this.$.last.textContent = formatMs(ms) + (valid ? '' : ' ✕');
    if (!valid) return;
    this.setSectors(sectors, true);
    sectors.forEach((v, k) => {
      if (!this.bestSectors[k] || v < this.bestSectors[k]) this.bestSectors[k] = v;
    });
    if (this.sessionBest === null || ms < this.sessionBest) this.sessionBest = ms;

    if (!this.pb || ms < this.pb.ms) {
      const prevPb = this.pb?.ms;
      this.ghostRec.push({ x: this.phys.x, z: this.phys.z, h: this.phys.heading });
      this.pb = { ms, sectors, splits: this.splits.slice(), ghost: encodeGhost(this.ghostRec) };
      this.savePB();
      this.$.best.textContent = formatMs(ms);
      this.centerMsg(prevPb ? `PERSONAL BEST  −${((prevPb - ms) / 1000).toFixed(3)}` : 'FIRST TIMED LAP', 2.2, 'pb');
      this.setGhost('pb', 'Your best', this.opts.driver.color, this.pb.ghost);
      this.submit();
    } else {
      this.centerMsg(`${formatMs(ms)}   +${((ms - this.pb.ms) / 1000).toFixed(3)}`, 1.6);
    }
  }

  private nextSyncAt = 0;

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
      if (res.improved) this.toast(`🏁 P${res.rank} of ${res.total} on the live leaderboard`, 'gold');
      this.refreshBoard();
    } catch (e) {
      const msg = (e as Error).message;
      if (/^(bad|lap too|ghost|sectors)/.test(msg)) {
        // The server rejected this lap outright: keep it locally, don't retry.
        this.pb.synced = true;
        this.savePB();
        this.toast(`Lap not accepted by leaderboard: ${msg}`, 'warn');
      } else this.toast(`Leaderboard offline — lap saved locally`, 'warn');
    }
  }

  // ---------- leaderboard + ghosts

  private async refreshBoard() {
    this.boardTimer = 4;
    const d = this.opts.driver;
    try {
      const b = await api.board(this.opts.track.id, this.opts.dir, { pid: d.pid, name: d.name, color: d.color });
      if (this.disposed) return;
      this.board = b;
      this.renderBoard();
      // A PB that never reached the server (e.g. offline earlier): sync it now.
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
      this.$.board.innerHTML = '<div class="muted">Leaderboard offline. Your laps are saved on this device.</div>';
    }
  }

  private renderBoard() {
    const b = this.board!;
    const me = this.opts.driver.pid;
    const lead = b.entries[0]?.ms;
    const sig = b.entries.map((e) => e.pid + e.ms).join();
    const changed = this.boardSig && sig !== this.boardSig;
    this.boardSig = sig;
    const rows = b.entries
      .map(
        (e) => `<li class="${e.pid === me ? 'me' : ''}">
          <span class="pos">${e.rank}</span>
          <span class="dot" style="background:${escapeHtml(e.color)}"></span>
          <span class="nm">${escapeHtml(e.name)}</span>
          <span class="tm">${e.rank === 1 ? formatMs(e.ms) : '+' + ((e.ms - lead) / 1000).toFixed(3)}</span>
        </li>`,
      )
      .join('');
    const others = b.onTrack.filter((o) => o.pid !== me);
    this.$.board.innerHTML =
      (rows ? `<ol>${rows}</ol>` : '<div class="muted">No laps yet. Set the first time!</div>') +
      `<div class="ontrack"><span class="live-dot"></span>${others.length ? `${others.length + 1} on track now: you, ${others.map((o) => escapeHtml(o.name)).join(', ')}` : 'Only you on track'}</div>`;
    this.$.boardCount.textContent = b.total ? `${b.total} driver${b.total > 1 ? 's' : ''}` : '';
    if (changed) {
      this.$.boardPanel.classList.remove('flash');
      void this.$.boardPanel.offsetWidth;
      this.$.boardPanel.classList.add('flash');
    }
  }

  private async syncBoardGhosts() {
    const me = this.opts.driver.pid;
    const top = (this.board?.entries ?? []).filter((e) => e.pid !== me).slice(0, 3);
    const wanted = new Set(top.map((e) => `${e.pid}:${e.ms}`));
    for (const g of this.ghosts.filter((g) => g.key !== 'pb' && !wanted.has(g.key))) this.removeGhost(g.key);
    for (const e of top) {
      const key = `${e.pid}:${e.ms}`;
      if (this.ghosts.some((g) => g.key === key)) continue;
      this.ghosts.push({ key, pending: true } as any); // reserve to avoid duplicate fetches
      try {
        const r = await api.ghost(this.opts.track.id, this.opts.dir, e.pid);
        this.ghosts = this.ghosts.filter((g) => g.key !== key);
        if (r.ghost && !this.disposed) this.setGhost(key, `P${e.rank} ${e.name}`, e.color, r.ghost);
      } catch {
        this.ghosts = this.ghosts.filter((g) => g.key !== key);
      }
    }
  }

  private setGhost(key: string, label: string, color: string, data: GhostData) {
    this.removeGhost(key);
    const visual = buildKart(color, { ghost: true });
    this.scene.add(visual.root);
    const tag = document.createElement('div');
    tag.className = 'ghost-tag';
    tag.textContent = label;
    tag.style.borderColor = color;
    this.$.tags.appendChild(tag);
    this.ghosts.push({ key, label, color, frames: decodeGhost(data), dt: data.dt, visual, tag });
  }

  private removeGhost(key: string) {
    const g = this.ghosts.find((x) => x.key === key);
    if (!g) return;
    if (g.visual) this.scene.remove(g.visual.root);
    g.tag?.remove();
    this.ghosts = this.ghosts.filter((x) => x !== g);
  }

  // ---------- render

  private snapCamera() {
    this.camPos.set(this.phys.x - Math.sin(this.phys.heading) * 6, 2.6, this.phys.z - Math.cos(this.phys.heading) * 6);
    this.camLook.set(this.phys.x, 0.6, this.phys.z);
  }

  private render(dt: number) {
    const p = this.phys;
    const k = this.kart;
    k.root.position.set(p.x, 0, p.z);
    k.root.rotation.y = p.heading;
    // Body roll and pitch from lateral/longitudinal load.
    k.body.rotation.z += (THREE.MathUtils.clamp(p.yawRate * p.forwardSpeed * 0.004, -0.07, 0.07) - k.body.rotation.z) * Math.min(1, dt * 8);
    k.body.rotation.x += ((this.throttle ? -0.012 : 0.01) - k.body.rotation.x) * Math.min(1, dt * 5);
    k.body.position.y = p.surface === 'grass' ? Math.sin(this.simT * 40) * 0.012 : p.surface === 'kerb' ? Math.sin(this.simT * 70) * 0.02 : 0;
    k.frontPivots.forEach((f) => (f.rotation.y = -p.steerAngle * 1.2));
    k.wheels.forEach((w) => (w.rotation.x = p.wheelSpin));

    // Camera
    const fwd = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
    const mode = CAMS[this.camMode];
    const speed = p.speed;
    let wantPos: THREE.Vector3;
    let wantLook: THREE.Vector3;
    let lerp = 1 - Math.exp(-dt * 7);
    if (mode === 'hood') {
      wantPos = new THREE.Vector3(p.x, 1.12, p.z).addScaledVector(fwd, 0.1);
      wantLook = new THREE.Vector3(p.x, 0.9, p.z).addScaledVector(fwd, 10);
      lerp = 1;
    } else if (mode === 'tv') {
      wantPos = new THREE.Vector3(p.x, 34, p.z).addScaledVector(fwd, -18);
      wantLook = new THREE.Vector3(p.x, 0, p.z).addScaledVector(fwd, 6);
      lerp = 1 - Math.exp(-dt * 3);
    } else {
      const far = mode === 'far';
      wantPos = new THREE.Vector3(p.x, far ? 4.2 : 2.3, p.z).addScaledVector(fwd, far ? -9.5 : -5.2);
      wantLook = new THREE.Vector3(p.x, 0.7, p.z).addScaledVector(fwd, 3.5);
    }
    this.camPos.lerp(wantPos, lerp);
    this.camLook.lerp(wantLook, Math.min(1, lerp * 1.6));
    this.camera.position.copy(this.camPos);
    if (p.bump > 0.02) this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * p.bump * 0.4, (Math.random() - 0.5) * p.bump * 0.3, 0));
    this.camera.lookAt(this.camLook);
    const fov = (mode === 'hood' ? 70 : 60) + speed * 0.38;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
    }
    this.kart.root.visible = mode !== 'hood' || true;

    // Sun follows the kart so shadows stay crisp.
    this.sun.position.set(p.x + 40, 90, p.z + 25);
    this.sun.target.position.set(p.x, 0, p.z);

    // Ghosts
    const lapT = this.lapStart !== null && this.state !== 'grid' ? this.simT - this.lapStart : -1;
    const tmp = new THREE.Vector3();
    for (const g of this.ghosts) {
      if (!g.visual) continue;
      const pose = this.showGhosts && lapT >= 0 ? sampleGhost(g.frames, g.dt, lapT) : null;
      g.visual.root.visible = !!pose;
      if (!pose) {
        g.tag.style.display = 'none';
        continue;
      }
      g.visual.root.position.set(pose.x, 0, pose.z);
      g.visual.root.rotation.y = pose.h;
      tmp.set(pose.x, 1.6, pose.z).project(this.camera);
      const dist = this.camera.position.distanceTo(g.visual.root.position);
      if (tmp.z < 1 && dist < 150 && dist > 2.5) {
        g.tag.style.display = '';
        g.tag.style.transform = `translate(${((tmp.x + 1) / 2) * innerWidth}px, ${((1 - tmp.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
      } else g.tag.style.display = 'none';
    }

    this.renderer.render(this.scene, this.camera);
    this.drawHud(lapT);
  }

  private drawHud(lapT: number) {
    const p = this.phys;
    this.$.speed.textContent = String(Math.round(p.speed * 3.6));
    (this.$.speedBar as HTMLElement).style.setProperty('--v', String(Math.min(1, p.speed / p.vmax)));
    if (lapT >= 0) {
      this.$.lapTime.textContent = formatMs(lapT * 1000);
      // Live delta vs PB at the same distance.
      const si = Math.floor(p.s / SPLIT);
      if (this.pb?.splits[si] !== undefined && si < this.splits.length && si > 1) {
        const d = (lapT * 1000 - this.pb.splits[si]) / 1000;
        this.$.delta.textContent = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2);
        this.$.delta.className = 'delta ' + (d >= 0 ? 'slow' : 'fast');
      } else this.$.delta.textContent = '';
    }
    if (this.centerMsgUntil && this.simT > this.centerMsgUntil) {
      this.$.center.className = 'center-msg';
      this.centerMsgUntil = 0;
    }
    // Minimap
    const { canvas, bg, map } = this.minimap;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bg, 0, 0);
    const dot = (x: number, z: number, color: string, r: number, ring = false) => {
      const [mx, my] = map(x, z);
      g.beginPath();
      g.arc(mx, my, r, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      if (ring) {
        g.lineWidth = 3;
        g.strokeStyle = '#fff';
        g.stroke();
      }
    };
    for (const gh of this.ghosts) if (gh.visual?.root.visible) dot(gh.visual.root.position.x, gh.visual.root.position.z, gh.color + 'aa', 7);
    dot(p.x, p.z, this.opts.driver.color, 9, true);
  }

  private setSectors(times: number[], final = false) {
    const boxes = this.$.sectors.children;
    for (let k = 0; k < 3; k++) {
      const el = boxes[k] as HTMLElement;
      const t = times[k];
      if (t === undefined) {
        el.className = '';
        el.textContent = `S${k + 1}`;
        continue;
      }
      const leader = this.board?.entries[0]?.sectors?.[k];
      const purple = (!leader || t <= leader) && (!this.bestSectors[k] || t <= this.bestSectors[k]);
      const green = !this.bestSectors[k] || t <= this.bestSectors[k];
      el.className = purple ? 'purple' : green ? 'green' : 'yellow';
      el.textContent = (t / 1000).toFixed(final ? 3 : 2);
    }
  }

  private centerMsg(text: string, secs: number, kind = '') {
    this.$.center.textContent = text;
    this.$.center.className = `center-msg ${text ? 'show' : ''} ${kind}`;
    this.centerMsgUntil = text ? this.simT + secs : 0;
  }

  private toast(text: string, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    this.toastQ.appendChild(t);
    setTimeout(() => t.classList.add('out'), 3800);
    setTimeout(() => t.remove(), 4400);
  }

  private updateSkids(drift: boolean) {
    const p = this.phys;
    const skidding = p.surface !== 'grass' && p.speed > 4 && (p.slip > 2.6 || (drift && Math.abs(p.yawRate) > 0.6));
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    const sk = this.skid;
    [-0.6, 0.6].forEach((side, w) => {
      const cur = new THREE.Vector3(p.x - fz * side * -1 - fx * 0.62, 0.05, p.z + fx * side * -1 - fz * 0.62);
      const prev = sk.prev[w];
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
        sk.prev[w] = cur;
      } else if (!skidding) sk.prev[w] = null;
      else if (!prev) sk.prev[w] = cur;
    });
  }

  private onResize = () => {
    const w = this.root.clientWidth || innerWidth;
    const h = this.root.clientHeight || innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  // ---------- persistence

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

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      mats.forEach((x) => {
        (x as THREE.MeshStandardMaterial).map?.dispose();
        x.dispose();
      });
    });
    this.root.remove();
  }
}

/** Local personal best for a track (used by the picker). */
export function localPB(trackId: string, dir: Dir): number | null {
  try {
    return JSON.parse(localStorage.getItem(`ak:pb:${trackId}:${dir}`) || 'null')?.ms ?? null;
  } catch {
    return null;
  }
}

const HUD_HTML = /* html */ `
<div class="hud">
  <div class="hud-tl glass">
    <div class="trk"><span data-el="trackName"></span> <em data-el="dirTag"></em></div>
    <div class="lapline"><span class="lbl">LAP</span> <b data-el="lap">–</b></div>
    <div class="laptime" data-el="lapTime">0:00.000</div>
    <div class="delta" data-el="delta"></div>
    <div class="sectors" data-el="sectors"><span>S1</span><span>S2</span><span>S3</span></div>
    <div class="rows">
      <div><span class="lbl">LAST</span><b data-el="last">--:--.---</b></div>
      <div><span class="lbl">BEST</span><b data-el="best">--:--.---</b></div>
    </div>
  </div>
  <div class="hud-tr">
    <canvas class="minimap glass" data-el="minimap"></canvas>
    <div class="glass board" data-el="boardPanel">
      <div class="board-h"><span><span class="live-dot"></span> LIVE LEADERBOARD</span><small data-el="boardCount"></small></div>
      <div data-el="board"><div class="muted">Loading…</div></div>
    </div>
  </div>
  <div class="hud-br">
    <div class="speedo" data-el="speedBar"><b data-el="speed">0</b><span>km/h</span></div>
  </div>
  <div class="start-lights" data-el="lights"></div>
  <div class="center-msg" data-el="center"></div>
  <div class="toasts" data-el="toasts"></div>
  <div class="tags" data-el="tags"></div>
  <div class="loading-sat" data-el="loading">Loading satellite imagery…</div>
  <div class="hud-bl">
    <button class="icon-btn" data-act="pause" title="Pause (Esc)">❚❚</button>
    <button class="icon-btn" data-act="cam" title="Camera (C)">🎥</button>
    <button class="icon-btn" data-act="ghosts" title="Ghosts (G)">👻</button>
    <span class="keys">WASD / ↑↓←→ drive · Space drift · R reset · C cam · G ghosts · M mute · Esc pause</span>
  </div>
  <div class="attrib">Imagery © Esri, Maxar, Earthstar Geographics · Track © OpenStreetMap contributors</div>
  <div class="touch" data-el="touch">
    <div class="tl"><button data-touch="left">◀</button><button data-touch="right">▶</button></div>
    <div class="tr"><button data-touch="drift" class="sm">DRIFT</button><button data-touch="brake">BRAKE</button><button data-touch="gas" class="gas">GAS</button></div>
  </div>
  <div class="pause" data-el="pause" hidden>
    <div class="pause-card glass">
      <h2>Paused</h2>
      <button class="btn primary" data-act="resume">Resume</button>
      <button class="btn" data-act="restart">Restart from grid</button>
      <button class="btn" data-act="mute" data-el="muteBtn">Sound</button>
      <button class="btn" data-act="exit">Back to track map</button>
    </div>
  </div>
</div>`;
