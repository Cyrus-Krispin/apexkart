// A watching screen between races (#/watch/CODE, src/watchController.ts): the room's drivers and
// their ready state, the circuit, the last results, and a QR code for joining the room to race.
// The race itself opens over it on its own when the host starts one.
import './multiplayer.css';
import './pad.css';
import './party.css';
import './watch.css';
import { escapeHtml, formatMs } from '../net/api';
import { isReady, roomTime, type Dir, type RoomState } from '../shared/room';
import type { TrackData } from '../track/osm';
import { analyzeShape, type TrackShape } from '../track/shape';
import { trackArt } from './trackArt';
import { circuitCode, stripeStyle } from './pitwall';
import { qrSvg } from './padCard';

const shapes = new Map<string, TrackShape>();
function outline(t: TrackData, dir: Dir) {
  let shape = shapes.get(t.id);
  if (!shape) shapes.set(t.id, (shape = analyzeShape(t.points)));
  return trackArt(shape, { w: 150, h: 104, pad: 12, reverse: dir === 'rev', arrows: true, road: true, sectors: true });
}

export class WatchBoard {
  readonly root: HTMLElement;
  private $: Record<string, HTMLElement> = {};
  private qrFor = '';

  constructor(private actions: { leave(): void; race(): void }) {
    this.root = document.createElement('div');
    this.root.className = 'mp-lobby wt-lobby';
    this.root.hidden = true;
    this.root.innerHTML = BOARD_HTML;
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.$[e.dataset.el!] = e));
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close') this.actions.leave();
      if (act === 'race') this.actions.race();
    });
  }

  show() {
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
  }

  get visible() {
    return !this.root.hidden;
  }

  /** Before there's a room to show (connecting, or it closed). */
  message(code: string, text: string) {
    this.$.code.textContent = code;
    this.$.room.hidden = true;
    this.$.msg.textContent = text;
  }

  /** `raceOpen`: a race view exists to go back to. */
  render(s: RoomState, track: TrackData | null, raceOpen: boolean) {
    const { cfg } = s;
    this.$.room.hidden = false;
    this.$.msg.textContent = '';
    this.$.code.textContent = cfg.code;
    const t = track?.id === cfg.track ? track : null;
    const sig = `${cfg.track}:${cfg.dir}:${!!t}`;
    if (this.$.outline.dataset.sig !== sig) {
      this.$.outline.dataset.sig = sig;
      this.$.outline.innerHTML = t ? outline(t, cfg.dir) : '';
    }
    this.$.trackName.textContent = cfg.trackName;
    this.$.stripe.setAttribute('style', stripeStyle(t?.country));
    const night = roomTime(cfg) === 'night';
    this.$.trackMeta.textContent = `${(cfg.lengthM / 1000).toFixed(2)} km · ${cfg.dir === 'rev' ? 'reverse' : 'normal'} · ${cfg.laps} lap${cfg.laps > 1 ? 's' : ''}${night ? ' · night' : ''}`;
    this.$.boardTrack.textContent = circuitCode(cfg.trackName);
    this.$.boardLaps.textContent = `${cfg.laps} LAP${cfg.laps > 1 ? 'S' : ''}`;
    this.$.boardGrid.textContent = `${s.players.length}/8`;

    const racing = cfg.phase === 'racing';
    const onGrid = new Set(cfg.grid.map((g) => g.mid));
    this.$.players.innerHTML = s.players
      .map((p, i) => {
        const host = p.mid === cfg.host;
        const state = racing ? (onGrid.has(p.mid) ? (p.fin?.r === cfg.race ? 'DONE' : 'RACING') : 'WAITING') : host ? '' : isReady(p, cfg) ? 'READY' : 'NOT READY';
        const tone = state === 'READY' || state === 'DONE' ? 'yes' : state === 'RACING' ? 'live' : '';
        const c = escapeHtml(p.color);
        return `<li class="pw-row">
          <span class="pw-pos">${i + 1}</span>
          <span class="pw-stripe" style="--c1:${c};--c2:${c}"></span>
          <span class="nm"><span class="nm-t">${escapeHtml(p.name)}</span>${host ? '<span class="host">HOST</span>' : ''}</span>
          <span class="link"></span>
          <span class="state ${tone}">${state}</span>
          <span class="kick"></span>
        </li>`;
      })
      .join('');
    this.$.count.textContent = `${s.players.length} / 8`;
    const others = (s.watchers ?? []).length - 1;
    this.$.watchers.textContent = others > 0 ? `${others === 1 ? 'One other screen' : `${others} other screens`} watching` : '';

    const hostName = s.players.find((p) => p.mid === cfg.host)?.name ?? 'the host';
    const waiting = s.players.filter((p) => p.mid !== cfg.host && !isReady(p, cfg));
    this.$.banner.textContent = racing
      ? `A ${cfg.laps}-lap race is on.`
      : waiting.length
        ? `Waiting for ${waiting.map((p) => p.name).join(', ')} to ready up`
        : `Waiting for ${hostName} to start the race`;
    (this.$.raceBtn as HTMLButtonElement).hidden = !raceOpen;
    this.$.hint.textContent = racing ? '' : 'The race opens here on its own when it starts.';

    const last = cfg.last;
    this.$.last.hidden = !last;
    if (last) {
      const lead = last.rows[0]?.ms;
      this.$.lastTitle.textContent = `Last race · ${last.trackName} · ${last.laps} lap${last.laps > 1 ? 's' : ''}`;
      this.$.lastRows.innerHTML = last.rows
        .map((r, i) => {
          const dnf = r.ms == null;
          const c = escapeHtml(r.color);
          return `<li class="${dnf ? 'dnf' : ''}"><span class="p">${dnf ? '–' : i + 1}</span>
          <span class="pw-stripe" style="--c1:${c};--c2:${c}"></span><span class="nm">${escapeHtml(r.name)}</span>
          <span class="tm${!dnf && i === 0 ? ' p' : ''}">${dnf ? 'DNF' : i === 0 ? formatMs(r.ms) : '+' + ((r.ms! - lead!) / 1000).toFixed(3)}</span></li>`;
        })
        .join('');
    }
    this.drawQr(cfg.code);
  }

  /** A code for phones and laptops to join the room and race. */
  private async drawQr(code: string) {
    const url = `${location.origin}${location.pathname}#/room/${code}`;
    if (this.qrFor === url) return;
    this.qrFor = url;
    this.$.joinUrl.textContent = `${location.host}/#/room/${code}`;
    const svg = await qrSvg(url);
    if (this.qrFor === url) this.$.qr.innerHTML = svg;
  }
}

