// Multiplayer lobby: create/join a room, then the room itself (players, track, ready/start,
// last results). Room lifecycle (create/join/leave, starting races) belongs to the controller
// in src/multiplayer.ts; settings, ready and profile changes go straight to the RoomClient.
import './multiplayer.css';
import { escapeHtml, formatMs, saveDriver, type Driver } from '../net/api';
import { CODE_RE, KART_COLORS, LAPS_DEFAULT, LAPS_MAX, LAPS_MIN, isReady, roomTime, type Dir, type RoomState, type RoomTime } from '../shared/room';
import type { TrackData } from '../track/osm';
import { analyzeShape, type TrackShape } from '../track/shape';
import { trackArt } from './trackArt';
import { circuitCode, stripeStyle } from './pitwall';
import { cleanDriverName } from './profile';
import type { RoomClient } from '../net/room';
import type { LinkInfo } from '../net/mesh';
import { phonePad } from '../net/pad';
import { openPadCard, PHONE_ICON } from './padCard';

export interface LobbyActions {
  create(track: TrackData, dir: Dir, laps: number): Promise<void>;
  join(code: string): Promise<void>;
  leave(): Promise<void>;
  /** Back to the track map (leaves the room). */
  close(): void;
  /** Re-enter a race in progress that we're on the grid for (e.g. after a reload). */
  rejoinRace(): void;
}

/** Tracks the host can pick: featured presets plus tracks discovered on this device. */
export async function trackCatalog(): Promise<TrackData[]> {
  const out = new Map<string, TrackData>();
  try {
    const presets: TrackData[] = await fetch('/tracks/presets.json').then((r) => r.json());
    presets.forEach((t) => out.set(t.id, { ...t, preset: true }));
  } catch {
    /* offline: discovered tracks only */
  }
  try {
    const saved: TrackData[] = JSON.parse(localStorage.getItem('ak:tracks') || '[]');
    saved.forEach((t) => out.has(t.id) || out.set(t.id, t));
  } catch {
    /* ignore */
  }
  return [...out.values()];
}

const shapes = new Map<string, TrackShape>();
function outline(t: TrackData | null, dir: Dir) {
  if (!t?.points?.length) return '';
  let shape = shapes.get(t.id);
  if (!shape) shapes.set(t.id, (shape = analyzeShape(t.points)));
  return trackArt(shape, { w: 150, h: 104, pad: 12, reverse: dir === 'rev', arrows: true, road: true, sectors: true });
}

export class Lobby {
  readonly root: HTMLElement;
  private $: Record<string, HTMLElement> = {};
  private room: RoomClient | null = null;
  private offs: (() => void)[] = [];
  private catalog: TrackData[] = [];
  private roomTrack: TrackData | null = null;
  private busy = false;
  /** Track to offer when creating a room (e.g. the one selected on the map). */
  preferred: { id: string; dir: Dir } | null = null;

