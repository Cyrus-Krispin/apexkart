// Phone controller link. The screen (the laptop running the game) opens a pairing code through
// /api/pad and shows it as a QR code; the phone joins it and offers a WebRTC connection, the same
// non-trickle offer/answer the room mesh uses (src/net/mesh.ts), with two negotiated channels:
// "ctl" (reliable: buttons, what the screen shows, vibration, pings) and "in" (unordered, no
// retransmits: steering frames at ~60 Hz). Once connected nothing goes through the server.
// See docs/phone-controller.md.
import { gathered, iceServers } from './mesh';
import { tabIdentity } from './room';
import type { SignalMsg } from '../shared/room';
import type { PadButton, PadCtl, PadFrame, PadPollResponse, PadView } from '../shared/pad';

export type { PadButton, PadView } from '../shared/pad';

class PadError extends Error {
  constructor(
    msg: string,
    readonly status: number,
  ) {
    super(msg);
  }
}

async function post<T>(a: string, body: object): Promise<T> {
  const { secret } = await tabIdentity();
  const res = await fetch('/api/pad', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, s: secret, ...body }) });
  if (!res.ok) throw new PadError((await res.text()) || res.statusText, res.status);
  return res.json();
}

/** One RTCPeerConnection between a screen and a phone. */
class Link {
  readonly pc = new RTCPeerConnection({ iceServers: iceServers() });
  // Negotiated channels: both sides create them with fixed ids, no ondatachannel race.
  private ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 0 });
  private inp = this.pc.createDataChannel('in', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
  private dead = false;
  private lostTimer = 0;

  constructor(h: { open(): void; ctl(m: PadCtl): void; frame(f: PadFrame): void; lost(): void }) {
    const lost = () => {
      if (this.dead) return;
      this.close();
      h.lost();
    };
    this.ctl.onopen = () => !this.dead && h.open();
    this.ctl.onclose = lost;
    this.ctl.onmessage = (e) => {
      try {
        h.ctl(JSON.parse(e.data));
      } catch {
        /* ignore junk */
      }
    };
    this.inp.onmessage = (e) => {
      try {
        const f = JSON.parse(e.data);
        if (Array.isArray(f) && f.length === 4 && f.every((x) => typeof x === 'number' && isFinite(x))) h.frame(f as PadFrame);
      } catch {
        /* ignore junk */
      }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') lost();
      // 'disconnected' often recovers by itself; give it a few seconds.
      if (s === 'disconnected') this.lostTimer = window.setTimeout(() => this.pc.connectionState !== 'connected' && lost(), 4000);
      if (s === 'connected') clearTimeout(this.lostTimer);
    };
  }

  get open() {
    return !this.dead && this.ctl.readyState === 'open';
  }

  async offer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc);
    return this.pc.localDescription!.sdp;
  }

  async answer(sdp: string) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    return this.pc.localDescription!.sdp;
  }

  async accept(sdp: string) {
    if (this.pc.signalingState === 'have-local-offer') await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  sendCtl(m: PadCtl) {
    if (!this.open) return;
    try {
      this.ctl.send(JSON.stringify(m));
    } catch {
      /* closing */
    }
  }

  sendFrame(f: PadFrame) {
    // Drop frames rather than queue them behind a congested link: only the newest matters.
    if (this.dead || this.inp.readyState !== 'open' || this.inp.bufferedAmount > 2000) return;
    try {
      this.inp.send(JSON.stringify(f));
    } catch {
      /* closing */
    }
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.lostTimer);
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}

// ======================================================================== screen (the game)

/**
 * off: nothing open. waiting: a code is open, no phone yet. connecting: a phone joined and the
 * link is being set up. live: steering. lost: the phone dropped; the code stays open for it.
 */
export type PadStatus = 'off' | 'waiting' | 'connecting' | 'live' | 'lost';

export interface PadInput {
  steer: number;
  brake: number;
  gas: number;
}

const CODE_KEY = 'ak:pad:code'; // sessionStorage: a reload keeps the code, so the phone reconnects by itself
const FRAME_STALE_MS = 400; // no steering for this long: hands off (straight ahead, no pedals)
const SILENT_MS = 6000; // and for this long: the phone is gone (closed, out of range)
const POLL_FAST = 1200;
const POLL_LIVE = 15_000; // connected: keeps the code alive, and lets another phone take over by scanning it
const GIVE_UP_MS = 5 * 60_000; // waiting this long with no phone: close the code

type ScreenEvents = { status: (s: PadStatus) => void; button: (b: PadButton) => void };

