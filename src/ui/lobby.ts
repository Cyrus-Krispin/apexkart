// Multiplayer lobby: create/join a room, then the room itself (players, track, ready/start,
// last results). Room lifecycle (create/join/leave, starting races) belongs to the controller
// in src/multiplayer.ts; settings, ready and profile changes go straight to the RoomClient.
import './multiplayer.css';
import { escapeHtml, formatMs, saveDriver, type Driver } from '../net/api';
import { CODE_RE, KART_COLORS, LAPS_DEFAULT, LAPS_MAX, LAPS_MIN, isReady, type Dir, type RoomState } from '../shared/room';
import type { TrackData } from '../track/osm';
import type { RoomClient } from '../net/room';
import type { LinkInfo } from '../net/mesh';

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

function outline(t: TrackData | null) {
  if (!t?.points?.length) return '';
  const k = Math.cos((t.center[0] * Math.PI) / 180);
  const xs = t.points.map((p) => p[1] * k);
  const ys = t.points.map((p) => -p[0]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min(108 / (x1 - x0 || 1), 72 / (y1 - y0 || 1));
  const ox = (120 - (x1 - x0) * s) / 2;
  const oy = (84 - (y1 - y0) * s) / 2;
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${(ox + (x - x0) * s).toFixed(1)} ${(oy + (ys[i] - y0) * s).toFixed(1)}`).join('') + 'Z';
  return `<path d="${d}"/>`;
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
        this.driver.name = (this.$.myName as HTMLInputElement).value.replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, 16) || 'Driver';
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
    this.$.outline.innerHTML = outline(t);
    this.$.trackName.textContent = cfg.trackName;
    this.$.trackMeta.textContent = `${(cfg.lengthM / 1000).toFixed(2)} km · ${cfg.dir === 'rev' ? 'reverse' : 'normal direction'} · ${cfg.laps} lap${cfg.laps > 1 ? 's' : ''}`;
    this.$.hostControls.hidden = !host;
    const lobby = cfg.phase === 'lobby';
    this.$.hostControls.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach((b) => (b.disabled = !lobby));
    this.$.dirs.querySelectorAll<HTMLElement>('[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === cfg.dir));
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
        ? ''
        : l.state === 'p2p'
          ? `<span class="link p2p" title="Direct peer-to-peer link">● ${l.rtt != null ? Math.round(l.rtt) + ' ms' : 'direct'}</span>`
          : l.state === 'relay'
            ? `<span class="link relay" title="A direct connection isn't possible between your networks (no TURN server), so positions go through the server a few times a second.">● relayed</span>`
            : `<span class="link" title="Setting up a direct connection">● connecting…</span>`;
    const racing = s.cfg.phase === 'racing';
    const onGrid = new Set(s.cfg.grid.map((g) => g.mid));
    this.$.players.innerHTML = s.players
      .map((p) => {
        const me = p.mid === room.mid;
        const ready = racing ? (onGrid.has(p.mid) ? (p.fin?.r === s.cfg.race ? 'DONE' : 'RACING') : 'WAITING') : p.mid === s.cfg.host ? '' : isReady(p, s.cfg) ? 'READY' : 'NOT READY';
        return `<li class="${me ? 'me' : ''}">
          <span class="dot" style="background:${escapeHtml(p.color)}"></span>
          <span class="nm">${escapeHtml(p.name)}${me ? ' <span class="mp-muted">(you)</span>' : ''}</span>
          ${p.mid === s.cfg.host ? '<span class="host">HOST</span>' : ''}
          <span class="ready ${ready === 'READY' || ready === 'DONE' ? 'yes' : ''}">${ready}</span>
          ${me ? '' : linkLabel(links.get(p.mid))}
          ${room.isHost && !me ? `<button class="kick" data-kick="${p.mid}" title="Remove from room">✕</button>` : ''}
        </li>`;
      })
      .join('');
    this.$.count.textContent = `${s.players.length}/8`;
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
    readyBtn.classList.toggle('ok', iAmReady);
    readyBtn.classList.toggle('primary', !iAmReady);
    startBtn.disabled = waiting.length > 0;
    startBtn.textContent = s.players.length === 1 ? 'Start solo race' : 'Start race';
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
      .map(
        (r, i) => `<li class="${r.mid === this.room!.mid ? 'me' : ''}"><span class="pos">${r.ms != null ? i + 1 : '–'}</span>
        <span class="dot" style="background:${escapeHtml(r.color)}"></span><span class="nm">${escapeHtml(r.name)}</span>
        <span class="tm">${r.ms == null ? 'DNF' : i === 0 ? formatMs(r.ms) : '+' + ((r.ms - lead!) / 1000).toFixed(3)}</span></li>`,
      )
      .join('');
  }
}

const LOBBY_HTML = /* html */ `
<div class="mp-card">
  <div class="mp-head">
    <h1>Race with friends</h1>
    <button class="mp-back" data-act="close">← Track map</button>
  </div>

  <section class="mp-home" data-el="home">
    <p class="mp-muted" style="margin:0">Create a room, send your friends the link or code, and race each other live.</p>
    <label class="mp-field mp-row"><span class="mp-muted">Track</span><select data-el="homeTrackSel"></select></label>
    <button class="mp-btn primary" data-act="create">Create room</button>
    <div class="mp-or">OR JOIN ONE</div>
    <form class="mp-join" data-el="joinForm">
      <input data-el="joinCode" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false" />
      <button class="mp-btn">Join</button>
    </form>
    <div class="mp-msg" data-el="homeMsg"></div>
  </section>

  <section class="mp-room" data-el="inRoom" hidden>
    <div class="mp-code">
      <span class="mp-muted">Room</span><span class="code" data-el="code"></span><span class="grow"></span>
      <button class="mp-btn small" data-act="copy">Copy link</button>
      <button class="mp-btn small" data-act="share">Share</button>
    </div>
    <div class="mp-banner" data-el="banner"></div>

    <div class="mp-track">
      <svg viewBox="0 0 120 84" data-el="outline"></svg>
      <div class="mp-settings">
        <div><div class="name" data-el="trackName"></div><div class="meta" data-el="trackMeta"></div></div>
        <div data-el="hostControls" class="mp-settings">
          <label class="mp-field mp-row"><select data-el="trackSel"></select></label>
          <div class="mp-row">
            <div class="mp-seg" data-el="dirs"><button data-dir="fwd">Normal</button><button data-dir="rev">Reverse</button></div>
            <div class="mp-laps"><button class="mp-btn small" data-laps="-1">−</button><b data-el="laps"></b><button class="mp-btn small" data-laps="1">+</button><span class="mp-muted">laps</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="mp-players">
      <h3>Drivers <span data-el="count"></span></h3>
      <ul data-el="players"></ul>
      <div class="mp-me"><input data-el="myName" maxlength="16" autocomplete="off" spellcheck="false" aria-label="Your name" /><div class="mp-swatches" data-el="swatches"></div></div>
    </div>

    <div class="mp-last" data-el="last" hidden>
      <h3 data-el="lastTitle"></h3>
      <ol data-el="lastRows"></ol>
    </div>

    <div class="mp-msg" data-el="roomMsg"></div>
    <div class="mp-net" data-el="net"></div>
    <div class="mp-actions">
      <button class="mp-btn" data-act="leave">Leave</button>
      <span class="grow mp-muted" data-el="hint"></span>
      <button class="mp-btn" data-act="end" data-el="endBtn" hidden title="End the race for everyone">End race</button>
      <button class="mp-btn primary big" data-act="rejoin" data-el="rejoin" hidden>Back to race</button>
      <button class="mp-btn primary big" data-act="ready" data-el="readyBtn">Ready up</button>
      <button class="mp-btn primary big" data-act="start" data-el="startBtn">Start race</button>
    </div>
  </section>
</div>`;
