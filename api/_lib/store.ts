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
}

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
    hmget: async (k, fs) => fs.map((f) => db.get(k)?.get(f) ?? null),
    hgetall: async (k) => Object.fromEntries(db.get(k) ?? []),
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

export function cleanColor(s: unknown): string {
  return /^#[0-9a-f]{6}$/i.test(String(s)) ? String(s) : '#ff5a1f';
}
