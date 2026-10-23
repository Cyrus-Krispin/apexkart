// Party: split screen on one laptop or TV. Up to four players scan one QR code with their phones,
// then race each other on this screen, each in their own view, each steering with their own phone.
// Loaded by src/party.ts when #/party first opens; it owns the route from then on: the lobby
// (src/ui/partyLobby.ts), then one Race per player in a grid, joined in one race by a hub in this
// page (src/game/partyHub.ts) that stands in for a multiplayer room, so the grid, contact,
// slipstream, standings and the finish all work as they do online. See docs/party.md.
import type { Race } from './game/race';
import type { MultiplayerRace } from './game/mpRace';
import type { PartyHub } from './game/partyHub';
import { PartyScreen, type PartySeat } from './net/pad';
import { escapeHtml, formatMs } from './net/api';
import { PartyLobby, loadPartySettings } from './ui/partyLobby';
import type { GridSlot, RaceResult } from './shared/room';
import type { PadButton } from './shared/pad';
import type { TrackData } from './track/osm';
import type { Quality } from './game/render';
import { PARTY_HASH, type PartyHost } from './party';

/** Each seat's kart: red, blue, green, pink (all take white text). */
export const SEAT_COLORS = ['#e5383b', '#2f4bff', '#16a34a', '#ec4899'];
const START_LEAD_MS = 6000; // lights out this long after every kart is ready (the red lights take the last 3.5 s)
const READY_WAIT_MS = 45_000; // start anyway if a view's world takes longer than this to build...
const PHONE_WAIT_MS = 20_000; // ...or a phone that dropped while they built hasn't come back

export class PartyController {
  private screen = new PartyScreen(SEAT_COLORS);
  private lobby: PartyLobby;
  private session: PartySession | null = null;
  private active = false;
  private races = 0;
  private starting = false;

  /** `returnHash`: the page to go back to (the one open before #/party). */
  constructor(
    private host: PartyHost,
    private returnHash: string,
  ) {
    this.lobby = new PartyLobby(this.screen, loadPartySettings(), SEAT_COLORS, { start: () => this.start(), close: () => this.close() });
    this.screen.on('seats', () => {
      this.lobby.renderSeats();
      this.session?.seatsChanged();
    });
    this.screen.on('button', (n, b) => this.onButton(n, b));
    this.screen.on('closed', () => {
      if (!this.active) return;
      this.lobby.message('The party code expired, so here’s a new one. Scan it again.');
      this.openCode();
    });
    addEventListener('hashchange', (e) => {
      const from = new URL(e.oldURL).hash;
      if (!PARTY_HASH.test(from)) this.returnHash = from;
      this.route();
    });
    this.route();
    if (import.meta.env.DEV) (window as { __party?: PartyController }).__party = this;
  }

  private route() {
    if (!PARTY_HASH.test(location.hash)) {
      if (this.active) this.close(false);
      return;
    }
    if (this.active) return;
    this.active = true;
    this.host.enter();
    this.showLobby();
    this.openCode();
  }

  private async openCode() {
    try {
      await this.screen.open();
      this.lobby.render();
    } catch (e) {
      this.lobby.message(`Couldn’t open a code for the phones (${(e as Error).message}). Trying again…`);
      setTimeout(() => this.active && !this.screen.code && this.openCode(), 4000);
    }
  }

  private showLobby() {
    this.screen.welcoming = true;
    this.screen.setView('brief', 'simple');
    this.lobby.show();
  }

  /** A phone's button: Start in the lobby or on the results, Pause and Reset in the race. */
  private onButton(n: number, b: PadButton) {
    const s = this.session;
    if (b === 'go') {
      if (s?.phase === 'results') this.start();
      else if (s?.phase === 'paused') s.resume();
      else if (!s && this.lobby.visible) this.start();
    } else if (b === 'pause') s?.togglePause(`P${n + 1} paused`);
    else if (b === 'reset') s?.reset(n);
  }

