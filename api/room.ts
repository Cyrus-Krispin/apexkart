// Multiplayer rooms: lobby state, WebRTC signaling, and a low-rate pose relay for
// players whose networks can't connect peer-to-peer. Race traffic itself goes over
// WebRTC data channels between the players; this endpoint only keeps the room.
//
// POST /api/room  { a: action, code, s: secret, ... }   (see MULTIPLAYER.md)
// GET  /api/room?code=&trk=1                            track geometry for the room
//
// Redis layout (all keys expire ROOM_TTL_S after the last heartbeat):
//   ak:room:{code}            hash: cfg, p:{mid} profile, s:{mid} last seen, r:{mid} ready version,
//                                   f:{mid} finish, m:{mid} signal count, k:{mid} kicked
//   ak:room:{code}:in:{mid}   list: pending signaling messages for mid
//   ak:room:{code}:trk        track geometry (TrackData JSON)
//   ak:room:{code}:rl:{mid}   latest relayed pose (5 s)
import { getStore, json, bad, publicId, cleanName, cleanColor, isDir, TRACK_RE, type Store } from './_lib/store.js';
import {
  CODE_ALPHABET, CODE_RE, MID_RE, SECRET_RE, ROOM_MAX, LAPS_MIN, LAPS_MAX, LAPS_DEFAULT, START_DELAY_MS, STALE_MS, IDLE_MS,
  ROOM_TTL_S, FINISH_GRACE_MS, KART_COLORS, isReady, raceResult, nearestLivery, isRoomTime, roomTime,
  type RoomCfg, type RoomPlayer, type RoomState, type PollResponse, type SignalMsg, type RoomTime,
} from '../src/shared/room.js';

const TRK_TTL_S = 6 * 3600;
const KART_TOP_SPEED = 30; // m/s, a bit above the game's real top speed

const K = {
  room: (c: string) => `ak:room:${c}`,
  inbox: (c: string, mid: string) => `ak:room:${c}:in:${mid}`,
  trk: (c: string) => `ak:room:${c}:trk`,
  relay: (c: string, mid: string) => `ak:room:${c}:rl:${mid}`,
  rate: (mid: string) => `ak:rl:room:${mid}`,
};

class HttpError extends Error {
  constructor(
    msg: string,
    readonly status = 400,
  ) {
    super(msg);
  }
}

interface Loaded {
  state: RoomState;
  raw: string; // cfg as stored, for compare-and-set
  hash: Record<string, string>;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const code = (q.get('code') ?? '').toUpperCase();
  if (!CODE_RE.test(code) || !q.has('trk')) return bad('bad request');
  const trk = await getStore().get(K.trk(code));
  if (!trk) return bad('no track', 404);
  return new Response(trk, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 300_000) return bad('payload too large', 413);
  let b: any;
  try {
    b = JSON.parse(raw);
  } catch {
    return bad('invalid json');
  }
  if (!b || typeof b.a !== 'string') return bad('bad action');
  if (typeof b.s !== 'string' || !SECRET_RE.test(b.s)) return bad('bad secret');
  const db = getStore();
  const mid = await publicId(b.s);
  const now = Date.now();
  try {
    if (b.a === 'create') return json(await create(db, mid, b, now));
    const code = String(b.code ?? '').toUpperCase();
    if (!CODE_RE.test(code)) return bad('bad room code');
    switch (b.a) {
      case 'relay':
        return json(await relay(db, code, mid, b, now));
      case 'poll':
        return json(await poll(db, code, mid, b, now));
      case 'join':
        return json(await join(db, code, mid, b, now));
      case 'leave':
        if (b.soft) await softLeave(db, code, mid, now);
        else await leave(db, code, mid, now);
        return json({ ok: true, now });
      case 'signal':
        return json(await signal(db, code, mid, b, now));
      default:
        return json(await mutate(db, code, mid, b, now));
    }
  } catch (e) {
    if (e instanceof HttpError) return bad(e.message, e.status);
    throw e;
  }
}

// ---------- loading + housekeeping

function parse(code: string, hash: Record<string, string>): Loaded | null {
  if (!hash.cfg) return null;
  const cfg: RoomCfg = JSON.parse(hash.cfg);
  const players: RoomPlayer[] = [];
  for (const [f, v] of Object.entries(hash)) {
    if (!f.startsWith('p:')) continue;
    const mid = f.slice(2);
    const p = JSON.parse(v);
    players.push({
      mid,
      name: p.name,
      color: p.color,
      joined: p.joined,
      seen: Number(hash[`s:${mid}`] ?? p.joined),
      ready: Number(hash[`r:${mid}`] ?? 0),
      fin: hash[`f:${mid}`] ? JSON.parse(hash[`f:${mid}`]) : null,
    });
  }
  players.sort((a, b) => a.joined - b.joined || (a.mid < b.mid ? -1 : 1));
  cfg.code = code;
  return { state: { cfg, players }, raw: hash.cfg, hash };
}

