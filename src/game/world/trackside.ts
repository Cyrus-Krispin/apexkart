// Circuit furniture: raised kerbs, branded tyre walls, floodlights, hoardings,
// grandstand, pit building and marshal posts. All procedural, placed from the
// track geometry and kept clear of other parts of the circuit.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TrackModel } from '../track';
import type { GroundPainter } from './ground';
import { hashString, Land, rng } from './common';

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
  emissive: THREE.MeshStandardMaterial[]; // floodlight heads (night/bloom)
}

export function buildTrackside(track: TrackModel, ground: GroundPainter | null, seed: string, aniso: number): Trackside {
  const group = new THREE.Group();
  const rand = rng(hashString(seed + ':side'));
  const t = track;
  const hw = t.halfWidth;
  const wallOff = hw + t.runoff + 0.65; // inner face, where the kart body meets the physics barrier
  const emissive: THREE.MeshStandardMaterial[] = [];
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
    const kerbTex = canvasTex(32, 64, (g) => {
      g.fillStyle = '#d8262c';
      g.fillRect(0, 0, 32, 32);
      g.fillStyle = '#f3f1ea';
      g.fillRect(0, 32, 32, 32);
    });
    kerbTex.wrapT = THREE.RepeatWrapping;
    const pos: number[] = [];
    const uv: number[] = [];
    const isCorner = (i: number) => Math.abs(t.curv[((i % t.n) + t.n) % t.n]) > 0.028;
    const seen = new Uint8Array(t.n);
    // Profile across the kerb: offset from edge (m) and height (m).
    const prof: [number, number][] = [
      [-0.05, 0.035],
      [0.35, 0.1],
      [1.0, 0.08],
      [1.15, 0.02],
    ];
    for (let i = 0; i < t.n; i++) {
      if (seen[i] || !isCorner(i)) continue;
      let a = i;
      while (isCorner(a - 1) && a > i - t.n) a--;
      let b = i;
      while (isCorner(b + 1) && b < a + t.n) b++;
      for (let k = a; k <= b; k++) seen[((k % t.n) + t.n) % t.n] = 1;
      for (const side of [-1, 1]) {
        let prev: number[][] | null = null;
        for (let k = a - 5; k <= b + 6; k++) {
          const q = ((k % t.n) + t.n) % t.n;
          const [nx, nz] = t.normal(q);
          const v = (k * t.length) / t.n / 1.6;
          const row = prof.map(([o, y]) => [t.px[q] + nx * side * (hw + o), y, t.pz[q] + nz * side * (hw + o), (o + 0.05) / 1.2, v]);
          if (prev) {
            for (let p = 0; p < prof.length - 1; p++) {
              const A = prev[p];
              const B = prev[p + 1];
              const C = row[p + 1];
              const D = row[p];
              // Winding so the top faces up on either side of the track.
              const tri = side > 0 ? [A, D, C, A, C, B] : [A, B, C, A, C, D];
              for (const v3 of tri) {
                pos.push(v3[0], v3[1], v3[2]);
                uv.push(v3[3], v3[4]);
              }
            }
          }
          prev = row;
        }
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.55, side: THREE.DoubleSide }));
      m.receiveShadow = true;
      m.castShadow = true;
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
    for (const side of [-1, 1]) {
      let run: [number, number, number][] = []; // x, z, u
      const flush = () => {
        for (let k = 0; k + 1 < run.length; k++) {
          const [ax, az, au] = run[k];
          const [bx, bz, bu] = run[k + 1];
          // Outward direction for the back face.
          const dx = bx - ax;
          const dz = bz - az;
          const L = Math.hypot(dx, dz) || 1;
          let ox = -dz / L;
          let oz = dx / L;
          // Make o point away from the track (same as side * normal).
          const q = run[k];
          const near = t.nearest(q[0], q[1]);
          const [nx, nz] = t.normal(near.i);
          if (ox * nx * side + oz * nz * side < 0) {
            ox = -ox;
            oz = -oz;
          }
          const a0 = [ax, 0, az];
          const b0 = [bx, 0, bz];
          const a1 = [ax, H, az];
          const b1 = [bx, H, bz];
          const a2 = [ax + ox * T, H, az + oz * T];
          const b2 = [bx + ox * T, H, bz + oz * T];
          const a3 = [ax + ox * T, 0, az + oz * T];
          const b3 = [bx + ox * T, 0, bz + oz * T];
          const faces: [number[], number[], number[], number[], number, number][] = [
            [a0, b0, b1, a1, 0.25, 1], // front (belt)
            [a1, b1, b2, a2, 0.12, 0.12], // top
            [a2, b2, b3, a3, 0.1, 0.1], // back
          ];
          for (const [A, B, C, D, v0, v1] of faces) {
            const tri = [A, B, C, A, C, D];
            const vs = [v0, v0, v1, v0, v1, v1];
            const us = [au, bu, bu, au, bu, au];
            for (let m = 0; m < 6; m++) push(tri[m], us[m], vs[m]);
          }
        }
        run = [];
      };
      let u = 0;
      for (let i = 0; i <= t.n; i += 2) {
        const [x, z] = at(i, side, wallOff);
        if (clearAt(x, z, wallOff - 0.3) && landOk(x, z)) {
          if (run.length) u += Math.hypot(x - run[run.length - 1][0], z - run[run.length - 1][1]) / 12.5;
          run.push([x, z, u]);
        } else if (run.length) flush();
      }
      flush();
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: belt, roughness: 0.7, side: THREE.DoubleSide }));
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
  }

  // ---------------------------------------------------------------- floodlights
  {
    const poles: THREE.Matrix4[] = [];
    const step = Math.max(18, Math.round(42 / (t.length / t.n)));
    for (let i = 0, k = 0; i < t.n; i += step, k++) {
      const side = (k % 2 ? 1 : -1) * (t.curv[i] > 0 ? -1 : 1);
      for (const sd of [side, -side]) {
        const [x, z] = at(i, sd, wallOff + 2.2);
        if (!clearAt(x, z, wallOff + 1.5) || !landOk(x, z)) continue;
        const [nx, nz] = t.normal(i);
        const yaw = Math.atan2(-nx * sd, -nz * sd); // face the track
        poles.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)));
        break;
      }
    }
    if (poles.length) {
      const poleGeo = mergeGeometries([
        tint(new THREE.CylinderGeometry(0.1, 0.16, 9, 8).translate(0, 4.5, 0), '#9aa0a6'),
        tint(new THREE.BoxGeometry(0.12, 0.12, 1.6).translate(0, 8.9, 0.6), '#9aa0a6'),
        tint(new THREE.BoxGeometry(1.4, 0.5, 0.3).translate(0, 8.9, 1.3), '#2a2a2c'),
      ])!;
      const poleMesh = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.4 }), poles.length);
      const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff1d0, emissiveIntensity: 0.6 });
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
        const back = new THREE.BoxGeometry(5.7, 1.1, 0.08).rotateY(yaw).translate(x - nx * side * -0.05, 1.05, z - nz * side * -0.05);
        legs.push(tint(back, '#2a2a2c'));
        for (const lx of [-2.4, 2.4]) {
          legs.push(tint(new THREE.BoxGeometry(0.08, 0.6, 0.08).translate(lx, 0.3, -0.06).rotateY(yaw).translate(x, 0, z), '#55565a'));
        }
      }
    }
    if (boards.length) {
      const bm = new THREE.Mesh(mergeGeometries(boards)!, new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.5 }));
      bm.castShadow = true;
      group.add(bm);
      const lm = new THREE.Mesh(mergeGeometries(legs)!, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
      lm.castShadow = true;
      group.add(lm);
    }
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
      const stand = new THREE.Mesh(mergeGeometries(parts)!, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
      stand.applyMatrix4(frame(standSide, -4, wallOff + 2.6));
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
      const crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.19, 0.32, 2, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }), seats.length);
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
        new THREE.MeshStandardMaterial({ color: 0xe2ddd0 }),
        new THREE.MeshStandardMaterial({ color: 0xe2ddd0 }),
        new THREE.MeshStandardMaterial({ color: 0x8d8a83 }),
        new THREE.MeshStandardMaterial({ color: 0x8d8a83 }),
        new THREE.MeshStandardMaterial({ map: doors, roughness: 0.7 }),
        new THREE.MeshStandardMaterial({ color: 0xd8d2c4 }),
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
      const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.75), new THREE.MeshStandardMaterial({ map: sign, emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: 0.25 }));
      signMesh.position.set(0, 5.4, 0.02);
      pit.add(signMesh);
      const signBack = new THREE.Mesh(new THREE.BoxGeometry(14.2, 1.9, 0.2), new THREE.MeshStandardMaterial({ color: 0x141414 }));
      signBack.position.set(0, 5.4, -0.11);
      pit.add(signBack);
      pit.applyMatrix4(frame(pitSide, 10, wallOff + 3));
      group.add(pit);
    }
  }

  // ---------------------------------------------------------------- marshal posts at the big corners
  {
    const parts: THREE.BufferGeometry[] = [];
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
      parts.push(tint(new THREE.BoxGeometry(2.0, 0.18, 2.0).translate(0, 2.2, 0), '#ff4d00').applyMatrix4(m));
      parts.push(tint(new THREE.BoxGeometry(1.2, 0.6, 0.05).translate(0, 1.4, 0.81), '#2c3843').applyMatrix4(m));
      parts.push(tint(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 5).translate(0.9, 1.2, 0.9), '#9aa0a6').applyMatrix4(m));
      parts.push(tint(new THREE.BoxGeometry(0.02, 0.45, 0.65).translate(0.9, 2.1, 1.25), '#ffc600').applyMatrix4(m));
    }
    if (parts.length) {
      const m = new THREE.Mesh(mergeGeometries(parts)!, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
      m.castShadow = true;
      group.add(m);
    }
  }

  void aniso;
  return { group, emissive };
}
