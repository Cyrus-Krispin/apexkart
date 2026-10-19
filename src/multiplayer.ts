// Multiplayer controller: routes #/room[/CODE], owns the RoomClient, the lobby and the
// multiplayer Race. The rest of the app only provides enter()/leave() (see MULTIPLAYER.md).
import { Race } from './game/race';
import { MultiplayerRace } from './game/mpRace';
import { Lobby } from './ui/lobby';
import { RoomClient, type RoomCloseReason } from './net/room';
import type { Driver } from './net/api';
import type { Dir, RoomState } from './shared/room';
import type { TrackData } from './track/osm';
import './ui/multiplayer.css';

export interface MultiplayerHost {
  driver: Driver;
  /** Element races are mounted in (the same one time trials use). */
  container: HTMLElement;
  /** Multiplayer is taking over the screen: hide the app and stop any time trial. */
  enter(): void;
  /** Multiplayer closed: show the app again. */
  leave(): void;
  /** Where to put the "Race friends" button. Omit to add your own (call open()). */
  entryParent?: HTMLElement;
}

const ROOM_HASH = /^#\/room(?:\/([A-Za-z0-9]{4}))?\/?$/;
const CLOSED_MSG: Record<RoomCloseReason, string> = {
  gone: 'That room has closed or expired.',
  idle: 'The room closed after 30 minutes without a race.',
  kicked: 'The host removed you from the room.',
  left: '',
};

export function initMultiplayer(host: MultiplayerHost) {
  const mp = new MultiplayerController(host);
  return {
    /** Open the lobby; with a code, join that room. */
    open: (code?: string) => (location.hash = code ? `#/room/${code.toUpperCase()}` : '#/room'),
    controller: mp,
  };
}

class MultiplayerController {
  private lobby: Lobby | null = null;
  private room: RoomClient | null = null;
  private race: Race | null = null;
  private mpRace: MultiplayerRace | null = null;
  private raceId = 0;
  private declined = new Set<number>(); // races we chose to leave (don't auto-rejoin)
  private tracks = new Map<string, Promise<TrackData>>();
  private active = false;
  private returnHash = '';
  private joining: string | null = null;

  constructor(private host: MultiplayerHost) {
    if (host.entryParent) {
      const b = document.createElement('button');
      b.className = 'btn primary mp-entry';
      b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15.5 5.2a3 3 0 010 5.6M18 14.4c1.6.7 2.6 2.3 3 4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Race friends';
      b.title = 'Create or join a multiplayer room';
      b.addEventListener('click', () => (location.hash = '#/room'));
      host.entryParent.prepend(b);
    }
    addEventListener('hashchange', (e) => {
      // Remember the track page we came from, to preselect it and to go back to.
      const from = new URL(e.oldURL).hash;
      if (!ROOM_HASH.test(from)) this.returnHash = from;
      this.route();
    });
    if (!ROOM_HASH.test(location.hash)) this.returnHash = location.hash;
    this.route();
  }

  private ensureLobby() {
    this.lobby ??= new Lobby(this.host.driver, {
      create: (t, dir, laps) => this.create(t, dir, laps),
      join: async (code) => {
        location.hash = `#/room/${code}`;
      },
      leave: () => this.leaveRoom(),
      close: () => this.close(),
      rejoinRace: () => {
        this.declined.delete(this.room?.state?.cfg.race ?? -1);
        if (this.room?.state) this.maybeStartRace(this.room.state);
      },
    });
    return this.lobby;
  }

  private route() {
    const m = ROOM_HASH.exec(location.hash);
    if (!m) {
      if (this.active) this.close(false);
      return;
    }
    if (!this.active) {
      this.active = true;
      this.host.enter();
    }
    const lobby = this.ensureLobby();
    const t = /^#\/t\/([^/]+)\/?(fwd|rev)?/.exec(this.returnHash);
    if (t && !this.room) lobby.preferred = { id: decodeURIComponent(t[1]), dir: (t[2] as Dir) || 'fwd' };
    const code = m[1]?.toUpperCase();
    if (!code) {
      if (this.room) history.replaceState(null, '', `#/room/${this.room.code}`);
      else lobby.showHome();
      if (!this.race) lobby.show();
      return;
    }
    if (this.room?.code === code) {
      if (!this.race) lobby.show();
      return;
    }
    this.join(code);
  }

