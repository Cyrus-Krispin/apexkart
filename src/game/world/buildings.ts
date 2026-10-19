// OpenStreetMap buildings extruded into a stylised low-poly city block.
import * as THREE from 'three';
import type { EnvData } from '../../track/env';
import type { TrackModel } from '../track';
import { centroid, hashString, pointInPolygon, polygonArea, projectRing, rng, type Pt } from './common';

const WALLS = ['#ece6da', '#e4ddcf', '#d6d2c9', '#ddd7cb', '#e8d2b8', '#cfd8cc', '#d9bfae', '#c9d1d8', '#efe9df', '#d8d0c0'];
const ROOFS = ['#8d8a83', '#7a7873', '#9a968d', '#6f6d68', '#a08670'];
const CELL = 3.2; // metres per window cell (one storey)

function windowTexture(kind: 'office' | 'shed'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  if (kind === 'office') {
    // Floor slab line and a window with a sky-ish reflection gradient.
    g.fillStyle = '#d9d6cf';
    g.fillRect(0, 118, 128, 10);
    const grd = g.createLinearGradient(0, 30, 0, 100);
    grd.addColorStop(0, '#5d7183');
    grd.addColorStop(0.55, '#3a4a58');
    grd.addColorStop(1, '#2c3843');
    g.fillStyle = grd;
    g.fillRect(22, 30, 84, 70);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.moveTo(22, 30);
    g.lineTo(60, 30);
    g.lineTo(22, 74);
    g.fill();
    g.fillStyle = '#c9c5bd';
    g.fillRect(20, 100, 88, 5);
  } else {
    // Profiled cladding with a high strip window.
    for (let x = 0; x < 128; x += 8) {
      g.fillStyle = x % 16 ? '#f1f0ec' : '#dcdad4';
      g.fillRect(x, 0, 8, 128);
    }
    g.fillStyle = '#4a5866';
    g.fillRect(0, 14, 128, 14);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

interface Built {
  group: THREE.Group;
  footprints: { pts: Pt[]; h: number }[];
}

export function buildBuildings(track: TrackModel, env: EnvData | null, seed: string): Built {
  const group = new THREE.Group();
  const footprints: Built['footprints'] = [];
  if (!env?.buildings.length) return { group, footprints };
  const rand = rng(hashString(seed));
  const geo = {
    office: { pos: [] as number[], uv: [] as number[], col: [] as number[] },
    shed: { pos: [] as number[], uv: [] as number[], col: [] as number[] },
    roof: { pos: [] as number[], col: [] as number[] },
  };
  const clutter: { x: number; z: number; y: number; s: number; h: number; r: number }[] = [];
  const color = new THREE.Color();

  for (const b of env.buildings) {
    let pts = projectRing(track, b.p);
    if (pts.length < 3) continue;
    const area = polygonArea(pts);
    if (area < 0) pts = pts.reverse(); // consistent winding: positive area = clockwise seen from above
    const A = Math.abs(area);
    if (A < 8) continue;
    const [cx, cz] = centroid(pts);
    // Never build on the circuit.
    if (!track.clearOfTrack(cx, cz, track.halfWidth + 2)) continue;

    let h = b.h;
    if (!h) {
      // Unknown height: estimate from footprint, with some variety.
      h = A < 40 ? 3.2 : A < 160 ? 5 + rand() * 3 : A < 900 ? 7 + rand() * 6 : A < 3000 ? 9 + rand() * 6 : 11 + rand() * 7;
    }
    h = Math.max(3, Math.min(160, h));
    const shed = !b.k?.match(/apartments|office|commercial|hotel|residential|house|school/) && A > 1200 && h < 18;
    const target = shed ? geo.shed : geo.office;
    color.set(WALLS[Math.floor(rand() * WALLS.length)]);
    const tint = 0.94 + rand() * 0.08;
    const wr = color.r * tint;
    const wg = color.g * tint;
    const wb = color.b * tint;

    // Walls: one quad per edge, UVs in storey-sized cells so windows tile per floor.
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[(i + 1) % pts.length];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      const u0 = run / CELL;
      const u1 = (run + len) / CELL;
      run += len;
      const v1 = h / CELL;
      // Clockwise footprint (seen from above): this order makes each quad face outward.
      const quad = [ax, 0, az, bx, h, bz, bx, 0, bz, ax, 0, az, ax, h, az, bx, h, bz];
      const uvs = [u0, 0, u1, v1, u1, 0, u0, 0, u0, v1, u1, v1];
      target.pos.push(...quad);
      target.uv.push(...uvs);
      for (let k = 0; k < 6; k++) {
        // Slight darkening towards the ground for depth.
        const y = quad[k * 3 + 1];
        const shade = y === 0 ? 0.82 : 1;
        target.col.push(wr * shade, wg * shade, wb * shade);
      }
    }

    // Flat roof.
    const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    color.set(ROOFS[Math.floor(rand() * ROOFS.length)]);
    for (const tri of tris) {
      const [p0, p1, p2] = tri.map((i) => pts[i]);
      // Order each triangle so its normal points up (+y).
      const up = (p1[1] - p0[1]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[1] - p0[1]) > 0;
      for (const idx of up ? tri : [tri[0], tri[2], tri[1]]) {
        geo.roof.pos.push(pts[idx][0], h, pts[idx][1]);
        geo.roof.col.push(color.r, color.g, color.b);
      }
    }
    footprints.push({ pts, h });

    // Rooftop clutter: AC units and a stair core on bigger roofs.
    if (A > 120) {
      const n = Math.min(6, Math.floor(A / 250) + 1);
      let tries = 0;
      for (let k = 0; k < n && tries < 30; tries++) {
        const xs = pts.map((p) => p[0]);
        const zs = pts.map((p) => p[1]);
        const x = Math.min(...xs) + rand() * (Math.max(...xs) - Math.min(...xs));
        const z = Math.min(...zs) + rand() * (Math.max(...zs) - Math.min(...zs));
        if (!pointInPolygon(x, z, pts)) continue;
        const big = k === 0 && A > 600;
        clutter.push({ x, z, y: h, s: big ? 3.2 : 1.2 + rand() * 0.8, h: big ? 2.6 : 0.9 + rand() * 0.5, r: rand() * Math.PI });
        k++;
      }
    }
  }

  const mk = (g: { pos: number[]; uv?: number[]; col: number[] }, mat: THREE.Material) => {
    if (!g.pos.length) return;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    if (g.uv) bg.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    bg.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
    bg.computeVertexNormals();
    const m = new THREE.Mesh(bg, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  mk(geo.office, new THREE.MeshStandardMaterial({ map: windowTexture('office'), vertexColors: true, roughness: 0.75, metalness: 0.02 }));
  mk(geo.shed, new THREE.MeshStandardMaterial({ map: windowTexture('shed'), vertexColors: true, roughness: 0.6, metalness: 0.1 }));
  mk(geo.roof, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));

  if (clutter.length) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.6, metalness: 0.2 }), clutter.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    clutter.forEach((c, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.r);
      m.compose(new THREE.Vector3(c.x, c.y + c.h / 2, c.z), q, new THREE.Vector3(c.s, c.h, c.s * 0.8));
      inst.setMatrixAt(i, m);
    });
    inst.castShadow = true;
    group.add(inst);
  }
  return { group, footprints };
}