  /** Race with every phone that's connected now. */
  private async start() {
    const track = this.lobby.track();
    const seats = this.screen.seats.filter((x) => x.status === 'live');
    if (!track || !seats.length || this.starting) return;
    this.starting = true;
    try {
      const [{ Race }, { MultiplayerRace }, { PartyHub, PARTY_RACE }, { autoQuality }] = await Promise.all([
        import('./game/race'),
        import('./game/mpRace'),
        import('./game/partyHub'),
        import('./game/render'),
      ]);
      if (!this.active) return;
      this.session?.dispose();
      this.lobby.hide();
      this.lobby.message('');
      this.screen.welcoming = false;
      const { dir, laps, time } = this.lobby.settings;
      this.session = new PartySession({
        Race,
        MultiplayerRace,
        PartyHub,
        race: PARTY_RACE,
        track,
        dir,
        laps,
        time,
        seats,
        turn: this.races++,
        // Several races at once: Low (no ambient occlusion) unless it's one player.
        quality: seats.length === 1 ? autoQuality() : 'low',
        container: this.host.container,
        screen: this.screen,
        onLobby: () => this.backToLobby(),
        onAgain: () => this.start(),
      });
    } catch (e) {
      this.lobby.message(`Couldn’t start the race: ${(e as Error).message}`);
    } finally {
      this.starting = false;
    }
  }

  private backToLobby() {
    this.session?.dispose();
    this.session = null;
    this.showLobby();
  }

  /** Back to the track map: the phones are let go and the code closed. */
  private close(setHash = true) {
    this.session?.dispose();
    this.session = null;
    this.screen.close();
    this.lobby.hide();
    this.lobby.message('');
    this.active = false;
    if (setHash) location.hash = PARTY_HASH.test(this.returnHash) ? '' : this.returnHash;
    this.host.leave();
  }
}

// ---------------------------------------------------------------- the race on the split screen

interface Pane {
  seat: PartySeat;
  slot: GridSlot;
  cell: HTMLElement;
  badge: HTMLElement;
  race: Race;
  mp: MultiplayerRace;
  ready: boolean;
}

interface SessionOptions {
  Race: typeof Race;
  MultiplayerRace: typeof MultiplayerRace;
  PartyHub: typeof PartyHub;
  race: number;
  track: TrackData;
  dir: 'fwd' | 'rev';
  laps: number;
  time: 'day' | 'night';
  seats: PartySeat[];
  /** Which race of the party this is: the grid order turns round by one each time. */
  turn: number;
  quality: Quality;
  container: HTMLElement;
  screen: PartyScreen;
  onLobby(): void;
  /** Race again: the same circuit, with every phone connected now. */
  onAgain(): void;
}

/**
 * Columns and rows for n views on a w x h screen. Two players go one above the other or side by
 * side, whichever gives views nearer 16:9; three or four share a 2 x 2 grid (three leave the last
 * cell to the standings).
 */
function layout(n: number, w: number, h: number) {
  if (n === 1) return { cols: 1, rows: 1 };
  if (n > 2) return { cols: 2, rows: 2 };
  const off = (a: number) => Math.abs(Math.log(a / (16 / 9)));
  return off(w / (h / 2)) <= off(w / 2 / h) ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 };
}

class PartySession {
  phase: 'loading' | 'racing' | 'paused' | 'results' = 'loading';
  private root: HTMLElement;
  private panes: Pane[] = [];
  private hub: PartyHub;
  private board: HTMLElement | null = null;
  private overlay: HTMLElement;
  private $: Record<string, HTMLElement> = {};
  private readyTimer: number;
  private phoneTimer = 0;
  private boardTimer = 0;
  private pauseReason = '';
  private result: RaceResult | null = null;
  private dropped = new Set<number>(); // seats whose phone dropped during this race