export class PadScreen {
  status: PadStatus = 'off';
  code: string | null = null;
  rtt: number | null = null;
  /** The phone steers by tilting (false: it has no motion sensor, so it shows steer buttons). */
  tilt = true;
  private link: Link | null = null;
  private frame: PadFrame | null = null;
  private frameAt = 0;
  private pollTimer = 0;
  private pingTimer = 0;
  private pingAt = 0;
  private polling = false;
  private since = 0; // when we started waiting (for GIVE_UP_MS)
  private view: Extract<PadCtl, { k: 'view' }> = { k: 'view', view: 'menu', scheme: 'simple', mp: false };
  private listeners: { [K in keyof ScreenEvents]: Set<ScreenEvents[K]> } = { status: new Set(), button: new Set() };

  on<K extends keyof ScreenEvents>(ev: K, fn: ScreenEvents[K]): () => void {
    (this.listeners[ev] as Set<ScreenEvents[K]>).add(fn);
    return () => (this.listeners[ev] as Set<ScreenEvents[K]>).delete(fn);
  }

  get live() {
    return this.status === 'live';
  }

  /** The join link the QR code holds. */
  get url() {
    return this.code ? `${location.origin}/pad.html?c=${this.code}` : '';
  }

  /** Show a code for a phone to join (keeping the current one if it's still ours). */
  async open() {
    if (this.status === 'live' || this.status === 'connecting') return;
    const res = await post<{ code: string }>('open', { code: this.code ?? sessionStorage.getItem(CODE_KEY) ?? '' });
    this.code = res.code;
    sessionStorage.setItem(CODE_KEY, res.code);
    this.since = performance.now();
    if (this.status === 'off') this.setStatus('waiting');
    this.schedule(0);
  }

  /** After a reload: if this tab had a phone, reopen its code so the phone finds us again. */
  resume() {
    const code = sessionStorage.getItem(CODE_KEY);
    if (!code) return;
    this.code = code;
    this.since = performance.now();
    this.setStatus('lost');
    this.schedule(0);
  }

  /** Disconnect the phone and close the code. */
  close() {
    this.link?.sendCtl({ k: 'bye' });
    this.drop();
    clearTimeout(this.pollTimer);
    if (this.code) post('close', { code: this.code }).catch(() => undefined);
    this.code = null;
    sessionStorage.removeItem(CODE_KEY);
    this.setStatus('off');
  }

  /** The phone's steering now, or null when no phone is steering. */
  input(): PadInput | null {
    if (this.status !== 'live' || !this.frame || performance.now() - this.frameAt > FRAME_STALE_MS) return null;
    const [, steer, brake, gas] = this.frame;
    const c = (x: number, lo: number) => Math.max(lo, Math.min(1, x));
    return { steer: c(steer, -1), brake: c(brake, 0), gas: c(gas, 0) };
  }

  /** What the game is showing, so the phone offers the right buttons. */
  setView(view: PadView, scheme: 'simple' | 'classic', mp = false) {
    this.view = { k: 'view', view, scheme, mp };
    this.link?.sendCtl(this.view);
  }

  buzz(p: number | number[]) {
    if (this.status === 'live') this.link?.sendCtl({ k: 'buzz', p });
  }

  private setStatus(s: PadStatus) {
    if (s === this.status) return;
    this.status = s;
    if (s !== 'live') this.rtt = null;
    this.listeners.status.forEach((fn) => fn(s));
  }

  private schedule(ms = this.status === 'live' ? POLL_LIVE : POLL_FAST * (document.hidden ? 3 : 1)) {
    clearTimeout(this.pollTimer);
    if (this.status !== 'off') this.pollTimer = window.setTimeout(() => this.poll(), ms);
  }

  private async poll() {
    if (this.polling || !this.code || this.status === 'off') return;
    if (this.status !== 'live' && this.status !== 'connecting' && performance.now() - this.since > GIVE_UP_MS) return this.close();
    this.polling = true;
    try {
      const res = await post<PadPollResponse>('poll', { code: this.code });
      if (!res.open) {
        // Expired (the laptop slept, say). A phone can't find a new code by itself, so stop; the
        // card offers a new code. A live link carries on without one.
        if (this.status !== 'live') return this.close();
        this.code = null;
        sessionStorage.removeItem(CODE_KEY);
        return;
      }
      // Only the newest offer matters: older ones are attempts the phone has given up on.
      const offer = res.mail.filter((m) => m.k === 'offer').pop();
      if (offer) await this.onSignal(offer);
    } catch {
      /* next poll */
    } finally {
      this.polling = false;
    }
    this.schedule();
  }

