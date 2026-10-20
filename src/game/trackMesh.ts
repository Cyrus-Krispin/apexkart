import * as THREE from 'three';
import type { TrackModel } from './track';
import { addDetail } from './world/ground';
import { trackQuery } from './trackQuery';
import { bigStops, racingLine } from './kerbs';
import { gridPose } from './raceMode';

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
      // (The rubbered racing line is vertex colour now, following an actual racing line.)
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
  const col: number[] = [];
  const idx: number[] = [];
  const covered = new Uint8Array((n + 1) * C);
  // Rubber laid down along the racing line (darker where karts brake for the big corners), and
  // faint low-frequency patching so long straights aren't one flat grey. Vertex colour only.
  const line = racingLine(track);
  const brake = new Float32Array(n);
  for (const st of bigStops(track)) {
    const len = Math.max(1, st.turnIn - st.brakeFrom);
    for (let k = st.brakeFrom; k <= st.turnIn + 4; k++) brake[((k % n) + n) % n] = Math.min(1, (k - st.brakeFrom) / len) * (k > st.turnIn ? 0.5 : 1);
  }
  const ds = track.length / n;
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
      const d = (o - line[i]) / 0.85;
      const rubber = Math.exp(-d * d) * (0.2 + 0.18 * brake[i]);
      const shade = (1 - rubber) * (1 + 0.05 * patchNoise((k * ds) / 17, o / 2.6));
      col.push(shade, shade, shade);
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
            col.push(col[q * 3], col[q * 3 + 1], col[q * 3 + 2]);
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
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Smooth value noise in [-1, 1] (deterministic), for gentle variation across the asphalt. */
function patchNoise(x: number, y: number): number {
  const h = (i: number, j: number) => {
    const q = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return (q - Math.floor(q)) * 2 - 1;
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * sx;
  const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * sx;
  return a + (b - a) * sy;
}

function roadMaterial(aniso: number) {
  const m = new THREE.MeshStandardMaterial({ map: asphaltTexture(aniso), vertexColors: true, roughness: 0.88, metalness: 0 });
  addDetail(m, 0.9, 0.16);
  return m;
}

/**
 * Painted on the asphalt, in one transparent draw: grid boxes with slot numbers and a pole line
 * behind the start, and braking marks along the racing line into the biggest stops.
 */
function buildMarkings(track: TrackModel, aniso: number): THREE.Mesh | null {
  const tex = canvasTex(
    256,
    256,
    (g) => {
      // Top-left: solid white for painted lines.
      g.fillStyle = '#f2f0ea';
      g.fillRect(0, 0, 64, 64);
      // Top-right: slot numbers 1-8 (48 x 64 cells).
      g.font = '800 54px Archivo, Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let k = 0; k < 8; k++) g.fillText(String(k + 1), 64 + (k % 4) * 48 + 24, (k < 4 ? 0 : 64) + 36);
      // Bottom half: braking streaks, two variants side by side. Rows run from the braking point
      // (bottom, faint) to the turn-in (top), tyre lines ~1.1 m apart.
      for (let variant = 0; variant < 2; variant++) {
        for (let y = 128; y < 256; y++) {
          const f = (255 - y) / 127; // 0 at the braking point, 1 at the turn-in
          const a = Math.min(1, f / 0.35) * (1 - Math.max(0, (f - 0.82) / 0.18));
          for (const wheel of [-1, 1]) {
            for (let line = 0; line < 3; line++) {
              const cx = variant * 128 + 64 + wheel * 38 + (line - 1) * 4 + Math.sin(y * 0.05 + line + variant * 2) * 1.5;
              g.fillStyle = `rgba(14,14,16,${(a * (0.22 + 0.12 * ((line + variant) % 2))).toFixed(3)})`;
              g.fillRect(cx - 1.5, y, 3, 1);
            }
          }
        }
      }
    },
    aniso,
  );
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const pos: number[] = [];
  const uv: number[] = [];
  const Y = 0.046;
  // Quad from four ground points (back-left, back-right, front-right, front-left), facing up.
  const quad = (BL: number[], BR: number[], FR: number[], FL: number[], u0: number, u1: number, v0: number, v1: number) => {
    const P = [BL, BR, FL, BR, FR, FL];
    const T = [
      [u0, v0],
      [u1, v0],
      [u0, v1],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
    P.forEach((p, k) => {
      pos.push(p[0], Y, p[1]);
      uv.push(T[k][0], T[k][1]);
    });
  };
  // A rectangle in a frame along the track at lap distance s: along [a0, a1], across [c0, c1].
  const rect = (s: number, base: number, a0: number, a1: number, c0: number, c1: number, u0: number, u1: number, v0: number, v1: number) => {
    const p = track.at(s);
    const tx = track.tx[p.i];
    const tz = track.tz[p.i];
    const [nx, nz] = track.normal(p.i);
    const at = (a: number, c: number) => [p.x + tx * a + nx * (base + c), p.z + tz * a + nz * (base + c)];
    quad(at(a0, c0), at(a0, c1), at(a1, c1), at(a1, c0), u0, u1, v0, v1);
  };
  const W = [0.02, 0.23, 0.77, 0.98]; // white block: u0, u1, v0, v1
  const hw = track.halfWidth;

  // Grid: a box per multiplayer slot (a bar in front of the kart's nose and a line down its
  // outer side), the slot number in front of it, and a pole line across the road.
  const slots = 8;
  const p0 = gridPose(track, 0);
  rect(p0.s, 0, 1.12, 1.2, -hw + 0.35, hw - 0.35, W[0], W[1], W[2], W[3]);
  for (let k = 0; k < slots; k++) {
    const g = gridPose(track, k);
    const side = k % 2 ? 1 : -1;
    const base = side * Math.min(2, hw * 0.45);
    rect(g.s, base, 1.0, 1.12, -0.85, 0.85, W[0], W[1], W[2], W[3]);
    const outer = side * 0.85;
    rect(g.s, base, -1.3, 1.0, Math.min(outer, outer - side * 0.11), Math.max(outer, outer - side * 0.11), W[0], W[1], W[2], W[3]);
    const cu = 64 + (k % 4) * 48;
    const cv = k < 4 ? 0 : 64;
    rect(g.s, base, 1.35, 2.15, -0.3, 0.3, cu / 256 + 0.01, (cu + 48) / 256 - 0.01, 1 - (cv + 64) / 256 + 0.01, 1 - cv / 256 - 0.01);
  }

  // Braking marks: two sets of tyre streaks along the racing line from the braking point to
  // just past the turn-in.
  const n = track.n;
  const line = racingLine(track);
  for (const st of bigStops(track)) {
    for (const [variant, shift, w] of [
      [0, -0.18, 0.75],
      [1, 0.22, 0.7],
    ] as const) {
      const k0 = st.brakeFrom + Math.round(variant * 3);
      const k1 = st.turnIn + 2;
      let prev: number[][] | null = null;
      for (let k = k0; k <= k1; k++) {
        const q = ((k % n) + n) % n;
        const [nx, nz] = track.normal(q);
        const o = line[q] + shift;
        const L = [track.px[q] + nx * (o - w), track.pz[q] + nz * (o - w)];
        const R = [track.px[q] + nx * (o + w), track.pz[q] + nz * (o + w)];
        const v = ((k - k0) / Math.max(1, k1 - k0)) * 0.5;
        const row = [L, R, [v]];
        if (prev) quad(prev[0], prev[1], R, L, variant * 0.5, variant * 0.5 + 0.5, prev[2][0], v);
        prev = row;
      }
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
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
  const markings = buildMarkings(track, aniso);
  if (markings) group.add(markings);

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
