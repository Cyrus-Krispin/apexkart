// Low-poly, instanced trees: mapped trees, woods, parks, and a framing tree line.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EnvData } from '../../track/env';
import type { TrackModel } from '../track';
import type { GroundPainter } from './ground';
import { hashString, Land, pointInPolygon, projectRing, rng, type Pt } from './common';
import type { MaterialFactory } from './materials';

type Variant = 'broadleaf' | 'conifer' | 'raintree' | 'palm';

function colored(geo: THREE.BufferGeometry, hex: string, jitter = 0, seed = 1): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const cols = new Float32Array(n * 3);
  const r = rng(seed);
  for (let i = 0; i < n; i += 3) {
    // Per-face variation reads as faceted foliage.
    const k = 1 + (r() - 0.5) * jitter;
    for (let v = 0; v < 3; v++) {
      cols[(i + v) * 3] = c.r * k;
      cols[(i + v) * 3 + 1] = c.g * k;
      cols[(i + v) * 3 + 2] = c.b * k;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.deleteAttribute('uv');
  return g;
}

function variantGeometry(v: Variant): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = (r0: number, r1: number, h: number) => colored(new THREE.CylinderGeometry(r1, r0, h, 6).translate(0, h / 2, 0), '#6b4f36', 0.1, 3);
  if (v === 'broadleaf') {
    parts.push(trunk(0.28, 0.2, 2.6));
    parts.push(colored(new THREE.IcosahedronGeometry(2.1, 0).translate(0, 4.2, 0), '#4f7d35', 0.25, 11));
    parts.push(colored(new THREE.IcosahedronGeometry(1.6, 0).translate(1.2, 3.5, 0.5), '#5a8a3c', 0.25, 12));
    parts.push(colored(new THREE.IcosahedronGeometry(1.5, 0).translate(-1.0, 3.7, -0.7), '#47742f', 0.25, 13));
  } else if (v === 'conifer') {
    parts.push(trunk(0.25, 0.18, 1.6));
    parts.push(colored(new THREE.ConeGeometry(2.0, 3.2, 7).translate(0, 2.9, 0), '#355f32', 0.2, 21));
    parts.push(colored(new THREE.ConeGeometry(1.6, 2.8, 7).translate(0, 4.6, 0), '#3b6a37', 0.2, 22));
    parts.push(colored(new THREE.ConeGeometry(1.1, 2.4, 7).translate(0, 6.2, 0), '#42733c', 0.2, 23));
  } else if (v === 'raintree') {
    parts.push(trunk(0.42, 0.3, 3.4));
    parts.push(colored(new THREE.CylinderGeometry(0.16, 0.22, 2.2, 5).rotateZ(0.7).translate(0.8, 3.9, 0), '#6b4f36', 0.1, 4));
    parts.push(colored(new THREE.IcosahedronGeometry(3.6, 0).scale(1, 0.42, 1).translate(0, 5.4, 0), '#4e8a35', 0.22, 31));
    parts.push(colored(new THREE.IcosahedronGeometry(2.6, 0).scale(1, 0.45, 1).rotateY(0.6).translate(-0.4, 6.0, 0.3), '#55913b', 0.22, 34));
    parts.push(colored(new THREE.IcosahedronGeometry(2.2, 0).scale(1, 0.5, 1).translate(1.8, 5.0, 1.0), '#5a9640', 0.22, 32));
    parts.push(colored(new THREE.IcosahedronGeometry(2.0, 0).scale(1, 0.5, 1).translate(-1.9, 5.1, -0.8), '#46802f', 0.22, 33));
  } else {
    // Palm: segmented leaning trunk + drooping fronds.
    let x = 0;
    for (let k = 0; k < 4; k++) {
      parts.push(colored(new THREE.CylinderGeometry(0.17, 0.2, 1.9, 6).translate(x, 0.95 + k * 1.85, 0), k % 2 ? '#8a7053' : '#7a6248', 0.08, 40 + k));
      x += 0.18;
    }
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const frond = new THREE.ConeGeometry(0.45, 3.4, 4).scale(1, 1, 0.25).rotateZ(-Math.PI / 2 - 0.45).translate(1.6, 0, 0).rotateY(a).translate(x, 7.6, 0);
      parts.push(colored(frond, '#4f8a33', 0.25, 50 + k));
    }
  }
  return mergeGeometries(parts)!;
}

interface Placement {
  x: number;
  z: number;
  s: number;
  r: number;
  v: Variant;
}

