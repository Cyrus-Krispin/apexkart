// Watching a multiplayer room (#/watch/CODE), loaded by src/watch.ts when the route first opens; it
// owns the route from then on. The screen joins the room as a watcher (RoomClient.watch), so every
// player links up with it and sends it their poses, but it's never on the grid and nobody waits for
// it. Between races it shows the room (src/ui/watchBoard.ts); when the host starts a race it opens a
// Race with no kart of its own (RaceMode.watch) and the WatchRace add-on, which draws the field and
// points the camera at the leader. See docs/watch.md.
import type { Race } from './game/race';
import type { WatchRace } from './game/watchRace';
import { RoomClient, type RoomCloseReason } from './net/room';
import { WatchBoard } from './ui/watchBoard';
import { roomTime, type RoomState } from './shared/room';
import type { TrackData } from './track/osm';
import { WATCH_HASH, type WatchHost } from './watch';

const RESULTS_MS = 15_000; // the classification stays over the race this long, then the room comes back
const CLOSED_MSG: Record<RoomCloseReason, string> = {
  gone: 'The room has closed: everyone left, or it expired.',
  idle: 'The room closed after 30 minutes without a race.',
  kicked: 'This screen was removed from the room.',
  left: '',
};

export class WatchController {
  readonly board: WatchBoard;
  private room: RoomClient | null = null;
  private race: Race | null = null;
  /** The race add-on (tests read it). */
  watchRace: WatchRace | null = null;
  private raceId = 0;
  private endTimer = 0;
  private tracks = new Map<string, Promise<TrackData>>();
  private track: TrackData | null = null;
  private active = false;
  private joining: string | null = null;

  /** `returnHash`: the page to go back to (the one open before #/watch). */
  constructor(
    private host: WatchHost,
    private returnHash: string,
  ) {
    this.board = new WatchBoard({ leave: () => this.close(), race: () => this.showRace() });
    addEventListener('hashchange', (e) => {
      const from = new URL(e.oldURL).hash;
      if (!WATCH_HASH.test(from)) this.returnHash = from;
      this.route();
    });
    addEventListener('keydown', this.onKey);
    this.route();
    if (import.meta.env.DEV) (window as { __watch?: WatchController }).__watch = this;
  }

  /** Esc: from the race to the room, from the room back to the race (or, with no race, away). */
  private onKey = (e: KeyboardEvent) => {
    if (!this.active || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (!this.board.visible) this.showBoard();
      else if (this.race) this.showRace();
      else this.close();
    } else if (e.key === 'Enter' && this.board.visible && this.race) this.showRace();
  };

  private route() {
    const m = WATCH_HASH.exec(location.hash);
    if (!m) {
      if (this.active) this.close(false);
      return;
    }
    const code = m[1]?.toUpperCase();
    if (!code) {
      // No code: the multiplayer home has the code box (and its Watch button).
      location.replace('#/room');
      return;
    }
    if (!this.active) {
      this.active = true;
      this.host.enter();
    }
    if (this.room?.code === code) return;
    this.join(code);
  }

  private async join(code: string) {
    if (this.joining === code) return;
    this.joining = code;
    this.disposeRace();
    this.room?.leave();
    this.room = null;
    this.board.message(code, `Connecting to room ${code}…`);
    this.board.show();
    try {
      const room = await RoomClient.watch(code, this.host.driver.name);
      if (!this.active || WATCH_HASH.exec(location.hash)?.[1]?.toUpperCase() !== code) return void room.leave();
      this.room = room;
      room.on('state', (s) => this.onState(s));
      room.on('closed', (why) => this.onClosed(why));
      if (room.state) this.onState(room.state);
    } catch (e) {
      const msg = (e as Error).message;
      this.board.message(code, /not found/.test(msg) ? `Room ${code} doesn’t exist (rooms close when everyone leaves).` : `Couldn’t watch ${code}: ${msg}`);
    } finally {
      this.joining = null;
    }
  }

