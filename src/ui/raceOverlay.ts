// In-race multiplayer HUD: race position, lap counter, live standings, pre-start countdown,
// and the results card. Pure view: src/game/mpRace.ts computes everything it shows.
import './multiplayer.css';
import { escapeHtml, formatMs } from '../net/api';

export interface StandingRow {
  mid: string;
  name: string;
  color: string;
  me: boolean;
  status: 'racing' | 'finished' | 'dnf' | 'out';
  ms: number | null; // finish time (ms from lights out)
  lap: number; // lap they're on (1..laps)
}

export interface OverlayView {
  laps: number;
  lap: number; // local player's lap
  pos: number; // local player's position (1-based)
  rows: StandingRow[]; // in race order
  countdown: number | null; // seconds until lights out, before the lights sequence
  finished: boolean; // local player has taken the flag (or retired)
  final: boolean; // race is over for everyone
  graceLeft: number | null; // seconds until stragglers are marked DNF
}

export class RaceOverlay {
  private el: HTMLElement;
  private $: Record<string, HTMLElement> = {};
  private sig: Record<string, string> = {};

  constructor(hud: HTMLElement, handlers: { lobby(): void }) {
    this.el = document.createElement('div');
    this.el.className = 'mp-overlay';
    this.el.innerHTML = /* html */ `
      <div class="mp-standings" data-el="standings">
        <div class="mp-poslap"><b data-el="pos">P–</b><span data-el="lap">LAP –</span></div>
        <ol data-el="rows"></ol>
      </div>
      <div class="mp-countdown" data-el="countdown" hidden></div>
      <div class="mp-results" data-el="results" hidden>
        <h2 data-el="resTitle"></h2>
        <ol data-el="resRows"></ol>
        <p class="mp-muted" data-el="resNote"></p>
        <button class="mp-btn primary" data-act="lobby">Back to lobby</button>
      </div>`;
    this.el.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.$[e.dataset.el!] = e));
    this.el.querySelector('[data-act="lobby"]')!.addEventListener('click', () => handlers.lobby());
    hud.appendChild(this.el);
  }

  private set(key: string, html: string) {
    if (this.sig[key] === html) return;
    this.sig[key] = html;
    this.$[key].innerHTML = html;
  }

  render(v: OverlayView) {
    const n = v.rows.length;
    this.set('pos', `P${v.pos}<small>/${n}</small>`);
    this.set('lap', v.finished ? 'FINISHED' : `LAP ${Math.min(v.lap, v.laps)}/${v.laps}`);
    const leader = v.rows[0]?.ms;
    const right = (r: StandingRow) =>
      r.status === 'finished'
        ? r.ms === leader
          ? formatMs(r.ms)
          : `+${((r.ms! - leader!) / 1000).toFixed(3)}`
        : r.status === 'racing'
          ? `L${Math.min(r.lap, v.laps)}`
          : r.status === 'dnf'
            ? 'DNF'
            : 'OUT';
    const row = (r: StandingRow, i: number) =>
      `<li class="${r.me ? 'me' : ''} ${r.status}"><span class="pos">${i + 1}</span><span class="dot" style="background:${escapeHtml(r.color)}"></span><span class="nm">${escapeHtml(r.name)}</span><span class="tm">${right(r)}</span></li>`;
    this.set('rows', v.rows.map(row).join(''));

    this.$.countdown.hidden = v.countdown === null;
    if (v.countdown !== null) this.set('countdown', `On the grid · lights in <b>${Math.ceil(v.countdown)}</b>`);

    this.$.results.hidden = !v.finished && !v.final;
    if (!this.$.results.hidden) {
      const me = v.rows.find((r) => r.me);
      const title = v.final ? 'Final results' : me?.status === 'finished' ? `You finished P${v.pos}` : 'You retired';
      this.set('resTitle', title);
      const full = (r: StandingRow) =>
        r.status === 'finished' ? formatMs(r.ms) : r.status === 'racing' ? `racing · lap ${Math.min(r.lap, v.laps)}/${v.laps}` : r.status === 'dnf' ? 'DNF' : 'left';
      this.set(
        'resRows',
        v.rows
          .map(
            (r, i) =>
              `<li class="${r.me ? 'me' : ''} ${r.status}"><span class="pos">${r.status === 'finished' ? i + 1 : '–'}</span><span class="dot" style="background:${escapeHtml(r.color)}"></span><span class="nm">${escapeHtml(r.name)}</span><span class="tm">${full(r)}</span></li>`,
          )
          .join(''),
      );
      this.set('resNote', v.final ? '' : v.graceLeft !== null ? `Waiting for the others · ${Math.ceil(v.graceLeft)}s left` : 'Waiting for the others…');
    }
  }

  dispose() {
    this.el.remove();
  }
}