const playerFields = (mid: string) => [`p:${mid}`, `s:${mid}`, `r:${mid}`, `f:${mid}`, `m:${mid}`];

async function destroy(db: Store, code: string, mids: string[]) {
  await db.del([K.room(code), K.trk(code), ...mids.map((m) => K.inbox(code, m))]);
}

/** Replace cfg atomically; returns false if someone else changed it first. */
async function writeCfg(db: Store, code: string, l: Loaded, cfg: RoomCfg) {
  const next = JSON.stringify(cfg);
  if (next === l.raw) return true;
  const ok = await db.hcas(K.room(code), 'cfg', l.raw, next);
  if (ok) l.raw = next;
  return ok;
}

function nextHost(players: RoomPlayer[], except: string[]) {
  return players.find((p) => !except.includes(p.mid))?.mid ?? null;
}

/** Load a room and apply lazy housekeeping: idle close, stale players, host migration, race end. */
async function load(db: Store, code: string, now: number): Promise<Loaded | { closed: 'gone' | 'idle' }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const l = parse(code, await db.hgetall(K.room(code)));
    if (!l) return { closed: 'gone' };
    const { cfg, players } = l.state;

    // A race in progress is never idle; it ends on its own (maybeEndRace's hard cap).
    if (cfg.phase !== 'racing' && now - cfg.active > IDLE_MS) {
      await destroy(db, code, players.map((p) => p.mid));
      return { closed: 'idle' };
    }

    const stale = players.filter((p) => now - p.seen > STALE_MS).map((p) => p.mid);
    if (stale.length) {
      const alive = players.filter((p) => !stale.includes(p.mid));
      if (!alive.length) {
        await destroy(db, code, players.map((p) => p.mid));
        return { closed: 'gone' };
      }
      await db.hdel(K.room(code), stale.flatMap(playerFields));
      await db.del(stale.map((m) => K.inbox(code, m)));
      l.state.players = alive;
    }

    const next: RoomCfg = { ...cfg };
    if (!l.state.players.some((p) => p.mid === next.host)) next.host = l.state.players[0].mid;
    maybeEndRace(l.state, next, now);
    if (await writeCfg(db, code, l, next)) {
      l.state.cfg = next;
      return l;
    }
  }
  throw new HttpError('room busy, retry', 409);
}

/** Back to the lobby once everyone on the grid has finished/retired/left, or time is up. */
function maybeEndRace(state: RoomState, next: RoomCfg, now: number, force = false) {
  if (next.phase !== 'racing') return;
  const byMid = new Map(state.players.map((p) => [p.mid, p]));
  const done = (mid: string) => {
    const p = byMid.get(mid);
    return !p || p.fin?.r === next.race;
  };
  const times = next.grid.map((g) => byMid.get(g.mid)?.fin).filter((f) => f?.r === next.race && f.ms != null).map((f) => f!.ms!);
  const firstFinishAt = times.length ? next.startAt + Math.min(...times) : Infinity;
  const hardCap = next.startAt + next.laps * 10 * 60_000 + 120_000;
  if (!force && !next.grid.every((g) => done(g.mid)) && now < firstFinishAt + FINISH_GRACE_MS && now < hardCap) return;
  next.last = raceResult({ cfg: next, players: state.players });
  next.phase = 'lobby';
  next.v++; // everyone readies up again
  next.active = now;
}

function me(l: Loaded, mid: string) {
  const p = l.state.players.find((x) => x.mid === mid);
  if (!p) throw new HttpError('not in this room', 403);
  return p;
}

// ---------- actions

