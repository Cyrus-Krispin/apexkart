import * as THREE from 'three';

/** Gradient sky dome with a soft sun glow; horizon colour doubles as the fog colour. */
export const SKY = {
  zenith: new THREE.Color('#2f6fd0'),
  horizon: new THREE.Color('#cfe0ea'), // cool, so distance (fog) reads as air rather than beige haze
};

/** Night palette: blue-black zenith, a faint warm city glow low down (horizon doubles as fog). */
export const NIGHT_SKY = {
  zenith: new THREE.Color('#03050b'),
  horizon: new THREE.Color('#141a28'),
  glow: new THREE.Color('#2a2016'),
};

// ---------------------------------------------------------------- clouds

let cloudTex: THREE.DataTexture | null = null;

/**
 * One 256² tiling texture the cloud layer is drawn from, made once: R = soft fractal noise (where
 * the clouds gather), G = finer noise (eats into their edges), B = round cells (the cumulus puffs).
 */
function cloudTexture(): THREE.DataTexture {
  if (cloudTex) return cloudTex;
  const N = 256;
  let seed = 1234567;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const norm = (a: Float32Array) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of a) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / (hi - lo || 1);
    return a;
  };
  // Tiling value noise: a P×P lattice of random values, smoothly interpolated, wrapping at the edges.
  const fbm = (base: number, octaves: number) => {
    const out = new Float32Array(N * N);
    let amp = 1;
    for (let o = 0, P = base; o < octaves; o++, P *= 2, amp *= 0.5) {
      const lat = new Float32Array(P * P).map(() => rand());
      for (let y = 0; y < N; y++) {
        const fy = (y / N) * P;
        const y0 = Math.floor(fy);
        let ty = fy - y0;
        ty = ty * ty * (3 - 2 * ty);
        const r0 = y0 * P;
        const r1 = ((y0 + 1) % P) * P;
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * P;
          const x0 = Math.floor(fx);
          let tx = fx - x0;
          tx = tx * tx * (3 - 2 * tx);
          const x1 = (x0 + 1) % P;
          const a = lat[r0 + x0] + (lat[r0 + x1] - lat[r0 + x0]) * tx;
          const b = lat[r1 + x0] + (lat[r1 + x1] - lat[r1 + x0]) * tx;
          out[y * N + x] += (a + (b - a) * ty) * amp;
        }
      }
    }
    return norm(out);
  };
  // Tiling cells: 1 - distance to the nearest of a jittered P×P grid of points, so round puffs.
  const cells = (P: number) => {
    const out = new Float32Array(N * N);
    const pts = new Float32Array(P * P * 2).map(() => 0.15 + rand() * 0.7);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * P;
        const fy = (y / N) * P;
        const cx = Math.floor(fx);
        const cy = Math.floor(fy);
        let best = 9;
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            const gx = cx + i;
            const gy = cy + j;
            const k = ((((gy % P) + P) % P) * P + (((gx % P) + P) % P)) * 2;
            best = Math.min(best, Math.hypot(gx + pts[k] - fx, gy + pts[k + 1] - fy));
          }
        out[y * N + x] = 1 - Math.min(1, best);
      }
    return norm(out);
  };
  const r = fbm(4, 5);
  const g = fbm(16, 3);
  const b = cells(9);
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = r[i] * 255;
    data[i * 4 + 1] = g[i] * 255;
    data[i * 4 + 2] = b[i] * 255;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  cloudTex = t;
  return t;
}

/**
 * The cloud layer, shared by the day and night skies: a flat deck projected onto the dome
 * (uv = dir.xz / dir.y), drifting slowly. Three texture reads per sky pixel.
 */
