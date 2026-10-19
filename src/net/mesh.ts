// Peer-to-peer links between everyone in a room: one RTCPeerConnection per pair, with a
// reliable "ctl" channel (events) and an unreliable "pos" channel (kart poses at ~20 Hz).
// Signaling goes through the room API (non-trickle ICE: one offer + one answer per attempt).
// STUN only: when two networks can't be traversed without TURN, the pair falls back to the
// room's low-rate HTTP relay (see RoomClient).
import type { PoseTuple, SignalMsg } from '../shared/room';

export type LinkState = 'connecting' | 'p2p' | 'relay';

export interface LinkInfo {
  state: LinkState;
  rtt: number | null; // ms, p2p only
}

export interface MeshHooks {
  signal(to: string, msg: Omit<SignalMsg, 'from'>): Promise<void>;
  onPose(from: string, pose: PoseTuple): void;
  onCtl(from: string, msg: CtlMsg): void;
  onLinks(): void;
}

export type CtlMsg =
  | { k: 'nudge' } // "room state changed, poll now"
  | { k: 'fin'; race: number; ms: number | null }
  | { k: 'bye' }
  | { k: 'ping'; t: number }
  | { k: 'pong'; t: number };

const DEFAULT_ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
// An attempt is two signaling round trips through the room API (each answered on the
// other side's next poll) plus ICE gathering on both sides: allow for slow function starts.
const ATTEMPT_MS = 12_000;
const MAX_FAST_ATTEMPTS = 2; // after this many failed attempts, use the relay and retry p2p occasionally
const SLOW_RETRY_MS = 45_000;
const RESPONDER_WAIT_MS = 18_000; // responder gives up waiting for an offer and uses the relay meanwhile

function iceServers(): RTCIceServer[] {
  const custom = import.meta.env.VITE_ICE_SERVERS as string | undefined;
  if (custom) {
    try {
      return JSON.parse(custom);
    } catch {
      console.warn('VITE_ICE_SERVERS is not valid JSON; using public STUN');
    }
  }
  return DEFAULT_ICE;
}

function gathered(pc: RTCPeerConnection, ms = 2500): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

class Peer {
  pc: RTCPeerConnection | null = null;
  ctl: RTCDataChannel | null = null;
  pos: RTCDataChannel | null = null;
  state: LinkState = 'connecting';
  rtt: number | null = null;
  attempt = 0;
  fastTries = 0;
  timer = 0;
  waitingAnswer = false;
  closed = false;

  constructor(
    readonly mid: string,
    readonly initiator: boolean,
    private mesh: Mesh,
  ) {
    if (initiator) this.offer();
    else this.arm(RESPONDER_WAIT_MS, () => this.setState('relay'));
  }

