import * as THREE from 'three';

/** Gradient sky dome with a soft sun glow; horizon colour doubles as the fog colour. */
export const SKY = {
  zenith: new THREE.Color('#3d78c2'),
  horizon: new THREE.Color('#e6d6bf'),
};

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
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 col = mix(horizon, zenith, pow(h, 0.38));
        float sun = max(dot(normalize(vDir), sunDir), 0.0);
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

/** Night palette: blue-black zenith, a faint warm city glow low down (horizon doubles as fog). */
export const NIGHT_SKY = {
  zenith: new THREE.Color('#03050b'),
  horizon: new THREE.Color('#141a28'),
  glow: new THREE.Color('#2a2016'),
};

/** Night dome with stars and a moon at `moonDir`. */
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
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith; uniform vec3 horizon; uniform vec3 glow; uniform vec3 moonDir;
      varying vec3 vDir;
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
        // Stars: one candidate per cell of a grid on the sphere, sized in pixels so they stay crisp.
        const float CELLS = 240.0;
        vec3 p = d * CELLS;
        vec3 c = floor(p);
        float r = hash(c);
        if (r > 0.9968) {
          vec3 sp = normalize(c + 0.5 + (vec3(hash(c + 1.3), hash(c + 2.7), hash(c + 4.1)) - 0.5) * 0.5);
          float dist = length(cross(d, sp)) * CELLS;
          float px = max(length(fwidth(p)), 1e-4);
          float mag = pow(hash(c + 7.9), 3.0);
          float star = exp(-pow(dist / px, 2.0) * 1.6) * (0.25 + 1.6 * mag);
          col += mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.9, 0.78), hash(c + 3.3)) * star * smoothstep(0.03, 0.32, h);
        }
        float m = dot(d, moonDir);
        col += vec3(1.0, 0.97, 0.9) * 2.4 * smoothstep(0.99985, 0.99991, m);
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