function cleanTrack(t: any) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !TRACK_RE.test(t.id)) throw new HttpError('bad track');
  const center = t.center;
  if (!Array.isArray(center) || center.length !== 2 || !center.every((x: unknown) => typeof x === 'number' && isFinite(x))) throw new HttpError('bad track center');
  const pts = t.points;
  if (
    !Array.isArray(pts) || pts.length < 6 || pts.length > 4000 ||
    !pts.every((p: unknown) => Array.isArray(p) && p.length === 2 && Math.abs(p[0] - center[0]) < 0.05 && Math.abs(p[1] - center[1]) < 0.05)
  )
    throw new HttpError('bad track points');
  const lengthM = Number(t.lengthM);
  if (!(lengthM >= 100 && lengthM <= 10000)) throw new HttpError('bad track length');
  const txt = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  return {
    id: t.id,
    name: txt(t.name, 80) || 'Kart track',
    location: txt(t.location, 120),
    center: [center[0], center[1]],
    points: pts.map((p: number[]) => [+(+p[0]).toFixed(7), +(+p[1]).toFixed(7)]),
    width: Math.min(20, Math.max(4, Number(t.width) || 8)),
    lengthM: Math.round(lengthM),
    osmWays: Array.isArray(t.osmWays) ? t.osmWays.filter(Number.isInteger).slice(0, 60) : [],
    source: txt(t.source, 40) || 'OpenStreetMap',
  };
}

const cleanLaps = (n: unknown) => Math.min(LAPS_MAX, Math.max(LAPS_MIN, Math.round(Number(n) || LAPS_DEFAULT)));

function pickColor(wanted: string, taken: string[]) {
  const want = nearestLivery(cleanColor(wanted));
  if (!taken.includes(want)) return want;
  return KART_COLORS.find((c) => !taken.includes(c)) ?? want;
}

async function create(db: Store, mid: string, b: any, now: number) {
  if (!(await db.set(K.rate(mid), '1', { ex: 5, nx: true }))) throw new HttpError('slow down', 429);
  const track = cleanTrack(b.track);
  const dir = isDir(b.dir) ? b.dir : 'fwd';
  const time: RoomTime = isRoomTime(b.time) ? b.time : 'day';
  for (let i = 0; i < 6; i++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
    const cfg: RoomCfg = {
      code, host: mid, track: track.id, trackName: track.name, lengthM: track.lengthM, dir, laps: cleanLaps(b.laps), time, v: 1,
      phase: 'lobby', race: 0, startAt: 0, grid: [], created: now, active: now, last: null,
    };
    if (!(await db.hsetnx(K.room(code), 'cfg', JSON.stringify(cfg)))) continue; // code in use
    const profile = { name: cleanName(b.name), color: pickColor(b.color, []), joined: now };
    await Promise.all([
      db.hsetMany(K.room(code), { [`p:${mid}`]: JSON.stringify(profile), [`s:${mid}`]: String(now) }),
      db.set(K.trk(code), JSON.stringify(track), { ex: TRK_TTL_S }),
    ]);
    await db.expire(K.room(code), ROOM_TTL_S);
    const player: RoomPlayer = { mid, ...profile, seen: now, ready: 0, fin: null };
    return { now, state: { cfg, players: [player] }, mail: [], mailN: 0 } satisfies PollResponse;
  }
  throw new HttpError('could not allocate a room code', 503);
}

async function join(db: Store, code: string, mid: string, b: any, now: number): Promise<PollResponse> {
  const l = await load(db, code, now);
  if (!('state' in l)) throw new HttpError('room not found', 404);
  const { players, cfg } = l.state;
  const existing = players.find((p) => p.mid === mid);
  if (!existing && players.length >= ROOM_MAX) throw new HttpError('room is full', 409);
  const color = pickColor(b.color, players.filter((p) => p.mid !== mid).map((p) => p.color));
  const profile = { name: cleanName(b.name), color, joined: existing?.joined ?? now };
  await db.hsetMany(K.room(code), { [`p:${mid}`]: JSON.stringify(profile), [`s:${mid}`]: String(now) });
  // A (re)joining page has no use for signals sent to its previous incarnation.
  await Promise.all([db.hdel(K.room(code), [`k:${mid}`]), db.expire(K.room(code), ROOM_TTL_S), db.del([K.inbox(code, mid)])]);
  if (!existing) {
    players.push({ mid, ...profile, seen: now, ready: 0, fin: null });
    // Joining counts as activity, so a room people keep coming back to stays open.
    const next = { ...cfg, active: now };
    if (await writeCfg(db, code, l, next)) l.state.cfg = next;
  } else Object.assign(existing, profile, { seen: now });
  return { now, state: l.state, mail: [], mailN: Number(l.hash[`m:${mid}`] ?? 0) };
}