  private arm(ms: number, fn: () => void) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(fn, ms);
  }

  private setState(s: LinkState) {
    if (this.state === s) return;
    this.state = s;
    if (s !== 'p2p') this.rtt = null;
    this.mesh.changed();
  }

  private newPc() {
    this.teardownPc();
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc = pc;
    // Negotiated channels: both sides create them with fixed ids, no ondatachannel race.
    this.ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
    this.pos = pc.createDataChannel('pos', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    this.ctl.onopen = () => {
      if (pc !== this.pc) return;
      clearTimeout(this.timer);
      this.fastTries = 0;
      this.waitingAnswer = false;
      this.setState('p2p');
      this.mesh.sendCtl({ k: 'ping', t: performance.now() }, this.mid);
    };
    this.ctl.onmessage = (e) => {
      try {
        this.mesh.gotCtl(this.mid, JSON.parse(e.data));
      } catch {
        /* ignore junk */
      }
    };
    this.pos.onmessage = (e) => {
      try {
        const p = JSON.parse(e.data);
        if (Array.isArray(p) && p.length === 10) this.mesh.hooks.onPose(this.mid, p as PoseTuple);
      } catch {
        /* ignore junk */
      }
    };
    const lost = () => {
      if (pc !== this.pc || this.closed) return;
      this.linkLost();
    };
    this.ctl.onclose = lost;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') lost();
      // 'disconnected' often recovers by itself; give it a few seconds.
      if (pc.connectionState === 'disconnected') this.arm(6000, () => pc === this.pc && pc.connectionState !== 'connected' && lost());
    };
    return pc;
  }

  private linkLost() {
    this.teardownPc();
    this.setState(this.fastTries >= MAX_FAST_ATTEMPTS ? 'relay' : 'connecting');
    if (this.initiator) this.arm(800 + Math.random() * 800, () => this.offer());
    else this.arm(RESPONDER_WAIT_MS, () => this.setState('relay'));
  }

  async offer() {
    if (this.closed) return;
    this.attempt++;
    this.fastTries++;
    const id = this.attempt;
    const pc = this.newPc();
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      if (pc !== this.pc || this.closed) return;
      this.waitingAnswer = true;
      await this.mesh.hooks.signal(this.mid, { k: 'offer', id, sdp: pc.localDescription!.sdp });
    } catch (e) {
      console.warn('[mesh] offer failed', e);
    }
    // No answer / no open channel in time: retry a few times quickly, then use the relay
    // and keep trying p2p now and then (networks change, e.g. phone joins Wi-Fi).
    const fast = this.fastTries <= MAX_FAST_ATTEMPTS;
    this.arm(fast ? ATTEMPT_MS : SLOW_RETRY_MS, () => {
      if (this.state === 'p2p') return;
      if (this.fastTries >= MAX_FAST_ATTEMPTS) this.setState('relay');
      this.offer();
    });
  }

  async onSignal(msg: SignalMsg) {
    if (this.closed) return;
    try {
      if (msg.k === 'offer' && !this.initiator) {
        this.attempt = msg.id;
        const pc = this.newPc();
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);
        if (pc !== this.pc || this.closed) return;
        await this.mesh.hooks.signal(this.mid, { k: 'answer', id: msg.id, sdp: pc.localDescription!.sdp });
        if (this.state !== 'p2p') this.arm(ATTEMPT_MS + 4000, () => this.state !== 'p2p' && this.setState('relay'));
      } else if (msg.k === 'answer' && this.initiator && msg.id === this.attempt && this.pc?.signalingState === 'have-local-offer') {
        this.waitingAnswer = false;
        await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      }
    } catch (e) {
      console.warn('[mesh] signal failed', e);
    }
  }

  send(ch: 'ctl' | 'pos', data: string) {
    const c = ch === 'ctl' ? this.ctl : this.pos;
    if (c?.readyState !== 'open') return false;
    // Drop poses rather than queue them behind a congested link.
    if (ch === 'pos' && c.bufferedAmount > 16_000) return false;
    try {
      c.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private teardownPc() {
    const pc = this.pc;
    this.pc = this.ctl = this.pos = null;
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.close();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.teardownPc();
  }
}

export class Mesh {
  private peers = new Map<string, Peer>();
  private pingTimer: number;
  private notifyQueued = false;

  constructor(
    readonly me: string,
    readonly hooks: MeshHooks,
  ) {
    this.pingTimer = window.setInterval(() => this.sendCtl({ k: 'ping', t: performance.now() }), 2000);
  }

  /** Match peers to the room's members. The later joiner offers, so there's never glare. */
  sync(members: { mid: string; joined: number }[]) {
    const self = members.find((m) => m.mid === this.me);
    if (!self) return;
    const wanted = new Set(members.map((m) => m.mid).filter((m) => m !== this.me));
    for (const [mid, p] of this.peers) {
      if (!wanted.has(mid)) {
        p.close();
        this.peers.delete(mid);
        this.changed();
      }
    }
    for (const m of members) {
      if (m.mid === this.me || this.peers.has(m.mid)) continue;
      const iJoinedLater = self.joined > m.joined || (self.joined === m.joined && this.me > m.mid);
      this.peers.set(m.mid, new Peer(m.mid, iJoinedLater, this));
      this.changed();
    }
  }

  handleSignal(msg: SignalMsg) {
    this.peers.get(msg.from)?.onSignal(msg);
  }

  /** True while we're waiting for an answer, so the room should poll quickly. */
  expectingSignal() {
    for (const p of this.peers.values()) if (p.state === 'connecting') return true;
    return false;
  }

  links(): Map<string, LinkInfo> {
    return new Map([...this.peers].map(([mid, p]) => [mid, { state: p.state, rtt: p.rtt }]));
  }

  /** Peers we can't reach directly (their poses come through the HTTP relay). */
  relayPeers(): string[] {
    return [...this.peers.values()].filter((p) => p.state !== 'p2p').map((p) => p.mid);
  }

  sendPose(pose: PoseTuple) {
    const data = JSON.stringify(pose);
    for (const p of this.peers.values()) p.send('pos', data);
  }

  sendCtl(msg: CtlMsg, to?: string) {
    const data = JSON.stringify(msg);
    for (const p of this.peers.values()) if (!to || p.mid === to) p.send('ctl', data);
  }

  gotCtl(from: string, msg: CtlMsg) {
    if (msg.k === 'ping') return this.sendCtl({ k: 'pong', t: msg.t }, from);
    if (msg.k === 'pong') {
      const p = this.peers.get(from);
      if (p) {
        const rtt = performance.now() - msg.t;
        p.rtt = p.rtt == null ? rtt : p.rtt * 0.7 + rtt * 0.3;
        this.changed();
      }
      return;
    }
    this.hooks.onCtl(from, msg);
  }

  changed() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.hooks.onLinks();
    });
  }

  dispose() {
    clearInterval(this.pingTimer);
    this.sendCtl({ k: 'bye' });
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
  }
}