  constructor(private o: SessionOptions) {
    const n = o.seats.length;
    // Grid order: P1 on pole for the first race, then everyone moves up a place each race.
    const order = o.seats.map((_, i) => o.seats[(i + o.turn) % n]);
    const grid: GridSlot[] = order.map((s) => ({ mid: `p${s.n}`, name: `P${s.n + 1}`, color: SEAT_COLORS[s.n] }));
    this.hub = new o.PartyHub({ grid, laps: o.laps, track: o.track.id, trackName: o.track.name, lengthM: o.track.lengthM, dir: o.dir, onEnd: (r) => this.ended(r) });

    this.root = document.createElement('div');
    this.root.className = 'pt-race';
    this.root.dataset.n = String(n);
    o.container.appendChild(this.root);
    this.fit();
    addEventListener('resize', this.fit); // before the races' own resize listeners, so they read the new cells
    addEventListener('keydown', this.onKey, true);

    // Far in the future until every kart is ready; then lights out START_LEAD_MS later for everyone.
    const startAt = performance.now() + 10 * 60_000;
    const volume = 1 / Math.sqrt(n);
    for (const seat of o.seats) {
      const slot = grid.find((g) => g.mid === `p${seat.n}`)!;
      const cell = document.createElement('div');
      cell.className = 'pt-cell';
      cell.style.setProperty('--c', slot.color);
      this.root.appendChild(cell);
      const badge = document.createElement('div');
      badge.className = 'pt-badge';
      badge.innerHTML = `<b class="display">${slot.name}</b><span></span>`;
      cell.appendChild(badge);
      const mp = new o.MultiplayerRace({ room: this.hub.seat(slot.mid), race: o.race, grid, laps: o.laps, startAt, onLobby: () => undefined, ordinals: true });
      let pane: Pane;
      const race = new o.Race({
        track: o.track,
        dir: o.dir,
        driver: { id: '', pid: '', name: slot.name, color: slot.color },
        container: cell,
        onExit: () => o.onLobby(),
        mode: { ...mp.mode(), time: o.time },
        party: { pad: seat.conn, volume, quality: o.quality, onReady: () => this.paneReady(pane) },
      });
      pane = { seat, slot, cell, badge, race, mp, ready: false };
      this.panes.push(pane);
    }
    if (n === 3) {
      this.board = document.createElement('div');
      this.board.className = 'pt-cell pt-board';
      this.root.appendChild(this.board);
    }
    this.overlay = document.createElement('div');
    this.overlay.className = 'pt-overlay';
    this.overlay.innerHTML = /* html */ `
      <div class="pt-attrib">Track and world © OpenStreetMap contributors</div>
      <div class="pt-wait" data-el="wait"><p class="label">${escapeHtml(o.track.name)} · ${o.laps} lap${o.laps > 1 ? 's' : ''}</p><h2 class="display">Getting the circuit ready</h2><p class="pt-wait-k" data-el="waitK"></p></div>
      <div class="pt-menu" data-el="menu" hidden>
        <div class="pt-menu-in">
          <h2 class="display" data-el="menuTitle">Paused</h2>
          <p class="pt-menu-k" data-el="menuK"></p>
          <ol class="pt-cls" data-el="cls"></ol>
          <div class="pt-menu-act">
            <button class="btn primary lg" data-act="main" data-el="mainBtn">Resume <span class="arrow">→</span></button>
            <button class="btn primary lg" data-act="drop" data-el="dropBtn" hidden></button>
            <button class="btn" data-act="lobby">Back to the party</button>
          </div>
          <p class="pt-menu-hint pw-k" data-el="menuHint"></p>
        </div>
      </div>`;
    this.overlay.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.$[e.dataset.el!] = e));
    this.overlay.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'main') {
        if (this.phase === 'results') o.onAgain();
        else this.resume();
      }
      if (act === 'lobby') o.onLobby();
      if (act === 'drop') this.raceOnWithout();
    });
    this.root.appendChild(this.overlay);
    o.screen.setView('race', 'simple');
    this.paintWait();
    this.paintBadges();
    this.readyTimer = window.setTimeout(() => this.maybeGo(true), READY_WAIT_MS);
    this.boardTimer = window.setInterval(() => this.paintBoard(), 250);
  }

  private fit = () => {
    const { cols, rows } = layout(this.o.seats.length, innerWidth, innerHeight);
    this.root.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    this.root.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  };

  private paneReady(p: Pane) {
    p.ready = true;
    this.maybeGo();
  }

  /**
   * Lights out START_LEAD_MS after every view is ready and every phone connected (a busy laptop
   * building the worlds can make a phone drop and reconnect). `force`: go anyway (a view's world
   * is very slow, or a phone hasn't come back); a missing phone then pauses the race at once.
   */
  private maybeGo(force = false) {
    if (this.phase !== 'loading') return;
    this.paintWait();
    const ready = this.panes.every((x) => x.ready);
    if (!force && !(ready && this.panes.every((x) => x.seat.status === 'live'))) {
      if (ready && !this.phoneTimer) this.phoneTimer = window.setTimeout(() => this.maybeGo(true), PHONE_WAIT_MS);
      return;
    }
    clearTimeout(this.readyTimer);
    clearTimeout(this.phoneTimer);
    this.phase = 'racing';
    const shift = performance.now() + START_LEAD_MS - this.panes[0].mp.mode().startAt!;
    for (const p of this.panes) {
      p.race.shiftStart(shift);
      p.mp.shiftStart(shift);
    }
    this.$.wait.hidden = true;
    // A phone that dropped while the circuit loaded: wait for it now.
    const gone = this.panes.find((p) => p.seat.status !== 'live');
    if (gone) this.pause(`P${gone.seat.n + 1}’s phone disconnected`, gone.seat.n);
  }

  private paintWait() {
    const building = this.panes.some((p) => !p.ready);
    const away = this.panes.filter((p) => p.seat.status !== 'live').map((p) => p.slot.name);
    this.$.waitK.textContent = building
      ? `Building the world for ${this.panes.length > 1 ? `${this.panes.length} views` : 'the view'}…`
      : away.length
        ? `Waiting for ${away.join(' and ')}’s phone to reconnect…`
        : 'Ready';
  }

  // ---------------------------------------------------------------- pause, phones dropping

  togglePause(reason: string) {
    if (this.phase === 'paused') this.resume();
    else this.pause(reason);
  }

  private pause(reason: string, dropped?: number) {
    if (this.phase !== 'racing') return;
    this.phase = 'paused';
    this.hub.pause();
    for (const p of this.panes) p.race.pause(true);
    this.o.screen.setView('paused', 'simple');
    if (dropped !== undefined) this.dropped.add(dropped);
    this.pauseReason = reason;
    this.paintMenu();
  }

  /** Resume, once every phone is back (`without`: the ones that aren't retire). */
  resume(without = false) {
    if (this.phase !== 'paused' || (!without && this.waiting().length)) return;
    this.phase = 'racing';
    const ms = this.hub.resume();
    for (const p of this.panes) {
      p.race.shiftStart(ms);
      p.mp.shiftStart(ms);
      p.race.pause(false);
    }
    this.dropped.clear();
    this.o.screen.setView('race', 'simple');
    this.paintMenu();
  }

  reset(n: number) {
    if (this.phase === 'racing') this.panes.find((p) => p.seat.n === n)?.race.reset();
  }

  /** Seats whose phone dropped and hasn't come back. */
  private waiting() {
    return [...this.dropped].filter((n) => this.panes.some((p) => p.seat.n === n && p.seat.status !== 'live'));
  }

  /** A phone that dropped retires from this race; the rest race on. */
  private raceOnWithout() {
    for (const n of this.waiting()) this.panes.find((x) => x.seat.n === n)?.mp.retire();
    this.resume(true);
  }

  /** Phones came or went. One dropping mid-race pauses everyone, as a dropped phone does solo. */
  seatsChanged() {
    this.paintBadges();
    if (this.phase === 'loading') this.maybeGo();
    else if (this.phase === 'racing') {
      const gone = this.panes.find((p) => p.seat.status !== 'live' && p.mp.finishMs === undefined);
      if (gone) this.pause(`P${gone.seat.n + 1}’s phone disconnected`, gone.seat.n);
    } else if (this.phase === 'paused') {
      for (const p of this.panes) if (p.seat.status !== 'live' && p.mp.finishMs === undefined) this.dropped.add(p.seat.n);
      this.paintMenu();
    }
  }

  private paintBadges() {
    for (const p of this.panes) {
      const st = p.seat.status;
      p.badge.dataset.status = st;
      p.badge.lastElementChild!.textContent = st === 'live' ? '' : st === 'empty' ? 'Left the party' : 'Phone disconnected';
    }
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'p') {
      e.preventDefault();
      if (this.phase === 'racing' || this.phase === 'paused') this.togglePause('Paused on the laptop');
      else if (this.phase === 'results') this.o.onLobby();
    } else if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('button')) {
      if (this.phase === 'paused') this.resume();
      else if (this.phase === 'results') this.o.onAgain();
    }
  };

  // ---------------------------------------------------------------- the finish

  private ended(r: RaceResult) {
    this.result = r;
    // A moment for the last kart's finish banner, then the classification over every view.
    window.setTimeout(() => {
      if (this.phase === 'paused') this.resume();
      this.phase = 'results';
      this.o.screen.setView('brief', 'simple');
      this.paintMenu();
    }, 1800);
  }

  private paintMenu() {
    const show = this.phase === 'paused' || this.phase === 'results';
    this.$.menu.hidden = !show;
    if (!show) return;
    const results = this.phase === 'results';
    const r = this.result;
    const winner = r?.rows[0];
    this.$.menuTitle.textContent = results ? (winner && winner.ms !== null ? `${winner.name} wins` : 'Race over') : 'Paused';
    this.$.menuTitle.style.color = results && winner?.ms != null ? winner.color : '';
    const waiting = this.waiting();
    this.$.menuK.textContent = results
      ? `${this.o.track.name} · ${this.o.laps} lap${this.o.laps > 1 ? 's' : ''}`
      : waiting.length
        ? `${waiting.map((n) => `P${n + 1}`).join(' and ')}: waiting for the phone to reconnect…`
        : this.dropped.size
          ? 'Everyone’s back. Resume when you’re ready.'
          : this.pauseReason;
    const btn = this.$.mainBtn as HTMLButtonElement;
    btn.innerHTML = `${results ? 'Race again' : 'Resume'} <span class="arrow">→</span>`;
    btn.hidden = !results && waiting.length > 0; // until the phone is back, or the rest race on without it
    const drop = this.$.dropBtn as HTMLButtonElement;
    drop.hidden = results || !waiting.length;
    drop.textContent = `Race on without ${waiting.map((n) => `P${n + 1}`).join(' and ')}`;
    this.$.menuHint.textContent = results ? 'Start on any phone races again' : waiting.length ? '' : 'Pause or Resume on any phone · Esc here';
    this.$.cls.hidden = !results;
    if (results && r) {
      const lead = r.rows[0]?.ms;
      this.$.cls.innerHTML = r.rows
        .map((row, i) => {
          const dnf = row.ms === null;
          const c = escapeHtml(row.color);
          return `<li class="${dnf ? 'dnf' : ''}"><span class="pos">${dnf ? '–' : i + 1}</span><span class="pw-stripe" style="--c1:${c};--c2:${c}"></span><span class="nm">${escapeHtml(row.name)}</span><span class="tm${!dnf && i === 0 ? ' p' : ''}">${dnf ? 'DNF' : i === 0 ? formatMs(row.ms) : '+' + ((row.ms! - lead!) / 1000).toFixed(3)}</span></li>`;
        })
        .join('');
    }
  }

  /** Three players: the fourth cell is the live standings. */
  private paintBoard() {
    if (!this.board || !this.panes.length) return;
    const rows = this.panes[0].mp.standings();
    const names = new Map(this.panes.map((p) => [p.slot.mid, p.slot.name]));
    const html = `<p class="label">${escapeHtml(this.o.track.name)}</p><ol>${rows
      .map((r, i) => {
        const right = r.status === 'finished' ? formatMs(r.ms) : r.status === 'racing' ? `Lap ${Math.min(r.lap, this.o.laps)}/${this.o.laps}` : 'DNF';
        return `<li class="${r.status}"><span class="pos">${i + 1}</span><span class="pw-stripe" style="--c1:${escapeHtml(r.color)};--c2:${escapeHtml(r.color)}"></span><span class="nm">${escapeHtml(names.get(r.mid) ?? r.name)}</span><span class="tm">${right}</span></li>`;
      })
      .join('')}</ol>`;
    if (this.board.innerHTML !== html) this.board.innerHTML = html;
  }

  dispose() {
    clearTimeout(this.readyTimer);
    clearTimeout(this.phoneTimer);
    clearInterval(this.boardTimer);
    removeEventListener('resize', this.fit);
    removeEventListener('keydown', this.onKey, true);
    for (const p of this.panes) p.race.dispose(); // also disposes its MultiplayerRace
    this.hub.dispose();
    this.root.remove();
  }
}
