// Watching a multiplayer race (src/watchController.ts): the add-on for a Race with no kart of its
// own (RaceMode.watch). Every player sends this screen their poses as they would to another player,
// so it draws the whole field (src/game/remoteKarts.ts), works out the standings the way the players'
// own race views do (src/game/mpRace.ts), and points the camera at the leader, or at the driver the
// watcher picked. The view is src/ui/watchOverlay.ts.
import { RemoteKarts } from './remoteKarts';
import { WatchOverlay, type WatchView } from '../ui/watchOverlay';
import type { StandingRow } from '../ui/raceOverlay';
import { FINISH_GRACE_MS, type GridSlot, type RoomState } from '../shared/room';
import type { RoomEvents } from '../net/room';
import { gridPose, type Follow, type RaceAddon, type RaceContext } from './raceMode';

const LIGHTS_LEAD = 3.5; // s before lights out that the first red light comes on (as in mpRace.ts)
const SWITCH_AFTER = 1500; // ms a new leader must hold the lead before the camera goes to them...
const STAY_MIN = 4000; // ...and never sooner than this after the last switch
const FLAG_HOLD = 2500; // ms on a kart after its flag (or retirement) before moving on

/** What watching needs of a room: RoomClient has it. */
export interface WatchRoom {
  readonly state: RoomState | null;
  readonly clock: { at(perfMs: number): number };
  on<K extends 'state' | 'pose' | 'ctl'>(ev: K, fn: RoomEvents[K]): () => void;
}

export interface WatchRaceOptions {
  room: WatchRoom;
  code: string;
  race: number;
  grid: GridSlot[];
  laps: number;
  /** performance.now() time of lights out. */
  startAt: number;
  /** The overlay's Room button. */
  onRoom(): void;
  /** The overlay's camera button (the Race owns the camera). */
  onCamera(): void;
  cameraLabel(): string;
}

type Row = StandingRow & { prog: number };

export class WatchRace implements RaceAddon {
  private ctx!: RaceContext;
  private karts!: RemoteKarts;
  private overlay!: WatchOverlay;
  private L = 1;
  private fin = new Map<string, number | null>();
  private finAt = new Map<string, number>(); // performance.now() we heard of each finish
  private gone = new Set<string>();
  /** The race is over for everyone (the room is back in its lobby). */
  final = false;
  private rows: Row[] = [];
  private lastRows = 0;
  private lastHud = 0;
  private moved = false; // karts already moved this frame (by follow)
  /** Who the camera is on; `pinned` when the watcher chose them. */
  target: string | null = null;
  pinned: string | null = null;
  private cand: string | null = null;
  private candAt = 0;
  private switchedAt = 0;
  private offs: (() => void)[] = [];

  constructor(private o: WatchRaceOptions) {}

  attach(ctx: RaceContext) {
    this.ctx = ctx;
    this.L = ctx.track.length;
    this.karts = new RemoteKarts(ctx.scene, ctx.camera, ctx.hud, this.L);
    // Nobody here races them, so nobody is a ghost: every kart is drawn solid (see RemoteKarts.update).
    this.karts.racing = false;
    this.o.grid.forEach((g, i) => this.karts.add(g.mid, g.name, g.color, gridPose(ctx.track, i)));
    this.target = this.o.grid[0]?.mid ?? null;
    this.overlay = new WatchOverlay(ctx.hud, {
      follow: (mid) => this.pin(mid),
      auto: () => this.pin(null),
      camera: () => this.o.onCamera(),
      room: () => this.o.onRoom(),
    });
    const room = this.o.room;
    this.offs.push(
      room.on('pose', (mid, p) => p[9] === this.o.race && this.karts.push(mid, p)),
      room.on('ctl', (mid, m) => {
        if (m.k === 'fin' && m.race === this.o.race) this.setFin(mid, m.ms);
        if (m.k === 'bye') {
          this.gone.add(mid);
          this.karts.setGone(mid, true);
        }
      }),
      room.on('state', (s) => this.onState(s)),
    );
    if (room.state) this.onState(room.state);
    addEventListener('keydown', this.onKey);
  }

  private onState(s: RoomState) {
    const present = new Set(s.players.map((p) => p.mid));
    for (const g of this.o.grid) {
      const here = present.has(g.mid);
      if (here) this.gone.delete(g.mid);
      else this.gone.add(g.mid);
      this.karts.setGone(g.mid, !here);
    }
    for (const p of s.players) if (p.fin?.r === this.o.race) this.setFin(p.mid, p.fin.ms);
    if (s.cfg.race !== this.o.race || s.cfg.phase === 'lobby') {
      this.final = true;
      const last = s.cfg.last;
      if (last?.race === this.o.race) for (const r of last.rows) this.setFin(r.mid, r.ms);
    }
  }

  private setFin(mid: string, ms: number | null) {
    if (!this.fin.has(mid)) this.finAt.set(mid, performance.now());
    this.fin.set(mid, ms);
  }