  constructor(
    private driver: Driver,
    private actions: LobbyActions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'mp-lobby';
    this.root.hidden = true;
    this.root.innerHTML = LOBBY_HTML;
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.$[e.dataset.el!] = e));
    document.body.appendChild(this.root);
    this.bind();
    this.loadCatalog();
  }

  /** (Re)load the host's track choices; tracks found on the map since last time show up too. */
  private loadCatalog() {
    trackCatalog().then((c) => {
      if (this.roomTrack && !c.some((t) => t.id === this.roomTrack!.id)) c.push(this.roomTrack);
      this.catalog = c;
      this.renderHomeTrack();
      this.renderTrackPicker();
    });
  }

  // ---------- public

  show() {
    if (this.root.hidden) this.loadCatalog();
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
  }

  get visible() {
    return !this.root.hidden;
  }

  showHome(msg = '') {
    this.setRoom(null);
    this.$.home.hidden = false;
    this.$.inRoom.hidden = true;
    this.$.homeMsg.textContent = msg;
    this.renderHomeTrack();
    this.show();
  }

  setRoom(room: RoomClient | null) {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.room = room;
    if (!room) return;
    this.$.home.hidden = true;
    this.$.inRoom.hidden = false;
    this.$.code.textContent = room.code;
    this.$.net.textContent = '';
    this.offs.push(
      room.on('state', () => this.render()),
      room.on('links', () => this.renderPlayers()),
      room.on('net', (ok) => (this.$.net.textContent = ok ? '' : 'Connection to the room server lost, retrying…')),
    );
    (this.$.myName as HTMLInputElement).value = this.driver.name;
    this.render();
  }

  /** The room's track geometry, once loaded (for the outline). */
  setRoomTrack(t: TrackData | null) {
    this.roomTrack = t;
    this.renderTrack();
  }

  // ---------- events

  private bind() {
    const click = (sel: string, fn: (el: HTMLElement) => void) =>
      this.root.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>(sel);
        if (el && this.root.contains(el)) fn(el);
      });
    click('[data-act="close"]', () => this.actions.close());
    click('[data-act="phone"]', () => openPadCard());
    const phoneBtn = this.root.querySelector<HTMLElement>('[data-act="phone"]')!;
    phonePad.on('status', (s) => phoneBtn.classList.toggle('live', s === 'live'));
    // Esc goes back from create/join; in a room it would mean leaving, so it does nothing there.
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !this.root.hidden && !this.$.home.hidden) this.actions.close();
    });
    click('[data-act="create"]', () =>
      this.run(async () => {
        const t = this.homeTrack();
        if (!t) throw new Error('Pick a track first');
        await this.actions.create(t, this.preferred?.id === t.id ? this.preferred.dir : 'fwd', LAPS_DEFAULT);
      }),
    );
    (this.$.joinForm as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      const code = (this.$.joinCode as HTMLInputElement).value.trim().toUpperCase();
      if (!CODE_RE.test(code)) return (this.$.homeMsg.textContent = 'Room codes are 4 letters/numbers, like K7QX.');
      this.run(() => this.actions.join(code));
    });
    click('[data-act="leave"]', () => this.run(() => this.actions.leave()));
    click('[data-act="copy"]', async (b) => {
      if (!this.room) return;
      try {
        await navigator.clipboard.writeText(this.room.link);
        b.textContent = 'Copied!';
      } catch {
        prompt('Copy this link', this.room.link);
      }
      setTimeout(() => (b.textContent = 'Copy link'), 1500);
    });
    click('[data-act="share"]', () => this.room && navigator.share?.({ title: 'Race me on ApexKart', text: `Join my kart race (room ${this.room.code})`, url: this.room.link }).catch(() => undefined));
    if (!('share' in navigator)) this.root.querySelector<HTMLElement>('[data-act="share"]')!.hidden = true;
    click('[data-act="ready"]', () => this.run(() => this.room!.setReady(!this.room!.me || this.room!.me.ready !== this.room!.state!.cfg.v)));
    click('[data-act="start"]', () => this.run(() => this.room!.start()));
    click('[data-act="rejoin"]', () => this.actions.rejoinRace());
    click('[data-act="end"]', () => this.run(() => this.room!.endRace()));
    click('[data-dir]', (b) => this.run(() => this.room!.configure({ dir: b.dataset.dir as Dir })));
    click('[data-laps]', (b) => this.run(() => this.room!.configure({ laps: this.room!.state!.cfg.laps + Number(b.dataset.laps) })));
    click('[data-time]', (b) => this.run(() => this.room!.configure({ time: b.dataset.time as RoomTime })));
    click('[data-kick]', (b) => {
      const p = this.room?.state?.players.find((x) => x.mid === b.dataset.kick);
      if (p && confirm(`Remove ${p.name} from the room?`)) this.run(() => this.room!.kick(p.mid));
    });
    click('[data-color]', (b) => {
      this.driver.color = b.dataset.color!;
      saveDriver(this.driver);
      this.run(() => this.room!.setProfile({ name: this.driver.name, color: this.driver.color }));
    });
    this.$.trackSel.addEventListener('change', () => {
      const t = this.catalog.find((x) => x.id === (this.$.trackSel as HTMLSelectElement).value);
      if (t) this.run(() => this.room!.configure({ track: t }));
    });
    this.$.homeTrackSel.addEventListener('change', () => {
      this.preferred = { id: (this.$.homeTrackSel as HTMLSelectElement).value, dir: 'fwd' };
    });
    let nameTimer = 0;
    this.$.myName.addEventListener('input', () => {
      clearTimeout(nameTimer);
      nameTimer = window.setTimeout(() => {
        this.driver.name = cleanDriverName((this.$.myName as HTMLInputElement).value).trim() || 'Driver';
        saveDriver(this.driver);
        this.run(() => this.room!.setProfile({ name: this.driver.name, color: this.driver.color }));
      }, 600);
    });
  }

  private async run(fn: () => Promise<unknown>) {
    if (this.busy) return;
    this.busy = true;
    this.root.classList.add('busy');
    try {
      await fn();
      this.$.roomMsg.textContent = '';
    } catch (e) {
      const msg = (e as Error).message || 'Something went wrong';
      (this.room ? this.$.roomMsg : this.$.homeMsg).textContent = msg;
    } finally {
      this.busy = false;
      this.root.classList.remove('busy');
    }
  }

  // ---------- rendering

  private homeTrack() {
    const id = (this.$.homeTrackSel as HTMLSelectElement).value || this.preferred?.id;
    return this.catalog.find((t) => t.id === id) ?? this.catalog[0] ?? null;
  }

  private options(selected: string) {
    const opt = (t: TrackData) => `<option value="${escapeHtml(t.id)}" ${t.id === selected ? 'selected' : ''}>${escapeHtml(t.name)}${t.location ? ' · ' + escapeHtml(t.location) : ''}</option>`;
    const presets = this.catalog.filter((t) => t.preset);
    const mine = this.catalog.filter((t) => !t.preset);
    return `<optgroup label="Featured circuits">${presets.map(opt).join('')}</optgroup>` + (mine.length ? `<optgroup label="Discovered by you">${mine.map(opt).join('')}</optgroup>` : '');
  }

  private renderHomeTrack() {
    const sel = this.$.homeTrackSel as HTMLSelectElement;
    const want = this.preferred?.id || sel.value || this.catalog.find((t) => /KF1/.test(t.name))?.id || '';
    sel.innerHTML = this.options(want);
    if (!sel.value && this.catalog[0]) sel.value = this.catalog[0].id;
  }

  private renderTrackPicker() {
    const cfg = this.room?.state?.cfg;
    if (!cfg) return;
    if (this.roomTrack && !this.catalog.some((t) => t.id === this.roomTrack!.id)) this.catalog.push(this.roomTrack);
    const sel = this.$.trackSel as HTMLSelectElement;
    const html = this.options(cfg.track);
    if (sel.dataset.sig !== html) {
      sel.innerHTML = html;
      sel.dataset.sig = html;
    }
    sel.value = cfg.track;
  }

  private render() {
    const s = this.room?.state;
    if (!s) return;
    this.renderTrack();
    this.renderPlayers();
    this.renderActions(s);
    this.renderLast(s);
  }

  private renderTrack() {
    const s = this.room?.state;
    if (!s) return;
    const { cfg } = s;
    const host = this.room!.isHost;
    const t = this.roomTrack?.id === cfg.track ? this.roomTrack : null;
    const art = outline(t, cfg.dir);
    if (this.$.outline.dataset.sig !== `${cfg.track}:${cfg.dir}:${!!t}`) {
      this.$.outline.dataset.sig = `${cfg.track}:${cfg.dir}:${!!t}`;
      this.$.outline.innerHTML = art;
    }
    this.$.trackName.textContent = cfg.trackName;
    this.$.stripe.setAttribute('style', stripeStyle(t?.country));
    const night = roomTime(cfg) === 'night';
    this.$.trackMeta.textContent = `${(cfg.lengthM / 1000).toFixed(2)} km · ${cfg.dir === 'rev' ? 'reverse' : 'normal'} · ${cfg.laps} lap${cfg.laps > 1 ? 's' : ''}${night ? ' · night' : ''}`;
    this.$.boardTrack.textContent = circuitCode(cfg.trackName);
    this.$.boardLaps.textContent = `${cfg.laps} LAP${cfg.laps > 1 ? 'S' : ''}`;
    this.$.hostControls.hidden = !host;
    const lobby = cfg.phase === 'lobby';
    this.$.hostControls.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach((b) => (b.disabled = !lobby));
    this.$.dirs.querySelectorAll<HTMLElement>('[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === cfg.dir));
    this.$.times.querySelectorAll<HTMLElement>('[data-time]').forEach((b) => {
      b.classList.toggle('on', b.dataset.time === roomTime(cfg));
      b.setAttribute('aria-pressed', String(b.dataset.time === roomTime(cfg)));
    });
    this.$.laps.textContent = String(cfg.laps);
    (this.root.querySelector('[data-laps="-1"]') as HTMLButtonElement).disabled = !lobby || cfg.laps <= LAPS_MIN;
    (this.root.querySelector('[data-laps="1"]') as HTMLButtonElement).disabled = !lobby || cfg.laps >= LAPS_MAX;
    this.renderTrackPicker();
  }

  private renderPlayers() {
    const room = this.room;
    const s = room?.state;
    if (!room || !s) return;
    const links = room.mesh.links();
    const linkLabel = (l: LinkInfo | undefined) =>
      !l
        ? '<span class="link"></span>'
        : l.state === 'p2p'
          ? `<span class="link p2p" title="Direct peer-to-peer link">${l.rtt != null ? Math.round(l.rtt) + ' MS' : 'DIRECT'}</span>`
          : l.state === 'relay'
            ? `<span class="link relay" title="A direct connection isn't possible between your networks (no TURN server), so positions go through the server a few times a second.">RELAY</span>`
            : `<span class="link" title="Setting up a direct connection">LINKING…</span>`;
    const racing = s.cfg.phase === 'racing';
    const onGrid = new Set(s.cfg.grid.map((g) => g.mid));
    this.$.players.innerHTML = s.players
      .map((p, i) => {
        const me = p.mid === room.mid;
        const host = p.mid === s.cfg.host;
        const ready = racing ? (onGrid.has(p.mid) ? (p.fin?.r === s.cfg.race ? 'DONE' : 'RACING') : 'WAITING') : host ? '' : isReady(p, s.cfg) ? 'READY' : 'NOT READY';
        const tone = ready === 'READY' || ready === 'DONE' ? 'yes' : ready === 'RACING' ? 'live' : '';
        const c = escapeHtml(p.color);
        return `<li class="pw-row${me ? ' me' : ''}">
          <span class="pw-pos${me ? ' me' : ''}">${i + 1}</span>
          <span class="pw-stripe" style="--c1:${c};--c2:${c}"></span>
          <span class="nm"><span class="nm-t">${escapeHtml(p.name)}</span>${me ? '<small>YOU</small>' : ''}${host ? '<span class="host">HOST</span>' : ''}</span>
          ${me ? '<span class="link"></span>' : linkLabel(links.get(p.mid))}
          <span class="state ${tone}">${ready}</span>
          ${room.isHost && !me ? `<button class="kick" data-kick="${p.mid}" title="Remove from room" aria-label="Remove ${escapeHtml(p.name)}">✕</button>` : '<span class="kick"></span>'}
        </li>`;
      })
      .join('');
    this.$.count.textContent = `${s.players.length} / 8`;
    this.$.boardGrid.textContent = `${s.players.length}/8`;
    const taken = new Set(s.players.filter((p) => p.mid !== room.mid).map((p) => p.color));
    const mine = room.me?.color;
    this.$.swatches.innerHTML = KART_COLORS.map(
      (c) => `<button data-color="${c}" style="--c:${c}" class="${c === mine ? 'on' : ''}" ${taken.has(c) ? 'disabled' : ''} aria-label="Kart colour ${c}"></button>`,
    ).join('');
  }

  private renderActions(s: RoomState) {
    const room = this.room!;
    const { cfg } = s;
    const me = room.me;
    const readyBtn = this.$.readyBtn as HTMLButtonElement;
    const startBtn = this.$.startBtn as HTMLButtonElement;
    const racing = cfg.phase === 'racing';
    const others = s.players.filter((p) => p.mid !== cfg.host);
    const waiting = others.filter((p) => !isReady(p, cfg));
    readyBtn.hidden = room.isHost || racing;
    startBtn.hidden = !room.isHost || racing;
    const iAmReady = !!me && isReady(me, cfg);
    readyBtn.textContent = iAmReady ? 'Ready ✓' : 'Ready up';
    readyBtn.classList.toggle('primary', !iAmReady);
    readyBtn.classList.toggle('done', iAmReady);
    startBtn.disabled = waiting.length > 0;
    const code = escapeHtml(circuitCode(cfg.trackName));
    startBtn.innerHTML = `${s.players.length === 1 ? `Start solo · ${code}` : `Start ${code}`} <span class="arrow">→</span>`;
    this.$.hint.textContent = racing
      ? ''
      : room.isHost
        ? waiting.length
          ? `Waiting for ${waiting.map((p) => p.name).join(', ')} to ready up`
          : s.players.length === 1
            ? 'Share the link or code. Friends can join any time.'
            : 'Everyone’s ready!'
        : iAmReady
          ? `Waiting for ${s.players.find((p) => p.mid === cfg.host)?.name ?? 'the host'} to start`
          : 'Ready up when you’re set';

    const inGrid = cfg.grid.some((g) => g.mid === room.mid);
    const myFin = me?.fin?.r === cfg.race;
    const rejoin = this.$.rejoin as HTMLButtonElement;
    rejoin.hidden = !(racing && inGrid && !myFin);
    (this.$.endBtn as HTMLButtonElement).hidden = !(racing && room.isHost);
    this.$.banner.textContent = racing
      ? inGrid
        ? myFin
          ? me?.fin?.ms == null
            ? 'You retired from this race. Waiting for the others…'
            : 'You’ve finished. Waiting for the others…'
          : 'Your race is on!'
        : `A ${cfg.laps}-lap race is on. You’ll be on the grid for the next one.`
      : '';
  }

  private renderLast(s: RoomState) {
    const last = s.cfg.last;
    this.$.last.hidden = !last;
    if (!last) return;
    const lead = last.rows[0]?.ms;
    this.$.lastTitle.textContent = `Last race · ${last.trackName} · ${last.laps} lap${last.laps > 1 ? 's' : ''}`;
    this.$.lastRows.innerHTML = last.rows
      .map((r, i) => {
        const dnf = r.ms == null;
        const c = escapeHtml(r.color);
        return `<li class="${r.mid === this.room!.mid ? 'me' : ''}${dnf ? ' dnf' : ''}"><span class="p">${dnf ? '–' : i + 1}</span>
        <span class="pw-stripe" style="--c1:${c};--c2:${c}"></span><span class="nm">${escapeHtml(r.name)}</span>
        <span class="tm${!dnf && i === 0 ? ' p' : ''}">${dnf ? 'DNF' : i === 0 ? formatMs(r.ms) : '+' + ((r.ms! - lead!) / 1000).toFixed(3)}</span></li>`;
      })
      .join('');
  }
}

