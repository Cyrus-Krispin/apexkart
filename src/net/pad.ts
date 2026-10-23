// Phone as a wheel: a pairing between the game's screen and one phone, through /api/pad (polled,
// like a room) for the introduction and the multiplayer mesh (src/net/mesh.ts) for everything live.
// The phone joins later, so it makes the WebRTC offer. UI-free: the screen side is src/ui/padPair.ts,
// the phone side src/pad/main.ts.
import { Mesh } from './mesh';
import { tabIdentity } from './room';
import type { PadCtlMsg, PadMember, PadPollResponse, PadTuple } from '../shared/pad';
import type { SignalMsg } from '../shared/room';

/** waiting: no phone yet (screen only). connecting: the two are setting up a direct link. live: steering flows. */
export type PadStatus = 'waiting' | 'connecting' | 'live' | 'closed';
export type PadCloseReason = 'gone' | 'replaced' | 'left';

export class PadApiError extends Error {
  constructor(
    msg: string,
    readonly status: number,
  ) {
    super(msg);
  }
}

const POLL_WATCHED = 1500; // the screen is showing the QR code: notice the phone quickly
const POLL_WAITING = 6000;
const POLL_FAST = 700; // while the WebRTC offer and answer go back and forth
const POLL_LIVE = 15_000; // the link is up: polls are only heartbeats
const HEARTBEAT_MS = 8000;
const GIVE_UP_WAITING_MS = 10 * 60_000; // nobody scanned the code: stop polling for it

export class PadLink {
  status: PadStatus = 'connecting';
  /** Round trip over the direct link, ms. */
  rtt: number | null = null;
  /** True while the screen shows the code (polls faster so the phone connects sooner). */
  watching = false;
  onStatus?: () => void;
  onData?: (t: PadTuple) => void;
  onCtl?: (m: PadCtlMsg) => void;
  onClosed?: (why: PadCloseReason) => void;

  private readonly mesh: Mesh;
  private members: PadMember[] = [];
  private mailN = 0;
  private lastHb = 0;
  private pollTimer = 0;
  private polling = false;
  private disposed = false;
  private failures = 0;
  private waitingSince = performance.now();