const CLOUDS = /* glsl */ `
  uniform sampler2D clouds;
  uniform float time;
  uniform float cover; // density threshold: higher, fewer clouds
  vec2 cloudUv(vec3 d) {
    return d.xz / (d.y + 0.09) * 0.16 + vec2(time * 0.0016, time * 0.0007);
  }
  // Density 0..1 and, for shading, the soft base it sits on.
  vec2 cloudDensity(vec2 uv) {
    vec4 a = texture2D(clouds, uv);
    vec4 b = texture2D(clouds, uv * 3.3 + vec2(0.37, 0.71));
    float base = a.r * 0.58 + a.b * 0.42;
    return vec2(base - (b.g - 0.45) * 0.22, base);
  }
`;

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }`;

export function makeSky(sunDir: THREE.Vector3): THREE.Mesh {
  const geo = new THREE.SphereGeometry(4000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: SKY.zenith },
      horizon: { value: SKY.horizon },
      sunDir: { value: sunDir.clone().normalize() },
      clouds: { value: cloudTexture() },
      time: { value: 0 },
      cover: { value: 0.58 },
    },
    vertexShader: DOME_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir;
      varying vec3 vDir;
      ${CLOUDS}
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(horizon, zenith, pow(h, 0.38));
        // A pale haze band just above the horizon: the distant hills fade into it, so the
        // world's edge never meets the sky in a hard line.
        col = mix(col, horizon * 1.04 + 0.015, exp(-h * 16.0) * 0.6);
        float sun = max(dot(d, sunDir), 0.0);
        if (d.y > 0.0) {
          vec2 uv = cloudUv(d);
          vec2 n = cloudDensity(uv);
          float c = smoothstep(cover, cover + 0.085, n.x);
          // Lit on the sun side: where the deck thins towards the sun, the cloud is lit.
          vec4 s = texture2D(clouds, uv + normalize(sunDir.xz + 1e-4) * 0.035);
          float lit = clamp((n.y - (s.r * 0.58 + s.b * 0.42)) * 6.0 + 0.7, 0.0, 1.0);
          // Bright tops, soft blue-grey bellies (never darker than the sky behind them).
          vec3 bright = vec3(1.0, 0.985, 0.955);
          vec3 belly = mix(col, vec3(0.78, 0.83, 0.92), 0.78);
          vec3 cc = mix(belly, bright, lit);
          cc = mix(cc, belly, smoothstep(0.1, 0.4, n.x - cover) * 0.3); // thicker cores a touch greyer
          cc += vec3(1.0, 0.92, 0.78) * pow(sun, 10.0) * 0.3 * (1.0 - c * 0.5); // silver lining near the sun
          // Fade into the haze towards the horizon, where the deck would be paper-thin anyway.
          float fade = smoothstep(0.015, 0.2, d.y);
          col = mix(col, cc, c * fade * 0.94);
          sun *= 1.0 - c * fade * 0.85; // the sun hides behind a cloud
        }
        col += vec3(1.0, 0.9, 0.75) * (pow(sun, 24.0) * 0.35 + pow(sun, 600.0) * 1.2);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

/** Night dome with stars, a moon at `moonDir` and faint clouds against the city glow. */
export function makeNightSky(moonDir: THREE.Vector3): THREE.Mesh {
  const geo = new THREE.SphereGeometry(4000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: NIGHT_SKY.zenith },
      horizon: { value: NIGHT_SKY.horizon },
      glow: { value: NIGHT_SKY.glow },
      moonDir: { value: moonDir.clone().normalize() },
      clouds: { value: cloudTexture() },
      time: { value: 0 },
      cover: { value: 0.57 },
    },
    vertexShader: DOME_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith; uniform vec3 horizon; uniform vec3 glow; uniform vec3 moonDir;
      varying vec3 vDir;
      ${CLOUDS}
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(horizon, zenith, pow(h, 0.45));
        col += glow * exp(-h * 10.0);
        float m = dot(d, moonDir);
        // Clouds first: they hide the stars and the moon behind them.
        float c = 0.0;
        if (d.y > 0.0) {
          vec2 n = cloudDensity(cloudUv(d));
          c = smoothstep(cover, cover + 0.16, n.x) * smoothstep(0.015, 0.2, d.y);
          // Lit faintly from below by the city, and by the moon near it.
          vec3 cc = mix(vec3(0.021, 0.023, 0.033), glow * 1.3 + horizon * 0.45, exp(-h * 4.0));
          cc += vec3(0.5, 0.56, 0.72) * pow(max(m, 0.0), 30.0) * 0.12;
          col = mix(col, cc, c * 0.85);
        }
        // Stars: one candidate per cell of a grid on the sphere, sized in pixels so they stay crisp.
        const float CELLS = 240.0;
        vec3 p = d * CELLS;
        vec3 cl = floor(p);
        float r = hash(cl);
        if (r > 0.9968) {
          vec3 sp = normalize(cl + 0.5 + (vec3(hash(cl + 1.3), hash(cl + 2.7), hash(cl + 4.1)) - 0.5) * 0.5);
          float dist = length(cross(d, sp)) * CELLS;
          float px = max(length(fwidth(p)), 1e-4);
          float mag = pow(hash(cl + 7.9), 3.0);
          float star = exp(-pow(dist / px, 2.0) * 1.6) * (0.25 + 1.6 * mag);
          col += mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.9, 0.78), hash(cl + 3.3)) * star * smoothstep(0.03, 0.32, h) * (1.0 - c);
        }
        col += vec3(1.0, 0.97, 0.9) * 2.4 * smoothstep(0.99985, 0.99991, m) * (1.0 - c * 0.85);
        col += vec3(0.55, 0.62, 0.8) * (pow(max(m, 0.0), 400.0) * 0.25 + pow(max(m, 0.0), 24.0) * 0.03);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

/** Let the clouds drift: call once a frame with the frame time. */
export function driftSky(sky: THREE.Mesh, dt: number) {
  const u = (sky.material as THREE.ShaderMaterial).uniforms.time;
  u.value = (u.value + dt) % 100000;
}
