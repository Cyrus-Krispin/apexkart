// Circuit furniture: raised kerbs, branded tyre walls, floodlights, hoardings,
// grandstand, pit building and marshal posts. All procedural, placed from the
// track geometry and kept clear of other parts of the circuit.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TrackModel } from '../track';
import type { Lamp } from '../floodlights';
import { GROUND, type GroundPainter } from './ground';
import { hashString, Land, rng } from './common';
import { trackQuery } from '../trackQuery';
import { APRON_WIDTH, bigStops, KERB_PROFILE, KERB_WIDTH, kerbRuns, kerbWidthAt } from '../kerbs';
import type { MaterialFactory, WorldMaterial } from './materials';

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function tint(geo: THREE.BufferGeometry, hex: string) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

const SPONSORS: [string, string, string][] = [
  ['APEXKART', '#141414', '#ff4d00'],
  ['KERB & CO.', '#f2eee5', '#141414'],
  ['SECTOR 3 COFFEE', '#ff4d00', '#141414'],
  ['PADDOCK PAPER', '#141414', '#f2eee5'],
  ['LATE BRAKE TYRES', '#ffc600', '#141414'],
  ['FLYING LAP RADIO', '#2f4bff', '#f2eee5'],
];

export interface Trackside {
  group: THREE.Group;
  emissive: WorldMaterial[]; // floodlight heads (night/bloom)
  lamps: Lamp[]; // floodlight heads, aimed at the track
}

/**
 * The tyre wall's polylines, per side, ordered so that walking along a run the track is on the
 * right: points every 2 samples at the barrier, kept where no part of the circuit is near and the
 * land is buildable. A run is split wherever the piece between two points would cross road or
 * reach where a kart can drive (another section's, or its own where the offset line folds into a
 * chord at a tight corner), and where the offset line doubles back or kinks. Pieces shorter
 * than 12 m (orphan stubs in infields) are dropped.
 */
export function wallRuns(t: TrackModel, ground: GroundPainter | null): { side: number; pts: [number, number][] }[] {
  const hw = t.halfWidth;
  const wallOff = hw + t.runoff + 0.65;
  const reach = hw + t.runoff + 0.3; // a kart's body can get this close to a centreline
  const out: { side: number; pts: [number, number][] }[] = [];
  const landOk = (x: number, z: number) => {
    if (!ground) return true;
    const c = ground.classAt(x, z);
    return c !== Land.Building && c !== Land.Water;
  };
  const badPiece = (ax: number, az: number, bx: number, bz: number) => {
    const L = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(L));
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      if (!t.clearOfTrack(ax + (bx - ax) * f, az + (bz - az) * f, reach)) return true;
    }
    return false;
  };
  const length = (pts: [number, number][]) => {
    let L = 0;
    for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    return L;
  };
  for (const side of [-1, 1]) {
    const runs: [number, number][][] = [];
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length > 1) runs.push(run);
      run = [];
    };
    let lastI = -1;
    for (let i = 0; i <= t.n; i += 2) {
      const q = i % t.n;
      const [nx, nz] = t.normal(q);
      const x = t.px[q] + nx * side * wallOff;
      const z = t.pz[q] + nz * side * wallOff;
      if (!t.clearOfTrack(x, z, wallOff - 0.3) || !landOk(x, z)) {
        flush();
        continue;
      }
      const last = run[run.length - 1];
      if (last) {
        // Doubling back against the direction of travel, or a sharp kink: the offset line has
        // folded round the inside of a tight corner.
        const dx = x - last[0];
        const dz = z - last[1];
        const back = dx * t.tx[lastI] + dz * t.tz[lastI] < 0;
        let kink = false;
        if (run.length > 1) {
          const [px, pz] = run[run.length - 2];
          const ex = last[0] - px;
          const ez = last[1] - pz;
          kink = dx * ex + dz * ez < 0.5 * Math.hypot(dx, dz) * Math.hypot(ex, ez); // > 60°
        }
        if (back || kink || badPiece(last[0], last[1], x, z)) flush();
      }
      run.push([x, z]);
      lastI = q;
    }
    flush();
    // The lap closes: a run ending at the line carries on into the one starting there.
    if (runs.length > 1) {
      const first = runs[0];
      const last = runs[runs.length - 1];
      const [lx, lz] = last[last.length - 1];
      if (Math.hypot(lx - first[0][0], lz - first[0][1]) < 0.01) {
        runs[runs.length - 1] = last.concat(first.slice(1));
        runs.shift();
      }
    }
    for (const r of runs) {
      if (length(r) < 12) continue;
      // Right-hand walls are walked against the lap so the track is always on the run's right.
      out.push({ side, pts: side > 0 ? r.slice().reverse() : r });
    }
  }
  return out;
}