  private constructor(
    readonly code: string,
    readonly role: 'screen' | 'phone',
    private readonly secret: string,
    private readonly mid: string,
  ) {
    this.mesh = new Mesh(mid, {
      signal: (to, m) => this.call('signal', { to, ...m }).then(() => undefined),
      onPose: () => {},
      onData: (_from, d) => {
        if (d.length === 4 && d.every((x) => typeof x === 'number' && isFinite(x))) this.onData?.(d as PadTuple);
      },
      onCtl: (_from, m) => {
        if (m.k === 'bye') this.pollSoon(400);
        if (m.k === 'key' || m.k === 'scheme' || m.k === 'buzz') this.onCtl?.(m);
      },
      onLinks: () => this.update(),
    });
    addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** The screen opens a pairing and waits for a phone. */
  static async create() {
    const { secret, mid } = await tabIdentity();
    const res = await post('create', { s: secret });
    const link = new PadLink(res.code!, 'screen', secret, mid);
    link.apply(res);
    return link;
  }

  /** The phone takes the wheel of the screen showing `code`. */
  static async join(code: string) {
    const { secret, mid } = await tabIdentity();
    const link = new PadLink(code.toUpperCase(), 'phone', secret, mid);
    try {
      link.apply(await link.call('join', {}));
    } catch (e) {
      link.dispose();
      throw e;
    }
    return link;
  }

  /** What the QR code opens: the phone page with this code. */
  get url() {
    return new URL(`pad.html#${this.code}`, location.href).href;
  }

  /** Phone: the latest steering, on the unreliable channel. */
  send(t: PadTuple) {
    this.mesh.sendData(t);
  }

  /** Either side: a button press, the pedal layout, a buzz. */
  sendCtl(m: PadCtlMsg) {
    this.mesh.sendCtl(m);
  }

  async leave() {
    this.dispose();
    await post('leave', { s: this.secret, code: this.code }).catch(() => undefined);
    this.onClosed?.('left');
  }

  // ---------- internals

  private update() {
    const prev = this.status;
    const rtt = this.rtt;
    if (this.disposed) this.status = 'closed';
    else if (this.members.length < 2) this.status = 'waiting';
    else {
      const other = this.members.find((m) => m.mid !== this.mid);
      const l = other && this.mesh.links().get(other.mid);
      this.status = l?.state === 'p2p' ? 'live' : 'connecting';
      this.rtt = l?.state === 'p2p' ? l.rtt : null;
    }
    if (this.status !== 'waiting') this.waitingSince = performance.now();
    if (prev !== this.status || rtt !== this.rtt) this.onStatus?.();
    if (prev !== this.status) this.schedule();
  }

  private async call(a: string, body: object) {
    return post(a, { s: this.secret, code: this.code, ...body });
  }

  private apply(res: PadPollResponse, fromPoll = false) {
    if (this.disposed) return;
    if (!res.members) {
      this.dispose();
      this.onClosed?.(res.closed ?? 'gone');
      return;
    }
    if (!fromPoll) this.mailN = res.mailN;
    else this.mailN = Math.max(this.mailN, res.mailN);
    this.members = res.members;
    this.mesh.sync(res.members); // before mail, so the phone's offer finds its peer
    res.mail.forEach((m: SignalMsg) => this.mesh.handleSignal(m));
    this.update();
    this.schedule();
  }

  private interval() {
    if (this.status === 'live') return POLL_LIVE;
    if (this.status === 'connecting' || this.mesh.expectingSignal()) return POLL_FAST;
    if (document.hidden) return POLL_WAITING;
    return this.watching ? POLL_WATCHED : POLL_WAITING;
  }

  private schedule(ms = this.interval()) {
    if (this.disposed) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => this.poll(), ms);
  }

  pollSoon(ms = 50) {
    this.schedule(ms);
  }

  private async poll() {
    if (this.disposed || this.polling) return;
    if (this.status === 'waiting' && !this.watching && performance.now() - this.waitingSince > GIVE_UP_WAITING_MS) {
      void this.leave();
      return;
    }
    this.polling = true;
    const hb = performance.now() - this.lastHb > HEARTBEAT_MS;
    try {
      const res = await this.call('poll', { mailN: this.mailN, hb: hb ? 1 : 0 });
      if (hb) this.lastHb = performance.now();
      this.failures = 0;
      // The phone was dropped for being quiet (asleep in a pocket) and the wheel is still free: take it back.
      if (this.role === 'phone' && res.members && !res.members.some((m) => m.mid === this.mid)) {
        this.mesh.reset();
        return this.apply(await this.call('join', {}));
      }
      this.apply(res, true);
    } catch (e) {
      this.failures++;
      if (e instanceof PadApiError && e.status === 404) {
        this.dispose();
        this.onClosed?.('gone');
        return;
      }
      this.schedule(Math.min(10_000, 1000 * 2 ** Math.min(this.failures, 4)));
    } finally {
      this.polling = false;
    }
  }

  private onVisibility = () => !document.hidden && this.pollSoon(30);

  /** The screen closing ends the pairing. A phone reloading keeps its seat (same tab identity) and reconnects. */
  private onPageHide = () => {
    this.mesh.sendCtl({ k: 'bye' });
    if (this.role !== 'screen') return;
    const body = JSON.stringify({ a: 'leave', s: this.secret, code: this.code });
    navigator.sendBeacon?.('/api/pad', new Blob([body], { type: 'application/json' }));
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.pollTimer);
    removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.mesh.dispose();
    this.update();
  }
}

async function post(a: string, body: object): Promise<PadPollResponse> {
  const res = await fetch('/api/pad', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, ...body }) });
  if (!res.ok) throw new PadApiError((await res.text()) || res.statusText, res.status);
  return res.json();
}
