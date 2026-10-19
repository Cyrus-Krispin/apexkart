// Bakes preset tracks from OpenStreetMap into public/tracks/presets.json.
// Usage: npm run tracks
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { findLoops, layoutsNear, loopToTrack, type LatLon, type TrackData } from '../src/track/osm.ts';
import { envBBox, fetchEnv, parseEnv } from '../src/track/env.ts';
import { bboxAround, osmApiElements } from './osm-api.ts';

interface Preset {
  name: string;
  location: string;
  center?: LatLon; // known location; otherwise geocoded from `search`
  search?: string;
  radius?: number;
  layout?: number; // index into layouts sorted by length (0 = longest)
  country: string; // ISO alpha-3
  needsFix?: boolean; // OSM trace known not to match the asphalt
}

// Racing Underdog Medini is out for now: its OSM trace doesn't follow the asphalt.
// A hand-traced layout is kept in scripts/pending/medini-trace.json.
const PRESETS: Preset[] = [
  { name: 'KF1 Karting Circuit', country: 'SGP', location: 'Kranji, Singapore', center: [1.423125, 103.7585874], radius: 250 },
  { name: 'South Garda Karting', country: 'ITA', location: 'Lonato, Italy', search: 'South Garda Karting Lonato', radius: 500 },
  { name: 'Karting Genk', country: 'BEL', location: 'Genk, Belgium', search: 'Karting Genk Horensbergdam', radius: 500 },
  { name: 'PF International', country: 'GBR', location: 'Lincolnshire, England', center: [53.0387859, -0.6599601], radius: 600 },
  { name: 'Erftlandring Kerpen', country: 'DEU', location: 'Kerpen, Germany', search: 'Erftlandring Kerpen', radius: 500 },
  { name: 'Kartódromo Internacional do Algarve', country: 'PRT', location: 'Portimão, Portugal', search: 'Kartódromo Internacional do Algarve', radius: 600 },
];

const UA = 'ApexKart track baker (github.com/Cyrus-Krispin/apexkart)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function geocode(q: string): Promise<LatLon | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const j: any[] = await res.json();
  return j[0] ? [+j[0].lat, +j[0].lon] : null;
}

const out = 'public/tracks/presets.json';
const previous: TrackData[] = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : [];
const only = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').toLowerCase();
const result: TrackData[] = [];

for (const p of PRESETS) {
  const prev = previous.find((t) => t.name === p.name);
  if (only && !p.name.toLowerCase().includes(only)) {
    if (prev) result.push(prev);
    continue;
  }
  try {
    const center = p.center ?? (p.search ? await geocode(p.search) : null);
    await sleep(1100);
    if (!center) throw new Error('not geocoded');
    let { loops, elements } = await layoutsNear(center, p.radius ?? 500).catch(async (e) => {
      // Overpass down: fall back to the OSM API for this one small area.
      console.log(`  (${(e as Error).message}; using the OSM API)`);
      const els = (await osmApiElements(bboxAround(center[0], center[1], p.radius ?? 500))).filter((x) => x.type === 'way' && x.tags?.highway === 'raceway');
      return { loops: findLoops(els, 6), elements: els };
    });
    const loop = loops[p.layout ?? 0];
    if (!loop) throw new Error('no closed raceway loop found');
    const t = loopToTrack(loop, elements, p.name, p.location);
    t.name = p.name;
    t.preset = true;
    t.country = p.country;
    if (p.needsFix) t.needsFix = true;
    result.push(t);
    console.log(`✓ ${p.name}: ${t.lengthM} m, ${t.points.length} pts, ways ${t.osmWays.join(',')} (${loops.length} layouts: ${loops.map((l) => Math.round(l.lengthM)).join('/')})`);
  } catch (e) {
    console.log(`✗ ${p.name}: ${(e as Error).message}`);
    if (prev) result.push(prev);
  }
  await sleep(1500);
}

writeFileSync(out, JSON.stringify(result));
console.log(`wrote ${result.length} tracks to ${out}`);

// Surroundings (buildings, land use, trees) for the 3D world, one file per track.
if (process.argv.includes('--env') || !only) {
  mkdirSync('public/tracks/env', { recursive: true });
  for (const t of result) {
    if (only && !t.name.toLowerCase().includes(only.replace('--env', '').trim())) continue;
    const file = `public/tracks/env/${t.id}.json`;
    try {
      const env = await fetchEnv(t).catch(async (e) => {
        console.log(`  env for ${t.name}: ${(e as Error).message}; using the OSM API`);
        const bbox = envBBox(t);
        return parseEnv(await osmApiElements(bbox), bbox);
      });
      writeFileSync(file, JSON.stringify(env));
      console.log(`✓ env ${t.name}: ${env.buildings.length} buildings, ${env.areas.length} areas, ${env.lines.length} lines, ${env.trees.length} trees`);
    } catch (e) {
      console.log(`✗ env ${t.name}: ${(e as Error).message}`);
    }
    await sleep(1500);
  }
}
