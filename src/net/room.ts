// Client side of a multiplayer room: membership and settings through /api/room (polled,
// with a server-synchronised clock), live traffic through the WebRTC mesh (src/net/mesh.ts).
// UI-free: the lobby (src/ui/lobby.ts) and the race add-on (src/game/mpRace.ts) subscribe to it.
import { Mesh, type CtlMsg, type LinkInfo } from './mesh';
import type { TrackData } from '../track/osm';
import type { Dir, PollResponse, PoseTuple, RoomState, SignalMsg } from '../shared/room';

export type RoomCloseReason = 'gone' | 'idle' | 'kicked' | 'left';

export interface RoomEvents {
  state: (s: RoomState) => void;
  links: (l: Map<string, LinkInfo>) => void;
  pose: (mid: string, p: PoseTuple) => void;
  ctl: (mid: string, m: CtlMsg) => void;
  closed: (why: RoomCloseReason) => void;
  net: (ok: boolean) => void; // API reachable?
}

export interface Profile {
  name: string;
  color: string;
}

// ---------- per-tab identity (a tab is a player, so two tabs can race each other)

async function sha12(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const randomSecret = () => crypto.randomUUID().replace(/-/g, '');

/** `?player=2` in the URL gives a tab a separate identity (handy for testing in iframes). */
function slotKey() {
  const p = new URLSearchParams(location.search).get('player');
  return `ak:mp:secret${p && /^\w{1,8}$/.test(p) ? ':' + p : ''}`;
}

let identity: Promise<{ secret: string; mid: string }> | null = null;

/**
 * The secret lives in sessionStorage, so a reload keeps your place in the room. Duplicated
 * tabs copy sessionStorage, so we ask other tabs on a BroadcastChannel and re-roll on a clash.
 */
export function tabIdentity() {
  identity ??= (async () => {
    const key = slotKey();
    let secret = sessionStorage.getItem(key) || randomSecret();
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel('ak:mp:ids');
      const clash = await new Promise<boolean>((resolve) => {
        bc.onmessage = (e) => e.data?.q === secret && e.data?.dup && resolve(true);
        bc.postMessage({ q: secret });
        setTimeout(() => resolve(false), 120);
      });
      if (clash) secret = randomSecret();
      bc.onmessage = (e) => e.data?.q === secret && !e.data.dup && bc.postMessage({ q: secret, dup: true });
    }
    sessionStorage.setItem(key, secret);
    return { secret, mid: await sha12(secret) };
  })();
  return identity;
}

// ---------- server clock

/** Server time from API round trips; keeps the lowest-latency samples (NTP-style). */
export class ServerClock {
  private samples: { rtt: number; off: number }[] = [];
  offset = 0; // serverMs - performance.now()
  synced = false;

  sample(sentAt: number, recvAt: number, server: number) {
    const rtt = recvAt - sentAt;
    this.samples.push({ rtt, off: server - (sentAt + rtt / 2) });
    if (this.samples.length > 16) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.off;
    this.synced = true;
  }

  now() {
    return performance.now() + this.offset;
  }

  /** Server time for a performance.now() timestamp. */
  at(perfMs: number) {
    return perfMs + this.offset;
  }

  /** Server epoch ms -> local performance.now() time. */
  toLocal(serverMs: number) {
    return serverMs - this.offset;
  }
}

// ---------- the room

class ApiError extends Error {
  constructor(
    msg: string,
    readonly status: number,
  ) {
    super(msg);
  }
}

const POLL_LOBBY = 2000;
const POLL_RACING = 3000;
const POLL_HIDDEN = 8000;
const POLL_FAST = 600;
const HEARTBEAT_MS = 8000;
const RELAY_MS = 300;

export class RoomClient {
  state: RoomState | null = null;
  readonly clock = new ServerClock();
  readonly mesh: Mesh;
  private listeners: { [K in keyof RoomEvents]?: Set<RoomEvents[K]> } = {};
  private mailN = 0;
  private lastHb = 0;
  private pollTimer = 0;
  private polling = false;
  private relayTimer = 0;
  private relayBusy = false;
  private relaySeen = new Map<string, number>();
  private disposed = false;
  private failures = 0;
  /** Latest local pose, sent through the relay to peers we can't reach directly. */
  localPose: PoseTuple | null = null;