async function poll(db: Store, code: string, mid: string, b: any, now: number): Promise<PollResponse> {
  const l = await load(db, code, now);
  if (!('state' in l)) return { now, state: null, closed: l.closed, mail: [], mailN: 0 };
  const inRoom = l.state.players.some((p) => p.mid === mid);
  if (!inRoom && l.hash[`k:${mid}`]) return { now, state: null, closed: 'kicked', mail: [], mailN: 0 };
  const work: Promise<unknown>[] = [];
  if (inRoom && b.hb) {
    work.push(db.hsetMany(K.room(code), { [`s:${mid}`]: String(now) }), db.expire(K.room(code), ROOM_TTL_S));
    const p = l.state.players.find((x) => x.mid === mid)!;
    p.seen = now;
  }
  const stored = Number(l.hash[`m:${mid}`] ?? 0);
  const seenN = Number(b.mailN) || 0;
  let mail: SignalMsg[] = [];
  let mailN = stored;
  if (inRoom && stored > seenN) {
    const popped = await db.lpop(K.inbox(code, mid), 20);
    mail = popped.map((m) => JSON.parse(m));
    if (popped.length === 20) mailN = seenN + popped.length; // more waiting: fetch again next poll
  }
  await Promise.all(work);
  return { now, state: l.state, mail, mailN };
}

async function leave(db: Store, code: string, mid: string, now: number) {
  const l = await load(db, code, now);
  if (!('state' in l)) return;
  const rest = l.state.players.filter((p) => p.mid !== mid);
  if (!rest.length) return destroy(db, code, [mid]);
  await db.hdel(K.room(code), playerFields(mid));
  await db.del([K.inbox(code, mid)]);
  l.state.players = rest;
  for (let i = 0; i < 3; i++) {
    const next = { ...l.state.cfg };
    if (next.host === mid) next.host = nextHost(rest, [mid])!;
    maybeEndRace(l.state, next, now);
    if (await writeCfg(db, code, l, next)) return;
    const again = await load(db, code, now);
    if (!('state' in again)) return;
    Object.assign(l, again);
  }
}

/** Tab closed or reloading: drop the player in a few seconds unless they rejoin (a reload does). */
async function softLeave(db: Store, code: string, mid: string, now: number) {
  const exists = await db.hmget(K.room(code), [`p:${mid}`]);
  if (exists[0]) await db.hsetMany(K.room(code), { [`s:${mid}`]: String(now - STALE_MS + 8000) });
}

async function signal(db: Store, code: string, mid: string, b: any, now: number) {
  const to = String(b.to ?? '');
  if (!MID_RE.test(to) || (b.k !== 'offer' && b.k !== 'answer') || typeof b.sdp !== 'string' || b.sdp.length > 16_000) throw new HttpError('bad signal');
  const l = await load(db, code, now);
  if (!('state' in l)) throw new HttpError('room not found', 404);
  me(l, mid);
  if (!l.state.players.some((p) => p.mid === to)) throw new HttpError('peer not in room', 404);
  const msg: SignalMsg = { from: mid, k: b.k, id: Number(b.id) || 0, sdp: b.sdp };
  await db.rpush(K.inbox(code, to), JSON.stringify(msg));
  await Promise.all([db.expire(K.inbox(code, to), ROOM_TTL_S), db.hincrby(K.room(code), `m:${to}`, 1)]);
  return { ok: true, now };
}

async function relay(db: Store, code: string, mid: string, b: any, now: number) {
  const pose = b.pose;
  if (pose != null && (!Array.isArray(pose) || pose.length !== 10 || !pose.every((x: unknown) => typeof x === 'number' && isFinite(x)))) throw new HttpError('bad pose');
  const want: string[] = Array.isArray(b.want) ? b.want.filter((m: unknown) => typeof m === 'string' && MID_RE.test(m)).slice(0, ROOM_MAX) : [];
  const [, got] = await Promise.all([
    pose ? db.set(K.relay(code, mid), JSON.stringify(pose), { ex: 5 }) : null,
    db.mget(want.map((m) => K.relay(code, m))),
  ]);
  const poses: Record<string, unknown> = {};
  want.forEach((m, i) => got[i] && (poses[m] = JSON.parse(got[i]!)));
  return { now, poses };
}