const BOARD_HTML = /* html */ `
<div class="mp-wrap">
  <header class="mp-bar">
    <button class="mp-back ui" data-act="close"><span class="mono">‹</span> Circuits</button>
    <span class="mp-bar-t ui">Watching</span>
  </header>

  <section class="mp-room wt-room">
    <div class="mp-col">
      <div class="mp-boardwrap">
        <div class="pw-board" aria-label="Room code">
          <div class="pw-board-in">
            <div class="pw-board-row"><span>ROOM</span><span class="y mp-code" data-el="code"></span></div>
            <div class="pw-board-row"><span data-el="boardTrack">–</span><span class="sm" data-el="boardLaps"></span></div>
            <div class="pw-board-row"><span>GRID</span><span class="sm" data-el="boardGrid"></span></div>
          </div>
        </div>
        <p class="mp-lede wt-lede">This screen watches: every kart live, the camera on the leader, the timing tower. It doesn’t race.</p>
      </div>
      <div class="mp-msg" data-el="msg"></div>
      <div data-el="room" hidden>
        <div class="mp-banner ui" data-el="banner"></div>
        <div class="mp-track">
          <div class="mp-art graph-paper" data-el="outline"></div>
          <div class="mp-tinfo">
            <div class="mp-tname"><span class="pw-stripe big" data-el="stripe"></span><b class="display" data-el="trackName"></b></div>
            <div class="label" data-el="trackMeta"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="mp-col">
      <div class="pt-join wt-join">
        <div class="pc-qr pt-qr" data-el="qr"><span class="pc-qr-wait mono">…</span></div>
        <div>
          <h3 class="pt-join-t display">Scan to race</h3>
          <span class="pw-k">Or open <span class="mono" data-el="joinUrl"></span></span>
        </div>
      </div>
      <div class="mp-players">
        <h3 class="mp-colh label"><span>Drivers</span><span class="mono" data-el="count"></span></h3>
        <ul class="mp-tower" data-el="players"></ul>
        <p class="wt-watchers label" data-el="watchers"></p>
      </div>
      <div class="mp-last" data-el="last" hidden>
        <h3 class="mp-colh label" data-el="lastTitle"></h3>
        <ol class="mp-cls" data-el="lastRows"></ol>
      </div>
    </div>

    <div class="mp-foot">
      <p class="mp-hint" data-el="hint"></p>
      <div class="mp-actions">
        <button class="btn" data-act="close">Leave</button>
        <button class="btn primary lg" data-act="race" data-el="raceBtn" hidden>Back to race <span class="arrow">→</span></button>
      </div>
    </div>
  </section>
</div>`;
