/**
 * Tiny synthesized audio (Web Audio, no sound files): a direct-drive kart engine with a slipping clutch at
 * the launch, a rev limiter, overrun burble and a dip in pitch when you lift; tyre squeal; kerb rumble;
 * grass and gravel; wind that rises with speed; a barrier scrape; impact thumps; start beeps.
 */

// Phones only let audio start inside a tap. The race starts on its own once the world is built, so
// the Start tap on the circuit makes the context first and the race picks it up.
let primed: AudioContext | null = null;

/** Call inside a tap or key press that leads into a race. */
export function primeAudio() {
  try {
    if (!primed || primed.state === 'closed') primed = new AudioContext();
    void primed.resume();
  } catch {
    /* no Web Audio */
  }
}

/** What the kart is doing this frame (see KartFx for the 0..1 levels). */
export interface KartSound {
  speed: number; // m/s
  vmax: number;
  throttle: number; // 0..1
  squeal: number; // 0..1
  kerb: number; // 0..1
  grass: number; // 0..1
  scrape: number; // 0..1
  cockpit: boolean;
}

const VOLUME = 0.5;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class KartAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engA!: OscillatorNode;
  private engB!: OscillatorNode;
  private engSub!: OscillatorNode;
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private engAm!: GainNode; // the limiter cuts the engine in and out through this
  private detune!: ConstantSourceNode; // cents, shared by the three engine oscillators
  private limLfo!: OscillatorNode;
  private limDepth!: GainNode;
  private limAmDepth!: GainNode;
  private wobDepth!: GainNode;
  private squealGain!: GainNode;
  private squealBp!: BiquadFilterNode;
  private kerbOsc!: OscillatorNode;
  private kerbLfo!: OscillatorNode;
  private kerbGain!: GainNode;
  private grassGain!: GainNode;
  private crunchGain!: GainNode;
  private windGain!: GainNode;
  private windLp!: BiquadFilterNode;
  private scrapeGain!: GainNode;
  private white!: AudioBuffer;
  private lastThrottle = 0;
  private liftT = 9; // seconds since the throttle was last released
  private lastT = 0;
  private lastImpact = 0;
  private _muted = localStorage.getItem('ak:muted') === '1';

  get muted() {
    return this._muted;
  }

  start() {
    if (this.ctx) return;
    const ctx = primed && primed.state !== 'closed' ? primed : new AudioContext();
    primed = null;
    void ctx.resume();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : VOLUME;
    this.master.connect(ctx.destination);
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const osc = (type: OscillatorType, f: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      return o;
    };
    const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };

    // Engine: saw + square an octave up + a sub-octave for body, through a resonant low-pass.
    this.engFilter = filter('lowpass', 900, 4);
    this.engGain = gain(0);
    this.engAm = gain(1);
    this.engA = osc('sawtooth', 50);
    this.engB = osc('square', 100);
    this.engSub = osc('triangle', 25);
    this.engA.connect(this.engFilter);
    this.engB.connect(gain(0.35)).connect(this.engFilter);
    this.engSub.connect(gain(0.25)).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.engAm).connect(this.master);
    // One detune bus for the pitch dip on lift, the limiter and the wheelspin wobble in the grass.
    this.detune = ctx.createConstantSource();
    this.detune.offset.value = 0;
    for (const o of [this.engA, this.engB, this.engSub]) this.detune.connect(o.detune);
    this.limLfo = osc('square', 16);
    this.limDepth = gain(0);
    this.limAmDepth = gain(0);
    this.limLfo.connect(this.limDepth).connect(this.detune.offset);
    this.limLfo.connect(this.limAmDepth).connect(this.engAm.gain);
    const wob = osc('sine', 9);
    this.wobDepth = gain(0);
    wob.connect(this.wobDepth).connect(this.detune.offset);

    // Noise beds: white (squeal, gravel, wind, scrape) and brown (grass), one looping source each.
    const len = ctx.sampleRate * 2;
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    const brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.white.getChannelData(0);
    const br = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      br[i] = last * 3.5;
    }
    const loop = (b: AudioBuffer) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.loop = true;
      return s;
    };
    const white = loop(this.white);
    const brownSrc = loop(brown);

    this.squealBp = filter('bandpass', 2400, 6);
    this.squealGain = gain(0);
    white.connect(this.squealBp).connect(this.squealGain).connect(this.master);

    this.crunchGain = gain(0);
    white.connect(filter('bandpass', 1400, 0.8)).connect(this.crunchGain).connect(this.master);
    this.grassGain = gain(0);
    brownSrc.connect(filter('lowpass', 350)).connect(this.grassGain).connect(this.master);

    this.windLp = filter('lowpass', 1500);
    this.windGain = gain(0);
    white.connect(filter('highpass', 900)).connect(this.windLp).connect(this.windGain).connect(this.master);

    this.scrapeGain = gain(0);
    white.connect(filter('bandpass', 3200, 2)).connect(this.scrapeGain).connect(this.master);

    // Kerb rumble: a low tone chopped by a square wave at the stripe rate (0.8 m stripes).
    this.kerbOsc = osc('sawtooth', 90);
    this.kerbLfo = osc('square', 10);
    const am = gain(0.5);
    const amDepth = gain(0.5);
    this.kerbLfo.connect(amDepth).connect(am.gain);
    this.kerbGain = gain(0);
    this.kerbOsc.connect(filter('lowpass', 220)).connect(am).connect(this.kerbGain).connect(this.master);

    for (const s of [this.engA, this.engB, this.engSub, this.detune, this.limLfo, wob, white, brownSrc, this.kerbOsc, this.kerbLfo]) s.start();
  }

  toggleMute() {
    this._muted = !this._muted;
    localStorage.setItem('ak:muted', this._muted ? '1' : '0');
    if (this.ctx) this.master.gain.setTargetAtTime(this._muted ? 0 : VOLUME, this.ctx.currentTime, 0.05);
    return this._muted;
  }

  /** Once per frame while the kart is on the grid or racing. */
  update(k: KartSound) {
    const ctx = this.ctx;
    if (!ctx || this._muted) return;
    const t = ctx.currentTime;
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    const { speed, throttle } = k;
    const on = throttle > 0.05;

    // Direct drive: pitch follows speed, with a little load on throttle. A centrifugal clutch slips
    // at about 7000 rpm until the kart is rolling, so the launch sounds like revs, not a bog.
    const f = Math.max(on && speed < 8 ? 105 : 0, 48 + speed * 6.2 + throttle * 10);
    this.engA.frequency.setTargetAtTime(f, t, 0.04);
    this.engB.frequency.setTargetAtTime(f * 2.01, t, 0.04);
    this.engSub.frequency.setTargetAtTime(f * 0.5, t, 0.04);
    // Off throttle the note goes dull and quieter.
    this.engFilter.frequency.setTargetAtTime(on ? 500 + throttle * 1400 + speed * 30 : 380 + speed * 12, t, 0.06);
    this.engGain.gain.setTargetAtTime(on ? 0.09 + throttle * 0.08 : 0.06, t, 0.08);

    // Lift: a small dip in pitch as the load comes off, then overrun pops for a moment.
    if (this.lastThrottle > 0.5 && !on && speed > 6) {
      const d = this.detune.offset;
      d.cancelScheduledValues(t);
      d.setValueAtTime(0, t);
      d.linearRampToValueAtTime(-70, t + 0.04);
      d.setTargetAtTime(0, t + 0.06, 0.12);
      this.liftT = 0;
    }
    this.liftT = on ? 9 : this.liftT + dt;
    this.lastThrottle = throttle;
    if (!on && speed > 9 && Math.random() < dt * 14 * Math.exp(-this.liftT / 0.8)) this.pop();

    // Rev limiter flat out near top speed: ±1.5% at 16 Hz and the ignition cutting in and out.
    const lim = on && speed > 0.97 * k.vmax ? 1 : 0;
    this.limDepth.gain.setTargetAtTime(lim * 26, t, 0.03);
    this.limAmDepth.gain.setTargetAtTime(lim * 0.35, t, 0.03);
    // Wheelspin in the grass: the note wobbles ±2%.
    this.wobDepth.gain.setTargetAtTime(k.grass > 0 && on ? 35 : 0, t, 0.05);

    this.squealGain.gain.setTargetAtTime(0.12 * k.squeal, t, 0.05);
    this.squealBp.frequency.setTargetAtTime(2200 + 600 * k.squeal, t, 0.08);
    this.kerbLfo.frequency.setTargetAtTime(Math.max(2, speed / 0.8), t, 0.02);
    this.kerbOsc.frequency.setTargetAtTime(80 + speed, t, 0.05);
    this.kerbGain.gain.setTargetAtTime(0.12 * k.kerb, t, 0.01);
    const g = k.grass * clamp01(speed / 15);
    this.grassGain.gain.setTargetAtTime(0.08 * g, t, 0.04);
    this.crunchGain.gain.setTargetAtTime(0.03 * g, t, 0.04);
    const v = speed / k.vmax;
    this.windGain.gain.setTargetAtTime(0.05 * v * v * (k.cockpit ? 2 : 1), t, 0.15);
    this.windLp.frequency.setTargetAtTime(1200 + 160 * speed, t, 0.15);
    this.scrapeGain.gain.setTargetAtTime(0.07 * k.scrape, t, 0.03);
  }

  /** Overrun burble: a short pop of band-passed noise. */
  private pop() {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 250 + Math.random() * 350;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 + Math.random() * 0.12, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.004, 0.025);
    s.connect(bp).connect(g).connect(this.master);
    s.start(t, Math.random() * 1.5);
    s.stop(t + 0.15);
  }

  /** A wall hit: a low thump and a burst of noise, plus a plastic clack on a hard one. */
  impact(speed: number) {
    const ctx = this.ctx;
    if (!ctx || this._muted || speed < 0.8) return;
    const t = ctx.currentTime;
    if (t - this.lastImpact < 0.07) return;
    this.lastImpact = t;
    const k = Math.min(1, speed / 8);
    const env = (peak: number, tau: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.004);
      g.gain.setTargetAtTime(0, t + 0.006, tau);
      g.connect(this.master);
      return g;
    };
    const noise = (f: number, type: BiquadFilterType, q: number, g: GainNode) => {
      const s = ctx.createBufferSource();
      s.buffer = this.white;
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      s.connect(b).connect(g);
      s.start(t, Math.random() * 1.5);
      s.stop(t + 0.5);
    };
    noise(700, 'lowpass', 0.7, env(0.5 * k, 0.08));
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(70 + 20 * k, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + 0.15);
    thump.connect(env(0.6 * k, 0.09));
    thump.start(t);
    thump.stop(t + 0.5);
    if (speed > 4) noise(1800, 'bandpass', 3, env(0.25 * k, 0.04));
  }

  /** Two rising tones: a purple sector. */
  chime() {
    const ctx = this.ctx;
    if (!ctx || this._muted) return;
    const t = ctx.currentTime;
    [988, 1319].forEach((f, k) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + k * 0.09);
      g.gain.linearRampToValueAtTime(0.07, t + k * 0.09 + 0.01);
      g.gain.setTargetAtTime(0, t + k * 0.09 + 0.05, 0.06);
      o.connect(g).connect(this.master);
      o.start(t + k * 0.09);
      o.stop(t + k * 0.09 + 0.5);
    });
  }

  beep(high = false) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = high ? 1320 : 660;
    o.type = 'square';
    g.gain.value = 0.12;
    g.gain.setTargetAtTime(0, this.ctx.currentTime + (high ? 0.35 : 0.15), 0.04);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(this.ctx.currentTime + 0.6);
  }

  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engGain.gain.setTargetAtTime(0, t, 0.1);
    for (const g of [this.squealGain, this.kerbGain, this.grassGain, this.crunchGain, this.windGain, this.scrapeGain]) g.gain.setTargetAtTime(0, t, 0.05);
    this.limAmDepth.gain.setTargetAtTime(0, t, 0.05);
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
  }
}
