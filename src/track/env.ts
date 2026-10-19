// Real surroundings of a circuit from OpenStreetMap: buildings (with heights),
// land use, roads, water and individual trees. Shared by the browser and the
// preset baker (scripts/fetch-tracks.ts).
import { overpass, type LatLon, type TrackData } from './osm.ts';

export type AreaKind =
  | 'forest'
  | 'scrub'
  | 'grass'
  | 'park'
  | 'pitch'
  | 'farm'
  | 'water'
  | 'parking'
  | 'sand'
  | 'residential'
  | 'industrial'
  | 'commercial';

export type LineKind = 'major' | 'minor' | 'path' | 'rail' | 'stream';

export interface EnvBuilding {
  p: LatLon[]; // footprint ring, not closed
  h: number; // metres, 0 = unknown (estimate from footprint)
  k?: string; // building type
}

export interface EnvData {
  v: 1;
  bbox: [number, number, number, number]; // s, w, n, e
  buildings: EnvBuilding[];
  areas: { k: AreaKind; p: LatLon[] }[];
  lines: { k: LineKind; p: LatLon[] }[];
  trees: LatLon[];
}

const round = (p: { lat: number; lon: number }): LatLon => [+p.lat.toFixed(6), +p.lon.toFixed(6)];

function areaKind(t: Record<string, string>): AreaKind | null {
  const lu = t.landuse;
  const nat = t.natural;
  const lei = t.leisure;
  if (nat === 'water' || lu === 'reservoir' || lu === 'basin' || t.water) return 'water';
  if (nat === 'wood' || lu === 'forest') return 'forest';
  if (nat === 'scrub' || nat === 'heath' || nat === 'wetland') return 'scrub';
  if (nat === 'sand' || nat === 'beach' || lu === 'construction' || lu === 'brownfield') return 'sand';
  if (lei === 'pitch' || lei === 'track' || lei === 'golf_course') return 'pitch';
  if (lei === 'park' || lei === 'garden' || lei === 'playground' || lu === 'recreation_ground' || lu === 'cemetery') return 'park';
  if (lu === 'grass' || lu === 'meadow' || lu === 'village_green' || nat === 'grassland') return 'grass';
  if (lu === 'farmland' || lu === 'orchard' || lu === 'vineyard' || lu === 'allotments' || lu === 'plant_nursery') return 'farm';
  if (t.amenity === 'parking' || lu === 'garages' || t.parking) return 'parking';
  if (lu === 'industrial' || lu === 'railway' || lu === 'depot' || lu === 'port') return 'industrial';
  if (lu === 'commercial' || lu === 'retail') return 'commercial';
  if (lu === 'residential') return 'residential';
  return null;
}

function lineKind(t: Record<string, string>): LineKind | null {
  const h = t.highway;
  if (h === 'raceway') return null; // the circuit itself is modelled separately
  if (h && /^(motorway|trunk|primary|secondary)(_link)?$/.test(h)) return 'major';
  if (h && /^(tertiary|unclassified|residential|service|living_street|road)(_link)?$/.test(h)) return 'minor';
  if (h && /^(footway|path|cycleway|pedestrian|track|steps|bridleway)$/.test(h)) return 'path';
  if (t.railway && /^(rail|light_rail|subway|narrow_gauge|tram)$/.test(t.railway)) return 'rail';
  if (t.waterway && /^(river|stream|canal|drain|ditch)$/.test(t.waterway)) return 'stream';
  return null;
}

function buildingHeight(t: Record<string, string>): number {
  const h = parseFloat(t.height ?? t['building:height'] ?? '');
  if (h > 1 && h < 400) return h;
  const lv = parseFloat(t['building:levels'] ?? '');
  if (lv > 0 && lv < 120) return lv * 3.2 + 1.2;
  const b = t.building;
  if (/^(garage|garages|shed|roof|kiosk|carport|hut|toilets|cabin|container)$/.test(b)) return 3.2;
  if (/^(house|detached|semidetached_house|terrace|bungalow|farm|static_caravan)$/.test(b)) return 7;
  if (/^(apartments|residential|dormitory|hotel)$/.test(b)) return 22;
  if (/^(industrial|warehouse|manufacture|hangar|factory|service)$/.test(b)) return 9;
  if (/^(commercial|retail|office|supermarket|civic|public|hospital)$/.test(b)) return 13;
  if (/^(grandstand|stadium|sports_centre|sports_hall)$/.test(b)) return 11;
  if (/^(church|cathedral|mosque|temple)$/.test(b)) return 15;
  if (/^(school|university|college)$/.test(b)) return 12;
  return 0; // unknown: the client estimates from the footprint
}

