// Bakes public/tracks/venues/<cell>.json: every world-map venue's kart layouts, pre-stitched from
// OpenStreetMap, so the home screen opens any track from the CDN instead of querying Overpass at
// click time. It also rewrites public/tracks/world.json to keep only venues with a raceable loop,
// each dot moved onto its longest layout.
//
// A few hundred Overpass queries (one per 5° cell that has venues, covering only the ground around
// each venue), so it runs on CI:
// .github/workflows/bake-venues.yml. Locally: npm run venues [-- --cells 9_20,10_20]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { findLoops, loopToTrack, centroid } from '../src/track/osm.ts';
import { cellOf, packPoints, unpackPoints, venueKey, type PackedLayout, type VenueCell } from '../src/shared/venues.ts';

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

/** Overpass, with mirrors and backoff; null after `attempts` failures. */
async function query(q: string, label: string, worker: number, attempts: number): Promise<any[] | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = MIRRORS[(worker + attempt) % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(150_000),
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
    await sleep(3000 * (attempt + 1));
  }
  return null;
}

/**
 * Raceways around a set of venues: one query that unions a small box around each venue, so only the
 * raceways that matter come back (a whole 5° box is mostly motocross and big circuits). A batch that
 * keeps failing is split in half rather than retried as-is.
 */
async function racewaysNear(venues: Venue[], label: string, worker: number, depth = 0): Promise<any[]> {
  const d = NEAR_DEG + 0.002;
  const boxes = venues
    .map(([la, lo]) => {
      const dl = d / Math.cos((la * Math.PI) / 180);
      return `way["highway"="raceway"](${(la - d).toFixed(4)},${(lo - dl).toFixed(4)},${(la + d).toFixed(4)},${(lo + dl).toFixed(4)});`;
    })
    .join('');
  const els = await query(`[out:json][timeout:120];(${boxes});out body geom;`, label, worker, venues.length > 1 && depth < 4 ? 3 : 6);
  if (els) return els;
  if (venues.length === 1 || depth >= 4) throw new Error(`${label}: Overpass unavailable`);
  console.log(`  ${label}: splitting ${venues.length} venues in half`);
  const half = Math.ceil(venues.length / 2);
  const out = new Map<number, any>();
  for (const [i, part] of [venues.slice(0, half), venues.slice(half)].entries())
    for (const el of await racewaysNear(part, `${label}.${i}`, worker, depth + 1)) out.set(el.id, el);
  return [...out.values()];
}

async function raceways(cell: string, worker: number): Promise<any[]> {
  return racewaysNear(byCell.get(cell)!, cell, worker);
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