/** Actions that change the room: ready, profile, config, start, finish, kick, end. */
async function mutate(db: Store, code: string, mid: string, b: any, now: number): Promise<PollResponse> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const l = await load(db, code, now);
    if (!('state' in l)) throw new HttpError('room not found', 404);
    const self = me(l, mid);
    const { cfg, players } = l.state;
    const isHost = cfg.host === mid;
    const hostOnly = () => {
      if (!isHost) throw new HttpError('only the host can do that', 403);
    };
    const mailN = Number(l.hash[`m:${mid}`] ?? 0);
    const done = (): PollResponse => ({ now, state: l.state, mail: [], mailN });

    switch (b.a) {
      case 'ready': {
        if (cfg.phase !== 'lobby') throw new HttpError('race in progress', 409);
        self.ready = b.ready ? cfg.v : 0;
        await db.hsetMany(K.room(code), { [`r:${mid}`]: String(self.ready) });
        return done();
      }
      case 'profile': {
        const want = nearestLivery(cleanColor(b.color));
        self.name = cleanName(b.name);
        if (!players.some((p) => p.mid !== mid && p.color === want)) self.color = want; // colours stay unique
        await db.hsetMany(K.room(code), { [`p:${mid}`]: JSON.stringify({ name: self.name, color: self.color, joined: self.joined }) });
        return done();
      }
      case 'finish': {
        const ms = b.ms === null ? null : Math.round(Number(b.ms));
        if (cfg.phase !== 'racing' || Number(b.race) !== cfg.race || !cfg.grid.some((g) => g.mid === mid)) throw new HttpError('not racing', 409);
        if (self.fin?.r === cfg.race) return done(); // already recorded
        if (ms !== null && (!(ms > 0) || ms < ((cfg.lengthM * cfg.laps) / KART_TOP_SPEED) * 1000 || ms > 2 * 3600_000))
          throw new HttpError('implausible race time', 422);
        self.fin = { r: cfg.race, ms };
        await db.hsetMany(K.room(code), { [`f:${mid}`]: JSON.stringify(self.fin) });
        const next = { ...cfg };
        maybeEndRace(l.state, next, now);
        if (await writeCfg(db, code, l, next)) l.state.cfg = next;
        return done();
      }
      case 'config': {
        hostOnly();
        if (cfg.phase !== 'lobby') throw new HttpError('race in progress', 409);
        const next = { ...cfg, v: cfg.v + 1, active: now };
        if (b.track) {
          const t = cleanTrack(b.track);
          await db.set(K.trk(code), JSON.stringify(t), { ex: TRK_TTL_S });
          Object.assign(next, { track: t.id, trackName: t.name, lengthM: t.lengthM });
        }
        if (b.dir !== undefined) next.dir = isDir(b.dir) ? b.dir : cfg.dir;
        if (b.laps !== undefined) next.laps = cleanLaps(b.laps);
        if (b.time !== undefined) next.time = isRoomTime(b.time) ? b.time : roomTime(cfg);
        if (!(await writeCfg(db, code, l, next))) continue;
        l.state.cfg = next;
        return done();
      }
      case 'start': {
        hostOnly();
        if (cfg.phase !== 'lobby') throw new HttpError('race already started', 409);
        const waiting = players.filter((p) => p.mid !== mid && !isReady(p, cfg));
        if (waiting.length) throw new HttpError(`waiting for ${waiting.map((p) => p.name).join(', ')}`, 409);
        const grid = players.map((p) => ({ mid: p.mid, name: p.name, color: p.color }));
        for (let i = grid.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [grid[i], grid[j]] = [grid[j], grid[i]];
        }
        const next: RoomCfg = { ...cfg, phase: 'racing', race: cfg.race + 1, startAt: now + START_DELAY_MS, grid, active: now };
        if (!(await writeCfg(db, code, l, next))) continue;
        await db.expire(K.trk(code), TRK_TTL_S);
        l.state.cfg = next;
        return done();
      }
      case 'end': {
        hostOnly();
        const next = { ...cfg };
        maybeEndRace(l.state, next, now, true);
        if (!(await writeCfg(db, code, l, next))) continue;
        l.state.cfg = next;
        return done();
      }
      case 'kick': {
        hostOnly();
        const who = String(b.mid ?? '');
        if (who === mid || !players.some((p) => p.mid === who)) throw new HttpError('bad player');
        await db.hdel(K.room(code), playerFields(who));
        await Promise.all([db.hsetMany(K.room(code), { [`k:${who}`]: '1' }), db.del([K.inbox(code, who)])]);
        l.state.players = players.filter((p) => p.mid !== who);
        const next = { ...cfg };
        maybeEndRace(l.state, next, now);
        if (await writeCfg(db, code, l, next)) l.state.cfg = next;
        return done();
      }
      default:
        throw new HttpError('bad action');
    }
  }
  throw new HttpError('room busy, retry', 409);
}
