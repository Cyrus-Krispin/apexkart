// Multiplayer race add-on for Race (via src/game/raceMode.ts): tracks race progress and the
// finish, streams the local kart's pose to the room, draws the other karts, and feeds the
// standings/results overlay. The room is an online one (RoomClient), or a party's split screen,
// where each kart's "room" is a seat on a hub in this page (src/game/partyHub.ts).
import { RemoteKarts } from './remoteKarts';
import { RaceOverlay, ordinal, type OverlayView, type StandingRow } from '../ui/raceOverlay';
import { FINISH_GRACE_MS, type GridSlot, type PoseTuple, type RoomState } from '../shared/room';
import type { RoomEvents } from '../net/room';
import { gridPose, type RaceAddon, type RaceContext, type RaceMode } from './raceMode';
import type { KartPhysics } from './kart';
import { LaunchHint, TowIndicator } from './hud';

const SEND_MS = 50; // 20 Hz
const RELAY_CHECK_MS = 500; // how often to ask which links are relayed (their karts are ghosts)
const TOW_DRAG = 0.35; // a full slipstream takes this share off your air drag: +2-4 km/h on a straight
const LIGHTS_LEAD = 3.5; // s before lights out that the first red light comes on (Race: SYNC_GO - 0.9)

/**
 * Race distance from the kart's lap progress: metres covered, 0 = the start line. Progress is
 * continuous (KartPhysics), so the distance follows the kart exactly, back over a backward rejoin
 * and through resets; a forward rejoin that wasn't reset earns nothing, nor does any other
 * unexplained forward jump (a backstop).
 */
export class RaceDistance {
  private prevS: number;
  private placed: number;
  constructor(
    private L: number,
    phys: Pick<KartPhysics, 's' | 'placed'>,
    public dist = phys.s - L, // the grid is just behind the line
  ) {
    this.prevS = phys.s;
    this.placed = phys.placed;
  }

  /** After each physics step; returns the metres added (negative going backwards). */
  update(phys: Pick<KartPhysics, 's' | 'placed' | 'rejoin'>): number {
    let d = phys.s - this.prevS;
    if (d > this.L / 2) d -= this.L;
    else if (d < -this.L / 2) d += this.L;
    const reset = phys.placed !== this.placed;
    if (!reset && d > 0 && (phys.rejoin ? phys.rejoin.gain > 0 : d > 12)) d = 0;
    this.prevS = phys.s;
    this.placed = phys.placed;
    this.dist += d;
    return d;
  }
}

/** What a race needs of its room: RoomClient has all of it, and so does a party seat. */
export interface RaceRoom {
  readonly mid: string;
  readonly state: RoomState | null;
  /** The newest pose sent (heartbeats carry it while the mesh is down). */
  localPose: PoseTuple | null;
  /** Room time for a performance.now() time. */
  readonly clock: { at(perfMs: number): number };
  readonly mesh: { sendPose(p: PoseTuple): void; relayPeers(): Iterable<string> };
  on<K extends 'state' | 'pose' | 'ctl'>(ev: K, fn: RoomEvents[K]): () => void;
  finish(race: number, ms: number | null): Promise<unknown>;
  /**
   * A party: everyone's progress as last reported (laps), the same for every kart on the screen, so
   * the views never disagree on the order (each one's own kart is ahead of what it sees of others).
   */
  progressOf?(mid: string): number | undefined;
}

export interface MpRaceOptions {
  room: RaceRoom;
  race: number;
  grid: GridSlot[];
  laps: number;
  /** performance.now() time of lights out. */
  startAt: number;
  /** Player wants the lobby (results "Back to lobby"). */
  onLobby: () => void;
  /** Positions as 1st, 2nd… (a party, where the players are called P1-P4). */
  ordinals?: boolean;
}

export class MultiplayerRace implements RaceAddon {
  private ctx!: RaceContext;
  private karts!: RemoteKarts;
  private overlay!: RaceOverlay;
  private L = 1;
  private race!: RaceDistance; // laps * L = flag
  private crossSimT: number | null = null;
  /** ms from lights out to the flag; null = retired; undefined = still racing. */
  finishMs: number | null | undefined = undefined;
  private remoteFin = new Map<string, number | null>();
  private gone = new Set<string>();
  private final = false;
  private lastSend = 0;
  private lastHud = 0;
  private lastRelayCheck = 0;
  private towNow = 0; // slipstream strength this step, 0..1
  private towChip!: TowIndicator;
  private launchHint!: LaunchHint;
  private lastLap = 1;
  private offs: (() => void)[] = [];

  constructor(private o: MpRaceOptions) {}

  /** Mode to pass to `new Race({ ..., mode })`. */
  mode(): RaceMode {
    const slot = this.o.grid.findIndex((g) => g.mid === this.o.room.mid);
    return { startAt: this.o.startAt, gridSlot: Math.max(0, slot), ghosts: false, leaderboard: false, restart: false, exitLabel: 'Retire to lobby', addon: this };
  }

