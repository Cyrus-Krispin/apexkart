// OpenStreetMap -> raceable track loops.
// Shared between the browser (live "find tracks here") and scripts/fetch-tracks.ts.

export type LatLon = [number, number];

export interface TrackData {
  id: string;
  name: string;
  location: string;
  center: LatLon;
  points: LatLon[]; // closed loop centreline, first point is not repeated
  width: number; // metres
  lengthM: number;
  osmWays: number[];
  source: string;
  preset?: boolean;
}

interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Overpass is a shared, often-busy service: rotate mirrors, time out, and back off. */
export async function overpass(query: string, signal?: AbortSignal): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text);
      lastErr = new Error(`Overpass ${res.status}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    await new Promise((r) => setTimeout(r, Math.min(3000, 500 * 2 ** attempt)));
  }
  throw lastErr;
}

export function distM(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const x = dLon * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.sqrt(x * x + dLat * dLat) * R;
}

export function loopLength(pts: LatLon[]): number {
  let L = 0;
  for (let i = 0; i < pts.length; i++) L += distM(pts[i], pts[(i + 1) % pts.length]);
  return L;
}

function isRaceable(w: OsmWay): boolean {
  const t = w.tags ?? {};
  if (t.raceway === 'pitlane' || /pit/i.test(t.name ?? '')) return false;
  if (t.aerialway || t.area === 'yes') return false;
  if (t.sport && !['karting', 'motor', 'motorsport', 'racing'].includes(t.sport)) return false;
  return w.nodes?.length >= 2;
}

interface Segment {
  a: number; // junction node id
  b: number;
  nodes: number[]; // a ... b
  ways: Set<number>;
  oneway: number; // +1 if any oneway way runs a->b, -1 if b->a, 0 unknown
  len: number;
}

export interface Loop {
  nodes: number[];
  points: LatLon[];
  ways: number[];
  lengthM: number;
}

/**
 * Turn a soup of raceway ways into closed loops. Ways are split at junction
 * nodes into segments, then simple cycles in the junction graph are enumerated;
 * each cycle is a candidate layout (karting tracks often have several).
 */
export function findLoops(elements: any[], maxLoops = 4): Loop[] {
  const ways = (elements.filter((e) => e.type === 'way') as OsmWay[]).filter(isRaceable);
  const coord = new Map<number, LatLon>();
  const adj = new Map<number, { to: number; way: OsmWay; fwd: boolean }[]>();
  const link = (a: number, b: number, way: OsmWay, fwd: boolean) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ to: b, way, fwd });
  };
  for (const w of ways) {
    w.nodes.forEach((n, i) => coord.set(n, [w.geometry[i].lat, w.geometry[i].lon]));
    for (let i = 0; i + 1 < w.nodes.length; i++) {
      if (w.nodes[i] === w.nodes[i + 1]) continue;
      link(w.nodes[i], w.nodes[i + 1], w, true);
      link(w.nodes[i + 1], w.nodes[i], w, false);
    }
  }

  // Junctions: anything that isn't a simple pass-through node.
  const junction = new Set<number>();
  for (const [n, e] of adj) if (e.length !== 2) junction.add(n);
  // Pure rings have no junctions: pick one node per ring as an anchor.
  const seen = new Set<number>();
  for (const n of adj.keys()) {
    if (seen.has(n)) continue;
    const stack = [n];
    let hasJ = false;
    const comp: number[] = [];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      comp.push(c);
      if (junction.has(c)) hasJ = true;
      for (const e of adj.get(c)!) stack.push(e.to);
    }
    if (!hasJ) junction.add(comp[0]);
  }

  // Walk segments between junctions.
  const segments: Segment[] = [];
  const usedEdge = new Set<string>();
  const ek = (a: number, b: number, w: number) => `${a}>${b}@${w}`;
  for (const j of junction) {
    for (const first of adj.get(j)!) {
      if (usedEdge.has(ek(j, first.to, first.way.id))) continue;
      const nodes = [j];
      const segWays = new Set<number>();
      let oneway = 0;
      let len = 0;
      let prev = j;
      let edge = first;
      while (true) {
        usedEdge.add(ek(prev, edge.to, edge.way.id));
        usedEdge.add(ek(edge.to, prev, edge.way.id));
        segWays.add(edge.way.id);
        if (edge.way.tags?.oneway === 'yes') oneway += edge.fwd ? 1 : -1;
        len += distM(coord.get(prev)!, coord.get(edge.to)!);
        nodes.push(edge.to);
        if (junction.has(edge.to)) break;
        const next = adj.get(edge.to)!.find((e) => !usedEdge.has(ek(edge.to, e.to, e.way.id)));
        if (!next) break;
        prev = edge.to;
        edge = next;
      }
      segments.push({ a: j, b: nodes[nodes.length - 1], nodes, ways: segWays, oneway: Math.sign(oneway), len });
    }
  }

  // Enumerate simple cycles (graphs here are tiny, but cap the work anyway).
  const segsAt = new Map<number, number[]>();
  segments.forEach((s, i) => {
    for (const v of [s.a, s.b]) {
      if (!segsAt.has(v)) segsAt.set(v, []);
      if (!segsAt.get(v)!.includes(i)) segsAt.get(v)!.push(i);
    }
  });
  const cycles: { segs: number[]; dirs: boolean[] }[] = [];
  const cycleKeys = new Set<string>();
  let budget = 50000;
  segments.forEach((s, i) => {
    if (s.a === s.b && s.nodes.length > 3) {
      cycles.push({ segs: [i], dirs: [true] });
      cycleKeys.add(String(i));
    }
  });
  const jList = [...junction];
  for (const start of jList) {
    const path: number[] = [];
    const dirs: boolean[] = [];
    const visited = new Set<number>([start]);
    const dfs = (v: number) => {
      if (--budget < 0) return;
      for (const si of segsAt.get(v) ?? []) {
        if (path.includes(si)) continue;
        const s = segments[si];
        if (s.a === s.b) continue;
        const fwd = s.a === v;
        const to = fwd ? s.b : s.a;
        if (to === start && path.length >= 1) {
          const key = [...path, si].sort((x, y) => x - y).join(',');
          if (!cycleKeys.has(key)) {
            cycleKeys.add(key);
            cycles.push({ segs: [...path, si], dirs: [...dirs, fwd] });
          }
          continue;
        }
        if (visited.has(to) || to < start) continue; // canonical: start is min id
        visited.add(to);
        path.push(si);
        dirs.push(fwd);
        dfs(to);
        path.pop();
        dirs.pop();
        visited.delete(to);
      }
    };
    dfs(start);
  }

  let loops: Loop[] = cycles.map(({ segs, dirs }) => {
    let nodes: number[] = [];
    let ow = 0;
    const wayIds = new Set<number>();
    segs.forEach((si, k) => {
      const s = segments[si];
      const ns = dirs[k] ? s.nodes : [...s.nodes].reverse();
      nodes = nodes.concat(nodes.length ? ns.slice(1) : ns);
      ow += s.oneway * (dirs[k] ? 1 : -1) * s.len;
      s.ways.forEach((w) => wayIds.add(w));
    });
    if (nodes[0] === nodes[nodes.length - 1]) nodes.pop();
    if (ow < 0) nodes.reverse(); // follow the mapped race direction
    const points = nodes.map((n) => coord.get(n)!);
    return { nodes, points, ways: [...wayIds].sort((a, b) => a - b), lengthM: loopLength(points) };
  });

  // Nothing closed? Accept the longest open chain if its ends nearly meet.
  if (!loops.length) {
    const best = segments.filter((s) => s.a !== s.b).sort((x, y) => y.len - x.len)[0];
    if (best) {
      const pts = best.nodes.map((n) => coord.get(n)!);
      const gap = distM(pts[0], pts[pts.length - 1]);
      if (gap < Math.max(40, best.len * 0.1)) {
        loops = [{ nodes: best.nodes, points: pts, ways: [...best.ways], lengthM: loopLength(pts) }];
      }
    }
  }

  return loops
    .filter((l) => l.lengthM > 150 && l.lengthM < 8000 && l.points.length >= 6)
    .sort((x, y) => y.lengthM - x.lengthM)
    .slice(0, maxLoops);
}

export function trackId(ways: number[]): string {
  return 'osm-' + [...ways].sort((a, b) => a - b).join('_');
}

export function waysFromId(id: string): number[] | null {
  const m = /^osm-([\d_]+)$/.exec(id);
  return m ? m[1].split('_').map(Number) : null;
}

export function centroid(pts: LatLon[]): LatLon {
  let la = 0;
  let lo = 0;
  for (const p of pts) {
    la += p[0];
    lo += p[1];
  }
  return [la / pts.length, lo / pts.length];
}

function widthFrom(elements: any[], ways: number[]): number {
  for (const e of elements) {
    if (e.type === 'way' && ways.includes(e.id) && e.tags?.width) {
      const w = parseFloat(e.tags.width);
      if (w >= 4 && w <= 20) return w;
    }
  }
  return 8;
}

function nameFrom(elements: any[], ways: number[]): string | undefined {
  for (const e of elements) if (e.type === 'way' && ways.includes(e.id) && e.tags?.name && !/pit/i.test(e.tags.name)) return e.tags.name;
  return undefined;
}

export function loopToTrack(loop: Loop, elements: any[], fallbackName: string, location = ''): TrackData {
  const name = nameFrom(elements, loop.ways) ?? fallbackName;
  return {
    id: trackId(loop.ways),
    name,
    location,
    center: centroid(loop.points),
    points: loop.points.map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)] as LatLon),
    width: widthFrom(elements, loop.ways),
    lengthM: Math.round(loop.lengthM),
    osmWays: loop.ways,
    source: 'OpenStreetMap',
  };
}

const WAY_OUT = 'out body geom;';

/** Karting / raceway loops inside a bounding box (south, west, north, east). */
export async function discoverTracks(bbox: [number, number, number, number], signal?: AbortSignal) {
  const b = bbox.map((x) => x.toFixed(5)).join(',');
  // Many kart tracks (KF1 included) are tagged sport=motor, so take all raceways
  // and let isRaceable() drop RC tracks, pit lanes and the like.
  const q = `[out:json][timeout:45];way["highway"="raceway"](${b});${WAY_OUT}`;
  const data = await overpass(q, signal);
  // Group connected ways so each venue is stitched independently.
  const loops = findLoops(data.elements, 64);
  const tracks: TrackData[] = [];
  const taken = new Set<number>();
  for (const loop of loops) {
    if (loop.ways.some((w) => taken.has(w))) continue; // keep the longest layout per venue
    loop.ways.forEach((w) => taken.add(w));
    tracks.push(loopToTrack(loop, data.elements, 'Unnamed kart track'));
  }
  return tracks;
}

/** Rebuild a track from its id (the id encodes its OSM way ids). */
export async function trackFromId(id: string, signal?: AbortSignal): Promise<TrackData | null> {
  const ways = waysFromId(id);
  if (!ways) return null;
  const data = await overpass(`[out:json][timeout:30];way(id:${ways.join(',')});${WAY_OUT}`, signal);
  const loop = findLoops(data.elements, 1)[0];
  return loop ? loopToTrack(loop, data.elements, 'Kart track') : null;
}

/** All layouts at a venue: loops using raceways connected to the given ways. */
export async function layoutsNear(center: LatLon, radius = 600, signal?: AbortSignal) {
  const q = `[out:json][timeout:30];way["highway"="raceway"](around:${radius},${center[0]},${center[1]});${WAY_OUT}`;
  const data = await overpass(q, signal);
  return { loops: findLoops(data.elements, 6), elements: data.elements };
}