/** Join relation member ways into closed rings (outer members only). */
function ringsFromMembers(members: any[]): LatLon[][] {
  const segs: LatLon[][] = members
    .filter((m) => m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry))
    .map((m) => m.geometry.filter(Boolean).map(round));
  const rings: LatLon[][] = [];
  const key = (p: LatLon) => `${p[0]},${p[1]}`;
  while (segs.length) {
    let ring = segs.shift()!;
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 500) {
      const end = key(ring[ring.length - 1]);
      const i = segs.findIndex((s) => key(s[0]) === end || key(s[s.length - 1]) === end);
      if (i < 0) break;
      const s = segs.splice(i, 1)[0];
      ring = ring.concat(key(s[0]) === end ? s.slice(1) : s.reverse().slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

export function envBBox(track: TrackData, pad = 320): [number, number, number, number] {
  let s = Infinity,
    w = Infinity,
    n = -Infinity,
    e = -Infinity;
  for (const [la, lo] of track.points) {
    s = Math.min(s, la);
    n = Math.max(n, la);
    w = Math.min(w, lo);
    e = Math.max(e, lo);
  }
  const dLat = pad / 111000;
  const dLon = pad / (111000 * Math.cos((track.center[0] * Math.PI) / 180));
  return [s - dLat, w - dLon, n + dLat, e + dLon];
}

export function parseEnv(elements: any[], bbox: [number, number, number, number]): EnvData {
  const env: EnvData = { v: 1, bbox, buildings: [], areas: [], lines: [], trees: [] };
  for (const el of elements) {
    const t = el.tags ?? {};
    if (el.type === 'node') {
      if (t.natural === 'tree') env.trees.push(round(el));
      continue;
    }
    let rings: LatLon[][] = [];
    if (el.type === 'way' && Array.isArray(el.geometry)) rings = [el.geometry.filter(Boolean).map(round)];
    else if (el.type === 'relation' && Array.isArray(el.members)) {
      if (el.members.length > 300) continue; // huge relations (national forests etc.) aren't worth it
      rings = ringsFromMembers(el.members);
    }
    for (const r of rings) {
      if (r.length < 2) continue;
      const closed = r.length > 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
      if (t.building && closed) {
        env.buildings.push({ p: r.slice(0, -1), h: +buildingHeight(t).toFixed(1), k: t.building !== 'yes' ? t.building : undefined });
        continue;
      }
      if (t.natural === 'tree_row') {
        // Trees every ~7 m along the row.
        for (let i = 0; i + 1 < r.length; i++) {
          const [a, b] = [r[i], r[i + 1]];
          const d = Math.hypot((b[0] - a[0]) * 111000, (b[1] - a[1]) * 111000 * Math.cos((a[0] * Math.PI) / 180));
          const n = Math.max(1, Math.round(d / 7));
          for (let k = 0; k < n; k++) env.trees.push([+(a[0] + ((b[0] - a[0]) * k) / n).toFixed(6), +(a[1] + ((b[1] - a[1]) * k) / n).toFixed(6)]);
        }
        continue;
      }
      const ak = closed ? areaKind(t) : null;
      if (ak) {
        env.areas.push({ k: ak, p: r.slice(0, -1) });
        continue;
      }
      const lk = lineKind(t);
      if (lk) env.lines.push({ k: lk, p: r });
    }
  }
  return env;
}

export async function fetchEnv(track: TrackData, signal?: AbortSignal): Promise<EnvData> {
  const bbox = envBBox(track);
  const b = bbox.map((x) => x.toFixed(6)).join(',');
  const q = `[out:json][timeout:60];(
    way["building"](${b});
    relation["building"](${b});
    way["landuse"](${b});
    way["natural"~"^(wood|scrub|heath|water|grassland|sand|beach|wetland|tree_row)$"](${b});
    way["leisure"~"^(park|garden|pitch|playground|golf_course|track)$"](${b});
    way["amenity"="parking"](${b});
    way["highway"](${b});
    way["railway"~"^(rail|light_rail|subway|narrow_gauge|tram)$"](${b});
    way["waterway"~"^(river|stream|canal|drain|ditch)$"](${b});
    relation["natural"~"^(water|wood)$"](${b});
    relation["landuse"~"^(forest|grass|reservoir)$"](${b});
    node["natural"="tree"](${b});
  );out geom qt;`;
  const data = await overpass(q, signal);
  return parseEnv(data.elements, bbox);
}
