// The edge of the world: a ring of low-poly hills with a tree line in front, well outside
// everything else, so the flat ground never meets the sky in a hard line. One mesh, one draw,
// unlit; its colours melt into the horizon haze and follow the time of day through shared uniforms.
import * as THREE from 'three';
import type { TrackModel } from '../track';
import { HILLS } from '../sky';
import { hashString, rng } from './common';

interface Layer {
  R: number; // radius (m)
  seg: number; // segments round the ring
  h0: number; // lowest and highest crest (m)
  h1: number;
  haze: number; // 0 = the near tree line, 1 = the far hills
  jag: number; // per-vertex crest jitter (share of the height)
}

export function buildHorizon(track: TrackModel, seed: string): THREE.Mesh {
  const rand = rng(hashString(seed + ':hills'));
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (let i = 0; i < track.n; i++) {
    x0 = Math.min(x0, track.px[i]);
    x1 = Math.max(x1, track.px[i]);
    z0 = Math.min(z0, track.pz[i]);
    z1 = Math.max(z1, track.pz[i]);
  }
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const reach = Math.hypot(x1 - x0, z1 - z0) / 2;
  // Beyond the painted ground and the mapped surroundings (up to ~1.2 km out), inside the fog's far end.
  const near = Math.max(1250, reach + 850);
  const layers: Layer[] = [
    { R: near + 420, seg: 96, h0: 30, h1: 150, haze: 1, jag: 0.1 },
    { R: near, seg: 220, h0: 11, h1: 30, haze: 0, jag: 0.3 },
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const haze: number[] = [];
  const top: number[] = [];
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tri = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, hz: number, crest: number[]) => {
    n.subVectors(q, p).cross(c.subVectors(r, p)).normalize();
    // Face the middle of the ring (the camera is always inside it).
    const mx = (p.x + q.x + r.x) / 3 - cx;
    const mz = (p.z + q.z + r.z) / 3 - cz;
    let verts = [p, q, r];
    let k = [0, 1, 2];
    if (n.x * mx + n.z * mz > 0) {
      n.negate();
      verts = [p, r, q];
      k = [0, 2, 1];
    }
    verts.forEach((v, i) => {
      pos.push(v.x, v.y, v.z);
      nrm.push(n.x, n.y, n.z);
      haze.push(hz);
      top.push(crest[k[i]]);
    });
  };
  for (const L of layers) {
    // Smooth crest profile (whole-number frequencies so it closes), plus per-vertex jitter.
    const waves = [2, 3, 5, 9, 14].map((f, i) => ({ f, p: rand() * Math.PI * 2, w: [0.45, 0.35, 0.25, 0.15, 0.1][i] }));
    const crest: number[] = [];
    const tilt: number[] = [];
    for (let k = 0; k < L.seg; k++) {
      const t = (k / L.seg) * Math.PI * 2;
      let v = 0;
      for (const w of waves) v += Math.sin(t * w.f + w.p) * w.w;
      const u = THREE.MathUtils.clamp(0.5 + v * 0.75, 0, 1);
      crest.push((L.h0 + (L.h1 - L.h0) * u * u) * (1 - L.jag * rand()));
      tilt.push((rand() - 0.5) * 0.04); // the middle row in or out a little: facets catch the sun differently
    }
    const at = (k: number, y: number, r = 1) => {
      const t = ((k % L.seg) / L.seg) * Math.PI * 2;
      return new THREE.Vector3(cx + Math.cos(t) * L.R * r, y, cz + Math.sin(t) * L.R * r);
    };
    for (let k = 0; k < L.seg; k++) {
      const k1 = (k + 1) % L.seg;
      const h = crest[k];
      const h1 = crest[k1];
      const B0 = at(k, -30);
      const B1 = at(k + 1, -30);
      const M0 = at(k, h * 0.45, 1 + tilt[k]);
      const M1 = at(k + 1, h1 * 0.45, 1 + tilt[k1]);
      const T0 = at(k, h);
      const T1 = at(k + 1, h1);
      const f = (y: number, hh: number) => Math.max(0, y) / hh;
      tri(B0, B1, M1, L.haze, [0, 0, f(M1.y, h1)]);
      tri(B0, M1, M0, L.haze, [0, f(M1.y, h1), f(M0.y, h)]);
      tri(M0, M1, T1, L.haze, [f(M0.y, h), f(M1.y, h1), 1]);
      tri(M0, T1, T0, L.haze, [f(M0.y, h), 1, 1]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aHaze', new THREE.Float32BufferAttribute(haze, 1));
  geo.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1));
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: HILLS,
    vertexShader: /* glsl */ `
      attribute float aHaze;
      attribute float aTop;
      varying float vHaze;
      varying float vTop;
      varying vec3 vN;
      void main() {
        vHaze = aHaze;
        vTop = aTop;
        vN = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 hillNear; uniform vec3 hillFar; uniform vec3 hillHaze; uniform vec3 hillSun; uniform float hillLit;
      varying float vHaze;
      varying float vTop;
      varying vec3 vN;
      void main() {
        vec3 c = mix(hillNear, hillFar, vHaze);
        c *= mix(1.0, 0.8 + 0.38 * max(dot(normalize(vN), hillSun), 0.0), hillLit);
        // Aerial perspective: the far hills and the foot of everything melt into the haze.
        float a = mix(0.2, 0.46, vHaze) + (1.0 - vTop) * (1.0 - vTop) * 0.5;
        gl_FragColor = vec4(mix(c, hillHaze, clamp(a, 0.0, 1.0)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'horizon';
  return mesh;
}