const LOBBY_HTML = /* html */ `
<div class="mp-wrap">
  <header class="mp-bar">
    <button class="mp-back ui" data-act="close"><span class="mono">‹</span> Circuits</button>
    <span class="mp-bar-r">
      <span class="mp-bar-t ui">Race friends</span>
      <button class="btn primary mp-entry pc-entry" data-act="phone" aria-label="Phone controller" title="Steer with your phone">${PHONE_ICON}<span class="mp-entry-label">Phone</span></button>
    </span>
  </header>

  <section class="mp-home" data-el="home">
    <div class="mp-hero">
      <p class="label">Multiplayer · up to 8</p>
      <h1 class="display">Race friends</h1>
      <p class="mp-lede">Create a room, send your friends the link or code, and race each other live.</p>
    </div>
    <label class="mp-field"><span class="label">Circuit</span><span class="pw-select"><select data-el="homeTrackSel"></select></span></label>
    <button class="btn primary lg block" data-act="create">Create room <span class="arrow">→</span></button>
    <div class="mp-or label">or join one</div>
    <form class="mp-join" data-el="joinForm">
      <input data-el="joinCode" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Room code" />
      <button class="btn">Join</button>
    </form>
    <div class="mp-msg" data-el="homeMsg"></div>
  </section>

  <section class="mp-room" data-el="inRoom" hidden>
    <div class="mp-col">
      <div class="mp-boardwrap">
        <div class="pw-board" aria-label="Room code">
          <div class="pw-board-in">
            <div class="pw-board-row"><span>ROOM</span><span class="y mp-code" data-el="code"></span></div>
            <div class="pw-board-row"><span data-el="boardTrack">–</span><span class="sm" data-el="boardLaps"></span></div>
            <div class="pw-board-row"><span>GRID</span><span class="sm" data-el="boardGrid"></span></div>
          </div>
        </div>
        <div class="mp-share">
          <button class="btn" data-act="copy">Copy link</button>
          <button class="btn" data-act="share">Share</button>
        </div>
      </div>
      <div class="mp-banner ui" data-el="banner"></div>

      <div class="mp-track">
        <div class="mp-art graph-paper" data-el="outline"></div>
        <div class="mp-tinfo">
          <div class="mp-tname"><span class="pw-stripe big" data-el="stripe"></span><b class="display" data-el="trackName"></b></div>
          <div class="label" data-el="trackMeta"></div>
        </div>
      </div>
      <div data-el="hostControls" class="mp-settings">
        <span class="pw-select"><select data-el="trackSel" aria-label="Circuit"></select></span>
        <div class="mp-set"><span class="label">Direction</span><div class="pw-tabs" data-el="dirs"><button data-dir="fwd">Normal</button><button data-dir="rev">Reverse</button></div></div>
        <div class="mp-set"><span class="label">Laps</span><div class="mp-laps"><button data-laps="-1" aria-label="Fewer laps">−</button><b class="mono" data-el="laps"></b><button data-laps="1" aria-label="More laps">+</button></div></div>
        <div class="mp-set"><span class="label">Time of day</span><div class="pw-tabs soft" data-el="times" role="group" aria-label="Time of day for everyone"><button data-time="day">Day</button><button data-time="night">Night</button></div></div>
        <p class="mp-note">Everyone races at the time of day you pick.</p>
      </div>
    </div>

    <div class="mp-col">
      <div class="mp-players">
        <h3 class="mp-colh label"><span>Drivers</span><span class="mono" data-el="count"></span></h3>
        <ul class="mp-tower" data-el="players"></ul>
        <div class="mp-me">
          <span class="label">Your kart</span>
          <input data-el="myName" maxlength="16" autocomplete="off" spellcheck="false" aria-label="Your name" />
          <div class="mp-swatches" data-el="swatches"></div>
        </div>
      </div>
      <div class="mp-last" data-el="last" hidden>
        <h3 class="mp-colh label" data-el="lastTitle"></h3>
        <ol class="mp-cls" data-el="lastRows"></ol>
      </div>
    </div>

    <div class="mp-foot">
      <div class="mp-msg" data-el="roomMsg"></div>
      <div class="mp-net" data-el="net"></div>
      <p class="mp-hint" data-el="hint"></p>
      <div class="mp-actions">
        <button class="btn" data-act="leave">Leave</button>
        <button class="btn" data-act="end" data-el="endBtn" hidden title="End the race for everyone">End race</button>
        <button class="btn primary lg" data-act="rejoin" data-el="rejoin" hidden>Back to race <span class="arrow">→</span></button>
        <button class="btn primary lg" data-act="ready" data-el="readyBtn">Ready up</button>
        <button class="btn go lg" data-act="start" data-el="startBtn">Start race <span class="arrow">→</span></button>
      </div>
    </div>
  </section>
</div>`;