export function buildTrees(track: TrackModel, env: EnvData | null, ground: GroundPainter | null, seed: string, cap: number, mat: MaterialFactory) {
  const rand = rng(hashString(seed + ':trees'));
  const tropical = Math.abs(track.proj.lat0) < 24;
  const pick = (): Variant => (tropical ? (rand() < 0.62 ? 'raintree' : rand() < 0.6 ? 'palm' : 'broadleaf') : rand() < 0.62 ? 'broadleaf' : 'conifer');
  const minTrack = track.halfWidth + track.runoff + 5;
  const placements: Placement[] = [];
  const ok = (x: number, z: number) => {
    if (!track.clearOfTrack(x, z, minTrack)) return false;
    if (!ground) return true;
    const c = ground.classAt(x, z);
    return c !== Land.Water && c !== Land.Paved && c !== Land.Building && c !== Land.Track;
  };
  const add = (x: number, z: number, v?: Variant, scale = 1) => {
    if (placements.length >= cap || !ok(x, z)) return;
    placements.push({ x, z, s: (0.75 + rand() * 0.6) * scale, r: rand() * Math.PI * 2, v: v ?? pick() });
  };

  // 1. Individually mapped trees.
  for (const t of env?.trees ?? []) {
    const p = track.proj.toLocal(t[0], t[1]);
    add(p.x, p.z);
  }
  // 2. Woods and parks.
  for (const a of env?.areas ?? []) {
    const dense = a.k === 'forest';
    const sparse = a.k === 'park' || a.k === 'scrub' || a.k === 'grass';
    if (!dense && !sparse) continue;
    const pts: Pt[] = projectRing(track, a.p);
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    const step = dense ? 6.5 : a.k === 'scrub' ? 12 : 24;
    for (let x = Math.min(...xs); x < Math.max(...xs); x += step)
      for (let z = Math.min(...zs); z < Math.max(...zs); z += step) {
        const jx = x + (rand() - 0.5) * step * 0.9;
        const jz = z + (rand() - 0.5) * step * 0.9;
        if (ground && !ground.contains(jx, jz, 4)) continue;
        if (!dense && rand() > 0.55) continue;
        if (pointInPolygon(jx, jz, pts)) add(jx, jz);
      }
  }
  // 3. A natural tree line framing the circuit, in open grass beyond the barriers.
  const band = 40;
  for (let i = 0; i < track.n; i += 2) {
    for (const side of [-1, 1]) {
      if (rand() > 0.7) continue;
      const [nx, nz] = track.normal(i);
      // Bias towards the near edge so the tree line reads from the racing line.
      const d = minTrack + 1 + band * rand() ** 1.6;
      const x = track.px[i] + nx * side * d + (rand() - 0.5) * 6;
      const z = track.pz[i] + nz * side * d + (rand() - 0.5) * 6;
      if (ground && ground.classAt(x, z) !== Land.Grass && ground.classAt(x, z) !== Land.Forest) continue;
      add(x, z);
    }
  }

  const group = new THREE.Group();
  const material = mat({ vertexColors: true, roughness: 0.85, flatShading: true });
  // Chunk instances spatially so the renderer can skip off-screen chunks and the shadow pass
  // only draws trees near the kart (one big InstancedMesh can't be culled at all).
  const CHUNK = 70;
  const chunks = new Map<string, Placement[]>();
  for (const p of placements) {
    const key = `${p.v}:${Math.floor(p.x / CHUNK)}:${Math.floor(p.z / CHUNK)}`;
    let list = chunks.get(key);
    if (!list) chunks.set(key, (list = []));
    list.push(p);
  }
  const geos = new Map<Variant, THREE.BufferGeometry>();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  for (const [key, list] of chunks) {
    const v = key.split(':')[0] as Variant;
    let geo = geos.get(v);
    if (!geo) geos.set(v, (geo = variantGeometry(v)));
    const inst = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((p, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.r);
      m.compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(p.s, p.s * (0.9 + rand() * 0.25), p.s));
      inst.setMatrixAt(i, m);
      const tint = 0.85 + rand() * 0.25;
      inst.setColorAt(i, col.setRGB(tint, tint * (0.97 + rand() * 0.06), tint * 0.95));
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.computeBoundingSphere();
    group.add(inst);
  }
  // Soft contact shadows painted onto the ground under each tree.
  ground?.blobShadows(placements.map((p) => ({ x: p.x + 0.8, z: p.z + 0.8, r: (p.v === 'raintree' ? 4.6 : p.v === 'palm' ? 2.2 : 3.2) * p.s, a: 0.32 })));
  return { group, count: placements.length };
}

