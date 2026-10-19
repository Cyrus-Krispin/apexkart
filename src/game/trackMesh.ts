import * as THREE from 'three';
import type { TrackModel } from './track';

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

function ribbon(
  track: TrackModel,
  from: number,
  to: number,
  inner: number,
  outer: number,
  y: number,
  vScale: number,
): THREE.BufferGeometry {
  if (inner > outer) [inner, outer] = [outer, inner]; // keep winding facing up
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const count = to - from + 1;
  for (let k = 0; k < count; k++) {
    const i = (from + k) % track.n;
    const [nx, nz] = track.normal(i);
    const x = track.px[i];
    const z = track.pz[i];
    pos.push(x + nx * inner, y, z + nz * inner, x + nx * outer, y, z + nz * outer);
    const v = (k * track.length) / track.n / vScale;
    uv.push(0, v, 1, v);
    if (k < count - 1) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface TrackScene {
  group: THREE.Group;
  lights: THREE.MeshStandardMaterial[]; // 5 start lights
}

export function buildTrackScene(track: TrackModel, aniso: number): TrackScene {
  const group = new THREE.Group();
  const hw = track.halfWidth;

  // Road (closed loop: wrap one extra sample).
  const road = new THREE.Mesh(
    ribbon(track, 0, track.n, -hw, hw, 0.04, hw * 2),
    new THREE.MeshStandardMaterial({ map: asphaltTexture(aniso), roughness: 0.92, metalness: 0 }),
  );
  road.receiveShadow = true;
  group.add(road);

  // Kerbs on corners, both sides.
  const kerbTex = canvasTex(
    64,
    64,
    (g) => {
      g.fillStyle = '#d8262c';
      g.fillRect(0, 0, 64, 32);
      g.fillStyle = '#f3f3f3';
      g.fillRect(0, 32, 64, 32);
    },
    aniso,
  );
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.7 });
  const isCorner = (i: number) => Math.abs(track.curv[i]) > 0.028;
  const visited = new Uint8Array(track.n);
  for (let i = 0; i < track.n; i++) {
    if (visited[i] || !isCorner(i)) continue;
    let a = i;
    while (isCorner((a - 1 + track.n) % track.n) && a > i - track.n) a--;
    let b = i;
    while (isCorner((b + 1) % track.n) && b < a + track.n) b++;
    for (let k = a; k <= b; k++) visited[((k % track.n) + track.n) % track.n] = 1;
    const from = (a - 5 + track.n * 2) % track.n;
    const to = from + (b - a) + 10;
    for (const side of [-1, 1]) {
      const g = ribbon(track, from, to, side * hw, side * (hw + 1.1), 0.06, 2);
      group.add(Object.assign(new THREE.Mesh(g, kerbMat), { receiveShadow: true }));
    }
  }

  // Tyre walls on the outside of corners where there is room.
  const tyreGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.75, 10);
  const tyrePositions: THREE.Vector3[] = [];
  const wall = hw + track.runoff;
  for (let i = 0; i < track.n; i += 1) {
    if (Math.abs(track.curv[i]) < 0.018) continue;
    const side = track.curv[i] > 0 ? -1 : 1; // outside of the turn
    const [nx, nz] = track.normal(i);
    const x = track.px[i] + nx * side * wall;
    const z = track.pz[i] + nz * side * wall;
    if (!track.clearOfTrack(x, z, hw + 3)) continue;
    if (tyrePositions.length && tyrePositions[tyrePositions.length - 1].distanceTo(new THREE.Vector3(x, 0, z)) < 0.7) continue;
    tyrePositions.push(new THREE.Vector3(x, 0.37, z));
  }
  const tyres = new THREE.InstancedMesh(
    tyreGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    tyrePositions.length * 2,
  );
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  tyrePositions.forEach((p, k) => {
    for (let layer = 0; layer < 2; layer++) {
      m.makeTranslation(p.x, p.y + layer * 0.75, p.z);
      tyres.setMatrixAt(k * 2 + layer, m);
      const accent = Math.floor(k / 4) % 2 === 0 && layer === 1;
      tyres.setColorAt(k * 2 + layer, col.set(accent ? 0xe63946 : 0x18181a));
    }
  });
  tyres.castShadow = true;
  group.add(tyres);

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
  for (const s of [-1, 1]) {
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
