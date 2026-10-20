// Bakes scripts/data/venues-all.json: every kart venue on OpenStreetMap, grouped into venues and
// tagged with its country, for the atlas's world map and country filter.
//
// Two sources: anything tagged sport=karting, plus kart-sized clusters of other raceways
// (KF1 and many tracks like it are tagged sport=motor). Only venues with a mapped racing line
// are kept, since those are the ones the game can turn into a track.
//
// Usage: npm run world                                  (queries Overpass, a few minutes)
//        npm run world -- karting.json raceways.json    (reuse saved query results, see QUERIES)
import { readFileSync, writeFileSync } from 'node:fs';

const UA = 'ApexKart world index (github.com/Cyrus-Krispin/apexkart)';
const QUERIES = {
  karting: '[out:json][timeout:280];nwr["sport"="karting"];out center tags;',
  raceways: '[out:json][timeout:280];way["highway"="raceway"]["sport"!="karting"];out tags bb;',
};
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
const COUNTRIES = 'https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json';
const KART_LINK_M = 400; // karting features closer than this belong to the same venue
const RACEWAY_LINK_M = 150; // raceway pieces closer than this form one circuit
const KART_SIZE_M: [number, number] = [100, 700]; // a kart circuit's footprint, corner to corner
const OTHER_SPORT = /motocross|bmx|cycl|bicycle|horse|dog|rc_car|model|biathlon|running|luge|skat|ski|drag|quad|enduro|trial|speedway|off_road|rallycross|athletics/i;
const UNPAVED = /dirt|gravel|ground|grass|sand|unpaved|earth|mud|compacted|clay|fine_gravel|ice|snow/i;
const MOTOR_SPORT = /^(motor|motorsport|car_racing|racing)(;|$)|kart/i;
const BIG_CIRCUIT = /street circuit|grand prix|formula|speedway|oval|drag ?(strip|way)|dragway|motodrom|autodrom|ring$/i;
/** Bulk imports (New Zealand's LINZ race-track centrelines) are mostly horse and harness tracks. */
const isImport = (t: Tags) => Object.keys(t).some((k) => k.startsWith('LINZ')) || /LINZ/.test(`${t.source ?? ''} ${t.attribution ?? ''}`);

type Tags = Record<string, string>;
interface Feature {
  lat: number;
  lon: number;
  tags: Tags;
  bb?: [number, number, number, number]; // south, west, north, east
}
type Venue = [number, number, string, string];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function query(q: string): Promise<any> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) {
        const data = JSON.parse(text);
        if (data.elements?.length > 1000) return data;
      }
      console.log(`  ${url}: ${res.status}`);
    } catch (e) {
      console.log(`  ${url}: ${(e as Error).message}`);
    }
    await sleep(20000);
  }
  throw new Error('Overpass is unavailable; try again later or pass saved results');
}

const metres = (aLat: number, aLon: number, bLat: number, bLon: number) =>
  Math.hypot((aLat - bLat) * 110540, (aLon - bLon) * 111320 * Math.cos((aLat * Math.PI) / 180));

