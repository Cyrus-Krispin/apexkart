// Builds everything around the circuit, reporting progress for the intro screen.
import * as THREE from 'three';
import { fetchEnv, type EnvData } from '../../track/env';
import type { TrackData } from '../../track/osm';
import type { TrackModel } from '../track';
import type { Quality } from '../render';
import { buildSatelliteGround } from '../satellite';
import { GroundPainter, GROUND } from './ground';
import { buildBuildings } from './buildings';
import { buildTrees } from './trees';
import { buildTrackside } from './trackside';
import { trackExtent, type Extent } from './common';

export type WorldStyle = 'stylised' | 'satellite';

export function initialStyle(): WorldStyle {
  return localStorage.getItem('ak:style') === 'satellite' ? 'satellite' : 'stylised';
}

export interface World {
  group: THREE.Group;
  groundColor: THREE.Color;
  emissive: THREE.MeshStandardMaterial[];
  stats: { buildings: number; trees: number; env: boolean };
}

const envCache = new Map<string, EnvData | null>();

async function loadEnv(data: TrackData): Promise<EnvData | null> {
  if (envCache.has(data.id)) return envCache.get(data.id)!;
  let env: EnvData | null = null;
  try {
    const r = await fetch(`/tracks/env/${data.id}.json`);
    if (r.ok && r.headers.get('content-type')?.includes('json')) env = await r.json();
  } catch {
    /* fall through to a live fetch */
  }
  if (!env) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      env = await fetchEnv(data, ctl.signal);
    } catch {
      env = null; // the procedural world still works without it
    } finally {
      clearTimeout(timer);
    }
  }
  envCache.set(data.id, env);
  return env;
}

// Yield between heavy steps so the intro stays responsive (rAF would stall in background tabs).
const frame = () => new Promise((r) => setTimeout(r, 16));

export async function buildWorld(o: {
  track: TrackModel;
  data: TrackData;
  style: WorldStyle;
  quality: Quality;
  aniso: number;
  onStage: (label: string, frac: number) => void;
  isDisposed: () => boolean;
}): Promise<World | null> {
  const { track, data } = o;
  const group = new THREE.Group();
  o.onStage('Mapping the surroundings', 0.05);
  const env = await loadEnv(data);
  if (o.isDisposed()) return null;

  let extent: Extent = trackExtent(track, 320);
  if (env) {
    const [s, w, n, e] = env.bbox;
    const nw = track.proj.toLocal(n, w);
    const se = track.proj.toLocal(s, e);
    extent = { x0: nw.x, z0: nw.z, x1: se.x, z1: se.z };
  }

  o.onStage('Painting the ground', 0.25);
  await frame();
  const stylised = o.style === 'stylised';
  const painter = new GroundPainter(track, env, extent, stylised ? (o.quality === 'low' ? 2048 : 4096) : 1024);
  painter.paint();
  if (o.isDisposed()) return null;

  o.onStage('Raising buildings', 0.45);
  await frame();
  const b = buildBuildings(track, env, data.id);
  group.add(b.group);

  o.onStage('Planting trees', 0.6);
  await frame();
  const trees = buildTrees(track, env, painter, data.id, o.quality === 'high' ? 3600 : o.quality === 'medium' ? 2400 : 1100);
  group.add(trees.group);

  o.onStage('Building the circuit', 0.72);
  await frame();
  const side = buildTrackside(track, painter, data.id, o.aniso);
  group.add(side.group);

  let groundColor = new THREE.Color(GROUND.grass);
  if (stylised) {
    o.onStage('Finishing touches', 0.9);
    await frame();
    group.add(painter.toMesh(o.aniso));
  } else {
    o.onStage('Loading satellite imagery', 0.75);
    const sat = await buildSatelliteGround(track, o.aniso, (d, t) => o.onStage('Loading satellite imagery', 0.75 + 0.25 * (d / Math.max(1, t))));
    if (sat) {
      sat.mesh.position.y = -0.02;
      group.add(sat.mesh);
      groundColor = sat.edgeColor;
    } else group.add(painter.toMesh(o.aniso));
  }
  o.onStage('Ready', 1);
  return { group, groundColor, emissive: side.emissive, stats: { buildings: b.footprints.length, trees: trees.count, env: !!env } };
}
