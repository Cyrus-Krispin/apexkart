// Bakes public/tracks/venues/<cell>.json: every world-map venue's kart layouts, pre-stitched from
// OpenStreetMap, so the home screen opens any track from the CDN instead of querying Overpass at
// click time. It also rewrites public/tracks/world.json to keep only venues with a raceable loop,
// each dot moved onto its longest layout.
//
// A few hundred Overpass queries (one per 5° cell that has venues), so it runs on CI:
// .github/workflows/bake-venues.yml. Locally: npm run venues [-- --cells 9_20,10_20]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { findLoops, loopToTrack, centroid } from '../src/track/osm.ts';
import { CELL_DEG, cellOf, packPoints, unpackPoints, venueKey, type PackedLayout, type VenueCell } from '../src/shared/venues.ts';

const UA = 'ApexKart venue baker (github.com/Cyrus-Krispin/apexkart)';
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const KART_M: [number, number] = [150, 2100]; // a loop outside this is a pit lane or the big circuit next door
const KARTISH = /kart|go.?kart|carting/i;
const NEAR_DEG = 0.008; // raceways within ~900 m of a venue belong to it
const MAX_LAYOUTS = 3;
const WORKERS = 2; // Overpass gives each address two slots

type Venue = [number, number, string, string];
const world: { venues: Venue[]; countries: Record<string, unknown>; source: string; built: string } = JSON.parse(readFileSync('public/tracks/world.json', 'utf8'));
const onlyCells = process.argv.includes('--cells') ? new Set(process.argv[process.argv.indexOf('--cells') + 1].split(',')) : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raceways in one box. A box that keeps failing (too much data for a public Overpass slot) is
 *  split into quarters, down to 1.25°, rather than retried as-is. */
async function racewaysIn(box: [number, number, number, number], label: string, worker: number, depth = 0): Promise<any[]> {
  const pad = 0.02;
  const bbox = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad].map((v) => v.toFixed(3)).join(',');
  const q = `[out:json][timeout:180][maxsize:536870912];way["highway"="raceway"](${bbox});out body geom;`;
  const attempts = depth < 2 ? 3 : 6;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = MIRRORS[(worker + attempt) % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(200_000),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) {
        const data = JSON.parse(text);
        if (!(typeof data.remark === 'string' && /error|timed out/i.test(data.remark))) return data.elements ?? [];
      }
      console.log(`  ${label}: ${url.split('/')[2]} ${res.status}`);
    } catch (e) {
      console.log(`  ${label}: ${url.split('/')[2]} ${(e as Error).message}`);
    }
    await sleep(4000 * (attempt + 1));
  }
  if (depth >= 2) throw new Error(`${label}: Overpass unavailable`);
  const [s, w, n, e] = box;
  const mLat = (s + n) / 2;
  const mLon = (w + e) / 2;
  console.log(`  ${label}: splitting into quarters`);
  const parts: [number, number, number, number][] = [
    [s, w, mLat, mLon],
    [s, mLon, mLat, e],
    [mLat, w, n, mLon],
    [mLat, mLon, n, e],
  ];
  const out = new Map<number, any>();
  for (const [i, b] of parts.entries()) for (const el of await racewaysIn(b, `${label}.${i}`, worker, depth + 1)) out.set(el.id, el);
  return [...out.values()];
}

async function raceways(cell: string, worker: number): Promise<any[]> {
  const [cy, cx] = cell.split('_').map(Number);
  return racewaysIn([cy * CELL_DEG, cx * CELL_DEG, (cy + 1) * CELL_DEG, (cx + 1) * CELL_DEG], cell, worker);
}

/** The layouts at one venue from the raceways around it, longest first. */
function layoutsAt(v: Venue, ways: { el: any; bb: [number, number, number, number] }[], taken: Set<string>): PackedLayout[] {
  const dLon = NEAR_DEG / Math.cos((v[0] * Math.PI) / 180);
  const near = ways.filter(({ bb }) => bb[2] >= v[0] - NEAR_DEG && bb[0] <= v[0] + NEAR_DEG && bb[3] >= v[1] - dLon && bb[1] <= v[1] + dLon).map((w) => w.el);
  if (!near.length) return [];
  // Kart loops first (venues often share a site with handling or car circuits), then longest. A way
  // counts as kart if it's tagged sport=karting or named like one.
  const kart = (ways: number[]) => near.some((e) => ways.includes(e.id) && (/karting/.test(e.tags?.sport ?? '') || KARTISH.test(e.tags?.name ?? '')));
  const tracks = findLoops(near, 10)
    .filter((l) => l.lengthM >= KART_M[0] && l.lengthM <= KART_M[1])
    .sort((a, b) => Number(kart(b.ways)) - Number(kart(a.ways)) || b.lengthM - a.lengthM)
    .map((l) => loopToTrack(l, near, v[3] || 'Unnamed kart track'));
  const out: PackedLayout[] = [];
  for (const t of tracks) {
    if (taken.has(t.id) || out.some((o) => o[0] === t.id)) continue;
    out.push([t.id, t.name, t.width, t.lengthM, packPoints(t.points)]);
    if (out.length === MAX_LAYOUTS) break;
  }
  return out;
}

