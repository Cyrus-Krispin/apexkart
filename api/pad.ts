// Phone controller pairing: a screen opens a short code, a phone joins it, and the two swap one
// WebRTC offer and answer through here (non-trickle ICE, as in api/room.ts). After that the
// steering goes straight from the phone to the screen; this endpoint only introduces them.
//
// POST /api/pad  { a: open | join | signal | poll | close, s: secret, code, ... }
//
// Redis layout (expires PAD_TTL_S after the screen's last poll):
//   ak:pad:{code}           hash: scr = screen's mid, pad = phone's mid
//   ak:pad:{code}:in:{mid}  list: pending offers/answers for mid
import { getStore, json, bad, publicId, type Store } from './_lib/store.js';
import { CODE_ALPHABET, CODE_RE, SECRET_RE } from '../src/shared/room.js';
import { PAD_TTL_S, type PadPollResponse } from '../src/shared/pad.js';
import type { SignalMsg } from '../src/shared/room.js';

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
  const code = String(b.code ?? '').toUpperCase();
  try {
    if (b.a === 'open') return json(await open(db, mid, code, now));
    if (!CODE_RE.test(code)) return bad('bad code');
    switch (b.a) {
      case 'join':
        return json(await join(db, code, mid, !!b.again, now));
      case 'signal':
        return json(await signal(db, code, mid, b, now));
      case 'poll':
        return json(await poll(db, code, mid, now));
      case 'close':
        await close(db, code, mid);
        return json({ ok: true, now });
      default:
        return bad('bad action');
    }
  } catch (e) {
    if (e instanceof HttpError) return bad(e.message, e.status);
    throw e;
  }
}

/** Screen: keep its code if it still holds it (a dropped link), otherwise open a fresh one. */
async function open(db: Store, mid: string, code: string, now: number) {
  if (CODE_RE.test(code)) {
    const [scr] = await db.hmget(K.pad(code), ['scr']);
    if (scr === mid) {
      await db.expire(K.pad(code), PAD_TTL_S);
      return { now, code };
    }
  }
  if (!(await db.set(K.rate(mid), '1', { ex: 2, nx: true }))) throw new HttpError('slow down', 429);
  for (let i = 0; i < 6; i++) {
    const c = Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
    if (!(await db.hsetnx(K.pad(c), 'scr', mid))) continue; // in use
    await db.expire(K.pad(c), PAD_TTL_S);
    return { now, code: c };
  }
  throw new HttpError('could not allocate a code', 503);
}

async function load(db: Store, code: string) {
  const h = await db.hgetall(K.pad(code));
  return h.scr ? h : null;
}

/**
 * Phone: the newest phone to scan the code is the controller. A phone reconnecting (`again`) after
 * a dropped link doesn't take it back from one that scanned since.
 */
async function join(db: Store, code: string, mid: string, again: boolean, now: number) {
  const h = await load(db, code);
  if (!h) throw new HttpError('That code has closed.', 404);
  if (h.scr === mid) throw new HttpError('That is the game’s own code.', 409);
  if (again && h.pad && h.pad !== mid) throw new HttpError('Another phone took over.', 409);
  await Promise.all([db.hsetMany(K.pad(code), { pad: mid }), db.del([K.inbox(code, mid)])]);
  return { now };
}

async function signal(db: Store, code: string, mid: string, b: any, now: number) {
  if ((b.k !== 'offer' && b.k !== 'answer') || typeof b.sdp !== 'string' || b.sdp.length > 16_000) throw new HttpError('bad signal');
  const h = await load(db, code);
  if (!h) throw new HttpError('code expired', 404);
  const to = mid === h.scr ? h.pad : mid === h.pad ? h.scr : null;
  if (!to) throw new HttpError('not paired with this code', 403);
  const msg: SignalMsg = { from: mid, k: b.k, id: Number(b.id) || 0, sdp: b.sdp };
  await db.rpush(K.inbox(code, to), JSON.stringify(msg));
  await db.expire(K.inbox(code, to), PAD_TTL_S);
  return { ok: true, now };
}

/** Either side: pending signals. The screen's polls keep the code alive. */
async function poll(db: Store, code: string, mid: string, now: number): Promise<PadPollResponse> {
  const h = await load(db, code);
  if (!h) return { now, open: false, pad: null, mail: [] };
  if (h.scr !== mid && h.pad !== mid) return { now, open: false, pad: h.pad ?? null, mail: [] }; // another phone took over
  const [popped] = await Promise.all([db.lpop(K.inbox(code, mid), 10), h.scr === mid ? db.expire(K.pad(code), PAD_TTL_S) : null]);
  return { now, open: true, pad: h.pad ?? null, mail: popped.map((m) => JSON.parse(m) as SignalMsg) };
}

/** The screen closes its code; a phone just lets go of it. */
async function close(db: Store, code: string, mid: string) {
  const h = await load(db, code);
  if (!h) return;
  if (h.scr === mid) await db.del([K.pad(code), K.inbox(code, h.scr), ...(h.pad ? [K.inbox(code, h.pad)] : [])]);
  else if (h.pad === mid) await Promise.all([db.hdel(K.pad(code), ['pad']), db.del([K.inbox(code, mid)])]);
}
