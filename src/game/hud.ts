// Race HUD in the Pit Wall style (docs/pit-wall.md): timing panels on carbon, purple and green for
// fastest and personal best, red start lights, broadcast banners, and the on-screen pedals.
import { escapeHtml, formatMs, type BoardResponse } from '../net/api';
import { circuitCode } from '../ui/pitwall';
import { MEDAL_NAME, MEDALS, type Medal } from './medals';
import { touchDevice, type ControlScheme } from './input';

export type SectorColor = '' | 'purple' | 'green' | 'yellow';
export type BannerKind = 'go' | 'pb' | 'warn' | 'info' | 'medal';

export interface SessionStats {
  laps: number;
  valid: number;
  best: number | null;
  pb: number | null;
  rank: number | null;
  total: number;
}

const SPEED_SEGMENTS = 24;
/** The ghost gap bar runs out at this many seconds either side. */

const ICON = {
  gauge: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 16a8 8 0 1116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 16l4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/></svg>',
  cam: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 7h11v10H4zM15 10l5-3v10l-5-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  ghost: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 20V10a7 7 0 0114 0v10l-2.5-2-2.3 2-2.2-2-2.2 2-2.3-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9.5" cy="10.5" r="1.3" fill="currentColor"/><circle cx="14.5" cy="10.5" r="1.3" fill="currentColor"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  wheel: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M4.5 10.5h5M14.5 10.5h5M12 14v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  sound: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 9.5A7 7 0 1 1 5 14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M4.5 4.5v5h5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** On-screen controls for each scheme (touch screens only; see the touch rules in race.css). */
const STEER = `<div class="ht-l"><div data-touch="left" role="button" aria-label="Steer left">${ICON.left}</div><div data-touch="right" role="button" aria-label="Steer right">${ICON.right}</div></div>`;
const TOUCH: Record<ControlScheme, string> = {
  classic: `${STEER}
    <div class="ht-r ht-pedals"><div data-touch="brake" role="button" class="ht-brk">Brake</div><div data-touch="gas" role="button" class="ht-gas">Gas</div></div>`,
  simple: `${STEER}
    <div class="ht-r"><div data-touch="brake" role="button" class="ht-brk ht-brake">Brake</div></div>`,
};

/** The short reminder at the start of a run. */
function hintHtml(s: ControlScheme): string {
  if (touchDevice()) return s === 'simple' ? 'Steer ◀ ▶ · Brake on the right' : 'Steer ◀ ▶ · Gas and brake on the right';
  return s === 'simple'
    ? 'Steer <kbd>A</kbd><kbd>D</kbd> · Brake <kbd>Space</kbd>'
    : 'Throttle <kbd>W</kbd> · Steer <kbd>A</kbd><kbd>D</kbd> · Brake <kbd>S</kbd> or <kbd>Space</kbd>';
}

const signed = (s: number, dp: number) => `${s < 0 ? '−' : '+'}${Math.abs(s).toFixed(dp)}`;

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
  private lapCardEl: HTMLElement | null = null;
  private hintTimer = 0;
  private lightsTimer = 0;
  private boardSig = '';
  private flashTimers: number[] = [];
  // The medal target panel: the next medal and its time.
  private goal: { medal: Medal; ms: number } | null = null;

  constructor(
    container: HTMLElement,
    o: { trackName: string; dirLabel: string; dirIcon: string; color: string },
    private onAction: (act: string) => void,
  ) {
    const code = escapeHtml(circuitCode(o.trackName));
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="h-left">
      <section class="h-timing">
        <header><span class="pw-code">${code}</span><span class="h-lapno"><span class="pw-k">Lap</span><b class="mono" data-el="lap">OUT</b></span><span class="h-dir" title="${o.dirLabel}">${o.dirIcon}</span></header>
        <div class="h-time-row"><div class="h-time mono" data-el="time">0:00.000</div><b class="h-dl mono" data-el="delta" hidden title="Gap to your best lap"></b></div>
        <div class="h-sectors" data-el="sectors">${[1, 2, 3].map((k) => `<div class="sec"><i></i><span class="mono">S${k}</span></div>`).join('')}</div>
        <footer>
          <div><span class="pw-k">Last</span><b class="mono" data-el="last">–:––.–––</b></div>
          <div><span class="pw-k">Best</span><b class="mono" data-el="best">–:––.–––</b></div>
        </footer>
      </section>

        <section class="h-target" data-el="target" hidden>
          <span class="pw-k"><i class="medal" data-el="targetDot"></i><span data-el="targetK"></span></span>
          <b class="h-tdl mono" data-el="targetDl"></b>
        </section>

        <section class="h-tower" data-el="tower">
          <header><span><i class="live-dot"></i>Live timing</span><em data-el="towerCount"></em></header>
          <ol data-el="board"><li class="h-empty">Loading…</li></ol>
          <p class="h-ontrack" data-el="onTrack"></p>
        </section>
      </div>

      <div class="h-map"><canvas data-el="minimap" aria-hidden="true"></canvas></div>
      <div class="h-notes" data-el="notes" aria-live="polite"></div>

      <section class="h-speed">
        <div class="h-stuck" data-el="stuck" hidden>
          <button class="h-reset" data-act="reset" title="Back on the track (R)" aria-label="Reset: back on the track">${ICON.reset}<span>Reset</span><kbd>R</kbd></button>
          <span class="h-stuck-tip" data-el="stuckTip"></span>
        </div>
        <div class="h-hint" data-el="hint"></div>
        <div class="h-speed-box">
          <div class="h-speed-num"><b class="mono" data-el="speed">0</b><span class="pw-k">km/h</span></div>
          <div class="h-segs" data-el="segs">${'<i></i>'.repeat(SPEED_SEGMENTS)}</div>
        </div>
      </section>

      <nav class="h-tools">
        <button data-act="pause" title="Pause (Esc)" aria-label="Pause">${ICON.pause}<kbd>Esc</kbd></button>
        <button data-act="cam" title="Camera (C)" aria-label="Camera">${ICON.cam}<kbd>C</kbd></button>
        <button data-act="ghosts" data-el="ghostBtn" title="Ghosts (G)" aria-label="Ghosts">${ICON.ghost}<kbd>G</kbd></button>
        <button data-act="mute" data-el="muteBtn" title="Sound (M)" aria-label="Sound">${ICON.sound}<kbd>M</kbd></button>
      </nav>

      <div class="h-lights" data-el="lights" hidden>${'<div class="h-lamp"><i></i><i></i></div>'.repeat(5)}</div>
      <div class="h-banner" data-el="banner"><span data-el="bannerText"></span></div>
      <div class="h-tags" data-el="tags"></div>
      <div class="h-loading" data-el="loading" hidden>Loading the world</div>
      <div class="h-attrib">Track and world © OpenStreetMap contributors</div>

      <div class="h-touch" data-el="touch"></div>

      <div class="h-pause" data-el="pause" hidden>
        <div class="hp-inner">
          <header class="hp-head">
            <span class="pw-code">${code}</span>
            <div><p class="pw-k">${escapeHtml(o.trackName)} · ${o.dirIcon} ${o.dirLabel}</p><h2 class="display">Paused</h2></div>
          </header>
          <div class="hp-cols">
            <div class="hp-main">
              <div class="pw-board"><div class="pw-board-in" data-el="stats"></div></div>
              <div class="hp-actions">
                <button class="btn primary lg block" data-act="resume">Resume <span class="arrow">→</span></button>
                <div class="hp-sub">
                  <button class="btn" data-act="restart">Restart from the grid</button>
                  <button class="btn" data-act="exit">Back to circuits</button>
                </div>
              </div>
            </div>
            <div class="hp-set">
              <p class="pw-k">Settings</p>
              <div class="hp-toggles">
                <button data-act="controls" data-el="controlsToggle"></button>
                <button data-act="mute" data-el="muteToggle"></button>
                <button data-act="ghosts" data-el="ghostToggle"></button>
                <button data-act="cam" data-el="camToggle"></button>
                <button data-act="quality" data-el="qualityToggle"></button>
                <button data-act="time" data-el="timeToggle"></button>
              </div>
            </div>
          </div>
          <p class="hp-hint pw-k">Press <kbd>Esc</kbd> to resume</p>
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

  private cls(key: string, value: string) {
    if (this.$[key].className !== value) this.$[key].className = value;
  }

  // ---------- timing

  lap(n: number | null) {
    this.text('lap', n === null ? 'OUT' : String(n).padStart(2, '0'));
  }

  lapTime(ms: number, invalid: boolean) {
    this.text('time', formatMs(ms));
    this.$.time.classList.toggle('invalid', invalid);
  }

  /** The gap to your best lap: one number beside the lap time, green when you're ahead, red behind. */
  delta(seconds: number | null) {
    this.$.delta.hidden = seconds === null;
    if (seconds === null) return;
    this.text('delta', signed(seconds, 2));
    this.cls('delta', `h-dl mono ${seconds < 0 ? 'fast' : 'slow'}`);
  }

  /** times[k] set when sector k is complete; `current` sector fills by `progress` 0..1. */
  sectors(times: (number | undefined)[], colors: SectorColor[], current: number, progress: number, final = false) {
    const els = this.$.sectors.children;
    for (let k = 0; k < 3; k++) {
      const el = els[k] as HTMLElement;
      const fill = el.querySelector('i') as HTMLElement;
      const label = el.querySelector('span') as HTMLElement;
      const t = times[k];
      const cls = t !== undefined ? `sec done ${colors[k]}` : k === current ? 'sec cur' : 'sec';
      if (el.className !== cls) el.className = cls;
      const w = t !== undefined ? 1 : k === current ? progress : 0;
      fill.style.transform = `scaleX(${w.toFixed(3)})`;
      const txt = t !== undefined ? (t / 1000).toFixed(final ? 3 : 2) : `S${k + 1}`;
      if (label.textContent !== txt) label.textContent = txt;
    }
  }

  /** A sector just completed: its chip flashes in its colour with the gap to your best sector for a moment. */
  sectorFlash(k: number, color: SectorColor, delta: number) {
    const el = this.$.sectors.children[k] as HTMLElement | undefined;
    if (!el) return;
    el.removeAttribute('data-flash');
    void el.offsetWidth; // restart the animation
    el.dataset.dl = signed(delta, 3);
    el.dataset.flash = color || 'yellow';
    clearTimeout(this.flashTimers[k]);
    this.flashTimers[k] = window.setTimeout(() => el.removeAttribute('data-flash'), 1600);
  }

  last(ms: number | null, valid = true) {
    this.text('last', ms === null ? '–:––.–––' : formatMs(ms) + (valid ? '' : ' ✕'));
    this.$.last.classList.toggle('invalid', ms !== null && !valid);
  }

  best(ms: number | null) {
    this.text('best', ms === null ? '–:––.–––' : formatMs(ms));
    this.$.best.classList.toggle('pb', ms !== null);
  }

  /** The next medal to chase and its time; null hides the panel (all won, or not a time trial). */
  target(medal: Medal | null, ms: number | null) {
    this.goal = medal && ms !== null ? { medal, ms } : null;
    this.paintTarget();
  }

  /** The medal target panel: the next medal and the time it takes. The only moving number is the gap on the map. */
  private paintTarget() {
    const g = this.goal;
    this.$.target.hidden = !g;
    if (!g) return;
    this.cls('targetDot', `medal ${g.medal}`);
    this.text('targetK', `${MEDAL_NAME[g.medal]} medal`);
    this.text('targetDl', formatMs(g.ms));
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
      `<li class="${e.pid === me ? 'me' : ''}"><span class="pw-pos${e.pid === me ? ' me' : ''}">${e.rank}</span><span class="bar" style="background:${escapeHtml(e.color)}"></span><span class="nm">${escapeHtml(e.name)}</span><span class="tm mono${e.rank === 1 ? ' p' : ''}">${e.rank === 1 ? formatMs(e.ms) : `+${((e.ms - lead) / 1000).toFixed(3)}`}</span></li>`;
    let html = top.map(row).join('');
    if (mine && mine.rank > 8) html += `<li class="gap">···</li>${row(mine)}`;
    this.$.board.innerHTML = html || '<li class="h-empty">No times yet. Set the benchmark.</li>';
    this.$.towerCount.textContent = b.total ? `${b.total} driver${b.total > 1 ? 's' : ''}` : '';
    const others = b.onTrack.filter((o) => o.pid !== me);
    this.$.onTrack.innerHTML = others.length
      ? `<i class="live-dot"></i><span>${others.length} on track · ${others.map((o) => escapeHtml(o.name)).join(', ')}</span>`
      : '';
    if (changed) {
      this.$.tower.classList.remove('flash');
      void this.$.tower.offsetWidth;
      this.$.tower.classList.add('flash');
    }
  }

  // ---------- moments
  // Only the big moments take the top centre (lights, GO, a finish, an invalid lap, wrong way); the
  // middle of the screen stays clear for driving. Everything else is a notification at the side.

  banner(text: string, kind: BannerKind = 'info', secs = 2) {
    if (kind !== 'go' && kind !== 'warn') return void this.note(text, kind, secs + 1);
    clearTimeout(this.bannerTimer);
    if (text !== this.bannerText || !this.$.banner.classList.contains('show')) {
      this.$.bannerText.textContent = text;
      this.$.banner.className = `h-banner is-${kind}`;
      void this.$.banner.offsetWidth;
      this.$.banner.classList.add('show');
      this.bannerText = text;
    }
    this.bannerTimer = window.setTimeout(() => {
      this.$.banner.classList.remove('show');
      this.bannerText = '';
    }, secs * 1000);
  }

  /** A notification at the side: slides in, then fades. At most four at once (the oldest goes). */
  private note(content: string, kind: string, secs: number, html = false): HTMLElement {
    const box = this.$.notes;
    const same = [...box.children].find((n) => !html && n.textContent === content && !n.classList.contains('out')) as HTMLElement | undefined;
    if (same) same.remove(); // the same message again: just move it to the newest place
    const n = document.createElement('div');
    n.className = `h-note is-${kind}`;
    if (html) n.innerHTML = content;
    else n.textContent = content;
    // A medal wears its medal's colour.
    const m = kind === 'medal' ? MEDALS.find((x) => content.toLowerCase().startsWith(x)) : undefined;
    if (m) n.style.setProperty('--m', `var(--${m})`);
    box.appendChild(n);
    while (box.children.length > 4) box.firstElementChild!.remove();
    setTimeout(() => n.classList.add('out'), secs * 1000);
    setTimeout(() => n.remove(), secs * 1000 + 450);
    return n;
  }

  /** The lap just completed, held up on a pit board at the side. */
  lapCard(o: { lap: number; ms: number; valid: boolean; delta: number | null; sectors: number[]; colors: SectorColor[]; pb: boolean }) {
    const d = o.delta;
    const tag = o.pb ? '<span class="g">PB</span>' : o.valid ? '' : '<span class="y">Invalid</span>';
    this.lapCardEl = this.note(`
      <div class="pw-board"><div class="pw-board-in">
        <div class="pw-board-row"><span>Lap ${String(o.lap).padStart(2, '0')}</span>${tag}</div>
        <div class="pw-board-row"><span class="sm ${o.valid ? (o.pb ? 'g' : '') : 'x'}">${formatMs(o.ms)}</span></div>
        ${d !== null && o.valid ? `<div class="pw-board-row"><span class="lc-vs">vs ${o.pb ? 'previous' : 'best'}</span><span class="sm ${d < 0 ? 'g' : 'y'}">${signed(d, 3)}</span></div>` : ''}
        <div class="pw-board-row lc-rank" data-el="lcRank"></div>
      </div></div>
      ${o.valid ? `<div class="lc-secs">${o.sectors.map((s, k) => `<span class="${o.colors[k]}">${(s / 1000).toFixed(3)}</span>`).join('')}</div>` : ''}`, 'lap', 6.5, true);
  }

  lapCardRank(rank: number, total: number) {
    const el = this.lapCardEl?.querySelector('[data-el=lcRank]');
    if (el) el.innerHTML = `<span>Board</span><span class="y">P${rank}<small>/${total}</small></span>`;
  }

  /** Five pairs of red lights; null puts them out (lights out and away) and fades the gantry. */
  lights(lit: number | null) {
    const el = this.$.lights;
    clearTimeout(this.lightsTimer);
    if (lit === null) {
      if (el.hidden || el.classList.contains('out')) return;
      el.classList.add('out');
      [...el.children].forEach((lamp) => lamp.classList.remove('on'));
      this.lightsTimer = window.setTimeout(() => {
        el.hidden = true;
        el.classList.remove('out');
      }, 900);
      return;
    }
    el.classList.remove('out');
    el.hidden = false;
    [...el.children].forEach((lamp, k) => lamp.classList.toggle('on', k < lit));
  }

  /** The controls reminder above the speedometer; it fades out after autoHideMs. */
  hint(show: boolean, autoHideMs = 0) {
    clearTimeout(this.hintTimer);
    this.$.hint.classList.toggle('show', show);
    if (show && autoHideMs) this.hintTimer = window.setTimeout(() => this.$.hint.classList.remove('show'), autoHideMs);
  }

  /** Stuck, off the track a while, or facing the wrong way: offer Reset above the speed. */
  stuck(show: boolean) {
    if (this.$.stuck.hidden !== show) return;
    if (show) this.$.stuckTip.innerHTML = touchDevice() ? 'Or hold Brake to reverse' : 'Or hold <kbd>S</kbd> to reverse';
    this.$.stuck.hidden = !show;
  }

  /** Lay out the on-screen controls and the hint for a control scheme. */
  setControls(s: ControlScheme) {
    this.root.dataset.controls = s;
    this.touch.innerHTML = TOUCH[s];
    this.$.hint.innerHTML = hintHtml(s);
  }

  loading(show: boolean) {
    this.$.loading.hidden = !show;
  }

  toast(text: string, kind: '' | 'warn' | 'gold' = '') {
    this.note(text, kind || 'info', 3.6);
  }

  // ---------- pause + toggles

  pause(show: boolean, stats?: SessionStats) {
    this.$.pause.hidden = !show;
    this.root.classList.toggle('paused', show);
    if (show && stats) {
      const row = (k: string, v: string) => `<div class="pw-board-row"><span>${k}</span>${v}</div>`;
      this.$.stats.innerHTML =
        row('Laps', `<span class="sm">${stats.laps}<small>· ${stats.valid} clean</small></span>`) +
        row('Session', `<span class="sm">${formatMs(stats.best)}</span>`) +
        row('PB', `<span class="sm ${stats.pb === null ? '' : 'g'}">${formatMs(stats.pb)}</span>`) +
        row('Board', stats.rank ? `<span class="y">P${stats.rank}<small>/${stats.total}</small></span>` : '<span class="sm">–</span>');
    }
  }

  toggles(o: { controls: string; muted: boolean; ghosts: boolean; cam: string; quality: string; night: boolean; time: string }) {
    const row = (icon: string, label: string, value: string, off = false) =>
      `${icon}<span>${label}</span><b class="${off ? 'off' : ''}">${escapeHtml(value)}</b><i aria-hidden="true">›</i>`;
    this.$.controlsToggle.innerHTML = row(ICON.wheel, 'Controls', o.controls);
    this.$.muteToggle.innerHTML = row(ICON.sound, 'Sound', o.muted ? 'Off' : 'On', o.muted);
    this.$.ghostToggle.innerHTML = row(ICON.ghost, 'Ghosts', o.ghosts ? 'On' : 'Off', !o.ghosts);
    this.$.camToggle.innerHTML = row(ICON.cam, 'Camera', o.cam);
    this.$.qualityToggle.innerHTML = row(ICON.gauge, 'Graphics', o.quality);
    this.$.timeToggle.innerHTML = row(o.night ? ICON.moon : ICON.sun, 'Time of day', o.time);
    this.$.muteBtn.classList.toggle('off', o.muted);
    this.$.ghostBtn.classList.toggle('off', !o.ghosts);
  }

  setVisible(v: boolean) {
    this.root.classList.toggle('hidden-hud', !v);
  }

  dispose() {
    clearTimeout(this.bannerTimer);
    clearTimeout(this.hintTimer);
    clearTimeout(this.lightsTimer);
    this.root.remove();
  }
}

// ---------- Tow (Lane D, multiplayer only)

/**
 * A small chip beside the speed while you're in another kart's slipstream: three chevrons that
 * fill with how much of it you have, and the word Tow. Nothing in the middle of the screen; it
 * fades in after a moment in the tow and out a moment after, so a brief pass doesn't flicker it.
 */
export class TowIndicator {
  private el: HTMLElement | null;
  private onT = 0; // s in the tow
  private offT = 0; // s out of it
  private n = 0; // chevrons lit (0 = hidden)

  constructor(hudRoot: HTMLElement) {
    const box = hudRoot.querySelector<HTMLElement>('.h-speed-box');
    this.el = box && document.createElement('div');
    if (!box || !this.el) return;
    this.el.className = 'h-tow';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.innerHTML = '<i></i><i></i><i></i><span>Tow</span>';
    box.appendChild(this.el);
  }

  /** Strength 0..1 (MultiplayerRace, every frame). */
  set(strength: number, dt: number) {
    if (!this.el) return;
    const want = strength < 0.06 ? 0 : strength < 0.3 ? 1 : strength < 0.55 ? 2 : 3;
    if (want) {
      this.onT += dt;
      this.offT = 0;
    } else {
      this.offT += dt;
      this.onT = 0;
    }
    // Shows after 0.15 s in the tow, then follows it; hides 0.4 s after it ends.
    const n = want ? (this.n || this.onT >= 0.15 ? want : 0) : this.offT >= 0.4 ? 0 : this.n;
    if (n === this.n) return;
    this.n = n;
    if (n) this.el.dataset.n = String(n);
    this.el.classList.toggle('on', n > 0);
  }

  dispose() {
    this.el?.remove();
  }
}

// ---------- Launch hint (Lane D, multiplayer only)

/**
 * Classic controls on a multiplayer grid: the kart only launches at lights out if you're already
 * holding Gas (Simple players launch by themselves), so the grid's controls reminder says so.
 * Once the lights go out the usual reminder is back.
 */
export class LaunchHint {
  private el: HTMLElement | null;
  private on = false;
  private html = touchDevice() ? 'Hold Gas: you launch at lights out' : 'Hold Gas <kbd>W</kbd> · you launch at lights out';

  constructor(private root: HTMLElement) {
    this.el = root.querySelector<HTMLElement>('[data-el="hint"]');
  }

  /** Every frame: `grid` while waiting for the lights. */
  update(grid: boolean) {
    if (!this.el) return;
    const scheme = this.root.dataset.controls as ControlScheme | undefined;
    const want = grid && scheme === 'classic';
    if (want && this.el.innerHTML !== this.html) this.el.innerHTML = this.html; // (again, if the controls changed)
    else if (!want && this.on && scheme) this.el.innerHTML = hintHtml(scheme);
    this.on = want;
  }
}
