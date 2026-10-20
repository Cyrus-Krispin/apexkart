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
      : 'Steer with ◀ ▶. Gas and Brake on the right, Drift above Brake.';
  return s === 'simple'
    ? `${keys([['A D', 'Steer'], ['Space', 'Brake, reverse'], ['R', 'Back on track'], ['Esc', 'Pause']])}The kart accelerates by itself. Gamepad: stick steers, LT brakes.`
    : `${keys([['W', 'Throttle'], ['S', 'Brake'], ['A D', 'Steer'], ['Space', 'Drift'], ['R', 'Back on track'], ['Esc', 'Pause']])}Gamepad: RT throttle, LT brake, stick steers, X drift.`;
}

/**
 * The grid: the pre-race briefing. The circuit drawn large with its sectors, the times to beat,
 * controls and time of day, and the world loading like a lap on the timing screen. One green
 * START, by tap or any key.
 */
export class RaceIntro {
  readonly el: HTMLDivElement;
  private canStart = false;
  private started = false;
  private bar: HTMLElement;
  private count: HTMLElement;
  private pct: HTMLElement;
  private go: HTMLButtonElement;
  private help: HTMLElement;
  private medals: HTMLElement;
  private record: HTMLElement;
  private markControls: (s: ControlScheme) => void;
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
          </div>
        </div>
        <div class="io-art graph-paper">${trackArt(o.shape, { w: 560, h: 380, pad: 30, reverse: o.dir === 'rev', road: true, sectors: true, turns: true, arrows: true, draw: true })}</div>
        <p class="io-meta">
          <span class="mono">${(t.lengthM / 1000).toFixed(2)} km</span><span class="mono">${o.shape.corners.length} turns</span><span>${rot.icon} ${rot.label}</span>
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
        <div class="io-load" aria-live="polite">
          <span class="pw-k" data-el="count">Building the world</span>
          <span class="mono io-pct" data-el="pct">00%</span>
          <div class="io-bar"><i data-el="bar"></i><s></s><s></s></div>
        </div>
        <button class="btn go lg block io-go" data-el="go" disabled>Start ${escapeHtml(code)}<span class="io-go-sub">${touchDevice() ? '' : 'or press any key'}</span></button>
      </footer>`;
    o.container.appendChild(this.el);
    const $ = (k: string) => this.el.querySelector<HTMLElement>(`[data-el=${k}]`)!;
    this.bar = $('bar');
    this.count = $('count');
    this.pct = $('pct');
    this.go = $('go') as HTMLButtonElement;
    this.help = $('help');
    this.medals = $('medals');
    this.record = $('rec');
    this.paintMedals(null);

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

  stage(label: string, frac: number) {
    const f = Math.max(0, Math.min(1, frac));
    this.bar.style.clipPath = `inset(0 ${(100 - f * 100).toFixed(1)}% 0 0)`; // the sectors fill in turn, like a lap
    this.count.textContent = label;
    this.pct.textContent = `${String(Math.round(f * 100)).padStart(2, '0')}%`;
    if (frac >= 1) this.ready();
  }

  failed() {
    this.count.textContent = 'World unavailable';
    this.ready();
  }

  ready() {
    if (this.canStart) return;
    this.canStart = true;
    this.go.disabled = false;
    this.el.classList.add('ready');
  }

  private start() {
    if (!this.canStart || this.started) return;
    this.started = true;
    this.el.classList.add('out');
    removeEventListener('keydown', this.onKey);
    setTimeout(() => this.el.remove(), 500);
    this.o.onStart();
  }

  dispose() {
    removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}
