import { escapeHtml, formatMs, saveDriver, type Dir, type Driver } from '../net/api';
import type { TrackData } from '../track/osm';
import type { TimeOfDay, TimePref } from '../game/atmosphere';
import { SCHEME_LABEL, touchDevice, type ControlScheme } from '../game/input';
import type { TrackShape } from '../track/shape';
import { cleanDriverName } from './profile';
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

/** Pre-race overlay: circuit, controls and loading, then "press any key". */
export class RaceIntro {
  readonly el: HTMLDivElement;
  private canStart = false;
  private started = false;
  private bar: HTMLElement;
  private count: HTMLElement;
  private go: HTMLElement;
  private help: HTMLElement;
  private markControls: (s: ControlScheme) => void;
  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if ((e.target as HTMLElement)?.closest?.('.io-seg') && (e.key === 'Enter' || e.key === ' ')) return; // let the button click
    if (e.key === 'Escape') return this.o.onBack();
    if (['Tab', 'Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return;
    this.start();
  };

  constructor(private o: IntroOptions) {
    const t = o.track;
    const rot = rotationLabel(o.shape, o.dir === 'rev');
    this.el = document.createElement('div');
    this.el.className = 'intro-ov';
    this.el.innerHTML = `
      <section class="io-panel">
        <button class="io-back" data-act="back"><span class="mono">←</span> Circuits</button>
        <p class="label io-kicker">${t.country ? `${t.country} · ` : ''}${escapeHtml(t.location || 'OpenStreetMap circuit')}</p>
        <h1 class="display io-name">${escapeHtml(t.name)}</h1>
        <p class="io-meta mono">${(t.lengthM / 1000).toFixed(2)} km<i></i>${o.shape.corners.length} turns<i></i>${rot.icon} ${rot.label}</p>
        <div class="io-art">${trackArt(o.shape, { w: 460, h: 300, pad: 26, reverse: o.dir === 'rev', arrows: true, road: true, draw: true, className: 'night' })}</div>
        <ul class="io-rules">
          <li><b class="mono">01</b>The clock starts when you cross the line. It's a flying lap.</li>
          <li><b class="mono">02</b>Put all four wheels off the track and the lap won't count.</li>
          <li><b class="mono">03</b>Your best lap goes on the live board, and its ghost races everyone.</li>
        </ul>
        <div class="io-ctl">
          <div class="io-ctl-head">
            <span class="label">Controls</span>
            <div class="io-seg" role="radiogroup" aria-label="Controls">${o.schemes.map((s) => `<button type="button" role="radio" data-controls="${s}">${SCHEME_LABEL[s]}</button>`).join('')}</div>
          </div>
          <p class="io-help" data-el="help"></p>
        </div>
        <label class="io-driver"><span class="label">Racing as</span><input maxlength="16" value="${escapeHtml(o.driver.name)}" spellcheck="false" autocomplete="off" aria-label="Driver name" /><span class="io-pb label">${o.pb ? `Best ${formatMs(o.pb)}` : 'No lap yet'}</span></label>
      </section>
      <footer class="io-foot">
        <div class="io-load"><span class="label">Building the world</span><div class="io-bar"><i data-el="bar"></i></div><span class="mono" data-el="count">…</span></div>
        <div class="io-foot-r">
          <div class="io-time" role="radiogroup" aria-label="Time of day">
            <span class="label">Time of day</span>
            <div class="io-seg">
              <button type="button" role="radio" data-time="live" title="The real time of day at this circuit">Live<small>${o.liveNow === 'night' ? 'Night now' : 'Day now'}</small></button>
              <button type="button" role="radio" data-time="day">Day</button>
              <button type="button" role="radio" data-time="night">Night<small>Floodlit</small></button>
            </div>
          </div>
          <button class="io-go" data-el="go" disabled><span class="io-go-key">Press any key</span><span class="io-go-sub">or tap to start</span></button>
        </div>
      </footer>`;
    o.container.appendChild(this.el);
    this.bar = this.el.querySelector('[data-el=bar]')!;
    this.count = this.el.querySelector('[data-el=count]')!;
    this.go = this.el.querySelector('[data-el=go]')!;
    this.help = this.el.querySelector('[data-el=help]')!;

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
        e.stopPropagation();
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
        e.stopPropagation();
        if (e.detail > 0) b.blur();
        if (!b.classList.contains('on')) o.onControls(b.dataset.controls as ControlScheme); // the race calls setControls back
      }),
    );
    this.el.querySelector('[data-act=back]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      o.onBack();
    });
    // On click, not pointerdown, so a touch that starts a scroll doesn't start the race.
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, label, .io-back, .io-time, .io-ctl')) return;
      this.start();
    });
    addEventListener('keydown', this.onKey);
    // Don't hold people hostage to slow tiles: allow starting after a few seconds regardless.
    setTimeout(() => this.ready(), 5000);
  }

  /** Show a scheme as picked, with its controls. */
  setControls(s: ControlScheme) {
    this.markControls(s);
    this.help.innerHTML = controlsHelp(s);
  }

  stage(label: string, frac: number) {
    this.bar.style.width = `${Math.round(frac * 100)}%`;
    this.count.textContent = label;
    if (frac >= 1) this.ready();
  }

  failed() {
    this.count.textContent = 'unavailable';
    this.ready();
  }

  ready() {
    if (this.canStart) return;
    this.canStart = true;
    this.go.removeAttribute('disabled');
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
