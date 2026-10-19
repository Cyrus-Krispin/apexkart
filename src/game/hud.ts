// Race HUD: broadcast-style timing in the "Paddock Paper" night palette.
import { escapeHtml, formatMs, type BoardResponse } from '../net/api';

export type SectorColor = '' | 'purple' | 'green' | 'yellow';
export type BannerKind = 'go' | 'pb' | 'warn' | 'info';

export interface SessionStats {
  laps: number;
  valid: number;
  best: number | null;
  pb: number | null;
  rank: number | null;
  total: number;
}

const SPEED_SEGMENTS = 24;

const ICON = {
  gauge: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M4 16a8 8 0 1116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 16l4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/></svg>',
  cam: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M4 7h11v10H4zM15 10l5-3v10l-5-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  ghost: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M5 20V10a7 7 0 0114 0v10l-2.5-2-2.3 2-2.2-2-2.2 2-2.3-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9.5" cy="10.5" r="1.3" fill="currentColor"/><circle cx="14.5" cy="10.5" r="1.3" fill="currentColor"/></svg>',
  sound: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: HTMLCanvasElement;
  readonly tags: HTMLElement;
  readonly touch: HTMLElement;
  private $: Record<string, HTMLElement> = {};
  private speedSegs: HTMLElement[] = [];
  private lastText = new Map<string, string>();
  private bannerTimer = 0;
  private bannerText = '';
  private lapCardTimer = 0;
  private coachTimer = 0;
  private boardSig = '';

  constructor(
    container: HTMLElement,
    o: { trackName: string; dirLabel: string; dirIcon: string; color: string },
    private onAction: (act: string) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <section class="h-timing">
        <header><span class="h-track">${escapeHtml(o.trackName)}</span><span class="h-dir">${o.dirIcon} ${o.dirLabel}</span></header>
        <div class="h-main">
          <div class="h-lap"><span class="label">Lap</span><b class="mono" data-el="lap">OUT</b></div>
          <div class="h-time mono" data-el="time">0:00.000</div>
        </div>
        <div class="h-delta-row"><span class="h-delta mono" data-el="delta"></span><span class="label" data-el="deltaLbl"></span></div>
        <div class="h-sectors" data-el="sectors">${[1, 2, 3].map((k) => `<div class="sec"><div class="sec-bar"><i></i></div><span class="mono">S${k}</span></div>`).join('')}</div>
        <footer>
          <div><span class="label">Last</span><b class="mono" data-el="last">–:––.–––</b></div>
          <div><span class="label">Best</span><b class="mono" data-el="best">–:––.–––</b></div>
        </footer>
      </section>

      <section class="h-tower" data-el="tower">
        <header><span><i class="live-dot"></i>Live timing</span><em data-el="towerCount"></em></header>
        <ol data-el="board"><li class="h-empty">Loading…</li></ol>
        <p class="h-ontrack" data-el="onTrack"></p>
      </section>
      <div class="h-lapcard" data-el="lapcard"></div>

      <canvas class="h-map" data-el="minimap"></canvas>

      <section class="h-speed">
        <div class="h-segs" data-el="segs">${'<i></i>'.repeat(SPEED_SEGMENTS)}</div>
        <div class="h-speed-num"><b class="mono" data-el="speed">0</b><span class="label">km/h</span></div>
      </section>

      <nav class="h-tools">
        <button data-act="pause" title="Pause (Esc)">${ICON.pause}<kbd>Esc</kbd></button>
        <button data-act="cam" title="Camera (C)">${ICON.cam}<kbd>C</kbd></button>
        <button data-act="ghosts" data-el="ghostBtn" title="Ghosts (G)">${ICON.ghost}<kbd>G</kbd></button>
        <button data-act="mute" data-el="muteBtn" title="Sound (M)">${ICON.sound}<kbd>M</kbd></button>
      </nav>

      <div class="h-lights" data-el="lights" hidden>${'<div class="h-lamp"><i></i><i></i></div>'.repeat(5)}</div>
      <div class="h-banner" data-el="banner"><span data-el="bannerText"></span></div>
      <div class="h-coach" data-el="coach">
        <span><kbd>W</kbd><kbd>↑</kbd> throttle</span><span><kbd>A</kbd><kbd>D</kbd> steer</span><span><kbd class="wide">Space</kbd> drift</span><span><kbd>R</kbd> reset</span>
      </div>
      <div class="h-tags" data-el="tags"></div>
      <div class="h-toasts" data-el="toasts"></div>
      <div class="h-loading label" data-el="loading" hidden>Loading satellite imagery…</div>
      <div class="h-attrib">Imagery © Esri, Maxar, Earthstar Geographics · Track © OpenStreetMap contributors</div>

      <div class="h-touch" data-el="touch">
        <div class="ht-l"><button data-touch="left" aria-label="Steer left">◀</button><button data-touch="right" aria-label="Steer right">▶</button></div>
        <div class="ht-r"><button data-touch="drift" class="sm">Drift</button><button data-touch="brake">Brake</button><button data-touch="gas" class="gas">Gas</button></div>
      </div>

      <div class="h-pause" data-el="pause" hidden>
        <div class="hp-inner">
          <p class="label">${escapeHtml(o.trackName)} · ${o.dirLabel}</p>
          <h2 class="display">Paused</h2>
          <dl class="hp-stats" data-el="stats"></dl>
          <div class="hp-actions">
            <button class="btn primary lg" data-act="resume">Resume <span class="arrow">→</span></button>
            <button class="btn ghost-btn" data-act="restart">Restart from the grid</button>
            <button class="btn ghost-btn" data-act="exit">Back to circuits</button>
          </div>
          <div class="hp-toggles">
            <button data-act="mute" data-el="muteToggle"></button>
            <button data-act="ghosts" data-el="ghostToggle"></button>
            <button data-act="cam" data-el="camToggle"></button>
            <button data-act="quality" data-el="qualityToggle"></button>
            <button data-act="style" data-el="styleToggle"></button>
          </div>
          <p class="hp-hint label">Press Esc to resume</p>
        </div>
      </div>`;
    container.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.$[e.dataset.el!] = e));
    this.minimap = this.$.minimap as HTMLCanvasElement;
    this.tags = this.$.tags;
    this.touch = this.$.touch;
    this.speedSegs = [...this.$.segs.children] as HTMLElement[];
    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act) this.onAction(act);
    });
  }

  private text(key: string, value: string) {
    if (this.lastText.get(key) === value) return;
    this.lastText.set(key, value);
    this.$[key].textContent = value;
  }

  // ---------- timing

  lap(n: number | null) {
    this.text('lap', n === null ? 'OUT' : String(n).padStart(2, '0'));
  }

  lapTime(ms: number, invalid: boolean) {
    this.text('time', formatMs(ms));
    this.$.time.classList.toggle('invalid', invalid);
  }

  delta(seconds: number | null, label = 'vs your best') {
    if (seconds === null) {
      this.text('delta', '');
      this.text('deltaLbl', '');
      this.$.delta.className = 'h-delta mono';
      return;
    }
    this.text('delta', `${seconds >= 0 ? '+' : '−'}${Math.abs(seconds).toFixed(2)}`);
    this.text('deltaLbl', label);
    this.$.delta.className = `h-delta mono ${seconds >= 0 ? 'slow' : 'fast'}`;
  }

  /** times[k] set when sector k is complete; `current` sector fills by `progress` 0..1. */
  sectors(times: (number | undefined)[], colors: SectorColor[], current: number, progress: number, final = false) {
    const els = this.$.sectors.children;
    for (let k = 0; k < 3; k++) {
      const el = els[k] as HTMLElement;
      const fill = el.querySelector('i') as HTMLElement;
      const label = el.querySelector('span') as HTMLElement;
      const t = times[k];
      const cls = t !== undefined ? `sec done ${colors[k]}` : k === current ? 'sec live' : 'sec';
      if (el.className !== cls) el.className = cls;
      const w = t !== undefined ? 1 : k === current ? progress : 0;
      fill.style.transform = `scaleX(${w.toFixed(3)})`;
      const txt = t !== undefined ? (t / 1000).toFixed(final ? 3 : 2) : `S${k + 1}`;
      if (label.textContent !== txt) label.textContent = txt;
    }
  }

  last(ms: number | null, valid = true) {
    this.text('last', ms === null ? '–:––.–––' : formatMs(ms) + (valid ? '' : ' ✕'));
  }

  best(ms: number | null) {
    this.text('best', ms === null ? '–:––.–––' : formatMs(ms));
  }

  speed(kmh: number, frac: number) {
    this.text('speed', String(Math.round(kmh)));
    const lit = Math.round(Math.min(1, frac) * SPEED_SEGMENTS);
    this.speedSegs.forEach((s, i) => {
      const on = i < lit;
      if (s.classList.contains('on') !== on) s.classList.toggle('on', on);
    });
  }

  // ---------- leaderboard

  board(b: BoardResponse | null, me: string, offline = false) {
    if (offline || !b) {
      this.$.board.innerHTML = '<li class="h-empty">Live timing offline. Laps are saved on this device.</li>';
      return;
    }
    const lead = b.entries[0]?.ms;
    const mine = b.entries.find((e) => e.pid === me);
    const top = b.entries.slice(0, 8);
    const sig = b.entries.map((e) => e.pid + e.ms).join();
    const changed = this.boardSig && sig !== this.boardSig;
    this.boardSig = sig;
    const row = (e: (typeof b.entries)[number]) =>
      `<li class="${e.pid === me ? 'me' : ''}"><span class="pos mono">${String(e.rank).padStart(2, '0')}</span><span class="bar" style="background:${escapeHtml(e.color)}"></span><span class="nm">${escapeHtml(e.name)}</span><span class="tm mono">${e.rank === 1 ? formatMs(e.ms) : `+${((e.ms - lead) / 1000).toFixed(3)}`}</span></li>`;
    let html = top.map(row).join('');
    if (mine && mine.rank > 8) html += `<li class="gap">···</li>${row(mine)}`;
    this.$.board.innerHTML = html || '<li class="h-empty">No times yet. Set the benchmark.</li>';
    this.$.towerCount.textContent = b.total ? `${b.total} driver${b.total > 1 ? 's' : ''}` : '';
    const others = b.onTrack.filter((o) => o.pid !== me);
    this.$.onTrack.innerHTML = others.length
      ? `<i class="live-dot"></i>On track with you: ${others.map((o) => escapeHtml(o.name)).join(', ')}`
      : '';
    if (changed) {
      this.$.tower.classList.remove('flash');
      void this.$.tower.offsetWidth;
      this.$.tower.classList.add('flash');
    }
  }

  // ---------- moments

  banner(text: string, kind: BannerKind = 'info', secs = 2) {
    clearTimeout(this.bannerTimer);
    if (text !== this.bannerText || !this.$.banner.classList.contains('show')) {
      this.$.bannerText.textContent = text;
      this.$.banner.className = `h-banner ${kind}`;
      void this.$.banner.offsetWidth;
      this.$.banner.classList.add('show');
      this.bannerText = text;
    }
    this.bannerTimer = window.setTimeout(() => {
      this.$.banner.classList.remove('show');
      this.bannerText = '';
    }, secs * 1000);
  }

  lapCard(o: { lap: number; ms: number; valid: boolean; delta: number | null; sectors: number[]; colors: SectorColor[]; pb: boolean }) {
    clearTimeout(this.lapCardTimer);
    const d = o.delta;
    this.$.lapcard.innerHTML = `
      <header><span class="label">Lap ${String(o.lap).padStart(2, '0')}</span>${o.pb ? '<span class="lc-tag pb">Personal best</span>' : o.valid ? '' : '<span class="lc-tag bad">Invalid</span>'}</header>
      <div class="lc-time mono ${o.valid ? '' : 'invalid'}">${formatMs(o.ms)}</div>
      ${d !== null && o.valid ? `<div class="lc-delta mono ${d < 0 ? 'fast' : 'slow'}">${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(3)} <span class="label">vs ${o.pb ? 'previous best' : 'best'}</span></div>` : ''}
      ${o.valid ? `<div class="lc-secs">${o.sectors.map((s, k) => `<span class="${o.colors[k]}">${(s / 1000).toFixed(3)}</span>`).join('')}</div>` : ''}
      <div class="lc-rank" data-el="lcRank"></div>`;
    this.$.lapcard.classList.remove('show');
    void this.$.lapcard.offsetWidth;
    this.$.lapcard.classList.add('show');
    this.lapCardTimer = window.setTimeout(() => this.$.lapcard.classList.remove('show'), 6500);
  }

  lapCardRank(rank: number, total: number) {
    const el = this.$.lapcard.querySelector('[data-el=lcRank]');
    if (el) el.innerHTML = `<span class="label">Live board</span><b class="mono">P${rank}</b><span class="label">of ${total}</span>`;
  }

  lights(lit: number | null) {
    const el = this.$.lights;
    if (lit === null) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    [...el.children].forEach((lamp, k) => lamp.classList.toggle('on', k < lit));
  }

  coach(show: boolean, autoHideMs = 0) {
    clearTimeout(this.coachTimer);
    this.$.coach.classList.toggle('show', show);
    if (show && autoHideMs) this.coachTimer = window.setTimeout(() => this.$.coach.classList.remove('show'), autoHideMs);
  }

  loading(show: boolean) {
    this.$.loading.hidden = !show;
  }

  toast(text: string, kind: '' | 'warn' | 'gold' = '') {
    const t = document.createElement('div');
    t.className = `h-toast ${kind}`;
    t.textContent = text;
    this.$.toasts.appendChild(t);
    setTimeout(() => t.classList.add('out'), 3600);
    setTimeout(() => t.remove(), 4200);
  }

  // ---------- pause + toggles

  pause(show: boolean, stats?: SessionStats) {
    this.$.pause.hidden = !show;
    this.root.classList.toggle('paused', show);
    if (show && stats) {
      this.$.stats.innerHTML = `
        <div><dt class="label">Laps</dt><dd class="mono">${stats.laps}<small>${stats.valid} clean</small></dd></div>
        <div><dt class="label">Session best</dt><dd class="mono">${formatMs(stats.best)}</dd></div>
        <div><dt class="label">Personal best</dt><dd class="mono">${formatMs(stats.pb)}</dd></div>
        <div><dt class="label">Live board</dt><dd class="mono">${stats.rank ? `P${stats.rank}<small>of ${stats.total}</small>` : '–'}</dd></div>`;
    }
  }

  toggles(o: { muted: boolean; ghosts: boolean; cam: string; quality: string; style: string }) {
    this.$.qualityToggle.innerHTML = `${ICON.gauge}<span>Graphics</span><b>${o.quality}</b>`;
    this.$.styleToggle.innerHTML = `${ICON.globe}<span>World</span><b>${o.style}</b>`;
    this.$.muteToggle.innerHTML = `${ICON.sound}<span>Sound</span><b>${o.muted ? 'Off' : 'On'}</b>`;
    this.$.ghostToggle.innerHTML = `${ICON.ghost}<span>Ghosts</span><b>${o.ghosts ? 'On' : 'Off'}</b>`;
    this.$.camToggle.innerHTML = `${ICON.cam}<span>Camera</span><b>${o.cam}</b>`;
    this.$.muteBtn.classList.toggle('off', o.muted);
    this.$.ghostBtn.classList.toggle('off', !o.ghosts);
  }

  setVisible(v: boolean) {
    this.root.classList.toggle('hidden-hud', !v);
  }

  dispose() {
    clearTimeout(this.bannerTimer);
    clearTimeout(this.lapCardTimer);
    clearTimeout(this.coachTimer);
    this.root.remove();
  }
}
