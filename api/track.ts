// GET /api/track?id=: geometry for a track someone has raced (stored on first lap),
// so shared links and the live feed don't depend on OpenStreetMap's Overpass API.
import { getStore, K, json, bad, TRACK_RE } from './_lib/store.js';
import { waysFromId } from '../src/track/osm.js';

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!TRACK_RE.test(id)) return bad('bad id');
  const raw = await getStore().get(K.track(id));
  const meta = raw ? JSON.parse(raw) : null;
  if (!meta?.points) return json(null, 200, 'public, s-maxage=30');
  return json(
    {
      id,
      name: meta.name,
      location: '',
      center: meta.center,
      points: meta.points,
      width: meta.width ?? 8,
      lengthM: meta.lengthM,
      osmWays: waysFromId(id) ?? [],
      source: 'OpenStreetMap',
    },
    200,
    'public, s-maxage=86400',
  );
}