  attach(ctx: RaceContext) {
    this.ctx = ctx;
    this.L = ctx.track.length;
    this.race = new RaceDistance(this.L, ctx.phys);
    this.karts = new RemoteKarts(ctx.scene, ctx.camera, ctx.hud, this.L);
    // Everyone waits on their grid slot until their first pose arrives.
    this.o.grid.forEach((g, i) => g.mid !== this.o.room.mid && this.karts.add(g.mid, g.name, g.color, gridPose(ctx.track, i)));
    this.overlay = new RaceOverlay(ctx.hud, { lobby: () => this.o.onLobby() });
    this.towChip = new TowIndicator(ctx.hud);
    this.launchHint = new LaunchHint(ctx.hud);
    const room = this.o.room;
    this.offs.push(
      room.on('pose', (mid, p) => p[9] === this.o.race && this.karts.push(mid, p)),
      room.on('ctl', (mid, m) => {
        if (m.k === 'fin' && m.race === this.o.race) this.setRemoteFin(mid, m.ms);
        if (m.k === 'bye') {
          this.gone.add(mid);
          this.karts.setGone(mid, true);
        }
      }),
      room.on('state', (s) => this.onState(s)),
    );
    if (room.state) this.onState(room.state);
  }

  private onState(s: RoomState) {
    const present = new Set(s.players.map((p) => p.mid));
    for (const g of this.o.grid) {
      const here = present.has(g.mid);
      if (here) this.gone.delete(g.mid);
      else this.gone.add(g.mid);
      this.karts.setGone(g.mid, !here);
    }
    for (const p of s.players) if (p.fin?.r === this.o.race) this.setRemoteFin(p.mid, p.fin.ms);
    // Server closed the race (everyone done, or the grace period ran out).
    if (s.cfg.race !== this.o.race || s.cfg.phase === 'lobby') {
      this.final = true;
      const last = s.cfg.last;
      if (last?.race === this.o.race) for (const r of last.rows) this.setRemoteFin(r.mid, r.ms);
      if (this.finishMs === undefined) this.finishMs = null; // out of time
    }
  }

  /** Someone took the flag (ms) or retired (null): their kart is a ghost from now on. */
  private setRemoteFin(mid: string, ms: number | null) {
    this.remoteFin.set(mid, ms);
    this.karts.setFinished(mid);
  }

  tick(dt: number) {
    const { phys } = this.ctx;
    if (this.finishMs === undefined && this.crossSimT === null) {
      const before = this.race.dist;
      this.race.update(phys);
      const flag = this.o.laps * this.L;
      if (this.race.dist >= flag && this.ctx.state === 'racing') {
        const frac = (flag - before) / Math.max(1e-6, this.race.dist - before);
        this.crossSimT = this.ctx.simT - dt * (1 - frac);
      }
    }
    // Contact: no ghosts before the lights; after your flag everyone passes through you.
    this.karts.setLocal(phys, dt, this.ctx.state === 'racing', this.finishMs !== undefined || this.crossSimT !== null);
    // The state just stepped is one step newer than ctx.physTime (Race lowers it after tick()).
    const now = this.o.room.clock.at(this.ctx.physTime + dt * 1000);
    this.karts.collide(phys, now);
    // Slipstream for the next step: only here, so a time trial's drag is always exactly 1.
    this.towNow = this.karts.tow(phys, now);
    phys.dragScale = 1 - TOW_DRAG * this.towNow;
  }

  frame(dt: number) {
    const room = this.o.room;
    const ctx = this.ctx;
    // Remote karts are drawn at the same instant as the (interpolated) local kart.
    const now = room.clock.at(ctx.viewTime);
    const perf = performance.now();

    if (this.crossSimT !== null && this.finishMs === undefined) {
      // Sim time -> wall time: the newest physics state belongs to ctx.physTime.
      const crossPerf = ctx.physTime - (ctx.simT - this.crossSimT) * 1000;
      this.finishMs = Math.max(1, Math.round(crossPerf - this.o.startAt));
      this.crossSimT = null;
      this.sendFinish(this.finishMs);
      this.ctx.setAutopilot(true); // cool-down lap
    }

    const p = this.ctx.phys;
    const prog = this.progress();
    if (perf - this.lastSend >= SEND_MS) {
      this.lastSend = perf;
      const r2 = (x: number) => Math.round(x * 100) / 100;
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      const pose: PoseTuple = [Math.round(room.clock.at(ctx.physTime)), r2(p.x), r2(p.z), r3(p.heading), r2(p.vx), r2(p.vz), r3(p.yawRate), r3(p.steerAngle), Math.round(prog * 1e4) / 1e4, this.o.race];
      room.mesh.sendPose(pose);
      room.localPose = pose;
    }

    if (perf - this.lastRelayCheck >= RELAY_CHECK_MS) {
      this.lastRelayCheck = perf;
      this.karts.setRelayed(room.mesh.relayPeers());
    }
    this.karts.update(dt, now, ctx.viewW, ctx.viewH);
    this.towChip.set(this.towNow, dt);
    this.launchHint.update(ctx.state === 'grid');

    const lap = this.currentLap();
    if (lap > this.lastLap && this.finishMs === undefined) {
      this.lastLap = lap;
      if (lap === this.o.laps && this.o.laps > 1) this.ctx.banner('Final lap', 'pb', 1.8);
    }
    if (this.finishMs !== undefined && this.lastLap <= this.o.laps) {
      this.lastLap = this.o.laps + 1;
      const pos = this.standings().findIndex((r) => r.me) + 1;
      if (this.finishMs !== null) this.ctx.banner(`Finished ${this.o.ordinals ? ordinal(pos) : `P${pos}`}`, 'go', 3);
    }

    if (perf - this.lastHud > 120) {
      this.lastHud = perf;
      this.overlay.render(this.view());
    }
  }