/** A local rectangle's corners in world x/z, for painting its contact shadow on the ground. */
function footprint(m: THREE.Matrix4, x0: number, x1: number, z0: number, z1: number): [number, number][] {
  const v = new THREE.Vector3();
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ].map(([x, z]) => {
    v.set(x, 0, z).applyMatrix4(m);
    return [v.x, v.z] as [number, number];
  });
}

export function buildTrackside(track: TrackModel, ground: GroundPainter | null, seed: string, aniso: number, mat: MaterialFactory): Trackside {
  const group = new THREE.Group();
  const rand = rng(hashString(seed + ':side'));
  const t = track;
  const hw = t.halfWidth;
  const wallOff = hw + t.runoff + 0.65; // inner face, where the kart body meets the physics barrier
  const emissive: WorldMaterial[] = [];
  const lamps: Lamp[] = [];
  const at = (i: number, side: number, off: number): [number, number] => {
    const q = ((i % t.n) + t.n) % t.n;
    const [nx, nz] = t.normal(q);
    return [t.px[q] + nx * side * off, t.pz[q] + nz * side * off];
  };
  const clearAt = (x: number, z: number, r: number) => t.clearOfTrack(x, z, r);
  const landOk = (x: number, z: number) => {
    if (!ground) return true;
    const c = ground.classAt(x, z);
    return c !== Land.Building && c !== Land.Water;
  };

  // ---------------------------------------------------------------- kerbs (raised)
  {
    // Left half: the kerb's red and white stripes, with rubber grime along the edge the tyres hit.
    // Right half: the concrete apron, with a darker lip at its outer edge so it meets the grass
    // with a crisp line.
    const kerbTex = canvasTex(128, 128, (g) => {
      g.fillStyle = '#d8262c';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#f3f1ea';
      g.fillRect(0, 64, 64, 64);
      // Grime: darkest at the track-side lip, gone ~0.35 m in, with a few streaks along the kerb.
      const grd = g.createLinearGradient(0, 0, 18, 0);
      grd.addColorStop(0, 'rgba(22,22,24,0.62)');
      grd.addColorStop(0.45, 'rgba(22,22,24,0.26)');
      grd.addColorStop(1, 'rgba(22,22,24,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 18, 128);
      const r = rng(77);
      for (let k = 0; k < 26; k++) {
        g.fillStyle = `rgba(22,22,24,${0.08 + r() * 0.14})`;
        g.fillRect(2 + r() * 20, r() * 128, 1 + r() * 2, 10 + r() * 40);
      }
      g.fillStyle = GROUND.apron;
      g.fillRect(64, 0, 56, 128);
      g.fillStyle = '#8c8678';
      g.fillRect(120, 0, 8, 128);
    });
    kerbTex.wrapT = THREE.RepeatWrapping;
    kerbTex.wrapS = THREE.ClampToEdgeWrapping;
    const pos: number[] = [];
    const uv: number[] = [];
    const tq = trackQuery(t);
    // Concrete apron round the whole lap (under the kerbs where there are kerbs), a real strip
    // with crisp edges instead of a band painted into the ground texture. Same mesh and material
    // as the kerbs, so it costs no extra draw call.
    for (const side of [-1, 1]) {
      let prev: number[][] | null = null;
      for (let k = 0; k <= t.n; k++) {
        const q = k % t.n;
        const [nx, nz] = t.normal(q);
        let w = Math.min(APRON_WIDTH, kerbWidthAt(t, q, side) * (APRON_WIDTH / KERB_WIDTH));
        // Where another section runs alongside, stop halfway so two aprons never overlap.
        const hit = tq.nearestOther(t.px[q] + nx * side * (hw + w), t.pz[q] + nz * side * (hw + w), q, hw + APRON_WIDTH + 0.05, 30);
        if (hit) w = Math.max(0.2, Math.min(w, (hw + w + hit.dist) / 2 - hw));
        const v = (k * t.length) / t.n / 2; // a red and a white stripe, 1 m each
        const row = [
          [-0.1, 36 / 64],
          [w - 0.12, 57 / 64],
          [w, 63 / 64],
        ].map(([o, u]) => [t.px[q] + nx * side * (hw + o), 0.01, t.pz[q] + nz * side * (hw + o), u, v]);
        if (prev) {
          for (let p = 0; p < 2; p++) {
            const A = prev[p];
            const B = prev[p + 1];
            const C = row[p + 1];
            const D = row[p];
            const tri = side > 0 ? [A, B, C, A, C, D] : [A, D, C, A, C, B];
            for (const v3 of tri) {
              pos.push(v3[0], v3[1], v3[2]);
              uv.push(v3[3], v3[4]);
            }
          }
        }
        prev = row;
      }
    }
    // Where the kerbs go is data shared with the physics (src/game/kerbs.ts): inside kerbs
    // from turn-in to just past the apex, outside kerbs on corner exits, none on kinks or on
    // another section of the lap.
    for (const run of kerbRuns(t)) {
      const side = run.side;
      let prev: number[][] | null = null;
      for (let k = run.i0; k <= run.i1; k++) {
        const q = k % t.n;
        const [nx, nz] = t.normal(q);
        const v = (k * t.length) / t.n / 2; // a red and a white stripe, 1 m each
        const w = kerbWidthAt(t, q, side) / KERB_WIDTH;
        // Ramp the ends down so a strip starts and stops flush with the ground (no open ends).
        const ramp = Math.min(1, (k - run.i0 + 0.35) / 2.2, (run.i1 - k + 0.35) / 2.2);
        const row = KERB_PROFILE.map(([o, y]) => {
          const off = hw + (o < 0 ? o : o * w);
          return [t.px[q] + nx * side * off, o < 0 ? y : Math.max(0.016, y * ramp), t.pz[q] + nz * side * off, ((o + 0.05) / 1.2) * 0.47, v];
        });
        if (prev) {
          for (let p = 0; p < KERB_PROFILE.length - 1; p++) {
            const A = prev[p];
            const B = prev[p + 1];
            const C = row[p + 1];
            const D = row[p];
            // Wound so the top faces up (counter-clockwise from above) on either side of the track.
            const tri = side > 0 ? [A, B, C, A, C, D] : [A, D, C, A, C, B];
            for (const v3 of tri) {
              pos.push(v3[0], v3[1], v3[2]);
              uv.push(v3[3], v3[4]);
            }
          }
        }
        prev = row;
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      // Every face is wound to face up (see above): front faces only, half the raster work.
      const m = new THREE.Mesh(g, mat({ map: kerbTex, roughness: 0.55 }));
      m.receiveShadow = true; // 10 cm kerbs and a flat apron: they cast no shadow (not worth the pass)
      group.add(m);
    }
  }

  // ---------------------------------------------------------------- tyre wall with belt
  {
    const belt = canvasTex(640, 64, (g) => {
      // Rows 0-47: belt panels facing the track; rows 48-63: dark tyre tops.
      const panels = ['#ff4d00', '#f2eee5', '#141414', '#f2eee5'];
      for (let k = 0; k < 5; k++) {
        g.fillStyle = panels[k % 4];
        g.fillRect(k * 128, 0, 128, 48);
      }
      g.font = '800 22px Archivo, Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#141414';
      g.fillText('APEXKART', 64, 25);
      g.fillStyle = '#ff4d00';
      g.fillText('APEXKART', 64 + 256, 25);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (let x = 0; x < 640; x += 128) g.fillRect(x, 0, 2, 48);
      g.fillStyle = '#1b1b1c';
      g.fillRect(0, 48, 640, 16);
      g.fillStyle = '#0d0d0e';
      for (let x = 8; x < 640; x += 18) {
        g.beginPath();
        g.arc(x, 56, 5, 0, Math.PI * 2);
        g.fill();
      }
    });
    belt.wrapT = THREE.ClampToEdgeWrapping;
    const H = 0.85;
    const T = 0.6;
    const pos: number[] = [];
    const uv: number[] = [];
    const push = (p: number[], u: number, v: number) => {
      pos.push(p[0], p[1], p[2]);
      uv.push(u, v);
    };
    const quad = (A: number[], B: number[], C: number[], D: number[], us: number[], v0: number, v1: number) => {
      // A-B along the bottom edge, D-C along the top; faces the side where A->B->C turns anticlockwise.
      const vs = [v0, v0, v1, v0, v1, v1];
      const uu = [us[0], us[1], us[1], us[0], us[1], us[0]];
      [A, B, C, A, C, D].forEach((P, m) => push(P, uu[m], vs[m]));
    };
    // Each run is walked with the track on its right, so the belt's front face (A->B->C) faces
    // the track and its texture runs left to right as seen from the kart: no mirrored text.
    const feet: [number, number][][] = [];
    for (const { pts } of wallRuns(t, ground)) {
      // The wall's foot for the painted contact shadow: its centreline, T/2 behind the inner face.
      feet.push(
        pts.map(([x, z], k) => {
          const [ax, az] = pts[Math.max(0, k - 1)];
          const [bx, bz] = pts[Math.min(pts.length - 1, k + 1)];
          const L = Math.hypot(bx - ax, bz - az) || 1;
          return [x + ((bz - az) / L) * T * 0.5, z - ((bx - ax) / L) * T * 0.5] as [number, number];
        }),
      );
      let u = 0;
      const corner = (k: number, ox: number, oz: number) => {
        const [x, z] = pts[k];
        return { p0: [x, 0, z], p1: [x, H, z], p2: [x + ox * T, H, z + oz * T], p3: [x + ox * T, 0, z + oz * T] };
      };
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k];
        const [bx, bz] = pts[k + 1];
        const L = Math.hypot(bx - ax, bz - az) || 1;
        // To the left of the run, away from the track (TrackModel.normal is (-tz, tx) = right).
        const ox = (bz - az) / L;
        const oz = -(bx - ax) / L;
        const a = corner(k, ox, oz);
        const b = corner(k + 1, ox, oz);
        const u0 = u;
        u += L / 12.5;
        quad(a.p0, b.p0, b.p1, a.p1, [u0, u], 0.25, 1); // front (belt)
        quad(a.p1, b.p1, b.p2, a.p2, [u0, u], 0.12, 0.12); // top
        quad(a.p2, b.p2, b.p3, a.p3, [u0, u], 0.1, 0.1); // back
        // End caps so an open end doesn't show the hollow inside.
        if (k === 0) quad(a.p3, a.p0, a.p1, a.p2, [0, 0.05], 0.1, 0.1);
        if (k + 2 === pts.length) quad(b.p0, b.p3, b.p2, b.p1, [0, 0.05], 0.1, 0.1);
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat({ map: belt, roughness: 0.7 }));
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    ground?.contactLines(feet, T + 1.3, 0.42);
  }

  // ---------------------------------------------------------------- floodlights
  {
    // One pole roughly every SPACING metres of lap, alternating sides, so the whole lap
    // is lit at night. Candidates every few metres find room on tight infields: a pole
    // only has to stand behind every tyre wall and keep clear of the other poles.
    const poles: THREE.Matrix4[] = [];
    const ds = t.length / t.n;
    const SPACING = 30;
    const tryStep = Math.max(1, Math.round(3 / ds));
    const placed: [number, number][] = [];
    let lastS = -Infinity;
    let k = 0;
    for (let i = 0; i < t.n; i += tryStep) {
      const s = i * ds;
      if (s - lastS < SPACING) continue;
      const pref = (k % 2 ? 1 : -1) * (t.curv[i] > 0 ? -1 : 1);
      let done = false;
      for (const off of [wallOff + 2.2, wallOff + 1.2, wallOff + 3.6, wallOff + 5.5]) {
        for (const sd of [pref, -pref]) {
          const [x, z] = at(i, sd, off);
          if (!clearAt(x, z, wallOff + 0.9) || !landOk(x, z)) continue;
          if (placed.some(([px, pz]) => (px - x) ** 2 + (pz - z) ** 2 < 16 ** 2)) continue;
          const [nx, nz] = t.normal(i);
          const yaw = Math.atan2(-nx * sd, -nz * sd); // face the track
          const pole = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
          poles.push(pole);
          placed.push([x, z]);
          const head = new THREE.Vector3(0, 8.7, 1.3).applyMatrix4(pole);
          lamps.push({ pos: head, dir: new THREE.Vector3(t.px[i], 0, t.pz[i]).sub(head).normalize() });
          lastS = s;
          k++;
          done = true;
          break;
        }
        if (done) break;
      }
    }
    if (poles.length) {
      const poleGeo = mergeGeometries([
        tint(new THREE.CylinderGeometry(0.1, 0.16, 9, 8).translate(0, 4.5, 0), '#9aa0a6'),
        tint(new THREE.BoxGeometry(0.12, 0.12, 1.6).translate(0, 8.9, 0.6), '#9aa0a6'),
        tint(new THREE.BoxGeometry(1.4, 0.5, 0.3).translate(0, 8.9, 1.3), '#2a2a2c'),
      ])!;
      const poleMesh = new THREE.InstancedMesh(poleGeo, mat({ vertexColors: true, metalness: 0.6, roughness: 0.4 }), poles.length);
      const lampMat = mat({ color: 0xfff6e0, emissive: 0xfff1d0, emissiveIntensity: 0.6 });
      emissive.push(lampMat);
      const lamp = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.2, 0.35).rotateX(Math.PI / 2 + 0.35).translate(0, 8.64, 1.3), lampMat, poles.length);
      poles.forEach((m, i) => {
        poleMesh.setMatrixAt(i, m);
        lamp.setMatrixAt(i, m);
      });
      poleMesh.castShadow = true;
      group.add(poleMesh, lamp);
    }
  }

  const boardSpots: [number, number][] = []; // braking boards; hoardings keep clear of them
  // ---------------------------------------------------------------- braking boards (3-2-1)
  {
    // Before the biggest stops of the lap: three boards counting down to the turn-in, behind the
    // tyre wall on the outside of the corner, turned to face the karts coming down the straight.
    const atlas = canvasTex(
      384,
      128,
      (g) => {
        for (let k = 0; k < 3; k++) {
          const x = k * 128;
          g.fillStyle = '#141414';
          g.fillRect(x, 0, 128, 128);
          g.fillStyle = '#f2eee5';
          g.fillRect(x + 8, 8, 112, 112);
          g.fillStyle = '#ff4d00';
          g.fillRect(x + 8, 8, 112, 16);
          g.fillStyle = '#141414';
          g.font = '800 88px Archivo, Arial, sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(String(3 - k), x + 64, 76);
        }
      },
      false,
    );
    const faces: THREE.BufferGeometry[] = [];
    const frames: THREE.BufferGeometry[] = [];
    const ds = t.length / t.n;
    const off = wallOff + 1.4;
    for (const stop of bigStops(t)) {
      const d = Math.max(8, Math.round((stop.turnIn - stop.brakeFrom) * ds / 2.5));
      const spots: { x: number; z: number; yaw: number; num: number }[] = [];
      for (const sd of [stop.side, -stop.side]) {
        spots.length = 0;
        for (let num = 3; num >= 1; num--) {
          const i = (((stop.turnIn - Math.round((num * d) / ds)) % t.n) + t.n) % t.n;
          const [x, z] = at(i, sd, off);
          if (!clearAt(x, z, off - 0.4) || !landOk(x, z)) break;
          // Face back down the straight, turned 25° towards the track.
          const [nx, nz] = t.normal(i);
          const fx = -t.tx[i] - nx * sd * 0.47;
          const fz = -t.tz[i] - nz * sd * 0.47;
          spots.push({ x, z, yaw: Math.atan2(fx, fz), num });
        }
        if (spots.length === 3) break;
      }
      if (spots.length !== 3) continue;
      for (const sp of spots) {
        boardSpots.push([sp.x, sp.z]);
        const k = 3 - sp.num; // atlas cell
        const face = new THREE.PlaneGeometry(1.1, 1.1);
        const uvA = face.attributes.uv as THREE.BufferAttribute;
        for (let q = 0; q < uvA.count; q++) uvA.setX(q, (k + uvA.getX(q)) / 3);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(sp.x, 0, sp.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp.yaw), new THREE.Vector3(1, 1, 1));
        faces.push(face.translate(0, 1.75, 0.03).applyMatrix4(m));
        frames.push(tint(new THREE.BoxGeometry(1.2, 1.2, 0.05).translate(0, 1.75, 0), '#2a2a2c').applyMatrix4(m));
        for (const lx of [-0.4, 0.4]) frames.push(tint(new THREE.BoxGeometry(0.07, 1.2, 0.07).translate(lx, 0.6, -0.04), '#55565a').applyMatrix4(m));
      }
    }
    if (faces.length) {
      const fm = new THREE.Mesh(mergeGeometries(faces)!, mat({ map: atlas, roughness: 0.5 }));
      const bm = new THREE.Mesh(mergeGeometries(frames)!, mat({ vertexColors: true, roughness: 0.7 }));
      fm.castShadow = bm.castShadow = true;
      group.add(fm, bm);
    }
  }

  // ---------------------------------------------------------------- hoardings on straights
  {
    const atlas = canvasTex(
      512,
      512,
      (g) => {
        SPONSORS.forEach(([name, bg, fg], k) => {
          const y = k * 85;
          g.fillStyle = bg;
          g.fillRect(0, y, 512, 85);
          g.fillStyle = fg;
          g.font = `800 ${name.length > 12 ? 38 : 50}px Archivo, Arial, sans-serif`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(name, 256, y + 45);
        });
      },
      false,
    );
    const boards: THREE.BufferGeometry[] = [];
    const legs: THREE.BufferGeometry[] = [];
    const hoardFeet: [number, number][][] = [];
    const per = Math.round(6 / (t.length / t.n));
    let k = 0;
    for (let i = 0; i < t.n; i += per) {
      // Only on gentle sections.
      let straight = true;
      for (let d = -per; d <= per; d += 2) if (Math.abs(t.curv[((i + d) % t.n + t.n) % t.n]) > 0.012) straight = false;
      if (!straight || rand() < 0.35) continue;
      for (const side of [-1, 1]) {
        const off = wallOff + 1.1;
        const [x, z] = at(i, side, off);
        if (!clearAt(x, z, off - 0.4) || !landOk(x, z)) continue;
        if (boardSpots.some(([bx, bz]) => (bx - x) ** 2 + (bz - z) ** 2 < 5 ** 2)) continue;
        const [nx, nz] = t.normal(i);
        const yaw = Math.atan2(-nx * side, -nz * side);
        const row = k++ % SPONSORS.length;
        const v0 = 1 - (row + 1) * (85 / 512);
        const v1 = 1 - row * (85 / 512);
        const plane = new THREE.PlaneGeometry(5.6, 1.0);
        const uvA = plane.attributes.uv as THREE.BufferAttribute;
        for (let q = 0; q < uvA.count; q++) uvA.setY(q, uvA.getY(q) > 0.5 ? v1 : v0);
        plane.rotateY(yaw).translate(x, 1.05, z);
        boards.push(plane);
        const ax = Math.cos(yaw) * 2.8;
        const az = -Math.sin(yaw) * 2.8;
        hoardFeet.push([
          [x - ax, z - az],
          [x + ax, z + az],
        ]);
        const back = new THREE.BoxGeometry(5.7, 1.1, 0.08).rotateY(yaw).translate(x - nx * side * -0.05, 1.05, z - nz * side * -0.05);
        legs.push(tint(back, '#2a2a2c'));
        for (const lx of [-2.4, 2.4]) {
          legs.push(tint(new THREE.BoxGeometry(0.08, 0.6, 0.08).translate(lx, 0.3, -0.06).rotateY(yaw).translate(x, 0, z), '#55565a'));
        }
      }
    }
    if (boards.length) {
      const bm = new THREE.Mesh(mergeGeometries(boards)!, mat({ map: atlas, roughness: 0.5 }));
      bm.castShadow = true;
      group.add(bm);
      const lm = new THREE.Mesh(mergeGeometries(legs)!, mat({ vertexColors: true, roughness: 0.7 }));
      lm.castShadow = true;
      group.add(lm);
    }
    ground?.contactLines(hoardFeet, 1.1, 0.22);
  }

  // ---------------------------------------------------------------- grandstand + pits at start/finish
  {
    const scoreSide = (side: number, off: number, len: number) => {
      let ok = 0;
      let all = 0;
      const per = Math.max(1, Math.round(4 / (t.length / t.n)));
      const half = Math.round(len / 2 / (t.length / t.n));
      for (let i = -half; i <= half; i += per)
        for (const d of [off, off + 6, off + 11]) {
          all++;
          const [x, z] = at(i, side, d);
          if (clearAt(x, z, wallOff + 0.5) && landOk(x, z) && (!ground || ground.contains(x, z, 2))) ok++;
        }
      return ok / all;
    };
    const L = 34;
    const sA = scoreSide(1, wallOff + 2.5, L);
    const sB = scoreSide(-1, wallOff + 2.5, L);
    const standSide = sA >= sB ? 1 : -1;
    const tx = t.tx[0];
    const tz = t.tz[0];
    const frame = (side: number, along: number, off: number): THREE.Matrix4 => {
      const [nx, nz] = t.normal(0);
      const x = t.px[0] + tx * along + nx * side * off;
      const z = t.pz[0] + tz * along + nz * side * off;
      // Local +z faces the track, local x runs along it.
      const yaw = Math.atan2(-nx * side, -nz * side);
      return new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    };

    if (Math.max(sA, sB) > 0.75) {
      const parts: THREE.BufferGeometry[] = [];
      const rows = 7;
      for (let r = 0; r < rows; r++) {
        const h = 0.6 + r * 0.48;
        parts.push(tint(new THREE.BoxGeometry(L, h, 0.9).translate(0, h / 2, -r * 0.9), r % 2 ? '#d6d1c6' : '#cdc8bc'));
      }
      parts.push(tint(new THREE.BoxGeometry(L, 4.3, 0.3).translate(0, 2.15, -rows * 0.9 + 0.3), '#bdb7aa'));
      for (const cx of [-L / 2 + 0.4, -L / 6, L / 6, L / 2 - 0.4]) parts.push(tint(new THREE.CylinderGeometry(0.14, 0.14, 7, 8).translate(cx, 3.5, -rows * 0.9 + 0.5), '#55575c'));
      parts.push(tint(new THREE.BoxGeometry(L + 2, 0.25, rows * 0.9 + 2.4).rotateX(-0.08).translate(0, 7.0, -rows * 0.45 + 0.4), '#f2eee5'));
      parts.push(tint(new THREE.BoxGeometry(L + 2, 0.7, 0.12).translate(0, 6.7, 1.6), '#ff4d00'));
      const stand = new THREE.Mesh(mergeGeometries(parts)!, mat({ vertexColors: true, roughness: 0.8 }));
      stand.applyMatrix4(frame(standSide, -4, wallOff + 2.6));
      ground?.contactShapes([footprint(frame(standSide, -4, wallOff + 2.6), -L / 2, L / 2, -rows * 0.9 - 0.2, 0.45)], 0.9, 0.4);
      stand.castShadow = true;
      stand.receiveShadow = true;
      group.add(stand);

      // Crowd.
      const seats: THREE.Matrix4[] = [];
      const colors: THREE.Color[] = [];
      const shirts = ['#ff4d00', '#f2eee5', '#141414', '#2f4bff', '#e5383b', '#ffc600', '#16a34a', '#8b5cf6', '#ec4899', '#7a7a7a'];
      const base = frame(standSide, -4, wallOff + 2.6);
      for (let r = 0; r < rows; r++)
        for (let x = -L / 2 + 0.6; x < L / 2 - 0.4; x += 0.62) {
          if (rand() < 0.3) continue;
          const local = new THREE.Matrix4().compose(
            new THREE.Vector3(x + (rand() - 0.5) * 0.15, 0.6 + r * 0.48 + 0.32, -r * 0.9 - 0.15),
            new THREE.Quaternion(),
            new THREE.Vector3(1, 0.85 + rand() * 0.3, 1),
          );
          seats.push(base.clone().multiply(local));
          colors.push(new THREE.Color(shirts[Math.floor(rand() * shirts.length)]));
        }
      const crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.19, 0.32, 2, 6), mat({ roughness: 0.8 }), seats.length);
      seats.forEach((m, i) => {
        crowd.setMatrixAt(i, m);
        crowd.setColorAt(i, colors[i]);
      });
      group.add(crowd);
    }

    const pitSide = -standSide;
    const pitScore = pitSide > 0 ? sA : sB;
    if (pitScore > 0.7) {
      const doors = canvasTex(512, 128, (g) => {
        g.fillStyle = '#e9e4d8';
        g.fillRect(0, 0, 512, 128);
        for (let k = 0; k < 4; k++) {
          const x = 14 + k * 125;
          g.fillStyle = '#3b3a36';
          g.fillRect(x, 26, 108, 102);
          g.fillStyle = 'rgba(255,255,255,0.08)';
          for (let y = 30; y < 128; y += 8) g.fillRect(x, y, 108, 2);
          g.fillStyle = '#ff4d00';
          g.font = '700 16px JetBrains Mono, monospace';
          g.fillText(`0${k + 1}`, x + 4, 20);
        }
      }, false);
      const len = 30;
      const pit = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(len, 4.4, 8), [
        mat({ color: 0xe2ddd0 }),
        mat({ color: 0xe2ddd0 }),
        mat({ color: 0x8d8a83 }),
        mat({ color: 0x8d8a83 }),
        mat({ map: doors, roughness: 0.7 }),
        mat({ color: 0xd8d2c4 }),
      ]);
      body.position.set(0, 2.2, -4);
      body.castShadow = body.receiveShadow = true;
      pit.add(body);
      const sign = canvasTex(512, 64, (g) => {
        g.fillStyle = '#141414';
        g.fillRect(0, 0, 512, 64);
        g.fillStyle = '#ff4d00';
        g.fillRect(0, 56, 512, 8);
        g.fillStyle = '#f2eee5';
        g.font = '800 40px Archivo, Arial, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('APEXKART · PIT', 256, 30);
      }, false);
      const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.75), mat({ map: sign, emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: 0.25 }));
      signMesh.position.set(0, 5.4, 0.02);
      pit.add(signMesh);
      const signBack = new THREE.Mesh(new THREE.BoxGeometry(14.2, 1.9, 0.2), mat({ color: 0x141414 }));
      signBack.position.set(0, 5.4, -0.11);
      pit.add(signBack);
      pit.applyMatrix4(frame(pitSide, 10, wallOff + 3));
      ground?.contactShapes([footprint(frame(pitSide, 10, wallOff + 3), -len / 2, len / 2, -8, 0)], 1.0, 0.42);
      group.add(pit);
    }
  }

  // ---------------------------------------------------------------- marshal posts at the big corners
  {
    const parts: THREE.BufferGeometry[] = [];
    const posts: [number, number][][] = [];
    let last = -999;
    for (let i = 0; i < t.n; i++) {
      const c = Math.abs(t.curv[i]);
      if (c < 0.06 || i - last < 60) continue;
      let peak = true;
      for (let d = -6; d <= 6; d++) if (Math.abs(t.curv[((i + d) % t.n + t.n) % t.n]) > c) peak = false;
      if (!peak) continue;
      const side = t.curv[i] > 0 ? -1 : 1; // outside of the corner
      const off = wallOff + 2.4;
      const [x, z] = at(i, side, off);
      if (!clearAt(x, z, off - 0.6) || !landOk(x, z)) continue;
      last = i;
      const [nx, nz] = t.normal(i);
      const yaw = Math.atan2(-nx * side, -nz * side);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
      parts.push(tint(new THREE.BoxGeometry(1.6, 2.1, 1.6).translate(0, 1.05, 0), '#f2eee5').applyMatrix4(m));
      posts.push(footprint(m, -0.8, 0.8, -0.8, 0.8));
      parts.push(tint(new THREE.BoxGeometry(2.0, 0.18, 2.0).translate(0, 2.2, 0), '#ff4d00').applyMatrix4(m));
      parts.push(tint(new THREE.BoxGeometry(1.2, 0.6, 0.05).translate(0, 1.4, 0.81), '#2c3843').applyMatrix4(m));
      parts.push(tint(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 5).translate(0.9, 1.2, 0.9), '#9aa0a6').applyMatrix4(m));
      parts.push(tint(new THREE.BoxGeometry(0.02, 0.45, 0.65).translate(0.9, 2.1, 1.25), '#ffc600').applyMatrix4(m));
    }
    if (parts.length) {
      const m = new THREE.Mesh(mergeGeometries(parts)!, mat({ vertexColors: true, roughness: 0.7 }));
      m.castShadow = true;
      group.add(m);
    }
    ground?.contactShapes(posts, 0.6, 0.4);
  }

  void aniso;
  return { group, emissive, lamps };
}