  private constructor(
    readonly code: string,
    readonly secret: string,
    readonly mid: string,
  ) {
    this.mesh = new Mesh(mid, {
      signal: (to, m) => this.call('signal', { to, ...m }).then(() => undefined),
      onPose: (from, p) => this.emit('pose', from, p),
      onCtl: (from, m) => {
        if (m.k === 'nudge' || m.k === 'bye' || m.k === 'fin') this.pollSoon(m.k === 'bye' ? 400 : 60);
        this.emit('ctl', from, m);
      },
      onLinks: () => {
        this.emit('links', this.mesh.links());
        this.updateRelay();
      },
    });
    addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  static async create(profile: Profile, track: TrackData, dir: Dir, laps: number) {
    const { secret, mid } = await tabIdentity();
    const res = await post<PollResponse>('create', { s: secret, ...profile, track: slimTrack(track), dir, laps });
    const room = new RoomClient(res.state!.cfg.code, secret, mid);
    room.apply(res);
    return room;
  }

  static async join(code: string, profile: Profile) {
    const { secret, mid } = await tabIdentity();
    const room = new RoomClient(code.toUpperCase(), secret, mid);
    try {
      room.apply(await room.call('join', profile));
    } catch (e) {
      room.dispose();
      throw e;
    }
    return room;
  }

  // ---------- events

  on<K extends keyof RoomEvents>(ev: K, fn: RoomEvents[K]): () => void {
    ((this.listeners[ev] ??= new Set() as any) as Set<RoomEvents[K]>).add(fn);
    return () => this.listeners[ev]?.delete(fn as any);
  }

  private emit<K extends keyof RoomEvents>(ev: K, ...args: Parameters<RoomEvents[K]>) {
    this.listeners[ev]?.forEach((fn) => (fn as (...a: unknown[]) => void)(...args));
  }

  // ---------- derived

  get me() {
    return this.state?.players.find((p) => p.mid === this.mid) ?? null;
  }

  get isHost() {
    return this.state?.cfg.host === this.mid;
  }

  get link() {
    return `${location.origin}${location.pathname}#/room/${this.code}`;
  }

  // ---------- actions (each returns once the server has applied it)

  setReady(ready: boolean) {
    return this.act('ready', { ready });
  }
  setProfile(p: Profile) {
    return this.act('profile', p);
  }
  configure(c: { track?: TrackData; dir?: Dir; laps?: number }) {
    return this.act('config', { ...c, track: c.track && slimTrack(c.track) });
  }
  start() {
    return this.act('start', {});
  }
  finish(race: number, ms: number | null) {
    this.mesh.sendCtl({ k: 'fin', race, ms });
    return this.act('finish', { race, ms });
  }
  endRace() {
    return this.act('end', {});
  }
  kick(mid: string) {
    return this.act('kick', { mid });
  }

  async fetchTrack(): Promise<TrackData> {
    const r = await fetch(`/api/room?code=${this.code}&trk=1`);
    if (!r.ok) throw new Error('Could not load the room’s track');
    return r.json();
  }

  async leave() {
    this.dispose();
    await post('leave', { s: this.secret, code: this.code }).catch(() => undefined);
    this.emit('closed', 'left');
  }

  // ---------- internals

  private async act(a: string, body: object) {
    const res = await this.call(a, body);
    this.apply(res);
    this.mesh.sendCtl({ k: 'nudge' });
    return res;
  }

  private async call(a: string, body: object): Promise<PollResponse> {
    const sent = performance.now();
    const res = await post<PollResponse>(a, { s: this.secret, code: this.code, ...body });
    if (typeof res?.now === 'number') this.clock.sample(sent, performance.now(), res.now);
    return res;
  }

  private apply(res: PollResponse) {
    if (this.disposed) return;
    if (!res.state) {
      this.dispose();
      this.emit('closed', res.closed ?? 'gone');
      return;
    }
    if (res.mailN !== undefined) this.mailN = Math.max(this.mailN, res.mailN);
    this.state = res.state;
    this.mesh.sync(res.state.players); // before mail, so offers from new peers find their Peer
    res.mail?.forEach((m: SignalMsg) => this.mesh.handleSignal(m));
    this.emit('state', res.state);
    this.updateRelay();
    this.schedule();
  }

  private interval() {
    if (document.hidden) return POLL_HIDDEN;
    if (this.mesh.expectingSignal()) return POLL_FAST;
    return this.state?.cfg.phase === 'racing' ? POLL_RACING : POLL_LOBBY;
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
    this.polling = true;
    const hb = performance.now() - this.lastHb > HEARTBEAT_MS;
    try {
      const res = await this.call('poll', { mailN: this.mailN, hb: hb ? 1 : 0 });
      if (hb) this.lastHb = performance.now();
      if (this.failures) this.emit('net', true);
      this.failures = 0;
      // Dropped for being quiet too long (e.g. a long background tab)? Walk back in.
      if (res.state && !res.state.players.some((p) => p.mid === this.mid)) {
        const me = this.lastProfile();
        if (me) return this.apply(await this.call('join', me));
      }
      this.apply(res);
    } catch (e) {
      this.failures++;
      this.emit('net', false);
      if (e instanceof ApiError && e.status === 404) {
        this.dispose();
        this.emit('closed', 'gone');
      }
      this.schedule(Math.min(10_000, 1000 * 2 ** Math.min(this.failures, 4)));
    } finally {
      this.polling = false;
    }
  }

  private profileCache: Profile | null = null;
  private lastProfile() {
    const m = this.me;
    if (m) this.profileCache = { name: m.name, color: m.color };
    return this.profileCache;
  }

  /** Peers without a p2p link exchange poses through the server a few times a second, only while racing. */
  private updateRelay() {
    const want = this.state?.cfg.phase === 'racing' && this.mesh.relayPeers().length > 0;
    if (want && !this.relayTimer) this.relayTimer = window.setInterval(() => this.relayTick(), RELAY_MS);
    if (!want && this.relayTimer) {
      clearInterval(this.relayTimer);
      this.relayTimer = 0;
    }
  }

  private async relayTick() {
    if (this.relayBusy || this.disposed) return;
    const want = this.mesh.relayPeers();
    if (!this.localPose) return; // not in the race view ourselves
    this.relayBusy = true;
    try {
      const sent = performance.now();
      const res = await post<{ now: number; poses: Record<string, PoseTuple> }>('relay', {
        s: this.secret,
        code: this.code,
        pose: this.localPose,
        want,
      });
      this.clock.sample(sent, performance.now(), res.now);
      for (const [mid, p] of Object.entries(res.poses)) {
        if ((this.relaySeen.get(mid) ?? 0) >= p[0]) continue;
        this.relaySeen.set(mid, p[0]);
        this.emit('pose', mid, p);
      }
    } catch {
      /* next tick */
    } finally {
      this.relayBusy = false;
    }
  }

  private onVisibility = () => !document.hidden && this.pollSoon(30);

  /**
   * Tab closing or reloading: tell peers now, and ask the server to drop us in a few seconds
   * unless we come back (a reload rejoins with the same identity and keeps host/ready).
   */
  private onPageHide = () => {
    this.mesh.sendCtl({ k: 'bye' });
    const body = JSON.stringify({ a: 'leave', soft: 1, s: this.secret, code: this.code });
    navigator.sendBeacon?.('/api/room', new Blob([body], { type: 'application/json' }));
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.relayTimer);
    removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.mesh.dispose();
  }
}

async function post<T>(a: string, body: object): Promise<T> {
  const res = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, ...body }) });
  if (!res.ok) throw new ApiError((await res.text()) || res.statusText, res.status);
  return res.json();
}

/** Only what the server keeps (drops `preset` and any extras). */
function slimTrack(t: TrackData) {
  const { id, name, location, center, points, width, lengthM, osmWays, source } = t;
  return { id, name, location, center, points, width, lengthM, osmWays, source };
}