  private profile() {
    return { name: this.host.driver.name, color: this.host.driver.color };
  }

  private async join(code: string) {
    if (this.joining === code) return;
    this.joining = code;
    const lobby = this.ensureLobby();
    this.disposeRace();
    this.room?.dispose();
    this.room = null;
    lobby.showHome(`Joining room ${code}…`);
    try {
      this.attach(await RoomClient.join(code, this.profile()));
    } catch (e) {
      const msg = (e as Error).message;
      lobby.showHome(/not found/.test(msg) ? `Room ${code} doesn’t exist (rooms close when everyone leaves).` : `Couldn’t join ${code}: ${msg}`);
      history.replaceState(null, '', '#/room');
    } finally {
      this.joining = null;
    }
  }

  private async create(track: TrackData, dir: Dir, laps: number) {
    const room = await RoomClient.create(this.profile(), track, dir, laps);
    this.tracks.set(track.id, Promise.resolve(track));
    history.replaceState(null, '', `#/room/${room.code}`);
    this.attach(room);
  }

  private attach(room: RoomClient) {
    this.room = room;
    const lobby = this.ensureLobby();
    lobby.setRoom(room);
    room.on('state', (s) => this.onState(s));
    room.on('closed', (why) => this.onClosed(why));
    if (room.state) this.onState(room.state);
    if (!this.race) lobby.show();
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
    this.trackFor(room, s.cfg.track)
      .then((t) => room === this.room && t.id === room.state?.cfg.track && this.lobby?.setRoomTrack(t))
      .catch(() => undefined);
    this.maybeStartRace(s);
  }

  /** Lights out soon (or already) and we're on the grid: put us in the race. */
  private async maybeStartRace(s: RoomState) {
    const room = this.room!;
    const { cfg } = s;
    if (cfg.phase !== 'racing' || this.raceId === cfg.race || this.declined.has(cfg.race)) return;
    const me = s.players.find((p) => p.mid === room.mid);
    if (!me || !cfg.grid.some((g) => g.mid === room.mid) || me.fin?.r === cfg.race) return;
    this.raceId = cfg.race;
    let track: TrackData;
    try {
      track = await this.trackFor(room, cfg.track);
    } catch {
      this.raceId = 0;
      return;
    }
    if (room !== this.room || room.state?.cfg.race !== cfg.race) {
      this.raceId = 0;
      return;
    }
    this.disposeRace();
    this.raceId = cfg.race;
    this.mpRace = new MultiplayerRace({
      room,
      race: cfg.race,
      grid: cfg.grid,
      laps: cfg.laps,
      startAt: room.clock.toLocal(cfg.startAt),
      onLobby: () => this.backToLobby(),
    });
    this.race = new Race({
      track,
      dir: cfg.dir,
      driver: { ...this.host.driver, name: me.name, color: me.color },
      container: this.host.container,
      onExit: () => this.backToLobby(),
      mode: this.mpRace.mode(),
    });
    this.lobby?.hide();
  }

  /** Leave the race view (retiring if we hadn't finished) and show the lobby. */
  private backToLobby() {
    if (this.mpRace && this.mpRace.finishMs === undefined) {
      this.mpRace.retire();
      this.declined.add(this.raceId);
    }
    this.disposeRace();
    if (this.room) this.lobby?.show();
    else this.lobby?.showHome();
  }

  private disposeRace() {
    this.race?.dispose(); // also disposes the add-on
    this.race = null;
    this.mpRace = null;
    this.raceId = 0;
  }

  private onClosed(why: RoomCloseReason) {
    this.room = null;
    this.disposeRace();
    if (!this.active) return;
    this.lobby?.showHome(CLOSED_MSG[why]);
    if (ROOM_HASH.test(location.hash)) history.replaceState(null, '', '#/room');
  }

  private async leaveRoom() {
    const room = this.room;
    this.room = null;
    this.disposeRace();
    this.lobby?.showHome();
    history.replaceState(null, '', '#/room');
    await room?.leave();
  }

  /** Back to the track map. */
  private close(setHash = true) {
    const room = this.room;
    this.room = null;
    room?.leave();
    this.disposeRace();
    this.lobby?.hide();
    this.active = false;
    if (setHash) location.hash = ROOM_HASH.test(this.returnHash) ? '' : this.returnHash;
    this.host.leave();
  }
}
