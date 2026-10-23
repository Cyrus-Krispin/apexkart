// Phone-as-wheel pairings: a screen (the game) and one phone, joined by a 4-character code.
// This endpoint only introduces the two and relays their WebRTC offer/answer; steering itself goes
// over a data channel between them (src/net/pad.ts, on the multiplayer mesh).
//
// POST /api/pad  { a: 'create' | 'join' | 'poll' | 'signal' | 'leave', code, s: secret, ... }
//
// Redis layout (all keys expire PAD_TTL_S after the last heartbeat):
//   ak:pad:{code}            hash: h screen {mid, joined}, c phone {mid, joined}, s:{mid} last seen,
//                                  m:{mid} signal count
//   ak:pad:{code}:in:{mid}   list: pending signaling messages for mid
import { getStore, json, bad, publicId, type Store } from './_lib/store.js';
import { CODE_ALPHABET, CODE_RE, MID_RE, SECRET_RE, type SignalMsg } from '../src/shared/room.js';
import { PAD_TTL_S, PAD_STALE_MS, type PadMember, type PadPollResponse } from '../src/shared/pad.js';

const K = {
  pad: (c: string) => `ak:pad:${c}`,
  inbox: (c: string, mid: string) => `ak:pad:${c}:in:${mid}`,
  rate: (mid: string) => `ak:rl:pad:${mid}`,
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
  host: PadMember;
  pad: PadMember | null;
  hash: Record<string, string>;
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 40_000) return bad('payload too large', 413);
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
    if (b.a === 'create') return json(await create(db, mid, now));
    const code = String(b.code ?? '').toUpperCase();
    if (!CODE_RE.test(code)) return bad('bad code');
    switch (b.a) {
      case 'join':
        return json(await join(db, code, mid, now));
      case 'poll':
        return json(await poll(db, code, mid, b, now));
      case 'signal':
        return json(await signal(db, code, mid, b, now));
      case 'leave':
        await leave(db, code, mid);
        return json({ ok: true, now });
      default:
        return bad('bad action');
    }
  } catch (e) {
    if (e instanceof HttpError) return bad(e.message, e.status);
    throw e;
  }
}

const members = (l: Loaded) => (l.pad ? [l.host, l.pad] : [l.host]);
const seen = (l: Loaded, m: PadMember) => Number(l.hash[`s:${m.mid}`] ?? m.joined);

async function destroy(db: Store, code: string, l: Loaded) {
  await db.del([K.pad(code), ...members(l).map((m) => K.inbox(code, m.mid))]);
}

/** Load a pairing and drop whoever has gone quiet (a silent screen closes it). */
async function load(db: Store, code: string, now: number): Promise<Loaded | null> {
  const hash = await db.hgetall(K.pad(code));
  if (!hash.h) return null;
  const l: Loaded = { host: JSON.parse(hash.h), pad: hash.c ? JSON.parse(hash.c) : null, hash };
  if (now - seen(l, l.host) > PAD_STALE_MS) {
    await destroy(db, code, l);
    return null;
  }
  if (l.pad && now - seen(l, l.pad) > PAD_STALE_MS) await dropPad(db, code, l);
  return l;
}

async function dropPad(db: Store, code: string, l: Loaded) {
  if (!l.pad) return;
  const mid = l.pad.mid;
  await db.hdel(K.pad(code), ['c', `s:${mid}`, `m:${mid}`]);
  await db.del([K.inbox(code, mid)]);
  l.pad = null;
}

function response(l: Loaded, mid: string, now: number, mail: SignalMsg[] = [], mailN?: number): PadPollResponse {
  return { now, members: members(l), mail, mailN: mailN ?? Number(l.hash[`m:${mid}`] ?? 0) };
}

