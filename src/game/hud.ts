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
const GAP_RANGE = 1.5;

const ICON = {
  gauge: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 16a8 8 0 1116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 16l4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/></svg>',
  cam: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 7h11v10H4zM15 10l5-3v10l-5-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  ghost: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 20V10a7 7 0 0114 0v10l-2.5-2-2.3 2-2.2-2-2.2 2-2.3-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9.5" cy="10.5" r="1.3" fill="currentColor"/><circle cx="14.5" cy="10.5" r="1.3" fill="currentColor"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  wheel: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M4.5 10.5h5M14.5 10.5h5M12 14v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  sound: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** On-screen controls for each scheme (touch screens only; see the touch rules in race.css). */
const STEER = `<div class="ht-l"><div data-touch="left" role="button" aria-label="Steer left">${ICON.left}</div><div data-touch="right" role="button" aria-label="Steer right">${ICON.right}</div></div>`;
const TOUCH: Record<ControlScheme, string> = {
  classic: `${STEER}
    <div class="ht-r ht-pedals"><div data-touch="drift" role="button" class="ht-drift">Drift</div><div data-touch="brake" role="button" class="ht-brk">Brake</div><div data-touch="gas" role="button" class="ht-gas">Gas</div></div>`,
  simple: `${STEER}
    <div class="ht-r"><div data-touch="brake" role="button" class="ht-brk ht-brake">Brake</div></div>`,
};

/** The short reminder at the start of a run. */
function hintHtml(s: ControlScheme): string {
  if (touchDevice()) return s === 'simple' ? 'Steer ◀ ▶ · Brake on the right' : 'Steer ◀ ▶ · Gas and brake on the right';
  return s === 'simple'
    ? 'Steer <kbd>A</kbd><kbd>D</kbd> · Brake <kbd>Space</kbd>'
    : 'Throttle <kbd>W</kbd> · Steer <kbd>A</kbd><kbd>D</kbd> · Brake <kbd>S</kbd> · Drift <kbd>Space</kbd>';
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
  private lapCardTimer = 0;
  private hintTimer = 0;
  private lightsTimer = 0;
  private boardSig = '';
  // What the medal target panel projects from: your best, the live delta to it, and the target.
  private bestMs: number | null = null;
  private deltaS: number | null = null;
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
      <section class="h-timing">
        <header><span class="pw-code">${code}</span><span class="h-lapno"><span class="pw-k">Lap</span><b class="mono" data-el="lap">OUT</b></span><span class="h-dir" title="${o.dirLabel}">${o.dirIcon}</span></header>
        <div class="h-time mono" data-el="time">0:00.000</div>
        <div class="h-sectors" data-el="sectors">${[1, 2, 3].map((k) => `<div class="sec"><i></i><span class="mono">S${k}</span></div>`).join('')}</div>
        <footer>
          <div><span class="pw-k">Last</span><b class="mono" data-el="last">–:––.–––</b></div>
          <div><span class="pw-k">Best</span><b class="mono" data-el="best">–:––.–––</b></div>
        </footer>
      </section>

      <section class="h-gap" data-el="gap" hidden>
        <span class="pw-k">Ghost</span>
        <span class="h-gap-who"><i style="background:${escapeHtml(o.color)}"></i><b data-el="deltaLbl"></b></span>
        <span class="h-gap-bar"><i data-el="gapFill"></i><em data-el="gapDot"></em></span>
        <span class="h-delta mono" data-el="delta"></span>
      </section>

      <div class="h-right">
        <section class="h-target" data-el="target" hidden>
          <span class="pw-k"><i class="medal" data-el="targetDot"></i><span data-el="targetK"></span></span>
          <b class="h-tdl mono" data-el="targetDl"></b>
          <span class="pw-k h-tsub" data-el="targetSub"></span>
        </section>

        <section class="h-tower" data-el="tower">
          <header><span><i class="live-dot"></i>Live timing</span><em data-el="towerCount"></em></header>
          <ol data-el="board"><li class="h-empty">Loading…</li></ol>
          <p class="h-ontrack" data-el="onTrack"></p>
        </section>
      </div>
      <div class="h-lapcard" data-el="lapcard"></div>

      <canvas class="h-map" data-el="minimap"></canvas>

      <section class="h-speed">
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
      <div class="h-toasts" data-el="toasts"></div>
      <div class="h-loading" data-el="loading" hidden>Loading satellite imagery</div>
      <div class="h-attrib">Imagery © Esri, Maxar, Earthstar Geographics · Track © OpenStreetMap contributors</div>

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
                <button data-act="style" data-el="styleToggle"></button>
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

  /** The gap to your best lap's ghost: the bar along the top, and what the target panel projects. */
  delta(seconds: number | null, label = 'vs your best') {
    this.deltaS = seconds;
    this.$.gap.hidden = seconds === null;
    if (seconds !== null) {
      const side = seconds < 0 ? 'fast' : 'slow';
      this.text('delta', signed(seconds, 2));
      this.text('deltaLbl', label.replace(/^vs\s+/i, ''));
      this.cls('gap', `h-gap ${side}`);
      // You're the dot, the ghost is the middle: ahead of it is to the right.
      const x = Math.max(-1, Math.min(1, -seconds / GAP_RANGE));
      this.$.gapDot.style.left = `${(50 + x * 50).toFixed(1)}%`;
      this.$.gapFill.style.transform = `scaleX(${x.toFixed(3)})`;
    }
    this.paintTarget();
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

  last(ms: number | null, valid = true) {
    this.text('last', ms === null ? '–:––.–––' : formatMs(ms) + (valid ? '' : ' ✕'));
    this.$.last.classList.toggle('invalid', ms !== null && !valid);
  }

  best(ms: number | null) {
    this.bestMs = ms;
    this.text('best', ms === null ? '–:––.–––' : formatMs(ms));
    this.$.best.classList.toggle('pb', ms !== null);
    this.paintTarget();
  }

  /** The next medal to chase and its time; null hides the panel (all won, or not a time trial). */
  target(medal: Medal | null, ms: number | null) {
    this.goal = medal && ms !== null ? { medal, ms } : null;
    this.paintTarget();
  }

  /**
   * The medal target panel: how far your lap is from the next medal. Mid-lap that's your best plus
   * the live gap to its ghost (projected); between laps it's your best; with no lap yet, the time.
   */
  private paintTarget() {
    const g = this.goal;
    this.$.target.hidden = !g;
    if (!g) return;
    this.cls('targetDot', `medal ${g.medal}`);
    if (this.bestMs === null) {
      this.text('targetK', `${MEDAL_NAME[g.medal]} medal`);
      this.text('targetDl', formatMs(g.ms));
      this.text('targetSub', 'Target');
      this.cls('targetDl', 'h-tdl mono');
      return;
    }
    const gap = (this.bestMs + (this.deltaS ?? 0) * 1000 - g.ms) / 1000;
    this.text('targetK', `${MEDAL_NAME[g.medal]} ${formatMs(g.ms)}`);
    this.text('targetDl', signed(gap, 2));
    this.text('targetSub', this.deltaS === null ? 'Your best' : 'Projected');
    this.cls('targetDl', `h-tdl mono ${gap <= 0 ? 'fast' : 'slow'}`);
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

  banner(text: string, kind: BannerKind = 'info', secs = 2) {
    clearTimeout(this.bannerTimer);
    if (text !== this.bannerText || !this.$.banner.classList.contains('show')) {
      this.$.bannerText.textContent = text;
      this.$.banner.className = `h-banner is-${kind}`;
      // A medal banner wears its medal's colour.
      const m = kind === 'medal' ? MEDALS.find((x) => text.toLowerCase().startsWith(x)) : undefined;
      this.$.banner.style.setProperty('--m', m ? `var(--${m})` : '');
      void this.$.banner.offsetWidth;
      this.$.banner.classList.add('show');
      this.bannerText = text;
    }
    this.bannerTimer = window.setTimeout(() => {
      this.$.banner.classList.remove('show');
      this.bannerText = '';
    }, secs * 1000);
  }

  /** The lap just completed, held up on a pit board. */
  lapCard(o: { lap: number; ms: number; valid: boolean; delta: number | null; sectors: number[]; colors: SectorColor[]; pb: boolean }) {
    clearTimeout(this.lapCardTimer);
    const d = o.delta;
    const tag = o.pb ? '<span class="g">PB</span>' : o.valid ? '' : '<span class="y">Invalid</span>';
    this.$.lapcard.innerHTML = `
      <div class="pw-board"><div class="pw-board-in">
        <div class="pw-board-row"><span>Lap ${String(o.lap).padStart(2, '0')}</span>${tag}</div>
        <div class="pw-board-row"><span class="sm ${o.valid ? (o.pb ? 'g' : '') : 'x'}">${formatMs(o.ms)}</span></div>
        ${d !== null && o.valid ? `<div class="pw-board-row"><span class="lc-vs">vs ${o.pb ? 'previous' : 'best'}</span><span class="sm ${d < 0 ? 'g' : 'y'}">${signed(d, 3)}</span></div>` : ''}
        <div class="pw-board-row lc-rank" data-el="lcRank"></div>
      </div></div>
      ${o.valid ? `<div class="lc-secs">${o.sectors.map((s, k) => `<span class="${o.colors[k]}">${(s / 1000).toFixed(3)}</span>`).join('')}</div>` : ''}`;
    this.$.lapcard.classList.remove('show');
    void this.$.lapcard.offsetWidth;
    this.$.lapcard.classList.add('show');
    this.lapCardTimer = window.setTimeout(() => this.$.lapcard.classList.remove('show'), 6500);
  }

  lapCardRank(rank: number, total: number) {
    const el = this.$.lapcard.querySelector('[data-el=lcRank]');
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
    const t = document.createElement('div');
    t.className = kind ? `h-toast is-${kind}` : 'h-toast';
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
      const row = (k: string, v: string) => `<div class="pw-board-row"><span>${k}</span>${v}</div>`;
      this.$.stats.innerHTML =
        row('Laps', `<span class="sm">${stats.laps}<small>· ${stats.valid} clean</small></span>`) +
        row('Session', `<span class="sm">${formatMs(stats.best)}</span>`) +
        row('PB', `<span class="sm ${stats.pb === null ? '' : 'g'}">${formatMs(stats.pb)}</span>`) +
        row('Board', stats.rank ? `<span class="y">P${stats.rank}<small>/${stats.total}</small></span>` : '<span class="sm">–</span>');
    }
  }

  toggles(o: { controls: string; muted: boolean; ghosts: boolean; cam: string; quality: string; style: string; night: boolean; time: string }) {
    const row = (icon: string, label: string, value: string, off = false) =>
      `${icon}<span>${label}</span><b class="${off ? 'off' : ''}">${escapeHtml(value)}</b><i aria-hidden="true">›</i>`;
    this.$.controlsToggle.innerHTML = row(ICON.wheel, 'Controls', o.controls);
    this.$.muteToggle.innerHTML = row(ICON.sound, 'Sound', o.muted ? 'Off' : 'On', o.muted);
    this.$.ghostToggle.innerHTML = row(ICON.ghost, 'Ghosts', o.ghosts ? 'On' : 'Off', !o.ghosts);
    this.$.camToggle.innerHTML = row(ICON.cam, 'Camera', o.cam);
    this.$.qualityToggle.innerHTML = row(ICON.gauge, 'Graphics', o.quality);
    this.$.styleToggle.innerHTML = row(ICON.globe, 'World', o.style);
    this.$.timeToggle.innerHTML = row(o.night ? ICON.moon : ICON.sun, 'Time of day', o.time);
    this.$.muteBtn.classList.toggle('off', o.muted);
    this.$.ghostBtn.classList.toggle('off', !o.ghosts);
  }

  setVisible(v: boolean) {
    this.root.classList.toggle('hidden-hud', !v);
  }

  dispose() {
    clearTimeout(this.bannerTimer);
    clearTimeout(this.lapCardTimer);
    clearTimeout(this.hintTimer);
    clearTimeout(this.lightsTimer);
    this.root.remove();
  }
}
