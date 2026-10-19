// Bakes preset tracks from OpenStreetMap into public/tracks/presets.json.
// Usage: npm run tracks              (everything)
//        npm run tracks -- kerpen    (one circuit, by name)
//        npm run tracks -- --new     (only circuits not baked yet: existing ids, and so leaderboards, stay put)
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
// Order is the featured order on the home screen. Centres come from public/tracks/world.json
// (the kart-sized raceway cluster) or Nominatim; keep radius tight next to big circuits.
const PRESETS: Preset[] = [
  { name: 'KF1 Karting Circuit', country: 'SGP', location: 'Kranji, Singapore', center: [1.423125, 103.7585874], radius: 250 },
  { name: 'South Garda Karting', country: 'ITA', location: 'Lonato, Italy', search: 'South Garda Karting Lonato', radius: 500 },
  { name: 'Karting Genk', country: 'BEL', location: 'Genk, Belgium', search: 'Karting Genk Horensbergdam', radius: 500 },
  { name: 'PF International', country: 'GBR', location: 'Lincolnshire, England', center: [53.0387859, -0.6599601], radius: 600 },
  { name: 'Erftlandring Kerpen', country: 'DEU', location: 'Kerpen, Germany', search: 'Erftlandring Kerpen', radius: 500 },
  { name: 'Kartódromo Internacional do Algarve', country: 'PRT', location: 'Portimão, Portugal', search: 'Kartódromo Internacional do Algarve', radius: 600 },
  { name: 'Adria Karting Raceway', country: 'ITA', location: 'Adria, Italy', center: [45.04545, 12.15047], radius: 500 },
  { name: 'Circuito Internacional de Zuera', country: 'ESP', location: 'Zuera, Spain', center: [41.82848, -0.81223], radius: 500 },
  { name: 'Kartódromo Lucas Guerrero', country: 'ESP', location: 'Chiva, Valencia, Spain', center: [39.5082, -0.74726], radius: 500 },
  { name: 'Kartodromo Franciacorta', country: 'ITA', location: 'Castrezzato, Italy', center: [45.5142, 10.00847], radius: 500 },
  { name: 'Buckmore Park', country: 'GBR', location: 'Chatham, Kent, England', center: [51.34339, 0.50196], radius: 400 },
  { name: 'Rye House Kart Raceway', country: 'GBR', location: 'Hoddesdon, England', center: [51.76745, 0.01216], radius: 350 },
  { name: 'Kartbahn Ampfing', country: 'DEU', location: 'Ampfing, Germany', center: [48.246, 12.44318], radius: 450 },
  { name: 'Paul Ricard Karting', country: 'FRA', location: 'Le Castellet, France', center: [43.24722, 5.79821], radius: 350 },
  { name: 'Rødby Karting', country: 'DNK', location: 'Rødby, Denmark', center: [54.65136, 11.38592], radius: 450 },
  { name: 'Sepang International Kart Circuit', country: 'MYS', location: 'Sepang, Malaysia', center: [2.7635, 101.72872], radius: 400 },
  { name: 'Dubai Kartdrome', country: 'ARE', location: 'Motor City, Dubai', center: [25.0442405, 55.2379262], radius: 450 },
  { name: 'Bahrain International Karting Circuit', country: 'BHR', location: 'Sakhir, Bahrain', center: [26.0273677, 50.5066771], radius: 450 },
  { name: 'Eastern Creek Karting Raceway', country: 'AUS', location: 'Sydney, Australia', center: [-33.8045381, 150.8810518], radius: 450 },
  { name: 'Kartódromo Granja Viana', country: 'BRA', location: 'Cotia, São Paulo, Brazil', center: [-23.60518, -46.83679], radius: 450 },
  { name: 'New Castle Motorsports Park', country: 'USA', location: 'New Castle, Indiana, USA', center: [39.85006, -85.4087], radius: 600 },
  { name: 'Orlando Kart Center', country: 'USA', location: 'Orlando, Florida, USA', center: [28.4109332, -81.3787477], radius: 400 },
  { name: 'SH Karting', country: 'CAN', location: 'Saint-Charles-sur-Richelieu, Québec', center: [45.60038, -73.13821], radius: 450 },
];

const KART_MAX_M = 2100; // longer loops are the big circuit next door, not the kart track
const KARTISH = /kart|go.?kart|carting/i;

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
const newOnly = process.argv.includes('--new');
const result: TrackData[] = [];
const baked = new Set<string>(); // names (re)baked this run, for the surroundings pass

for (const p of PRESETS) {
  const prev = previous.find((t) => t.name === p.name);
  if ((only && !p.name.toLowerCase().includes(only)) || (newOnly && prev)) {
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
      return { loops: findLoops(els, 12), elements: els };
    });
    // Kart loops first (handling and car circuits often share the site), then longest. A way counts
    // as kart if it's tagged sport=karting or named like one.
    const kart = (l: (typeof loops)[number]) =>
      Number(elements.some((e: any) => e.type === 'way' && l.ways.includes(e.id) && (/karting/.test(e.tags?.sport ?? '') || KARTISH.test(e.tags?.name ?? ''))));
    loops = loops.filter((l) => l.lengthM <= KART_MAX_M).sort((a, b) => kart(b) - kart(a) || b.lengthM - a.lengthM);
    const loop = loops[p.layout ?? 0];
    if (!loop) throw new Error('no closed kart-length raceway loop found');
    const t = loopToTrack(loop, elements, p.name, p.location);
    t.name = p.name;
    t.preset = true;
    t.country = p.country;
    if (p.needsFix) t.needsFix = true;
    result.push(t);
    baked.add(t.name);
    console.log(`✓ ${p.name}: ${t.lengthM} m, ${t.points.length} pts, ways ${t.osmWays.join(',')} (${loops.length} layouts: ${loops.map((l) => Math.round(l.lengthM)).join('/')})`);
  } catch (e) {
    console.log(`✗ ${p.name}: ${(e as Error).message}`);
    if (prev) result.push(prev);
  }
  await sleep(1500);
}

writeFileSync(out, JSON.stringify(result));
console.log(`wrote ${result.length} tracks to ${out}`);
// The API treats featured circuits as curated (no community re-traces); keep its list in step.
writeFileSync(
  'api/_lib/featured.ts',
  `// Generated by scripts/fetch-tracks.ts from public/tracks/presets.json. Don't edit by hand.\nexport const FEATURED_IDS: string[] = ${JSON.stringify(result.map((t) => t.id), null, 2)};\n`,
);

// Surroundings (buildings, land use, trees) for the 3D world, one file per track.
if (process.argv.includes('--env') || !only) {
  mkdirSync('public/tracks/env', { recursive: true });
  for (const t of result) {
    if ((only || newOnly) && !baked.has(t.name)) continue;
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
