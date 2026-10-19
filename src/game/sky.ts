import * as THREE from 'three';

/** Gradient sky dome with a soft sun glow; horizon colour doubles as the fog colour. */
export const SKY = {
  zenith: new THREE.Color('#5f93c8'),
  horizon: new THREE.Color('#dfe2dc'),
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
        vec3 col = mix(horizon, zenith, pow(h, 0.55));
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
