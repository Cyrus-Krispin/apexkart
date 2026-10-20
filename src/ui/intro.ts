import { escapeHtml, formatMs, saveDriver, type BoardResponse, type Dir, type Driver } from '../net/api';
import type { TrackData } from '../track/osm';
import type { TimeOfDay, TimePref } from '../game/atmosphere';
import { SCHEME_LABEL, touchDevice, type ControlScheme } from '../game/input';
import { earnedMedal, MEDAL_NAME, MEDALS, targets } from '../game/medals';
import type { TrackShape } from '../track/shape';
import { cleanDriverName } from './profile';
import { circuitCode, stripeStyle } from './pitwall';
import { rotationLabel, trackArt } from './trackArt';

export interface IntroOptions {
  container: HTMLElement;
  track: TrackData;
  shape: TrackShape;
  dir: Dir;
  driver: Driver;
  pb: number | null;
  time: TimePref;
  liveNow: TimeOfDay; // what "Live" means at this circuit right now
  controls: ControlScheme;
  schemes: ControlScheme[]; // the ones this device offers
  onTime: (t: TimePref) => void;
  onControls: (s: ControlScheme) => void;
  onStart: () => void;
  onBack: () => void;
}

/** The controls for a scheme, short enough for one or two lines of the briefing. */
function controlsHelp(s: ControlScheme): string {
  const keys = (pairs: [string, string][]) =>
    `<span class="io-keys">${pairs.map(([k, what]) => `<span>${k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('')} ${what}</span>`).join('')}</span>`;
  if (touchDevice())
    return s === 'simple'
      ? 'The kart accelerates by itself. Steer with ◀ ▶ and brake on the right. Hold Brake when stopped to reverse.'
      : 'Steer with ◀ ▶. Gas and Brake on the right.';
  return s === 'simple'
    ? `${keys([['A D', 'Steer'], ['Space', 'Brake, reverse'], ['R', 'Back on track'], ['Esc', 'Pause']])}The kart accelerates by itself. Gamepad: stick steers, LT brakes.`
    : `${keys([['W ↑', 'Throttle'], ['S ↓ Space', 'Brake'], ['A D', 'Steer'], ['R', 'Back on track'], ['Esc', 'Pause']])}Gamepad: RT throttle, LT or B brake, stick steers.`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The layout draws itself from the start line in this long. */
const DRAW_MS = 1300;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** The loading lap: the drawing's road, its sector traces and the dot that laps it. */
interface Lap {
  centre: SVGPathElement; // the road's centreline: the same path as the road, without pathLength, to measure along
  total: number;
  s0: number; // start line, as a fraction of the path
  dir: 1 | -1; // race direction along the path
  road: SVGPathElement[]; // road and casing, drawn in from the line
  traces: { el: SVGPathElement; len: number; lit: boolean }[];
  dot: SVGCircleElement;
}

/**
 * The grid: the pre-race briefing. The circuit drawn large on the timing screen, and the world
 * loading as a lap of it: a dot leaves the line, each sector lights up as it passes, and the
 * chequered line flashes when it gets back. The times to beat, controls and time of day around
 * it, and one green START, by tap or any key.
 */
export class RaceIntro {
  readonly el: HTMLDivElement;
  private canStart = false;
  private started = false;
  private count: HTMLElement;
  private pct: HTMLElement;
  private go: HTMLButtonElement;
  private help: HTMLElement;
  private medals: HTMLElement;
  private record: HTMLElement;
  private art: HTMLElement;
  private markControls: (s: ControlScheme) => void;
  // Progress: what's loaded, where the lap is heading (loaded, or the line once START is live),
  // and where the dot is.
  private loaded = 0;
  private goal = 0;
  private shown = 0;
  private label = 'Building the world';
  private lap: Lap | null = null;
  private drawn = 0;
  private flagged = false;
  private raf = 0;
  private t0 = performance.now();
  private last = this.t0;
  private still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t?.tagName === 'INPUT') return;
    if (t?.closest?.('button') && (e.key === 'Enter' || e.key === ' ')) return; // let the focused button click
    if (e.key === 'Escape') return this.o.onBack();
    if (['Tab', 'Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return;
    this.start();
  };

  constructor(private o: IntroOptions) {
    const t = o.track;
    const rot = rotationLabel(o.shape, o.dir === 'rev');
    const code = circuitCode(t.name);
    const where = t.location || 'OpenStreetMap circuit';
    const tabs = (attr: string, items: [string, string, string?][]) =>
      items.map(([v, label, small]) => `<button type="button" role="radio" ${attr}="${v}">${label}${small ? `<small>${small}</small>` : ''}</button>`).join('');
    this.el = document.createElement('div');
    this.el.className = 'intro-ov';
    this.el.innerHTML = `
      <header class="io-top">
        <button class="io-back" data-act="back"><span aria-hidden="true">‹</span> Circuits</button>
        <span class="io-sess"><i class="live-dot"></i>On the grid</span>
        <label class="io-driver"><span class="pw-k">Racing as</span><input maxlength="16" value="${escapeHtml(o.driver.name)}" spellcheck="false" autocomplete="off" aria-label="Driver name" /></label>
      </header>

      <section class="io-map">
        <div class="io-id">
          <span class="pw-stripe big" style="${stripeStyle(t.country)}"></span>
          <div class="io-id-t">
            <p class="io-code"><span class="pw-code">${escapeHtml(code)}</span><span class="pw-k">${escapeHtml(where)}</span></p>
            <h1 class="display io-name">${escapeHtml(t.name)}</h1>
            <p class="io-meta"><span class="mono">${(t.lengthM / 1000).toFixed(2)} km</span><span class="mono">${o.shape.corners.length} turns</span><span>${rot.icon} ${rot.label}</span></p>
          </div>
        </div>
        <div class="io-art graph-paper" data-el="art"></div>
        <p class="io-load">
          <span class="mono"><span data-el="count" aria-live="polite">Building the world</span> <b data-el="pct">0%</b></span>
          <span class="io-leg"><i class="p"></i>S1<i class="g"></i>S2<i class="y"></i>S3</span>
        </p>
      </section>

      <section class="io-panel">
        <div class="io-times">
          <div><span class="pw-k">Your best</span><b class="pw-t ${o.pb ? 'io-pb' : 'none'}">${o.pb ? formatMs(o.pb) : 'No time'}</b></div>
          <div><span class="pw-k">Track record</span><b class="pw-t io-rec" data-el="rec">–:––.–––</b></div>
        </div>
        <div class="io-block io-medals">
          <span class="pw-k">Medal targets</span>
          <div class="io-med" data-el="medals">${MEDALS.map((m) => `<div><i class="medal ${m}"></i><span>${MEDAL_NAME[m]}</span><b class="mono">–:––.–––</b></div>`).join('')}</div>
        </div>
        <div class="io-block io-ctl">
          <span class="pw-k">Controls</span>
          <div class="pw-tabs" role="radiogroup" aria-label="Controls">${tabs('data-controls', o.schemes.map((s) => [s, SCHEME_LABEL[s]]))}</div>
          <p class="io-help" data-el="help"></p>
        </div>
        <div class="io-block io-tod">
          <span class="pw-k">Time of day</span>
          <div class="pw-tabs soft" role="radiogroup" aria-label="Time of day">${tabs('data-time', [
            ['live', 'Live', o.liveNow === 'night' ? 'Night now' : 'Day now'],
            ['day', 'Day'],
            ['night', 'Night', 'Floodlit'],
          ])}</div>
        </div>
        <ol class="io-rules">
          <li><b>Flying lap</b>The clock starts when you cross the line.</li>
          <li><b>Track limits</b>Four wheels off the track and the lap won't count.</li>
          <li><b>Live board</b>Your best lap goes on the board, and its ghost races everyone.</li>
        </ol>
      </section>

      <footer class="io-foot">
        <button class="btn go lg block io-go" data-el="go" disabled>Start ${escapeHtml(code)}<span class="io-go-sub">${touchDevice() ? '' : 'or press any key'}</span></button>
      </footer>`;
    o.container.appendChild(this.el);
    const $ = (k: string) => this.el.querySelector<HTMLElement>(`[data-el=${k}]`)!;
    this.count = $('count');
    this.pct = $('pct');
    this.go = $('go') as HTMLButtonElement;
    this.help = $('help');
    this.medals = $('medals');
    this.record = $('rec');
    this.art = $('art');
    this.paintMedals(null);

    // Draw to the well's shape (upright on phones, wide on desktop).
    const box = this.art.getBoundingClientRect();
    const aspect = box.width > 0 && box.height > 0 ? Math.min(1.3, Math.max(0.5, box.height / box.width)) : 0.68;
    this.art.innerHTML = trackArt(o.shape, { w: 600, h: Math.round(600 * aspect), pad: 34, reverse: o.dir === 'rev', road: true, sectors: true, turns: true, arrows: true, draw: true });
    this.lap = this.setupLap();
    this.raf = requestAnimationFrame(this.tick);

    const input = this.el.querySelector('input')!;
    input.addEventListener('input', () => {
      const v = cleanDriverName(input.value);
      if (v !== input.value) input.value = v;
      o.driver.name = v.trim() || 'Driver';
      saveDriver(o.driver);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      e.stopPropagation();
    });
    const seg = [...this.el.querySelectorAll<HTMLButtonElement>('[data-time]')];
    const mark = (t: TimePref) =>
      seg.forEach((b) => {
        const on = b.dataset.time === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
    mark(o.time);
    seg.forEach((b) =>
      b.addEventListener('click', (e) => {
        if (e.detail > 0) b.blur(); // after a pointer click, the next key press starts the race again
        const t = b.dataset.time as TimePref;
        if (b.classList.contains('on')) return;
        mark(t);
        o.onTime(t);
      }),
    );
    const ctl = [...this.el.querySelectorAll<HTMLButtonElement>('[data-controls]')];
    this.markControls = (s) =>
      ctl.forEach((b) => {
        const on = b.dataset.controls === s;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
    this.setControls(o.controls);
    ctl.forEach((b) =>
      b.addEventListener('click', (e) => {
        if (e.detail > 0) b.blur();
        if (!b.classList.contains('on')) o.onControls(b.dataset.controls as ControlScheme); // the race calls setControls back
      }),
    );
    this.el.querySelector('[data-act=back]')!.addEventListener('click', () => o.onBack());
    this.go.addEventListener('click', () => this.start());
    addEventListener('keydown', this.onKey);
    // Don't hold people hostage to slow tiles: allow starting after a few seconds regardless.
    setTimeout(() => this.ready(), 5000);
  }

  /** Show a scheme as picked, with its controls. */
  setControls(s: ControlScheme) {
    this.markControls(s);
    this.help.innerHTML = controlsHelp(s);
  }

  /** The live board for this circuit: the record, and the medal targets set from it. */
  board(b: BoardResponse | null) {
    if (!b) return;
    const rec = b.entries[0];
    this.record.textContent = rec ? formatMs(rec.ms) : 'No time';
    this.record.classList.toggle('none', !rec);
    if (rec) this.record.title = rec.name;
    this.paintMedals(rec?.ms ?? 0);
  }

  /** Medal cells: won ones ticked, the next one ringed. null = the record isn't known yet. */
  private paintMedals(record: number | null) {
    const have = earnedMedal(this.o.track.id, this.o.dir);
    const next = MEDALS[(have ? MEDALS.indexOf(have) : -1) + 1];
    const tg = record === null ? null : targets(record, this.o.track.lengthM);
    MEDALS.forEach((m, k) => {
      const cell = this.medals.children[k] as HTMLElement;
      const won = have !== null && k <= MEDALS.indexOf(have);
      cell.className = won ? 'won' : m === next ? 'next' : '';
      cell.querySelector('b')!.textContent = tg ? formatMs(tg[m]) : '–:––.–––';
    });
  }

  // ---------- the loading lap

  /** Ready the drawing: road and casing to draw in from the line, a trace over each sector, the dot. */
  private setupLap(): Lap | null {
    const svg = this.art.querySelector('svg');
    const centre = svg?.querySelector<SVGPathElement>('.ta-center');
    const roadEl = svg?.querySelector<SVGPathElement>('.ta-road');
    if (!svg || !centre || !roadEl) return null;
    const road = [...svg.querySelectorAll<SVGPathElement>('.ta-casing, .ta-road')];
    road.forEach((p) => p.setAttribute('pathLength', '1'));
    // Each sector stays a dim line until the dot passes; a coloured trace grows over it behind the dot.
    const traces = [...svg.querySelectorAll<SVGPathElement>('.ta-sector')].map((base) => {
      const el = base.cloneNode() as SVGPathElement;
      base.classList.add('io-unlit');
      el.classList.add('io-trace');
      base.after(el);
      const len = el.getTotalLength();
      el.style.strokeDasharray = `${len} ${len}`;
      el.style.strokeDashoffset = `${len}`;
      el.style.visibility = 'hidden';
      return { el, len, lit: false };
    });
    // Corner numbers come in one after another once the road is down.
    svg.querySelectorAll<SVGElement>('.ta-turn').forEach((g, k) => (g.style.transitionDelay = `${k * 45}ms`));
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'io-dot');
    dot.setAttribute('r', (parseFloat(roadEl.getAttribute('stroke-width') ?? '9') * 0.6).toFixed(1));
    svg.appendChild(dot);
    const lap: Lap = { centre, total: centre.getTotalLength(), s0: this.o.shape.startFrac, dir: this.o.dir === 'rev' ? -1 : 1, road, traces, dot };
    if (this.still) this.paintRoad(lap, 1);
    this.paintLap(lap, 0);
    return lap;
  }

  /** The road and casing drawn from the start line in race direction, u of the way round. */
  private paintRoad(lap: Lap, u: number) {
    this.drawn = u;
    for (const p of lap.road) {
      p.style.strokeDasharray = u >= 1 ? 'none' : `${u} ${1 - u}`;
      p.style.strokeDashoffset = `${lap.dir > 0 ? -lap.s0 : u - lap.s0}`;
    }
    if (u >= 1) this.art.classList.add('drawn');
  }

  /** The dot f of the way round from the line, with the sectors behind it lit. */
  private paintLap(lap: Lap, f: number) {
    const x = (((lap.s0 + lap.dir * f) % 1) + 1) % 1;
    const pt = lap.centre.getPointAtLength(x * lap.total);
    lap.dot.setAttribute('cx', pt.x.toFixed(1));
    lap.dot.setAttribute('cy', pt.y.toFixed(1));
    lap.traces.forEach((s, k) => {
      const part = Math.max(0, Math.min(1, f * 3 - k));
      s.el.style.visibility = part > 0 ? '' : 'hidden';
      s.el.style.strokeDashoffset = `${(s.len * (1 - part)).toFixed(1)}`;
      if (part >= 1 && !s.lit) {
        s.lit = true;
        s.el.classList.add('lit');
      }
    });
    this.paintText();
  }

  private paintText() {
    const done = this.flagged && this.loaded >= 1;
    const text = done ? 'Ready' : this.label;
    const pct = `${Math.round((this.flagged ? this.loaded : this.shown) * 100)}%`;
    if (this.count.textContent !== text) this.count.textContent = text;
    if (this.pct.textContent !== pct) this.pct.textContent = pct;
  }

  /** One frame: the road draws in, then the dot chases the load (never ahead of the drawn road). */
  private tick = (now: number) => {
    const lap = this.lap;
    if (!lap) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.drawn < 1) this.paintRoad(lap, this.still ? 1 : easeOut(Math.min(1, (now - this.t0) / DRAW_MS)));
    const want = Math.min(this.goal, this.drawn);
    if (want > this.shown) {
      // Quick to catch up on a big jump, never a standstill, and a sprint for the line once START is live.
      const speed = Math.max((want - this.shown) * 4, this.goal >= 1 ? 1.2 : 0.15);
      this.shown = this.still ? want : Math.min(want, this.shown + speed * dt);
      this.paintLap(lap, this.shown);
    }
    if (this.shown >= 1) {
      // Back at the line: it flashes, and the lap is done.
      this.flagged = true;
      this.art.classList.add('flag');
      this.paintText();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  stage(label: string, frac: number) {
    if (frac < 1) this.label = label; // "Ready" waits for the dot to reach the line
    this.loaded = Math.max(this.loaded, Math.min(1, frac));
    this.goal = Math.max(this.goal, this.loaded);
    this.paintText();
    if (frac >= 1) this.ready();
  }

  failed() {
    this.label = 'World unavailable';
    this.ready();
  }

  ready() {
    if (this.canStart) return;
    this.canStart = true;
    this.goal = 1; // the dot sprints for the line; START doesn't wait for it
    this.go.disabled = false;
    this.el.classList.add('ready');
    if (!this.lap) this.paintText();
  }

  private start() {
    if (!this.canStart || this.started) return;
    this.started = true;
    cancelAnimationFrame(this.raf);
    this.el.classList.add('out');
    removeEventListener('keydown', this.onKey);
    setTimeout(() => this.el.remove(), 500);
    this.o.onStart();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}
