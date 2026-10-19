// Fallback data source for the baker when Overpass is down: the main OSM API's
// /map call, converted to Overpass-style elements ("out body geom").
// Only for occasional, small, developer-run requests (per the OSM API usage policy).

const UA = 'ApexKart track baker (github.com/Cyrus-Krispin/apexkart)';

export async function osmApiElements(bbox: [number, number, number, number]): Promise<any[]> {
  const [s, w, n, e] = bbox;
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${w},${s},${e},${n}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OSM API ${res.status}`);
  const data = await res.json();
  const nodes = new Map<number, { lat: number; lon: number }>();
  for (const el of data.elements) if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lon: el.lon });
  const out: any[] = [];
  for (const el of data.elements) {
    if (el.type === 'node') {
      if (el.tags) out.push(el);
    } else if (el.type === 'way') {
      const geometry = el.nodes.map((id: number) => nodes.get(id));
      if (geometry.some((g: unknown) => !g)) continue; // partially outside the bbox
      out.push({ ...el, geometry });
    }
  }
  return out;
}

export function bboxAround(lat: number, lon: number, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / 111000;
  const dLon = radiusM / (111000 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}
