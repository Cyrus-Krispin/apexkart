/** Tiny synthesized audio: two-stroke engine drone, tyre squeal, start beeps. */
export class KartAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engA!: OscillatorNode;
  private engB!: OscillatorNode;
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private squealGain!: GainNode;
  private _muted = localStorage.getItem('ak:muted') === '1';

  get muted() {
    return this._muted;
  }

  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 900;
    this.engFilter.Q.value = 4;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0.0;
    this.engA = ctx.createOscillator();
    this.engA.type = 'sawtooth';
    this.engB = ctx.createOscillator();
    this.engB.type = 'square';
    const bGain = ctx.createGain();
    bGain.gain.value = 0.35;
    this.engA.connect(this.engFilter);
    this.engB.connect(bGain).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.engA.start();
    this.engB.start();

    // Squeal: band-passed noise
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 6;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    noise.connect(bp).connect(this.squealGain).connect(this.master);
    noise.start();
  }

  toggleMute() {
    this._muted = !this._muted;
    localStorage.setItem('ak:muted', this._muted ? '1' : '0');
    if (this.ctx) this.master.gain.setTargetAtTime(this._muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    return this._muted;
  }

  update(speed: number, throttle: number, slip: number, onGrass: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Direct-drive kart: pitch follows speed, with a little load on throttle.
    const f = 48 + speed * 6.2 + throttle * 10;
    this.engA.frequency.setTargetAtTime(f, t, 0.04);
    this.engB.frequency.setTargetAtTime(f * 2.01, t, 0.04);
    this.engFilter.frequency.setTargetAtTime(500 + throttle * 1400 + speed * 30, t, 0.06);
    this.engGain.gain.setTargetAtTime(0.09 + throttle * 0.08, t, 0.08);
    const sq = onGrass ? 0 : Math.max(0, Math.min(1, (slip - 2.2) / 5)) * 0.12;
    this.squealGain.gain.setTargetAtTime(sq, t, 0.05);
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
    this.engGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    this.squealGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
  }
}
