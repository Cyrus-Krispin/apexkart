// What a watching screen shows over the race (src/game/watchRace.ts): the timing tower, who the
// camera is on, the countdown and the classification. Pure view, like src/ui/raceOverlay.ts.
import './watch.css';
import { escapeHtml, formatMs } from '../net/api';
import type { StandingRow } from './raceOverlay';

export interface WatchView {
  code: string;
  laps: number;
  lap: number; // the leader's lap
  rows: StandingRow[]; // in race order
  following: string | null; // mid on camera
  auto: boolean; // the camera picks (the leader) rather than the watcher
  camera: string; // camera name
  countdown: number | null; // seconds until the lights sequence
  final: boolean;
  graceLeft: number | null;
}

export interface WatchHandlers {
  follow(mid: string): void;
  auto(): void;
  camera(): void;
  room(): void;
}

const CAM_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="7" width="13" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 11l5-3v8l-5-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

export class WatchOverlay {
  private el: HTMLElement;
  private $: Record<string, HTMLElement> = {};
  private sig: Record<string, string> = {};

  constructor(hud: HTMLElement, h: WatchHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'mp-overlay wt-overlay';
    this.el.innerHTML = /* html */ `
      <section class="wt-board">
        <header class="wt-head"><span class="wt-live">Live</span><span class="wt-code mono" data-el="code"></span><b class="mono" data-el="lap"></b></header>
        <ol data-el="rows"></ol>
        <p class="wt-keys"><kbd>1</kbd>–<kbd>8</kbd> follow · <kbd>A</kbd> leader · <kbd>C</kbd> camera</p>
      </section>
      <div class="wt-bar">
        <div class="wt-row">
          <span class="wt-on" data-el="on"></span>
          <button class="wt-btn" data-act="auto" data-el="auto" title="The camera follows whoever leads (A)">Follow leader</button>
        </div>
        <div class="wt-row">
          <button class="wt-btn" data-act="cam" title="Change camera (C)">${CAM_ICON}<span data-el="cam"></span></button>
          <button class="wt-btn" data-act="room" title="The room: drivers, track and last results (Esc)">Room <kbd>Esc</kbd></button>
        </div>
      </div>
      <div class="mp-countdown" data-el="countdown" hidden></div>
      <div class="mp-results wt-results" data-el="results" hidden>
        <header><p class="label" data-el="resKicker"></p><h2 class="display">Classification</h2></header>
        <ol data-el="resRows"></ol>
      </div>`;
    this.el.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.$[e.dataset.el!] = e));
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('[data-follow]');
      if (row) return h.follow(row.dataset.follow!);
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'auto') h.auto();
      if (act === 'cam') h.camera();
      if (act === 'room') h.room();
    });
    hud.appendChild(this.el);
  }

  private set(key: string, html: string) {
    if (this.sig[key] === html) return;
    this.sig[key] = html;
    this.$[key].innerHTML = html;
  }

  render(v: WatchView) {
    this.set('code', escapeHtml(v.code));
    // After the winner's flag, the rest have FINISH_GRACE_MS to finish: count it down.
    this.set('lap', v.final ? 'FINISHED' : v.graceLeft !== null ? `FLAG · ${Math.ceil(v.graceLeft)}S` : `LAP ${v.lap}/${v.laps}`);
    const leader = v.rows[0]?.ms;
    const right = (r: StandingRow) =>
      r.status === 'finished'
        ? r.ms === leader
          ? `<span class="tm p">${formatMs(r.ms)}</span>`
          : `<span class="tm">+${((r.ms! - leader!) / 1000).toFixed(3)}</span>`
        : r.status === 'racing'
          ? `<span class="tm lap">L${Math.min(r.lap, v.laps)}</span>`
          : `<span class="tm">${r.status === 'dnf' ? 'DNF' : 'OUT'}</span>`;
    const row = (r: StandingRow, pos: string, tm: string, follow: boolean) => {
      const on = r.mid === v.following;
      const c = escapeHtml(r.color);
      return `<li class="${on ? 'on' : ''} ${r.status}"${follow ? ` data-follow="${r.mid}" role="button" tabindex="0" title="Follow ${escapeHtml(r.name)}"` : ''}><span class="pos">${pos}</span><span class="pw-stripe" style="--c1:${c};--c2:${c}"></span><span class="nm">${escapeHtml(r.name)}</span>${tm}</li>`;
    };
    this.set('rows', v.rows.map((r, i) => row(r, String(i + 1), right(r), true)).join(''));

    const on = v.rows.findIndex((r) => r.mid === v.following);
    const who = v.rows[on];
    this.set(
      'on',
      who
        ? `<span class="pw-stripe" style="--c1:${escapeHtml(who.color)};--c2:${escapeHtml(who.color)}"></span><span class="wt-on-k">${v.auto ? 'Leader' : 'Following'}</span><b>${escapeHtml(who.name)}</b><span class="wt-on-p">P${on + 1}</span>`
        : '',
    );
    this.$.auto.hidden = v.auto;
    this.set('cam', escapeHtml(v.camera));

    this.$.countdown.hidden = v.countdown === null;
    if (v.countdown !== null) this.set('countdown', `On the grid · lights in <b>${Math.ceil(v.countdown)}</b>`);

    // The classification once everyone is home (until then the tower has the times).
    this.$.results.hidden = !v.final;
    this.el.classList.toggle('done', v.final);
    if (v.final) {
      const n = v.rows.length;
      this.set('resKicker', `Final · ${v.laps} lap${v.laps > 1 ? 's' : ''} · ${n} driver${n > 1 ? 's' : ''}`);
      this.set('resRows', v.rows.map((r, i) => row(r, r.status === 'finished' ? String(i + 1) : '–', right(r), false)).join(''));
    }
  }

  dispose() {
    this.el.remove();
  }
}