/** Single-linkage clustering on a grid: features within `link` metres of each other group up. */
function cluster(fs: Feature[], link: number): Feature[][] {
  const parent = fs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cell = 0.005; // ~550 m, comfortably larger than either link distance
  const grid = new Map<string, number[]>();
  fs.forEach((f, i) => {
    const k = `${Math.floor(f.lat / cell)},${Math.floor(f.lon / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  // Raceway pieces link by their bounding boxes (long straights have far-apart centres).
  const gap = (a: Feature, b: Feature) => {
    if (!a.bb || !b.bb) return metres(a.lat, a.lon, b.lat, b.lon);
    const dLat = Math.max(0, a.bb[0] - b.bb[2], b.bb[0] - a.bb[2]);
    const dLon = Math.max(0, a.bb[1] - b.bb[3], b.bb[1] - a.bb[3]);
    return metres(a.lat, a.lon, a.lat + dLat, a.lon + dLon);
  };
  const reach = Math.ceil(link / 550) + 2; // big boxes can touch from further cells
  fs.forEach((f, i) => {
    const cy = Math.floor(f.lat / cell);
    const cx = Math.floor(f.lon / cell);
    for (let dy = -reach; dy <= reach; dy++)
      for (let dx = -reach; dx <= reach; dx++)
        for (const j of grid.get(`${cy + dy},${cx + dx}`) ?? []) if (j > i && find(i) !== find(j) && gap(f, fs[j]) < link) parent[find(j)] = find(i);
  });
  const groups = new Map<number, Feature[]>();
  fs.forEach((f, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(f);
  });
  return [...groups.values()];
}

const isRaceway = (t: Tags) => t.highway === 'raceway';
const JUNK_NAME = /^(pit|pits|pit ?lane|paddock|parking|start|finish|track|circuit|kart|karting|go ?karts?|raceway)$/i;

/** The venue's name: the sports centre / track it belongs to beats a named strip of asphalt. */
function venueName(group: Feature[]): string {
  let best = '';
  let bestScore = -1;
  for (const f of group) {
    const n = (f.tags.name ?? '').trim();
    if (!n || JUNK_NAME.test(n) || /\bpit/i.test(n)) continue;
    let s = 0;
    if (['sports_centre', 'racetrack', 'track', 'stadium', 'sports_hall'].includes(f.tags.leisure)) s += 3;
    if (/kart|circuit|raceway|ring|pista|kartódromo|kartodromo/i.test(n)) s += 2;
    if (!isRaceway(f.tags)) s += 1;
    if (s > bestScore || (s === bestScore && n.length < best.length)) {
      best = n;
      bestScore = s;
    }
  }
  return best;
}

const mean = (fs: Feature[], k: 'lat' | 'lon') => fs.reduce((s, f) => s + f[k], 0) / fs.length;

// ---------------------------------------------------------------- countries

interface Country {
  cc: string; // ISO 3166-1 alpha-3
  cc2: string; // alpha-2, for the browser's Intl APIs and locale matching
  name: string;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  rings: [number, number][][];
}

async function loadCountries(): Promise<Country[]> {
  const [topo, meta] = await Promise.all([fetch(ATLAS).then((r) => r.json()), fetch(COUNTRIES).then((r) => r.json())]);
  const byNum = new Map<string, { cca3: string; cca2: string; name: string }>();
  for (const c of meta) if (c.ccn3) byNum.set(c.ccn3, { cca3: c.cca3, cca2: c.cca2, name: c.name.common });
  // Decode the delta-encoded, quantised TopoJSON arcs.
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  const arcs: [number, number][][] = topo.arcs.map((arc: [number, number][]) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty] as [number, number];
    });
  });
  const ring = (ids: number[]) => {
    const out: [number, number][] = [];
    for (const id of ids) {
      const a = id >= 0 ? arcs[id] : arcs[~id].slice().reverse();
      out.push(...(out.length ? a.slice(1) : a));
    }
    return out;
  };
  const list: Country[] = [];
  for (const g of topo.objects.countries.geometries) {
    const m = byNum.get(String(g.id));
    if (!m || !g.arcs) continue;
    const polys: number[][][] = g.type === 'Polygon' ? [g.arcs] : g.arcs;
    const rings = polys.flatMap((p) => p.map(ring));
    const xs = rings.flat().map((p) => p[0]);
    const ys = rings.flat().map((p) => p[1]);
    list.push({ cc: m.cca3, cc2: m.cca2, name: m.name, rings, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  return list;
}

function inRings(lon: number, lat: number, rings: [number, number][][]) {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

function countryOf(lat: number, lon: number, countries: Country[]): Country | null {
  for (const c of countries) {
    const [a, b, x, y] = c.bbox;
    if (lon >= a && lon <= x && lat >= b && lat <= y && inRings(lon, lat, c.rings)) return c;
  }
  // Coastlines at this resolution miss some venues near the shore: take the nearest
  // border point within ~60 km.
  let best: Country | null = null;
  let bestD = 60000;
  for (const c of countries) {
    const [a, b, x, y] = c.bbox;
    if (lon < a - 0.6 || lon > x + 0.6 || lat < b - 0.6 || lat > y + 0.6) continue;
    for (const r of c.rings)
      for (const [plon, plat] of r) {
        const d = metres(lat, lon, plat, plon);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
  }
  return best;
}

// ---------------------------------------------------------------- main

const [kartFile, racewayFile] = process.argv.slice(2);
const load = async (file: string | undefined, q: string, what: string) => {
  console.log(file ? `Reading ${file}` : `Querying Overpass for ${what}…`);
  return file ? JSON.parse(readFileSync(file, 'utf8')) : await query(q);
};
const karting = await load(kartFile, QUERIES.karting, 'every sport=karting feature');
const raceways = await load(racewayFile, QUERIES.raceways, 'every other raceway');
const countries = await loadCountries();

// 1. Karting venues: anything tagged sport=karting, kept if it has a racing line.
const kartFeatures: Feature[] = [];
for (const e of karting.elements) {
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat != null && lon != null) kartFeatures.push({ lat, lon, tags: e.tags ?? {} });
}
const found: { lat: number; lon: number; name: string }[] = [];
let noLine = 0;
for (const g of cluster(kartFeatures, KART_LINK_M)) {
  const lines = g.filter((f) => isRaceway(f.tags));
  if (!lines.length) {
    noLine++;
    continue;
  }
  found.push({ lat: mean(lines, 'lat'), lon: mean(lines, 'lon'), name: venueName(g) });
}
const fromKarting = found.length;

// 2. Kart-sized circuits among the other raceways: tagged as motor sport, paved, compact, and
//    not part of a big circuit.
const pieces: Feature[] = [];
for (const e of raceways.elements) {
  const t: Tags = e.tags ?? {};
  const b = e.bounds;
  if (!b || !MOTOR_SPORT.test(t.sport ?? '') || OTHER_SPORT.test(t.sport ?? '') || UNPAVED.test(t.surface ?? '') || t.area === 'yes' || isImport(t)) continue;
  pieces.push({ lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2, tags: t, bb: [b.minlat, b.minlon, b.maxlat, b.maxlon] });
}
let tooBig = 0;
for (const g of cluster(pieces, RACEWAY_LINK_M)) {
  const s = Math.min(...g.map((f) => f.bb![0]));
  const w = Math.min(...g.map((f) => f.bb![1]));
  const n = Math.max(...g.map((f) => f.bb![2]));
  const e = Math.max(...g.map((f) => f.bb![3]));
  const size = metres(s, w, n, e);
  if (size < KART_SIZE_M[0] || size > KART_SIZE_M[1]) {
    tooBig += size > KART_SIZE_M[1] ? 1 : 0;
    continue;
  }
  if (g.some((f) => BIG_CIRCUIT.test(f.tags.name ?? ''))) continue;
  const lat = (s + n) / 2;
  const lon = (w + e) / 2;
  if (found.some((v) => Math.abs(v.lat - lat) < 0.01 && metres(v.lat, v.lon, lat, lon) < 500)) continue;
  found.push({ lat, lon, name: venueName(g) });
}

const venues: Venue[] = [];
const used = new Map<string, Country>();
for (const v of found) {
  const c = countryOf(v.lat, v.lon, countries);
  if (c) used.set(c.cc, c);
  venues.push([+v.lat.toFixed(5), +v.lon.toFixed(5), c?.cc ?? '', v.name]);
}
venues.sort((a, b) => a[2].localeCompare(b[2]) || a[0] - b[0]);

const out = {
  // [lat, lon, ISO alpha-3 country ('' if offshore), venue name ('' if unnamed)]
  venues,
  // alpha-3 -> [common name, alpha-2]
  countries: Object.fromEntries([...used.values()].sort((a, b) => a.cc.localeCompare(b.cc)).map((c) => [c.cc, [c.name, c.cc2]])),
  source: 'OpenStreetMap contributors (ODbL)',
  built: new Date().toISOString().slice(0, 10),
};
// The map shows the subset with baked layouts: scripts/build-venues.ts --merge-only --baked-only.
writeFileSync('scripts/data/venues-all.json', JSON.stringify(out));
const per = new Map<string, number>();
for (const v of venues) per.set(v[2], (per.get(v[2]) ?? 0) + 1);
const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log(`${venues.length} venues in ${per.size} countries: ${fromKarting} tagged karting (${noLine} more without a racing line), ${venues.length - fromKarting} kart-sized raceways (${tooBig} bigger circuits skipped)`);
console.log(`Unnamed: ${venues.filter((v) => !v[3]).length}. Top: ${top.map(([c, n]) => `${c || '??'} ${n}`).join(', ')}`);
