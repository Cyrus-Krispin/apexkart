// The party lobby (#/party, src/party.ts): the circuit and race settings, one QR code that every
// phone scans, and the four seats (P1-P4) filling up as phones join.
import './multiplayer.css';
import './pad.css';
import './party.css';
import { escapeHtml } from '../net/api';
import { LAPS_MAX, LAPS_MIN, type Dir, type RoomTime } from '../shared/room';
import type { TrackData } from '../track/osm';
import type { PartyScreen, PartySeat } from '../net/pad';
import { analyzeShape, type TrackShape } from '../track/shape';
import { trackArt } from './trackArt';
import { stripeStyle } from './pitwall';
import { trackCatalog } from './lobby';
import { joinWarning, qrSvg } from './padCard';

export interface PartySettings {
  track: string;
  dir: Dir;
  laps: number;
  time: RoomTime;
}

const SETTINGS_KEY = 'ak:party';

export function loadPartySettings(): PartySettings {
  const d: PartySettings = { track: '', dir: 'fwd', laps: 3, time: 'day' };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      track: typeof s.track === 'string' ? s.track : d.track,
      dir: s.dir === 'rev' ? 'rev' : 'fwd',
      laps: Number.isInteger(s.laps) ? Math.min(LAPS_MAX, Math.max(LAPS_MIN, s.laps)) : d.laps,
      time: s.time === 'night' ? 'night' : 'day',
    };
  } catch {
    return d;
  }
}

const shapes = new Map<string, TrackShape>();
function outline(t: TrackData, dir: Dir) {
  let shape = shapes.get(t.id);
  if (!shape) shapes.set(t.id, (shape = analyzeShape(t.points)));
  return trackArt(shape, { w: 150, h: 104, pad: 12, reverse: dir === 'rev', arrows: true, road: true, sectors: true });
}

export class PartyLobby {
  readonly root: HTMLElement;
  private $: Record<string, HTMLElement> = {};
  private catalog: TrackData[] = [];
  private shownCode: string | null = null;