  private trackFor(room: RoomClient, id: string) {
    let p = this.tracks.get(id);
    if (!p) {
      p = room.fetchTrack();
      this.tracks.set(id, p);
      p.catch(() => this.tracks.delete(id));
    }
    return p;
  }

  private onState(s: RoomState) {
    const room = this.room;
    if (!room) return;
    this.board.render(s, this.track, !!this.race);
    this.trackFor(room, s.cfg.track)
      .then((t) => {
        if (room !== this.room || t.id !== room.state?.cfg.track) return;
        this.track = t;
        if (room.state) this.board.render(room.state, t, !!this.race);
      })
      .catch(() => undefined);
    this.maybeStartRace(s);
    // The race is over: the classification for a while, then the room again.
    if (s.cfg.phase === 'lobby' && this.race && !this.endTimer) {
      const id = this.raceId;
      this.endTimer = window.setTimeout(() => {
        this.endTimer = 0;
        if (this.raceId !== id) return;
        this.disposeRace();
        if (this.room?.state) this.board.render(this.room.state, this.track, false);
        this.board.show();
      }, RESULTS_MS);
    }
  }

  /** A race is on that we aren't showing yet: open it (watching joins a race at any point). */
  private async maybeStartRace(s: RoomState) {
    const room = this.room!;
    const { cfg } = s;
    if (cfg.phase !== 'racing' || this.raceId === cfg.race) return;
    this.raceId = cfg.race;
    let track: TrackData;
    let Race: typeof import('./game/race').Race;
    let WatchRace: typeof import('./game/watchRace').WatchRace;
    try {
      [track, { Race }, { WatchRace }] = await Promise.all([this.trackFor(room, cfg.track), import('./game/race'), import('./game/watchRace')]);
    } catch {
      this.raceId = 0;
      return;
    }
    if (room !== this.room || room.state?.cfg.race !== cfg.race || room.state.cfg.phase !== 'racing') {
      if (this.raceId === cfg.race) this.raceId = 0;
      return;
    }
    this.disposeRace();
    this.raceId = cfg.race;
    const watchRace = new WatchRace({
      room,
      code: room.code,
      race: cfg.race,
      grid: cfg.grid,
      laps: cfg.laps,
      startAt: room.clock.toLocal(cfg.startAt),
      onRoom: () => this.showBoard(),
      onCamera: () => this.race?.cycleCamera(),
      cameraLabel: () => this.race?.cameraLabel ?? '',
    });
    this.watchRace = watchRace;
    this.race = new Race({
      track,
      dir: cfg.dir,
      driver: { id: '', pid: '', name: 'Watching', color: '#8b8f99' },
      container: this.host.container,
      onExit: () => this.showBoard(),
      mode: {
        startAt: room.clock.toLocal(cfg.startAt),
        gridSlot: 0,
        ghosts: false,
        leaderboard: false,
        restart: false,
        watch: true,
        time: roomTime(cfg),
        addon: watchRace,
      },
    });
    this.board.hide();
  }

  /** The room, over the race (Esc in the race, or the Room button). */
  private showBoard() {
    if (this.room?.state) this.board.render(this.room.state, this.track, !!this.race);
    this.board.show();
  }

  private showRace() {
    if (this.race) this.board.hide();
  }

  private disposeRace() {
    clearTimeout(this.endTimer);
    this.endTimer = 0;
    this.race?.dispose(); // also disposes the add-on
    this.race = null;
    this.watchRace = null;
    this.raceId = 0;
  }

  private onClosed(why: RoomCloseReason) {
    const code = this.room?.code ?? '';
    this.room = null;
    this.disposeRace();
    if (!this.active) return;
    this.board.message(code, CLOSED_MSG[why]);
    this.board.show();
  }

  /** Back to the circuits. */
  private close(setHash = true) {
    const room = this.room;
    this.room = null;
    room?.leave();
    this.disposeRace();
    this.board.hide();
    this.active = false;
    if (setHash) location.hash = WATCH_HASH.test(this.returnHash) ? '' : this.returnHash;
    this.host.leave();
  }
}