// ---------------------------------------------------------------- main

const byCell = new Map<string, Venue[]>();
for (const v of world.venues) {
  const c = cellOf(v[0], v[1]);
  if (onlyCells && !onlyCells.has(c)) continue;
  (byCell.get(c) ?? byCell.set(c, []).get(c)!).push(v);
}
const cells = [...byCell.keys()].sort((a, b) => byCell.get(b)!.length - byCell.get(a)!.length);
console.log(`${world.venues.length} venues in ${cells.length} cells`);

if (!onlyCells) rmSync('public/tracks/venues', { recursive: true, force: true });
mkdirSync('public/tracks/venues', { recursive: true });
const kept: Venue[] = [];
const taken = new Set<string>(); // a layout belongs to one venue only
let done = 0;
let bytes = 0;
const failed: string[] = [];

async function bake(cell: string, worker: number) {
  const els = await raceways(cell, worker);
  const ways = els
    .filter((e) => e.type === 'way' && e.geometry?.length > 1)
    .map((el) => {
      const la = el.geometry.map((g: any) => g.lat);
      const lo = el.geometry.map((g: any) => g.lon);
      return { el, bb: [Math.min(...la), Math.min(...lo), Math.max(...la), Math.max(...lo)] as [number, number, number, number] };
    });
  const file: VenueCell = {};
  // Named venues first, so they win a layout shared with an unnamed neighbour.
  const venues = byCell.get(cell)!.slice().sort((a, b) => (a[3] ? 0 : 1) - (b[3] ? 0 : 1));
  for (const v of venues) {
    const layouts = layoutsAt(v, ways, taken);
    if (!layouts.length) continue;
    layouts.forEach((l) => taken.add(l[0]));
    // Put the dot on the track itself, in the cell that holds its layouts.
    let at = centroid(unpackPoints(layouts[0][4]));
    if (cellOf(at[0], at[1]) !== cell) at = [v[0], v[1]];
    const lat = +at[0].toFixed(5);
    const lon = +at[1].toFixed(5);
    const name = v[3] || (layouts[0][1].startsWith('Unnamed') ? '' : layouts[0][1]);
    file[venueKey(lat, lon)] = layouts;
    kept.push([lat, lon, v[2], name]);
  }
  if (Object.keys(file).length) {
    const json = JSON.stringify(file);
    bytes += json.length;
    writeFileSync(`public/tracks/venues/${cell}.json`, json);
  }
  done++;
  console.log(`✓ ${cell}: ${Object.keys(file).length}/${venues.length} venues raceable, ${ways.length} raceways (${done}/${cells.length})`);
}

const queue = cells.slice();
await Promise.all(
  Array.from({ length: WORKERS }, async (_, w) => {
    for (let cell = queue.shift(); cell; cell = queue.shift()) {
      try {
        await bake(cell, w);
      } catch (e) {
        failed.push(cell);
        console.log(`✗ ${(e as Error).message}`);
      }
      await sleep(1000);
    }
  }),
);

if (failed.length) {
  // Never publish a half-baked map: a missing cell would drop every venue in it. The cell files that
  // did bake are kept (and uploaded), so a re-run only needs the failed ones.
  writeFileSync('public/tracks/venues/failed-cells.txt', failed.join(',') + '\n');
  console.log(`\n${failed.length} cells failed (${failed.join(',')}); not rewriting world.json. Re-run with --cells ${failed.join(',')}.`);
  process.exit(1);
}
if (!onlyCells) {
  kept.sort((a, b) => a[2].localeCompare(b[2]) || a[0] - b[0]);
  writeFileSync('public/tracks/world.json', JSON.stringify({ ...world, venues: kept, built: new Date().toISOString().slice(0, 10) }));
}
console.log(`\n${kept.length} of ${world.venues.length} venues have a raceable loop; ${cells.length} cell files, ${(bytes / 1e6).toFixed(1)} MB raw`);