  constructor(
    private screen: PartyScreen,
    readonly settings: PartySettings,
    private colors: string[],
    private actions: { start(): void; close(): void },
  ) {
    this.root = document.createElement('div');
    this.root.className = 'mp-lobby pt-lobby';
    this.root.hidden = true;
    this.root.innerHTML = LOBBY_HTML;
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.$[e.dataset.el!] = e));
    document.body.appendChild(this.root);
    this.bind();
    this.$.host.textContent = `${location.host}/pad.html`;
    const warn = joinWarning();
    this.$.warn.hidden = !warn;
    this.$.warn.innerHTML = warn;
  }

  show() {
    if (this.root.hidden) this.loadCatalog();
    this.root.hidden = false;
    this.render();
  }

  hide() {
    this.root.hidden = true;
  }

  get visible() {
    return !this.root.hidden;
  }

  message(text: string) {
    this.$.msg.textContent = text;
  }

  /** The circuit to race, once the catalog has loaded. */
  track(): TrackData | null {
    return this.catalog.find((t) => t.id === this.settings.track) ?? null;
  }

  private loadCatalog() {
    trackCatalog().then((c) => {
      this.catalog = c;
      if (!c.some((t) => t.id === this.settings.track)) this.settings.track = (c.find((t) => /KF1/.test(t.name)) ?? c[0])?.id ?? '';
      const opt = (t: TrackData) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.location ? ' · ' + escapeHtml(t.location) : ''}</option>`;
      const presets = c.filter((t) => t.preset);
      const mine = c.filter((t) => !t.preset);
      const sel = this.$.trackSel as HTMLSelectElement;
      sel.innerHTML = `<optgroup label="Featured circuits">${presets.map(opt).join('')}</optgroup>` + (mine.length ? `<optgroup label="Discovered by you">${mine.map(opt).join('')}</optgroup>` : '');
      sel.value = this.settings.track;
      this.render();
    });
  }

  private save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* not kept */
    }
    this.render();
  }

  private bind() {
    const click = (sel: string, fn: (el: HTMLElement) => void) =>
      this.root.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>(sel);
        if (el && this.root.contains(el)) fn(el);
      });
    click('[data-act="close"]', () => this.actions.close());
    click('[data-act="start"]', () => this.actions.start());
    click('[data-dir]', (b) => {
      this.settings.dir = b.dataset.dir as Dir;
      this.save();
    });
    click('[data-laps]', (b) => {
      this.settings.laps = Math.min(LAPS_MAX, Math.max(LAPS_MIN, this.settings.laps + Number(b.dataset.laps)));
      this.save();
    });
    click('[data-time]', (b) => {
      this.settings.time = b.dataset.time as RoomTime;
      this.save();
    });
    click('[data-kick]', (b) => this.screen.kick(Number(b.dataset.kick)));
    this.$.trackSel.addEventListener('change', () => {
      this.settings.track = (this.$.trackSel as HTMLSelectElement).value;
      this.save();
    });
    addEventListener('keydown', (e) => {
      if (this.root.hidden || e.defaultPrevented || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.key === 'Escape') this.actions.close();
      if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('button')) this.actions.start();
    });
  }

  render() {
    if (this.root.hidden) return;
    const s = this.settings;
    const t = this.track();
    const sig = `${t?.id}:${s.dir}`;
    if (t && this.$.outline.dataset.sig !== sig) {
      this.$.outline.dataset.sig = sig;
      this.$.outline.innerHTML = outline(t, s.dir);
    }
    this.$.trackName.textContent = t?.name ?? 'Loading circuits…';
    this.$.stripe.setAttribute('style', stripeStyle(t?.country));
    this.$.trackMeta.textContent = t ? `${(t.lengthM / 1000).toFixed(2)} km · ${s.dir === 'rev' ? 'reverse' : 'normal'} · ${s.laps} lap${s.laps > 1 ? 's' : ''}${s.time === 'night' ? ' · night' : ''}` : '';
    this.$.dirs.querySelectorAll<HTMLElement>('[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === s.dir));
    this.$.times.querySelectorAll<HTMLElement>('[data-time]').forEach((b) => {
      b.classList.toggle('on', b.dataset.time === s.time);
      b.setAttribute('aria-pressed', String(b.dataset.time === s.time));
    });
    this.$.laps.textContent = String(s.laps);
    (this.root.querySelector('[data-laps="-1"]') as HTMLButtonElement).disabled = s.laps <= LAPS_MIN;
    (this.root.querySelector('[data-laps="1"]') as HTMLButtonElement).disabled = s.laps >= LAPS_MAX;
    if (this.screen.code !== this.shownCode) this.drawCode(this.screen.code);
    this.renderSeats();
  }

  private async drawCode(code: string | null) {
    this.shownCode = code;
    this.$.code.textContent = code ?? '····';
    if (!code) {
      this.$.qr.innerHTML = '<span class="pc-qr-wait mono">…</span>';
      return;
    }
    const svg = await qrSvg(this.screen.url);
    if (this.shownCode === code) this.$.qr.innerHTML = svg;
  }

  renderSeats() {
    if (this.root.hidden) return;
    const seats = this.screen.seats;
    const label = (st: PartySeat) =>
      st.status === 'live'
        ? ['yes', st.conn.tilt ? 'READY · TILT' : 'READY · BUTTONS']
        : st.status === 'lost'
          ? ['live', 'RECONNECTING']
          : st.status === 'connecting'
            ? ['', 'CONNECTING']
            : ['', ''];
    this.$.seats.innerHTML = seats
      .map((st) => {
        const c = escapeHtml(this.colors[st.n]);
        const [tone, text] = label(st);
        return `<li class="pw-row pt-seat${st.mid ? '' : ' empty'}" style="--c:${c}">
          <span class="pw-pos pt-pos">P${st.n + 1}</span>
          <span class="pw-stripe" style="--c1:${c};--c2:${c}"></span>
          <span class="nm"><span class="nm-t">${st.mid ? `Player ${st.n + 1}` : 'Free · scan to join'}</span></span>
          <span class="link"></span>
          <span class="state ${tone}">${text}</span>
          ${st.mid ? `<button class="kick" data-kick="${st.n}" title="Free this seat" aria-label="Remove player ${st.n + 1}">✕</button>` : '<span class="kick"></span>'}
        </li>`;
      })
      .join('');
    const live = seats.filter((x) => x.status === 'live');
    const pending = seats.filter((x) => x.status === 'connecting' || x.status === 'lost');
    const n = seats.filter((x) => x.mid).length;
    this.$.count.textContent = `${n} / ${seats.length}`;
    const start = this.$.startBtn as HTMLButtonElement;
    start.disabled = !live.length || !this.track();
    start.innerHTML = `${live.length > 1 ? `Start · ${live.length} players` : 'Start race'} <span class="arrow">→</span>`;
    this.$.hint.textContent = !this.screen.code
      ? 'Opening a code for the phones…'
      : !n
        ? 'Scan the code with each phone. Up to four players.'
        : pending.length
          ? `Waiting for ${pending.map((x) => `P${x.n + 1}`).join(', ')} to connect. Players who aren’t connected sit the race out.`
          : `${n === 1 ? 'One phone in' : `${n} phones in`}. Start here, or with Start on any phone.`;
  }
}

const LOBBY_HTML = /* html */ `
<div class="mp-wrap">
  <header class="mp-bar">
    <button class="mp-back ui" data-act="close"><span class="mono">‹</span> Circuits</button>
    <span class="mp-bar-t ui">Party · split screen</span>
  </header>

  <section class="mp-room pt-room">
    <div class="mp-col">
      <div class="mp-hero">
        <p class="label">Split screen · up to 4 phones</p>
        <h1 class="display">Party</h1>
        <p class="mp-lede">Everyone scans the code with their phone, then you all race on this screen. Hold the phone sideways, tilt to steer, press to brake.</p>
      </div>
      <div class="mp-track">
        <div class="mp-art graph-paper" data-el="outline"></div>
        <div class="mp-tinfo">
          <div class="mp-tname"><span class="pw-stripe big" data-el="stripe"></span><b class="display" data-el="trackName"></b></div>
          <div class="label" data-el="trackMeta"></div>
        </div>
      </div>
      <div class="mp-settings">
        <span class="pw-select"><select data-el="trackSel" aria-label="Circuit"></select></span>
        <div class="mp-set"><span class="label">Direction</span><div class="pw-tabs" data-el="dirs"><button data-dir="fwd">Normal</button><button data-dir="rev">Reverse</button></div></div>
        <div class="mp-set"><span class="label">Laps</span><div class="mp-laps"><button data-laps="-1" aria-label="Fewer laps">−</button><b class="mono" data-el="laps"></b><button data-laps="1" aria-label="More laps">+</button></div></div>
        <div class="mp-set"><span class="label">Time of day</span><div class="pw-tabs soft" data-el="times" role="group" aria-label="Time of day"><button data-time="day">Day</button><button data-time="night">Night</button></div></div>
      </div>
    </div>

    <div class="mp-col">
      <div class="pt-join">
        <div class="pc-qr pt-qr" data-el="qr"><span class="pc-qr-wait mono">…</span></div>
        <div class="pc-typed">
          <h3 class="pt-join-t display">Scan to join</h3>
          <span class="pw-k">Or open <span class="mono" data-el="host"></span> and type</span>
          <b class="pc-code mono" data-el="code">····</b>
        </div>
      </div>
      <p class="pc-warn" data-el="warn" hidden></p>
      <div class="mp-players">
        <h3 class="mp-colh label"><span>Players</span><span class="mono" data-el="count"></span></h3>
        <ul class="mp-tower" data-el="seats"></ul>
      </div>
    </div>

    <div class="mp-foot">
      <div class="mp-msg" data-el="msg"></div>
      <p class="mp-hint" data-el="hint"></p>
      <div class="mp-actions">
        <button class="btn go lg" data-act="start" data-el="startBtn">Start race <span class="arrow">→</span></button>
      </div>
    </div>
  </section>
</div>`;