  minimap(dot: (x: number, z: number, color: string, r: number, ring?: boolean) => void) {
    for (const k of this.karts.list()) if (k.shown) dot(k.x, k.z, k.color, 8, true);
  }

  /** Laps completed + fraction of the current lap (negative on the grid). */
  private progress() {
    return this.race.dist / this.L;
  }

  private currentLap() {
    return Math.max(1, Math.floor(this.race.dist / this.L) + 1);
  }

  /** The start moved later (a party paused on the grid or mid-race): lights out, and every time from it, too. */
  shiftStart(ms: number) {
    this.o.startAt += ms;
  }

  /** Mark the local player as retired (left the race before the flag). */
  retire() {
    if (this.finishMs !== undefined) return;
    this.finishMs = null;
    this.sendFinish(null);
  }

  /** Report the finish (or retirement), retrying: a lost request would otherwise read as a DNF. */
  private sendFinish(ms: number | null, attempt = 0) {
    this.o.room.finish(this.o.race, ms).catch((e) => {
      if (attempt < 4) setTimeout(() => this.sendFinish(ms, attempt + 1), 1500 * (attempt + 1));
      else if (ms !== null) this.ctx.toast(`Couldn’t record finish: ${e.message}`, 'warn');
    });
  }

  standings(): StandingRow[] {
    const room = this.o.room;
    const now = room.clock.at(this.ctx.viewTime);
    const rows = this.o.grid.map((g, i) => {
      const me = g.mid === room.mid;
      const fin = me ? this.finishMs : this.remoteFin.has(g.mid) ? this.remoteFin.get(g.mid) : undefined;
      const shared = room.progressOf?.(g.mid);
      const remote = me || shared !== undefined ? 0 : this.karts.progress(g.mid, now);
      // Before their first pose, a player is where the grid put them.
      const prog = shared ?? (me ? this.progress() : remote >= -0.5 ? remote : gridPose(this.ctx.track, i).s / this.L - 1);
      const status: StandingRow['status'] =
        typeof fin === 'number' ? 'finished' : fin === null ? 'dnf' : !me && this.gone.has(g.mid) ? 'out' : 'racing';
      return { mid: g.mid, name: me ? 'You' : g.name, color: g.color, me, status, ms: typeof fin === 'number' ? fin : null, lap: Math.max(1, Math.floor(prog) + 1), prog };
    });
    const rank = (r: (typeof rows)[number]) => (r.status === 'finished' ? 0 : r.status === 'racing' ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || (a.status === 'finished' ? a.ms! - b.ms! : b.prog - a.prog));
    return rows;
  }

  private view(): OverlayView {
    const rows = this.standings();
    rows.forEach((r, i) => !r.me && this.karts.setLabel(r.mid, this.o.ordinals ? ordinal(i + 1) : `P${i + 1}`));
    const untilGo = (this.o.startAt - performance.now()) / 1000;
    const times = rows.filter((r) => r.status === 'finished').map((r) => r.ms!);
    const graceEnd = times.length ? this.o.startAt + Math.min(...times) + FINISH_GRACE_MS : null;
    return {
      laps: this.o.laps,
      lap: this.currentLap(),
      pos: rows.findIndex((r) => r.me) + 1,
      rows,
      countdown: untilGo > LIGHTS_LEAD + 0.2 ? untilGo - LIGHTS_LEAD : null,
      finished: this.finishMs !== undefined,
      final: this.final,
      graceLeft: graceEnd !== null ? Math.max(0, (graceEnd - performance.now()) / 1000) : null,
      ordinals: this.o.ordinals,
    };
  }

  dispose() {
    this.offs.forEach((f) => f());
    this.karts?.dispose();
    this.overlay?.dispose();
    this.towChip?.dispose();
    this.o.room.localPose = null;
  }
}