  private async onSignal(m: SignalMsg) {
    // A phone (this one again, or a new one taking over) wants to connect: start a fresh link.
    this.drop();
    this.setStatus('connecting');
    const link = this.newLink();
    try {
      const sdp = await link.answer(m.sdp);
      if (link !== this.link) return;
      await post('signal', { code: this.code, k: 'answer', id: m.id, sdp });
    } catch (e) {
      console.warn('[pad] answer failed', e);
    }
    // No channel in time: the phone retries with a new offer.
    window.setTimeout(() => link === this.link && !link.open && this.lost(), 15_000);
  }

  private newLink() {
    const link: Link = new Link({
      open: () => {
        if (link !== this.link) return;
        this.frame = null;
        this.since = performance.now();
        this.setStatus('live');
        link.sendCtl(this.view);
        clearInterval(this.pingTimer);
        this.pingAt = performance.now();
        this.pingTimer = window.setInterval(() => this.ping(), 1000);
        this.schedule();
      },
      ctl: (m) => link === this.link && this.onCtl(m),
      frame: (f) => {
        if (link !== this.link || (this.frame && f[0] <= this.frame[0] && f[0] > this.frame[0] - 1000)) return; // out of order
        this.frame = f;
        this.frameAt = performance.now();
      },
      lost: () => link === this.link && this.lost(),
    });
    this.link = link;
    return link;
  }

  private onCtl(m: PadCtl) {
    if (m.k === 'btn') this.listeners.button.forEach((fn) => fn(m.b));
    else if (m.k === 'hello') this.tilt = m.tilt;
    else if (m.k === 'ping') this.link?.sendCtl({ k: 'pong', t: m.t });
    else if (m.k === 'pong') {
      const rtt = performance.now() - m.t;
      this.rtt = this.rtt == null ? rtt : this.rtt * 0.7 + rtt * 0.3;
    } else if (m.k === 'bye') this.lost();
  }

  private ping() {
    if (this.status !== 'live') return;
    const now = performance.now();
    // This tick came late: the page was busy (building a race), and the phone's frames may still be
    // waiting to be read. Only judge silence on a tick that came on time.
    const late = now - this.pingAt > 2500;
    this.pingAt = now;
    // A phone that has gone quiet is gone: wait for it to come back.
    if (!late && now - this.frameAt > SILENT_MS && now - this.since > SILENT_MS) return this.lost();
    this.link?.sendCtl({ k: 'ping', t: now });
  }

  /** The link dropped: keep the code open and poll for the phone's next offer. */
  private lost() {
    this.drop();
    this.since = performance.now();
    this.setStatus(this.code ? 'lost' : 'off');
    this.schedule(0);
  }

  private drop() {
    clearInterval(this.pingTimer);
    this.link?.close();
    this.link = null;
    this.frame = null;
  }
}

/** The game's one phone controller. */
export const phonePad = new PadScreen();

// ======================================================================== phone (the controller)

/**
 * joining: asking the server for the code. connecting: offer sent, waiting for the link.
 * live: steering. retry: the link dropped or didn't come up; trying again. gone: the code is
 * closed (the game left or showed a new code).
 */
export type PhoneStatus = 'joining' | 'connecting' | 'live' | 'retry' | 'gone';

const ATTEMPT_MS = 12_000; // two signaling round trips, ICE gathering on both sides, slow function starts
const PHONE_POLL_MS = 700;
// The screen pings every second; this long without one and the link is dead. Generous: the game's
// page can be busy for a few seconds while it builds a race.
const PING_SILENT_MS = 10_000;

export class PadPhone {
  status: PhoneStatus = 'joining';
  error = '';
  attempts = 0;
  private link: Link | null = null;
  // Attempt ids start somewhere random, so an answer to the offer of a page this one replaced (a
  // reload: same identity, same code) can't be taken for the answer to ours.
  private attempt = Math.floor(Math.random() * 2 ** 30);
  private timer = 0;
  private pollTimer = 0;
  private watchTimer = 0;
  private lastCtl = 0;
  private seq = 0;
  private joined = false; // once in, reconnecting must not take the code from a phone that scanned since
  private disposed = false;

  constructor(
    readonly code: string,
    private h: { status(s: PhoneStatus): void; ctl(m: PadCtl): void },
  ) {
    document.addEventListener('visibilitychange', this.onVisible);
    addEventListener('pagehide', this.onHide);
    this.connect();
  }

  get live() {
    return this.status === 'live';
  }

