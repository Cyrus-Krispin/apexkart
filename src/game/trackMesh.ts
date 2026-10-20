import * as THREE from 'three';
import type { TrackModel } from './track';
import { addDetail } from './world/ground';
import { trackQuery } from './trackQuery';

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, aniso: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

function asphaltTexture(aniso: number) {
  return canvasTex(
    256,
    512,
    (g) => {
      g.fillStyle = '#3a3c40';
      g.fillRect(0, 0, 256, 512);
      const img = g.getImageData(0, 0, 256, 512);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 26;
        img.data[i] += n;
        img.data[i + 1] += n;
        img.data[i + 2] += n;
      }
      g.putImageData(img, 0, 0);
      // racing line rubber
      const grad = g.createLinearGradient(0, 0, 256, 0);
      grad.addColorStop(0.25, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, 'rgba(10,10,12,0.35)');
      grad.addColorStop(0.75, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 512);
      g.fillStyle = '#e8e8e8';
      g.fillRect(4, 0, 5, 512);
      g.fillRect(247, 0, 5, 512);
    },
    aniso,
  );
}

/** Offsets across the road for the ribbon's vertex columns: the edge-line strips, then ~0.7 m cells. */
function roadColumns(hw: number): number[] {
  const edge = 0.45;
  const cells = Math.max(2, Math.ceil((2 * (hw - edge)) / 0.75));
  const cols = [-hw];
  for (let c = 0; c <= cells; c++) cols.push(-hw + edge + (2 * (hw - edge) * c) / cells);
  cols.push(hw);
  return cols;
}

/**
 * The road surface: one ribbon round the lap, in columns across. Where the lap runs over itself
 * (a merge, or a bridge drawn flat) the later pass gives way to the earlier one, so one surface
 * wins instead of two fighting: its quads under the earlier road are dropped, and those near it
 * sit a few millimetres lower. Edge lines that would be painted across the other road are left
 * out (both passes), so a junction reads as one piece of asphalt.
 */
function roadGeometry(track: TrackModel, vScale: number): THREE.BufferGeometry {
  const hw = track.halfWidth;
  const n = track.n;
  const cols = roadColumns(hw);
  const C = cols.length;
  const tq = trackQuery(track);
  const Y = 0.04;
  const Y_UNDER = 0.028;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const covered = new Uint8Array((n + 1) * C);
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    const [nx, nz] = track.normal(i);
    const v = (k * track.length) / n / vScale;
    for (let c = 0; c < C; c++) {
      const o = cols[c];
      const x = track.px[i] + nx * o;
      const z = track.pz[i] + nz * o;
      const under = tq.nearestOther(x, z, i, hw + 1, 30, true);
      if (under && under.dist < hw - 0.05) covered[k * C + c] = 1;
      pos.push(x, under ? Y_UNDER : Y, z);
      uv.push((o + hw) / (2 * hw), v);
    }
  }
  for (let k = 0; k < n; k++) {
    const i = k % n;
    for (let c = 0; c < C - 1; c++) {
      const a = k * C + c;
      const b = a + 1;
      const d = a + C;
      const e = d + 1;
      if (covered[a] && covered[b] && covered[d] && covered[e]) continue; // under the earlier pass
      if (c === 0 || c === C - 2) {
        const cx = (pos[a * 3] + pos[b * 3] + pos[d * 3] + pos[e * 3]) / 4;
        const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[d * 3 + 2] + pos[e * 3 + 2]) / 4;
        if (tq.nearestOther(cx, cz, i, hw + 0.15, 30)) {
          // Edge-line strip lying on another section's road: shift its texture inwards, past the
          // painted line, so it shows plain asphalt.
          const base = pos.length / 3;
          const shift = c === 0 ? 0.06 : -0.06;
          for (const q of [a, b, d, e]) {
            pos.push(pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]);
            uv.push(uv[q * 2] + shift, uv[q * 2 + 1]);
          }
          idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
          continue;
        }
      }
      idx.push(a, b, d, b, e, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function roadMaterial(aniso: number) {
  const m = new THREE.MeshStandardMaterial({ map: asphaltTexture(aniso), roughness: 0.88, metalness: 0 });
  addDetail(m, 0.9, 0.16);
  return m;
}

export interface TrackScene {
  group: THREE.Group;
  lights: THREE.MeshStandardMaterial[]; // 5 start lights
}

export function buildTrackScene(track: TrackModel, aniso: number): TrackScene {
  const group = new THREE.Group();
  const hw = track.halfWidth;

  // Road (closed loop: one extra row closes it).
  const road = new THREE.Mesh(roadGeometry(track, hw * 2), roadMaterial(aniso));
  road.receiveShadow = true;
  group.add(road);

  // Start / finish: chequered strip + gantry with five start lights.
  const checker = canvasTex(
    256,
    32,
    (g) => {
      for (let x = 0; x < 16; x++)
        for (let y = 0; y < 2; y++) {
          g.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
          g.fillRect(x * 16, y * 16, 16, 16);
        }
    },
    aniso,
  );
  const sf = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 1.2), new THREE.MeshStandardMaterial({ map: checker }));
  const heading = Math.atan2(track.tx[0], track.tz[0]);
  const gantry = new THREE.Group();
  gantry.position.set(track.px[0], 0, track.pz[0]);
  gantry.rotation.y = heading;
  sf.position.y = 0.065;
  sf.rotation.x = -Math.PI / 2;
  gantry.add(sf);

  const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2d42, metalness: 0.5, roughness: 0.4 });
  // A post that would stand on another section of the lap (where the layout runs close by or
  // crosses over) is left out: the gantry becomes a cantilever from the other side.
  const tq = trackQuery(track);
  const [snx, snz] = track.normal(0); // gantry-local +x is the left of travel, i.e. -normal
  const blocked = [-1, 1].map((s) => !!tq.nearestOther(track.px[0] - snx * s * (hw + 0.8), track.pz[0] - snz * s * (hw + 0.8), 0, hw + 0.5, 30));
  for (const s of [-1, 1]) {
    if (blocked[s < 0 ? 0 : 1] && !(blocked[0] && blocked[1])) continue;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 5.2, 0.35), postMat);
    post.position.set(s * (hw + 0.8), 2.6, 0);
    post.castShadow = true;
    gantry.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 2, 0.9, 0.5), postMat);
  beam.position.set(0, 5, 0);
  beam.castShadow = true;
  gantry.add(beam);
  const lights: THREE.MeshStandardMaterial[] = [];
  for (let k = 0; k < 5; k++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a1a, emissiveIntensity: 0 });
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.22, 18), mat);
    // Lamps face oncoming karts (which approach from -z in gantry space).
    lamp.position.set((k - 2) * 0.7, 5, -0.26);
    lamp.rotation.y = Math.PI;
    gantry.add(lamp);
    lights.push(mat);
  }
  const banner = canvasTex(
    512,
    64,
    (g) => {
      g.fillStyle = '#0b0c10';
      g.fillRect(0, 0, 512, 64);
      g.font = 'bold 40px system-ui, sans-serif';
      g.fillStyle = '#ffd60a';
      g.textAlign = 'center';
      g.fillText('APEXKART', 256, 46);
    },
    aniso,
  );
  const bannerMesh = new THREE.Mesh(new THREE.PlaneGeometry(hw * 1.2, 0.5), new THREE.MeshBasicMaterial({ map: banner }));
  bannerMesh.position.set(0, 5.8, -0.26);
  bannerMesh.rotation.y = Math.PI;
  gantry.add(bannerMesh);
  group.add(gantry);

  return { group, lights };
}
