// Minimal key-value surface the leaderboard needs, backed by Upstash Redis in
// production and an in-memory map for local development.
import { Redis } from '@upstash/redis';

export interface Store {
  kind: 'redis' | 'memory';
  zadd(key: string, score: number, member: string): Promise<void>;
  zscore(key: string, member: string): Promise<number | null>;
  zrank(key: string, member: string): Promise<number | null>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<{ member: string; score: number }[]>;
  zremrangebyscore(key: string, min: number, max: number): Promise<void>;
  hset(key: string, field: string, value: string): Promise<void>;
  hmget(key: string, fields: string[]): Promise<(string | null)[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<boolean>;
  get(key: string): Promise<string | null>;
  lpush(key: string, value: string, keep: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  // Used by multiplayer rooms (api/room.ts).
  hsetMany(key: string, fields: Record<string, string>): Promise<void>;
  hsetnx(key: string, field: string, value: string): Promise<boolean>;
  hdel(key: string, fields: string[]): Promise<void>;
  hincrby(key: string, field: string, by: number): Promise<number>;
  /** Atomically set `field` to `next` only if it currently equals `prev`. */
  hcas(key: string, field: string, prev: string, next: string): Promise<boolean>;
  expire(key: string, seconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
  rpush(key: string, value: string): Promise<void>;
  lpop(key: string, count: number): Promise<string[]>;
  mget(keys: string[]): Promise<(string | null)[]>;
}

const CAS_LUA = `if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) return 1 end return 0`;
const str = (v: unknown) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

function redisStore(url: string, token: string): Store {
  const r = new Redis({ url, token, automaticDeserialization: false });
  return {
    kind: 'redis',
    async zadd(k, s, m) {
      await r.zadd(k, { score: s, member: m });
    },
    zscore: async (k, m) => {
      const v = await r.zscore(k, m);
      return v == null ? null : Number(v);
    },
    zrank: (k, m) => r.zrank(k, m),
    zcard: (k) => r.zcard(k),
    async zrange(k, a, b) {
      const flat = (await r.zrange(k, a, b, { withScores: true })) as (string | number)[];
      const out: { member: string; score: number }[] = [];
      for (let i = 0; i < flat.length; i += 2) out.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
      return out;
    },
    async zremrangebyscore(k, min, max) {
      await r.zremrangebyscore(k, min, max);
    },
    async hset(k, f, v) {
      await r.hset(k, { [f]: v });
    },
    async hmget(k, fs) {
      if (!fs.length) return [];
      // With automaticDeserialization off, Upstash returns the raw array; accept either shape.
      const res = (await r.hmget(k, ...fs)) as unknown;
      const vals = Array.isArray(res) ? res : fs.map((f) => (res as Record<string, unknown> | null)?.[f] ?? null);
      return vals.map((v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v)));
    },
    async hgetall(k) {
      const res = (await r.hgetall(k)) as unknown;
      const out: Record<string, string> = {};
      if (Array.isArray(res)) for (let i = 0; i + 1 < res.length; i += 2) out[String(res[i])] = String(res[i + 1]);
      else for (const [f, v] of Object.entries((res as Record<string, unknown>) ?? {})) out[f] = typeof v === 'string' ? v : JSON.stringify(v);
      return out;
    },
    async set(k, v, o) {
      const res = o?.nx ? await r.set(k, v, o.ex ? { nx: true, ex: o.ex } : { nx: true }) : await r.set(k, v, o?.ex ? { ex: o.ex } : undefined);
      return res === 'OK';
    },
    get: (k) => r.get<string>(k),
    async lpush(k, v, keep) {
      const p = r.pipeline();
      p.lpush(k, v);
      p.ltrim(k, 0, keep - 1);
      await p.exec();
    },
    lrange: (k, a, b) => r.lrange(k, a, b),
    async hsetMany(k, f) {
      await r.hset(k, f);
    },
    hsetnx: async (k, f, v) => (await r.hsetnx(k, f, v)) === 1,
    async hdel(k, fs) {
      if (fs.length) await r.hdel(k, ...fs);
    },
    hincrby: (k, f, by) => r.hincrby(k, f, by),
    hcas: async (k, f, prev, next) => Number(await r.eval(CAS_LUA, [k], [f, prev, next])) === 1,
    async expire(k, sec) {
      await r.expire(k, sec);
    },
    async del(ks) {
      if (ks.length) await r.del(...ks);
    },
    async rpush(k, v) {
      await r.rpush(k, v);
    },
    async lpop(k, n) {
      const res = (await r.lpop(k, n)) as unknown;
      return res == null ? [] : (Array.isArray(res) ? res : [res]).map((v) => str(v)!);
    },
    async mget(ks) {
      if (!ks.length) return [];
      const res = (await r.mget(...ks)) as unknown[];
      return res.map(str);
    },
  };
}

function memoryStore(): Store {
  const g = globalThis as any;
  const db: Map<string, any> = (g.__akdb ??= new Map());
  const expiry: Map<string, number> = (g.__akexp ??= new Map());
  const live = (k: string) => {
    const e = expiry.get(k);
    if (e && e < Date.now()) {
      db.delete(k);
      expiry.delete(k);
    }
    return db.get(k);
  };
  const zset = (k: string): Map<string, number> => {
    if (!db.has(k)) db.set(k, new Map());
    return db.get(k);
  };
  const sorted = (k: string) => [...zset(k)].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  return {
    kind: 'memory',
    async zadd(k, s, m) {
      zset(k).set(m, s);
    },
    zscore: async (k, m) => zset(k).get(m) ?? null,
    zrank: async (k, m) => {
      const i = sorted(k).findIndex(([x]) => x === m);
      return i < 0 ? null : i;
    },
    zcard: async (k) => zset(k).size,
    zrange: async (k, a, b) => {
      const s = sorted(k);
      return s.slice(a, b < 0 ? s.length + b + 1 : b + 1).map(([member, score]) => ({ member, score }));
    },
    async zremrangebyscore(k, min, max) {
      for (const [m, s] of zset(k)) if (s >= min && s <= max) zset(k).delete(m);
    },
    async hset(k, f, v) {
      if (!db.has(k)) db.set(k, new Map());
      db.get(k).set(f, v);
    },
    hmget: async (k, fs) => fs.map((f) => live(k)?.get(f) ?? null),
    hgetall: async (k) => Object.fromEntries(live(k) ?? []),
    async set(k, v, o) {
      if (o?.nx && live(k) !== undefined) return false;
      db.set(k, v);
      if (o?.ex) expiry.set(k, Date.now() + o.ex * 1000);
      else expiry.delete(k);
      return true;
    },
    get: async (k) => live(k) ?? null,
    async lpush(k, v, keep) {
      const l: string[] = db.get(k) ?? [];
      l.unshift(v);
      db.set(k, l.slice(0, keep));
    },
    lrange: async (k, a, b) => (db.get(k) ?? []).slice(a, b < 0 ? undefined : b + 1),
    async hsetMany(k, f) {
      live(k);
      if (!db.has(k)) db.set(k, new Map());
      for (const [x, v] of Object.entries(f)) db.get(k).set(x, v);
    },
    async hsetnx(k, f, v) {
      live(k);
      if (!db.has(k)) db.set(k, new Map());
      if (db.get(k).has(f)) return false;
      db.get(k).set(f, v);
      return true;
    },
    async hdel(k, fs) {
      const h: Map<string, string> | undefined = live(k);
      fs.forEach((f) => h?.delete(f));
      if (h && !h.size) db.delete(k);
    },
    async hincrby(k, f, by) {
      live(k);
      if (!db.has(k)) db.set(k, new Map());
      const n = Number(db.get(k).get(f) ?? 0) + by;
      db.get(k).set(f, String(n));
      return n;
    },
    async hcas(k, f, prev, next) {
      const h: Map<string, string> | undefined = live(k);
      if (h?.get(f) !== prev) return false;
      h.set(f, next);
      return true;
    },
    async expire(k, sec) {
      if (live(k) !== undefined) expiry.set(k, Date.now() + sec * 1000);
    },
    async del(ks) {
      ks.forEach((k) => {
        db.delete(k);
        expiry.delete(k);
      });
    },
    async rpush(k, v) {
      const l: string[] = live(k) ?? [];
      l.push(v);
      db.set(k, l);
    },
    async lpop(k, n) {
      const l: string[] = live(k) ?? [];
      const out = l.splice(0, n);
      if (!l.length) db.delete(k);
      return out;
    },
    mget: async (ks) => ks.map((k) => live(k) ?? null),
  };
}

let store: Store | null = null;

export function getStore(): Store {
  if (store) return store;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  store = url && token ? redisStore(url, token) : memoryStore();
  return store;
}

// ---------- helpers shared by the endpoints

export const K = {
  board: (t: string, d: string) => `ak:lb:${t}:${d}`,
  pb: (t: string, d: string) => `ak:pb:${t}:${d}`,
  ghost: (t: string, d: string, pid: string) => `ak:ghost:${t}:${d}:${pid}`,
  track: (t: string) => `ak:track:${t}`,
  live: (t: string, d: string) => `ak:live:${t}:${d}`,
  liveAll: 'ak:live:all',
  names: 'ak:names',
  /** The daily circuit's board for one UTC day: pid -> best lap ms that day. */
  daily: (day: string) => `ak:daily:${day}`,
  /** track id -> {name, center}: lets the live feed say where drivers are, even before a lap. */
  trackInfo: 'ak:trackinfo',
  records: 'ak:records',
  feed: 'ak:feed',
  rate: (pid: string) => `ak:rl:${pid}`,
};

export const LIVE_WINDOW_MS = 15000;

export function json(data: unknown, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  });
}

export function bad(msg: string, status = 400) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });
}

export const TRACK_RE = /^[a-z0-9_-]{3,200}$/i;
export const PID_RE = /^[0-9a-f]{12}$/;
export const isDir = (d: unknown): d is 'fwd' | 'rev' => d === 'fwd' || d === 'rev';

export async function publicId(driverId: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(driverId));
  return [...new Uint8Array(buf)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function cleanName(s: unknown): string {
  return (
    String(s ?? '')
      .replace(/[^\p{L}\p{N} _.\-]/gu, '')
      .trim()
      .slice(0, 16) || 'Driver'
  );
}

export function cleanTrackName(s: unknown): string {
  return String(s ?? '')
    .replace(/[\p{C}<>]/gu, '')
    .trim()
    .slice(0, 80);
}

/** "lat,lon" -> [lat, lon], or null if it isn't a plausible coordinate. */
export function parseCenter(s: unknown): [number, number] | null {
  const [la, lo] = String(s ?? '').split(',').map(Number);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [+la.toFixed(5), +lo.toFixed(5)] : null;
}

export function cleanColor(s: unknown): string {
  return /^#[0-9a-f]{6}$/i.test(String(s)) ? String(s) : '#ff5a1f';
}
