// The room behind a party's split screen (src/party.ts). Every player's Race runs in this page, each
// with its own MultiplayerRace (src/game/mpRace.ts), and each of those talks to a seat on this hub
// as it would to an online room: a pose or a finish from one kart goes straight to the others, the
// hub keeps the state a room server would (the grid, finishes, the result), and it closes the race
// when everyone is done or FINISH_GRACE_MS after the winner. Its clock stops while the party is
// paused, so poses stay continuous and no one's time counts the pause.
import type { RaceRoom } from './mpRace';
import type { RoomEvents } from '../net/room';
import { FINISH_GRACE_MS, raceResult, type Dir, type GridSlot, type PoseTuple, type RaceResult, type RoomState } from '../shared/room';

export const PARTY_RACE = 1; // each party race is a fresh hub; the race number only has to match

type SeatEvents = Pick<RoomEvents, 'state' | 'pose' | 'ctl'>;

class HubSeat implements RaceRoom {
  localPose: PoseTuple | null = null;
  readonly mesh = {
    sendPose: (p: PoseTuple) => this.hub.pose(this.mid, p),
    relayPeers: () => [] as string[],
  };
  private listeners: { [K in keyof SeatEvents]: Set<SeatEvents[K]> } = { state: new Set(), pose: new Set(), ctl: new Set() };

  constructor(
    readonly mid: string,
    private hub: PartyHub,
  ) {}

  get state() {
    return this.hub.state;
  }

  get clock() {
    return this.hub.clock;
  }

  progressOf(mid: string) {
    return this.hub.progress.get(mid);
  }

  on<K extends keyof SeatEvents>(ev: K, fn: SeatEvents[K]) {
    (this.listeners[ev] as Set<SeatEvents[K]>).add(fn);
    return () => void (this.listeners[ev] as Set<SeatEvents[K]>).delete(fn);
  }

  emit<K extends keyof SeatEvents>(ev: K, ...args: Parameters<SeatEvents[K]>) {
    (this.listeners[ev] as Set<(...a: Parameters<SeatEvents[K]>) => void>).forEach((fn) => fn(...args));
  }

  finish(race: number, ms: number | null) {
    this.hub.finish(this.mid, race, ms);
    return Promise.resolve();
  }
}

export class PartyHub {
  readonly state: RoomState;
  /** Each kart's progress in laps, from its newest pose. */
  readonly progress = new Map<string, number>();
  private seats = new Map<string, HubSeat>();
  private pausedAt: number | null = null;
  private pausedMs = 0;
  private firstFinish: number | null = null; // hub time of the winner's flag
  private timer = window.setInterval(() => this.check(), 500);
  private onEnd: (r: RaceResult) => void;

  /** Hub time for a performance.now() time: it stands still while the party is paused. */
  readonly clock = { at: (t: number) => (this.pausedAt !== null ? Math.min(t, this.pausedAt) : t) - this.pausedMs };

  constructor(o: { grid: GridSlot[]; laps: number; track: string; trackName: string; lengthM: number; dir: Dir; onEnd(r: RaceResult): void }) {
    this.onEnd = o.onEnd;
    const now = Date.now();
    this.state = {
      cfg: {
        code: '',
        host: o.grid[0]?.mid ?? '',
        track: o.track,
        trackName: o.trackName,
        lengthM: o.lengthM,
        dir: o.dir,
        laps: o.laps,
        v: 1,
        phase: 'racing',
        race: PARTY_RACE,
        startAt: 0,
        grid: o.grid,
        created: now,
        active: now,
        last: null,
      },
      players: o.grid.map((g) => ({ mid: g.mid, name: g.name, color: g.color, joined: now, seen: now, ready: 1, fin: null })),
    };
    for (const g of o.grid) this.seats.set(g.mid, new HubSeat(g.mid, this));
  }

  /** The room a kart's MultiplayerRace uses. */
  seat(mid: string): RaceRoom {
    return this.seats.get(mid)!;
  }

  get paused() {
    return this.pausedAt !== null;
  }

  pause() {
    this.pausedAt ??= performance.now();
  }

  /** Back from a pause; returns how long it lasted (ms), for the races to move their start by. */
  resume() {
    if (this.pausedAt === null) return 0;
    const ms = performance.now() - this.pausedAt;
    this.pausedMs += ms;
    this.pausedAt = null;
    return ms;
  }

  pose(from: string, p: PoseTuple) {
    this.progress.set(from, p[8]);
    for (const s of this.seats.values()) if (s.mid !== from) s.emit('pose', from, p);
  }

  finish(mid: string, race: number, ms: number | null) {
    const p = this.state.players.find((x) => x.mid === mid);
    if (!p || p.fin || this.state.cfg.phase !== 'racing') return;
    p.fin = { r: race, ms };
    if (ms !== null) this.firstFinish ??= this.clock.at(performance.now());
    for (const s of this.seats.values()) if (s.mid !== mid) s.emit('ctl', mid, { k: 'fin', race, ms });
    this.check();
  }

  /** Everyone done, or the winner's grace period over (stragglers are DNF): close the race. */
  private check() {
    const { cfg, players } = this.state;
    if (cfg.phase !== 'racing') return;
    const late = this.firstFinish !== null && this.clock.at(performance.now()) - this.firstFinish > FINISH_GRACE_MS;
    if (!late && players.some((p) => !p.fin)) return;
    for (const p of players) p.fin ??= { r: cfg.race, ms: null };
    cfg.last = raceResult(this.state);
    cfg.phase = 'lobby';
    for (const s of this.seats.values()) s.emit('state', this.state);
    clearInterval(this.timer);
    this.onEnd(cfg.last);
  }

  dispose() {
    clearInterval(this.timer);
  }
}