  /** Follow this driver (null: the leader, chosen by the camera itself). */
  pin(mid: string | null) {
    this.pinned = mid;
    if (mid) this.target = mid;
    this.cand = null;
    this.switchedAt = performance.now();
    this.lastHud = 0;
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 9 && this.rows[n - 1]) this.pin(this.rows[n - 1].mid);
    else if (e.key === 'a' || e.key === 'A' || e.key === '0') this.pin(null);
  };

  /** Standings, as the players' own views work them out: finishers by time, then the rest by distance. */
  standings(): Row[] {
    const now = this.o.room.clock.at(this.ctx.viewTime);
    const rows = this.o.grid.map((g, i): Row => {
      const fin = this.fin.has(g.mid) ? this.fin.get(g.mid) : undefined;
      const remote = this.karts.progress(g.mid, now);
      // Before their first pose, a player is where the grid put them.
      const prog = remote >= -0.5 ? remote : gridPose(this.ctx.track, i).s / this.L - 1;
      const status: StandingRow['status'] = typeof fin === 'number' ? 'finished' : fin === null ? 'dnf' : this.gone.has(g.mid) ? 'out' : 'racing';
      return { mid: g.mid, name: g.name, color: g.color, me: false, status, ms: typeof fin === 'number' ? fin : null, lap: Math.max(1, Math.floor(prog) + 1), prog };
    });
    const rank = (r: Row) => (r.status === 'finished' ? 0 : r.status === 'racing' ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || (a.status === 'finished' ? a.ms! - b.ms! : b.prog - a.prog));
    return rows;
  }

  /**
   * The camera's pick when nobody is pinned: the leader of those still racing. A new leader gets the
   * camera once they've held it a moment; a kart that took the flag keeps it a little longer, then
   * the camera moves on to the race behind.
   */
  private direct(perf: number) {
    // The driver the watcher picked, while they're on track (gone, and the camera finds the leader).
    if (this.pinned && this.karts.view(this.pinned)) {
      this.target = this.pinned;
      return;
    }
    const lead = this.rows.find((r) => r.status === 'racing' && this.karts.view(r.mid)) ?? this.rows[0];
    if (!lead || lead.mid === this.target) {
      this.cand = null;
      return;
    }
    if (this.cand !== lead.mid) {
      this.cand = lead.mid;
      this.candAt = perf;
    }
    const cur = this.rows.find((r) => r.mid === this.target);
    const lost = !cur || !this.karts.view(cur.mid);
    const done = cur && cur.status !== 'racing' && perf - (this.finAt.get(cur.mid) ?? 0) > FLAG_HOLD;
    const overtaken = cur?.status === 'racing' && perf - this.candAt > SWITCH_AFTER && perf - this.switchedAt > STAY_MIN;
    if (lost || done || overtaken) {
      this.target = lead.mid;
      this.switchedAt = perf;
      this.cand = null;
    }
  }

  private moveKarts(dt: number) {
    if (this.moved) return;
    this.moved = true;
    this.karts.update(dt, this.o.room.clock.at(this.ctx.viewTime), this.ctx.viewW, this.ctx.viewH);
  }

  follow(dt: number): Follow | null {
    this.moveKarts(dt);
    const perf = performance.now();
    if (perf - this.lastRows > 100) {
      this.lastRows = perf;
      this.rows = this.standings();
      this.direct(perf);
    }
    const v = this.target ? this.karts.view(this.target) : null;
    return v && { key: this.target!, x: v.x, z: v.z, heading: v.h, speed: v.speed, yawRate: v.yaw };
  }

  frame(dt: number) {
    this.moveKarts(dt); // if follow() didn't
    this.moved = false;
    const perf = performance.now();
    if (perf - this.lastHud > 120) {
      this.lastHud = perf;
      if (!this.rows.length) this.rows = this.standings();
      this.rows.forEach((r, i) => this.karts.setLabel(r.mid, `P${i + 1}`));
      this.overlay.render(this.view(perf));
    }
  }

  minimap(dot: (x: number, z: number, color: string, r: number, ring?: boolean) => void) {
    let on: { x: number; z: number; color: string } | null = null;
    for (const k of this.karts.list()) {
      if (!k.shown) continue;
      if (k.mid === this.target) on = k;
      else dot(k.x, k.z, k.color, 8, true);
    }
    if (on) {
      dot(on.x, on.z, '#f2f3f5', 12); // the one on camera, on top, ringed in white
      dot(on.x, on.z, on.color, 8.5);
    }
  }

  private view(perf: number): WatchView {
    const rows = this.rows;
    const untilGo = (this.o.startAt - perf) / 1000;
    const times = rows.filter((r) => r.status === 'finished').map((r) => r.ms!);
    const graceEnd = times.length ? this.o.startAt + Math.min(...times) + FINISH_GRACE_MS : null;
    const lead = rows.find((r) => r.status === 'racing');
    return {
      code: this.o.code,
      laps: this.o.laps,
      lap: lead ? Math.min(lead.lap, this.o.laps) : this.o.laps,
      rows,
      following: this.target,
      auto: !this.pinned,
      camera: this.o.cameraLabel(),
      countdown: untilGo > LIGHTS_LEAD + 0.2 ? untilGo - LIGHTS_LEAD : null,
      final: this.final,
      graceLeft: graceEnd !== null && !this.final ? Math.max(0, (graceEnd - perf) / 1000) : null,
    };
  }

  dispose() {
    removeEventListener('keydown', this.onKey);
    this.offs.forEach((f) => f());
    this.karts?.dispose();
    this.overlay?.dispose();
  }
}