  sendFrame(steer: number, brake: number, gas: number) {
    this.link?.sendFrame([++this.seq, +steer.toFixed(3), +brake.toFixed(2), +gas.toFixed(2)]);
  }

  send(m: PadCtl) {
    this.link?.sendCtl(m);
  }

  private setStatus(s: PhoneStatus) {
    if (s === this.status) return;
    this.status = s;
    this.h.status(s);
  }

  /** Join the code and offer a link; retried until it works or the code is gone. */
  private async connect() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    clearTimeout(this.pollTimer);
    this.link?.close();
    this.link = null;
    const id = ++this.attempt;
    this.attempts++;
    try {
      await post('join', { code: this.code, again: this.joined ? 1 : 0 });
      if (id !== this.attempt) return;
      this.joined = true;
      if (this.status !== 'retry') this.setStatus('connecting');
      const link = this.newLink();
      const sdp = await link.offer();
      if (id !== this.attempt) return;
      await post('signal', { code: this.code, k: 'offer', id, sdp });
      this.poll(id);
    } catch (e) {
      if (id !== this.attempt) return;
      if (e instanceof PadError && (e.status === 404 || e.status === 409)) {
        this.error = e.message;
        return this.setStatus('gone');
      }
      console.warn('[pad] connect failed', e);
    }
    // No link in time: again, waiting a little longer each time (a new offer replaces the one the
    // screen may still be answering, so a busy screen needs the time).
    this.timer = window.setTimeout(
      () => {
        if (this.status === 'live' || document.hidden) return; // hidden: onVisible reconnects
        if (this.attempts >= 2) this.setStatus('retry');
        this.connect();
      },
      Math.min(30_000, ATTEMPT_MS + (this.attempts - 1) * 4000),
    );
  }

  /** Wait for the screen's answer. */
  private async poll(id: number) {
    if (id !== this.attempt || this.status === 'live' || this.disposed) return;
    try {
      const res = await post<PadPollResponse>('poll', { code: this.code });
      if (id !== this.attempt) return;
      if (!res.open) {
        this.error = res.pad ? 'Another phone took over.' : 'That code has closed.';
        clearTimeout(this.timer);
        return this.setStatus('gone');
      }
      for (const m of res.mail) if (m.k === 'answer' && m.id === id) await this.link?.accept(m.sdp);
    } catch {
      /* next poll */
    }
    this.pollTimer = window.setTimeout(() => this.poll(id), PHONE_POLL_MS);
  }

  private newLink() {
    const link: Link = new Link({
      open: () => {
        if (link !== this.link) return;
        clearTimeout(this.timer);
        clearTimeout(this.pollTimer);
        this.attempts = 0;
        this.lastCtl = performance.now();
        clearInterval(this.watchTimer);
        this.watchTimer = window.setInterval(() => performance.now() - this.lastCtl > PING_SILENT_MS && this.dropped(), 1000);
        this.setStatus('live');
      },
      ctl: (m) => {
        if (link !== this.link) return;
        this.lastCtl = performance.now();
        if (m.k === 'ping') return link.sendCtl({ k: 'pong', t: m.t });
        if (m.k === 'bye') return this.dropped();
        this.h.ctl(m);
      },
      frame: () => {},
      lost: () => link === this.link && this.dropped(),
    });
    this.link = link;
    return link;
  }

  private dropped() {
    clearInterval(this.watchTimer);
    this.link?.close();
    this.link = null;
    if (this.disposed || this.status === 'gone') return;
    this.setStatus('retry');
    clearTimeout(this.timer);
    if (!document.hidden) this.timer = window.setTimeout(() => this.connect(), 600); // hidden: onVisible reconnects
  }

  /**
   * Off to the lock screen or another app: say so, so the game pauses now rather than when it
   * notices the silence. Back again: reconnect at once rather than wait for a timer.
   */
  private onVisible = () => {
    if (this.disposed || this.status === 'gone') return;
    if (document.hidden) {
      if (this.status === 'live') this.link?.sendCtl({ k: 'bye' });
      return;
    }
    this.dropped();
  };

  private onHide = () => this.link?.sendCtl({ k: 'bye' });

  /** Try again after "gone" (the player typed the code again, say). */
  retry() {
    this.error = '';
    this.attempts = 0;
    this.setStatus('joining');
    this.connect();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.pollTimer);
    clearInterval(this.watchTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    removeEventListener('pagehide', this.onHide);
    this.link?.sendCtl({ k: 'bye' });
    this.link?.close();
    this.link = null;
  }
}