async function create(db: Store, mid: string, now: number): Promise<PadPollResponse> {
  if (!(await db.set(K.rate(mid), '1', { ex: 3, nx: true }))) throw new HttpError('slow down', 429);
  for (let i = 0; i < 6; i++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
    const host = { mid, joined: now };
    if (!(await db.hsetnx(K.pad(code), 'h', JSON.stringify(host)))) continue; // code in use
    await db.hsetMany(K.pad(code), { [`s:${mid}`]: String(now) });
    await db.expire(K.pad(code), PAD_TTL_S);
    return { now, members: [host], mail: [], mailN: 0, code };
  }
  throw new HttpError('could not allocate a code', 503);
}

/** The phone takes the wheel. A different phone joining later replaces it (the old one is told on its next poll). */
async function join(db: Store, code: string, mid: string, now: number): Promise<PadPollResponse> {
  const l = await load(db, code, now);
  if (!l) throw new HttpError('no screen is waiting for that code', 404);
  if (l.host.mid === mid) throw new HttpError('open the code on your phone, not on the game’s screen', 409);
  if (l.pad && l.pad.mid !== mid) await dropPad(db, code, l);
  const pad = { mid, joined: l.pad?.joined ?? now };
  await db.hsetMany(K.pad(code), { c: JSON.stringify(pad), [`s:${mid}`]: String(now), [`m:${mid}`]: '0' });
  // A (re)joining page has no use for signals sent to its previous incarnation.
  await Promise.all([db.del([K.inbox(code, mid)]), db.expire(K.pad(code), PAD_TTL_S)]);
  l.pad = pad;
  return response(l, mid, now, [], 0);
}

async function poll(db: Store, code: string, mid: string, b: any, now: number): Promise<PadPollResponse> {
  const l = await load(db, code, now);
  if (!l) return { now, members: null, closed: 'gone', mail: [], mailN: 0 };
  const inside = l.host.mid === mid || l.pad?.mid === mid;
  if (!inside && l.pad) return { now, members: null, closed: 'replaced', mail: [], mailN: 0 };
  // Not in it but the wheel is free (a phone dropped for being quiet): the client joins again.
  if (!inside) return response(l, mid, now, [], 0);
  const work: Promise<unknown>[] = [];
  if (b.hb) work.push(db.hsetMany(K.pad(code), { [`s:${mid}`]: String(now) }), db.expire(K.pad(code), PAD_TTL_S));
  const stored = Number(l.hash[`m:${mid}`] ?? 0);
  const seenN = Number(b.mailN) || 0;
  let mail: SignalMsg[] = [];
  let mailN = stored;
  if (stored > seenN) {
    const popped = await db.lpop(K.inbox(code, mid), 20);
    mail = popped.map((m) => JSON.parse(m));
    if (popped.length === 20) mailN = seenN + popped.length; // more waiting: fetch again next poll
  }
  await Promise.all(work);
  return response(l, mid, now, mail, mailN);
}

async function signal(db: Store, code: string, mid: string, b: any, now: number) {
  const to = String(b.to ?? '');
  if (!MID_RE.test(to) || (b.k !== 'offer' && b.k !== 'answer') || typeof b.sdp !== 'string' || b.sdp.length > 16_000) throw new HttpError('bad signal');
  const l = await load(db, code, now);
  if (!l) throw new HttpError('pairing not found', 404);
  const ids = members(l).map((m) => m.mid);
  if (!ids.includes(mid) || !ids.includes(to) || to === mid) throw new HttpError('not paired', 403);
  const msg: SignalMsg = { from: mid, k: b.k, id: Number(b.id) || 0, sdp: b.sdp };
  await db.rpush(K.inbox(code, to), JSON.stringify(msg));
  await Promise.all([db.expire(K.inbox(code, to), PAD_TTL_S), db.hincrby(K.pad(code), `m:${to}`, 1)]);
  return { ok: true, now };
}

/** The screen leaving closes the pairing; the phone leaving frees the wheel for another phone. */
async function leave(db: Store, code: string, mid: string) {
  const hash = await db.hgetall(K.pad(code));
  if (!hash.h) return;
  const l: Loaded = { host: JSON.parse(hash.h), pad: hash.c ? JSON.parse(hash.c) : null, hash };
  if (l.host.mid === mid) await destroy(db, code, l);
  else if (l.pad?.mid === mid) await dropPad(db, code, l);
}
