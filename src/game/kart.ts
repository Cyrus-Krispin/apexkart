import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { KERB, type Nearest, type Rejoin, type TrackModel } from './track';
import { hasKerb } from './kerbs';

export interface KartVisual {
  root: THREE.Group;
  body: THREE.Group; // rolls/pitches
  frontPivots: THREE.Group[];
  wheels: THREE.Mesh[]; // spin about x (the rear pair is one mesh on its axle)
  materials: THREE.Material[];
  steering?: THREE.Object3D; // turns about its own z with the steering (poseDriver)
  helmet?: THREE.Object3D; // tilts into corners (poseDriver)
}

// ------------------------------------------------------------------ kart model
//
// The kart is modelled from ~40 simple parts, then merged at build time into a handful of meshes,
// one per moving node: the body (rolls and pitches), the steering wheel, the helmet, each front
// wheel (steers) and the rear axle with both rear wheels (one solid axle, so they spin together).
// Every part's surface (colour, roughness, metalness, glow) rides along as vertex attributes, so the
// whole kart is one material and about 6 draws instead of 39. Ghosts merge everything into one mesh.

type Kind = 'paint' | 'suit' | 'ink' | 'paper' | 'steel' | 'rubber' | 'tread' | 'treadLight' | 'visor' | 'lamp';
type NodeId = 'body' | 'steer' | 'helmet' | 'front' | 'rear';

/** Colour (null: the driver's colour), roughness, metalness, glow. */
const SURFACE: Record<Kind, [number | null, number, number, number]> = {
  paint: [null, 0.32, 0.15, 0],
  suit: [null, 0.8, 0.05, 0],
  ink: [0x18181a, 0.75, 0.05, 0],
  paper: [0xf2eee5, 0.45, 0.05, 0],
  steel: [0xa7abb0, 0.3, 0.85, 0],
  rubber: [0x151515, 0.92, 0.05, 0],
  tread: [0x060607, 0.97, 0, 0],
  treadLight: [0x2c2c30, 0.85, 0, 0],
  visor: [0x0b0b10, 0.08, 0.7, 0],
  lamp: [0xff1206, 0.35, 0, 1],
};

/** Where each moving node sits in its parent (body or root), and its rest rotation. */
const NODES: Record<Exclude<NodeId, 'body' | 'front'>, { pos: [number, number, number]; rot: [number, number, number] }> = {
  steer: { pos: [0, 0.5, 0.15], rot: [-0.6, 0, 0] },
  helmet: { pos: [0, 0.84, -0.19], rot: [0, 0, 0] },
  rear: { pos: [0, 0.14, -0.62], rot: [0, 0, 0] },
};
const FRONT_X = 0.56;
const FRONT_Z = 0.62;
const FRONT_R = 0.13;
/** The rear number plate: centre and backward tilt (it faces up and back, at the chase camera). */
const PLATE = { pos: [0, 0.37, -0.99] as [number, number, number], tilt: 0.3 };

interface Part {
  geo: THREE.BufferGeometry; // in its node's space, indexed, position + normal only
  kind: Kind;
  node: NodeId;
}

/** A rounded tyre's profile (radius, axle position): rim, shoulder arc, tread, shoulder arc, rim. */
function tyreProfile(r: number, w: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const rim = r * 0.62;
  const s = 0.35; // sidewall roundness
  pts.push(new THREE.Vector2(rim, -w / 2));
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - w * s * (1 - Math.sin(a)), -w / 2 + w * s * (1 - Math.cos(a))));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - w * s * (1 - Math.cos(a)), w / 2 - w * s * (1 - Math.sin(a))));
  }
  pts.push(new THREE.Vector2(rim, w / 2));
  return pts;
}

// Lathe a profile around the axle (lathe axis = y, rotated to x).
const lathe = (pts: THREE.Vector2[], segments: number, phi = 0, len = Math.PI * 2) => new THREE.LatheGeometry(pts, segments, phi, len).rotateZ(Math.PI / 2);

/** The ghost's plain tyre. */
function tyreGeometry(r: number, w: number, segments = 20): THREE.BufferGeometry {
  return lathe(tyreProfile(r, w), segments);
}

/** The kart's tyre: plain sidewalls and a darker tread band in blocks, so you can see the wheels turn. */
function tyreParts(r: number, w: number, blocks = 14): [THREE.BufferGeometry, Kind][] {
  const pts = tyreProfile(r, w); // 16 points: the tread runs from the middle of one shoulder to the other's
  // Sidewalls with two segments per block too, so their vertices meet the blocks' (no T-junction cracks).
  const out: [THREE.BufferGeometry, Kind][] = [
    [lathe(pts.slice(0, 5), blocks * 2), 'rubber'],
    [lathe(pts.slice(11), blocks * 2), 'rubber'],
  ];
  const step = (Math.PI * 2) / blocks;
  for (let k = 0; k < blocks; k++) out.push([lathe(pts.slice(4, 12), 2, k * step, step), k % 2 ? 'treadLight' : 'tread']);
  return out;
}

const partsCache: { full?: Part[]; lite?: Part[] } = {};

/**
 * The kart's parts, built once (never added to a scene, so never disposed). `lite` is the ghost's:
 * fewer segments, no thin rods, about half the triangles (a translucent silhouette doesn't need them).
 */
function kartParts(lite = false): Part[] {
  const cached = partsCache[lite ? 'lite' : 'full'];
  if (cached) return cached;
  const parts: Part[] = [];
  const L = <T,>(full: T, ghost: T) => (lite ? ghost : full);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const put = (geo: THREE.BufferGeometry, kind: Kind, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, node: NodeId = 'body') => {
    m4.compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), one);
    geo.applyMatrix4(m4);
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    if (!geo.index) geo.setIndex([...Array(geo.attributes.position.count).keys()]);
    parts.push({ geo, kind, node });
  };
  const rbox = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, L(2, 1), r);

  // Chassis: floor tray, side rails, rear axle
  put(rbox(0.7, 0.04, 1.45, 0.015), 'ink', 0, 0.1, 0);
  if (!lite) {
    for (const sx of [-1, 1]) put(new THREE.CylinderGeometry(0.022, 0.022, 1.5, 8).rotateX(Math.PI / 2), 'steel', sx * 0.36, 0.12, 0);
    put(new THREE.CylinderGeometry(0.025, 0.025, 1.18, 8).rotateZ(Math.PI / 2), 'steel', 0, 0.14, -0.62);
  }

  // Nose cone: extruded rounded trapezoid (top view), bevelled
  const nose = new THREE.Shape();
  nose.moveTo(-0.28, -0.62);
  nose.lineTo(0.28, -0.62);
  nose.quadraticCurveTo(0.5, -0.7, 0.5, -0.9);
  nose.quadraticCurveTo(0.5, -1.02, 0.38, -1.02);
  nose.lineTo(-0.38, -1.02);
  nose.quadraticCurveTo(-0.5, -1.02, -0.5, -0.9);
  nose.quadraticCurveTo(-0.5, -0.7, -0.28, -0.62);
  const noseGeo = new THREE.ExtrudeGeometry(nose, { depth: 0.1, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: L(3, 1), curveSegments: L(10, 4) });
  noseGeo.rotateX(-Math.PI / 2); // shape y = -z, extrusion goes up
  put(noseGeo, 'paint', 0, 0.1, 0);
  // Front panel ahead of the driver's legs (the number board sits on it)
  put(rbox(0.46, 0.3, 0.07, 0.03), 'paint', 0, 0.3, 0.52, -0.55);
  // Side pods with a paper stripe
  for (const sx of [-1, 1]) {
    put(rbox(0.22, 0.17, 0.8, 0.06), 'paint', sx * 0.6, 0.19, -0.04, 0, 0, sx * -0.08);
    put(rbox(0.225, 0.035, 0.6, 0.015), 'paper', sx * 0.6, 0.235, -0.04, 0, 0, sx * -0.08);
  }
  // Rear bumper
  put(rbox(1.28, 0.07, 0.1, 0.03), 'ink', 0, 0.21, -0.98);
  for (const sx of [-1, 1]) put(rbox(0.06, 0.07, 0.3, 0.02), 'ink', sx * 0.4, 0.21, -0.85);
  // Rear number plate on two stays above the bumper (the chase camera sees it most), and a red rain
  // light in the bumper that glows at night.
  put(rbox(0.3, 0.2, 0.03, 0.015), 'paint', ...PLATE.pos, PLATE.tilt);
  if (!lite) {
    for (const sx of [-1, 1]) put(new THREE.CylinderGeometry(0.009, 0.009, 0.08, 6), 'steel', sx * 0.1, 0.27, -0.99);
    put(rbox(0.12, 0.04, 0.02, 0.008), 'lamp', 0, 0.21, -1.035);
  }
  // Engine block, cylinder head and silencer (right rear)
  put(rbox(0.24, 0.26, 0.3, 0.03), 'steel', 0.32, 0.3, -0.48);
  put(new THREE.CylinderGeometry(0.075, 0.09, 0.12, 12), 'steel', 0.32, 0.48, -0.48);
  put(new THREE.CylinderGeometry(0.065, 0.065, 0.36, 12).rotateX(Math.PI / 2), 'ink', 0.47, 0.3, -0.76);
  // Seat
  put(rbox(0.42, 0.42, 0.12, 0.05), 'ink', 0, 0.36, -0.33, -0.32);
  // Steering column, and the wheel on its own node
  if (!lite) put(new THREE.CylinderGeometry(0.018, 0.018, 0.46, 6).rotateX(Math.PI / 2 - 0.92), 'steel', 0, 0.33, 0.3);
  put(new THREE.TorusGeometry(0.13, 0.02, L(8, 4), L(20, 12)), 'ink', 0, 0, 0, 0, 0, 0, 'steer');
  if (!lite) {
    // Hub, three spokes (left, right, down) and a marker at twelve o'clock in the kart's colour, so you see it turn.
    put(new THREE.CylinderGeometry(0.032, 0.032, 0.03, 10).rotateX(Math.PI / 2), 'ink', 0, 0, 0, 0, 0, 0, 'steer');
    for (const a of [0, Math.PI, -Math.PI / 2]) put(new THREE.BoxGeometry(0.014, 0.1, 0.008), 'steel', Math.cos(a) * 0.075, Math.sin(a) * 0.075, 0, 0, 0, a - Math.PI / 2, 'steer');
    put(rbox(0.04, 0.034, 0.05, 0.01), 'paint', 0, 0.13, 0, 0, 0, 0, 'steer');
  }

  // Driver: torso, arms; the helmet with visor and livery stripe on its own node (pivot at the neck)
  put(new THREE.CapsuleGeometry(0.17, 0.26, L(4, 3), L(10, 8)), 'suit', 0, 0.62, -0.22, -0.35);
  if (!lite) put(new THREE.CapsuleGeometry(0.172, 0.04, 4, 10), 'paper', 0, 0.5, -0.18, -0.35);
  for (const sx of [-1, 1]) put(new THREE.CapsuleGeometry(0.045, 0.32, L(4, 2), L(8, 6)), 'suit', sx * 0.16, 0.62, -0.02, Math.PI / 2 - 0.55, 0, sx * 0.28);
  const [hx, hy, hz] = NODES.helmet.pos;
  put(new THREE.SphereGeometry(0.155, L(20, 14), L(16, 10)), 'paper', -hx, 0.99 - hy, -0.16 - hz, 0, 0, 0, 'helmet');
  if (!lite) {
    put(new THREE.SphereGeometry(0.157, 20, 10, -Math.PI / 2.6, Math.PI / 1.3, Math.PI / 2.75, Math.PI / 4.2), 'visor', -hx, 0.99 - hy, -0.16 - hz, 0, 0, 0, 'helmet');
    put(new THREE.TorusGeometry(0.153, 0.022, 6, 24), 'paint', -hx, 0.99 - hy, -0.16 - hz, 0, Math.PI / 2, 0, 'helmet');
  }

  // Wheels: rounded tyre, paper rim, ink cap. One front wheel (both sides share it), and the rear axle's pair.
  const wheel = (x: number, r: number, w: number, node: NodeId) => {
    if (lite) put(tyreGeometry(r, w, 12), 'rubber', x, 0, 0, 0, 0, 0, node);
    else for (const [geo, kind] of tyreParts(r, w)) put(geo, kind, x, 0, 0, 0, 0, 0, node);
    put(new THREE.CylinderGeometry(r * 0.6, r * 0.6, w * 0.9, L(14, 10)).rotateZ(Math.PI / 2), 'paper', x, 0, 0, 0, 0, 0, node);
    if (lite) return;
    put(new THREE.CylinderGeometry(r * 0.2, r * 0.2, w * 0.95, 8).rotateZ(Math.PI / 2), 'ink', x, 0, 0, 0, 0, 0, node);
    // Three wheel nuts on each face of the rim.
    for (const side of [-1, 1])
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        put(new THREE.CylinderGeometry(0.012, 0.012, 0.014, 6).rotateZ(Math.PI / 2), 'ink', x + side * w * 0.45, Math.cos(a) * r * 0.37, Math.sin(a) * r * 0.37, 0, 0, 0, node);
      }
  };
  wheel(0, FRONT_R, 0.13, 'front');
  for (const sx of [-1, 1]) wheel(sx * 0.6, 0.14, 0.2, 'rear');

  return (partsCache[lite ? 'lite' : 'full'] = parts);
}

/**
 * Merge parts into one geometry with per-vertex colour and surface (roughness, metalness, glow), or
 * with no colour (null: the ghost's, whose colour is its material's).
 */
function mergeParts(list: { part: Part; matrix?: THREE.Matrix4 }[], color: THREE.Color | null): THREE.BufferGeometry {
  const c = new THREE.Color();
  const geos = list.map(({ part, matrix }) => {
    const g = new THREE.BufferGeometry();
    g.setIndex(part.geo.index);
    g.setAttribute('position', part.geo.attributes.position);
    g.setAttribute('normal', part.geo.attributes.normal);
    if (!color) return matrix ? g.clone().applyMatrix4(matrix) : g;
    const [hex, rough, metal, glow] = SURFACE[part.kind];
    if (hex === null) c.copy(color);
    else c.setHex(hex); // sRGB in, linear out (vertex colours are linear)
    const n = part.geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    const surf = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col.set([c.r, c.g, c.b], i * 3);
      surf.set([rough, metal, glow], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('akSurf', new THREE.BufferAttribute(surf, 3));
    return matrix ? g.clone().applyMatrix4(matrix) : g;
  });
  const merged = mergeGeometries(geos);
  if (!merged) throw new Error('kart: merge failed');
  merged.computeBoundingSphere();
  return merged;
}

/** Night glow for every kart's lamps (one shared uniform; set per frame from the race). */
const lampGlow = { value: 0 };

/** Per-vertex roughness, metalness and glow (akSurf) on a standard material. One function, so one program. */
function kartSurface(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.akGlow = lampGlow;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 akSurf;\nvarying vec3 vAkSurf;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAkSurf = akSurf;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vAkSurf;\nuniform float akGlow;')
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vAkSurf.x;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vAkSurf.y;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vAkSurf.z * akGlow;');
}

function kartMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true });
  m.onBeforeCompile = kartSurface;
  return m;
}

function nodeMatrix(id: Exclude<NodeId, 'body' | 'front'>) {
  const n = NODES[id];
  return new THREE.Matrix4().compose(new THREE.Vector3(...n.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...n.rot)), new THREE.Vector3(1, 1, 1));
}

/** The driver's number, front (on the panel) and rear (on the plate): one mesh, one texture. */
function numberDecals(n: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2eee5';
  g.fillRect(0, 0, 96, 64);
  g.fillStyle = '#141414';
  g.font = '800 48px Archivo, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 48, 36);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // On the front panel (0, 0.3, 0.52, tilted -0.55), just proud of its face; on the rear plate, facing back.
  const front = new THREE.PlaneGeometry(0.3, 0.2).translate(0, 0, 0.037).rotateX(-0.55).translate(0, 0.3, 0.52);
  const rear = new THREE.PlaneGeometry(0.21, 0.14).rotateY(Math.PI).translate(0, 0, -0.0165).rotateX(PLATE.tilt).translate(...PLATE.pos);
  const geo = mergeGeometries([front, rear]);
  if (!geo) throw new Error('kart: merge failed');
  const m = new THREE.MeshBasicMaterial({ map: t });
  m.userData.akDecal = true; // dimmed at night (kartLights): it's unlit
  return new THREE.Mesh(geo, m);
}

/** Low-poly racing kart facing +z, origin on the ground at the kart's centre. */
export function buildKart(color: string, opts: { ghost?: boolean; number?: number } = {}): KartVisual {
  if (opts.ghost) return buildGhost(color);
  const parts = kartParts();
  const paint = new THREE.Color(color);
  const material = kartMaterial();
  // Shadows through a depth material of the kart's own. three's shared one only picks a new program
  // when the caster type changes (not when the lights do), so whether its plain, untextured variant
  // for the current lights exists depends on the order casters happen to come in; with the old
  // 39-part kart it happened to, with the merged one a plain world caster could compile it mid-race.
  // Ours re-resolves whenever the kart's material recompiles (time of day, light rig), which the
  // warm-up always covers, and programs are shared by key, so the world's plain casters reuse it.
  const depth = new THREE.MeshDepthMaterial();
  let seen = -1;
  const syncDepth = () => {
    if (material.version === seen) return;
    seen = material.version;
    depth.needsUpdate = true;
  };
  const of = (node: NodeId) => parts.filter((p) => p.node === node).map((part) => ({ part }));
  const mesh = (geo: THREE.BufferGeometry, parent: THREE.Object3D, id?: Exclude<NodeId, 'body' | 'front'>) => {
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true;
    m.customDepthMaterial = depth;
    if (id) {
      m.position.set(...NODES[id].pos);
      m.rotation.set(...NODES[id].rot);
    }
    parent.add(m);
    return m;
  };

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  mesh(mergeParts(of('body'), paint), body).onBeforeRender = syncDepth;
  const steering = mesh(mergeParts(of('steer'), paint), body, 'steer');
  const helmet = mesh(mergeParts(of('helmet'), paint), body, 'helmet');
  const materials: THREE.Material[] = [material, depth];
  if (opts.number !== undefined) {
    const decals = numberDecals(opts.number);
    body.add(decals);
    materials.push(decals.material as THREE.Material);
  }

  const frontGeo = mergeParts(of('front'), paint);
  const frontPivots: THREE.Group[] = [];
  const wheels: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * FRONT_X, FRONT_R, FRONT_Z);
    root.add(pivot);
    frontPivots.push(pivot);
    wheels.push(mesh(frontGeo, pivot));
  }
  wheels.push(mesh(mergeParts(of('rear'), paint), root, 'rear'));

  return { root, body, frontPivots, wheels, materials, steering, helmet };
}

/**
 * The driver at work (render only): the steering wheel turns with the front wheels (about 2.8 turns
 * of lock to one of the wheels, as drawn), and the helmet leans into the corner, up to 6 degrees at
 * about 1.5 g. `steer` is the front wheels' angle (rad, + right), `lateral` the yaw rate times
 * forward speed (m/s², + left).
 */
export function poseDriver(v: KartVisual, steer: number, lateral: number, dt: number) {
  if (v.steering) v.steering.rotation.z = THREE.MathUtils.clamp(steer * 3.4, -1.7, 1.7);
  if (v.helmet) v.helmet.rotation.z += (THREE.MathUtils.clamp(-lateral * 0.007, -0.105, 0.105) - v.helmet.rotation.z) * Math.min(1, dt * 6);
}

/**
 * Lamps: a lit red by day, glowing at night (every kart shares it). With bloom (Medium, High) the lamp
 * has to be bright enough to pass its threshold, and the halo carries the red; without (Low), any
 * brighter than this and tone mapping washes it out to pink. The unlit number boards dim at night.
 */
export function kartLights(v: KartVisual, night: boolean, bloom: boolean) {
  lampGlow.value = night ? (bloom ? 5.5 : 1.3) : 0.8;
  for (const m of v.materials) if (m.userData.akDecal) (m as THREE.MeshBasicMaterial).color.setScalar(night ? 0.42 : 1);
}

// ------------------------------------------------------------------ ghosts
//
// A ghost is the whole kart merged into one mesh, drawn twice: a depth-only pass, then the colour pass
// with depth test "less or equal", so only its outer surface shows (a clean translucent silhouette,
// not 39 parts seen through each other). The colour pass is lit, with a Fresnel rim in the ghost's
// colour, and both fade out within ~3 m of the camera so a ghost never fills the screen. Colour is
// a uniform, so every ghost shares the same two programs (the warm-up's ghost compiles them all).

/** Distance from the camera (m) where a ghost starts to show, and where it's fully there. */
const GHOST_NEAR = 1.5;
const GHOST_FAR = 4;
/** Ghost pair draw slot: after other transparent things, each ghost's two passes back to front. */
const GHOST_ORDER = 2;

function ghostFade(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <opaque_fragment>',
    /* glsl */ `
    // Fresnel rim in the ghost's colour: bright where the surface turns away, faint face-on.
    float akFace = saturate(dot(normal, geometryViewDir));
    float akRim = pow(1.0 - akFace, 2.6);
    // Mostly its own colour (it shouldn't light up like a solid kart in a floodlight or the headlight),
    // with enough of the real lighting left to read its shape.
    outgoingLight = outgoingLight * 0.4 + diffuse * 0.3 + mix(diffuse, vec3(1.0), 0.35) * akRim * 1.1;
    diffuseColor.a = min(1.0, opacity + akRim * 0.5) * smoothstep(${GHOST_NEAR.toFixed(2)}, ${GHOST_FAR.toFixed(2)}, length(vViewPosition));
    #include <opaque_fragment>`,
  );
}

function ghostDepthCut(shader: THREE.WebGLProgramParametersWithUniforms) {
  // Where the colour pass is mostly faded (near the camera), write no depth either.
  const cut = (GHOST_NEAR + (GHOST_FAR - GHOST_NEAR) * 0.35).toFixed(2);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vAkDist;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvAkDist = length(mvPosition.xyz);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vAkDist;')
    .replace('void main() {', `void main() {\n  if (vAkDist < ${cut}) discard;`);
}

/**
 * A ghost in `color`. Pass another ghost (`share`) to reuse its geometry: every ghost has the same
 * shape, so a ghost arriving mid-race uploads nothing.
 */
export function buildGhost(color: string, share?: THREE.Object3D): KartVisual {
  let geo = (share?.children[0] as THREE.Mesh | undefined)?.geometry;
  if (!geo) {
    const at: Record<NodeId, THREE.Matrix4[]> = {
      body: [new THREE.Matrix4()],
      steer: [nodeMatrix('steer')],
      helmet: [nodeMatrix('helmet')],
      front: [-1, 1].map((sx) => new THREE.Matrix4().makeTranslation(sx * FRONT_X, FRONT_R, FRONT_Z)),
      rear: [nodeMatrix('rear')],
    };
    geo = mergeParts(
      kartParts(true).flatMap((part) => at[part.node].map((matrix) => ({ part, matrix }))),
      null,
    );
  }
  const depth = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true });
  depth.polygonOffset = true; // a hair behind, so the colour pass always passes "less or equal" on it
  depth.polygonOffsetFactor = 1;
  depth.polygonOffsetUnits = 1;
  depth.onBeforeCompile = ghostDepthCut;
  const tint = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1, transparent: true, opacity: 0.14, depthWrite: false });
  tint.onBeforeCompile = ghostFade;
  const root = new THREE.Group();
  // Same position, same draw slot: three sorts them by distance and then by id, so each ghost's depth
  // pass (made first) draws just before its colour pass, and ghosts go back to front.
  for (const m of [depth, tint]) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = GHOST_ORDER;
    root.add(mesh);
  }
  return { root, body: root, frontPivots: [], wheels: [], materials: [depth, tint] };
}

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  drift: boolean;
}

export type Surface = 'track' | 'kerb' | 'grass';

/** A wall contact starting (KartPhysics.impact): for sparks, sound, haptics and the camera. */
export interface Impact {
  speed: number; // closing speed into the wall, m/s (the normal component)
  x: number; // contact point, on the kart's side against the wall
  z: number;
  nx: number; // wall surface normal, unit, pointing back towards the track
  nz: number;
}

// Wall response: friction from the normal impulse, restitution, and a little extra loss on hard hits.
const WALL_MU = 0.5;
const WALL_E = 0.2;
const WALL_LOSS = 0.15;

/** Arcade kart dynamics on a flat plane, constrained by the track's barriers. */
export class KartPhysics {
  x = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  steerAngle = 0;
  slip = 0; // lateral speed, m/s (for skid marks / audio)
  surface: Surface = 'track';
  hint = -1;
  offset = 0;
  s = 0;
  wheelSpin = 0;
  bump = 0; // impact intensity for camera shake / sound
  /** Set for the one step in which the kart left its part of the lap for another (null otherwise). */
  rejoin: Rejoin | null = null;
  /** Metres driven in total (place() doesn't count): a lap shorter than the track allows is a cut. */
  odo = 0;
  /** How many times place() has run: lets progress consumers tell a reset from a jump. */
  placed = 0;
  /** Set for the one step in which a wall contact starts (null otherwise). */
  impact: Impact | null = null;
  /** Touching a wall this step. */
  onWall = false;
  /** On a painted kerb, not just the concrete apron's kerb-grip band: rumble, sound and buzz follow it. */
  onKerb = false;
  /** Seconds spent below walking pace with the pedals pressed (wedged, or beached). */
  stuckT = 0;
  /** The last lap position on this part of the lap's own asphalt: where a reset puts the kart. */
  goodS = 0;
  private gripLossT = 0; // after a hard wall hit: the tyres take a moment to bite again

  readonly vmax = 27; // ~97 km/h
  readonly wheelbase = 1.05;

  constructor(private track: TrackModel) {}

  place(s: number) {
    const p = this.track.at(s);
    this.x = p.x;
    this.z = p.z;
    this.heading = p.heading;
    this.vx = this.vz = this.yawRate = this.steerAngle = 0;
    this.hint = p.i;
    this.locate(); // s and offset right away, not at the next step
    this.rejoin = null;
    this.impact = null;
    this.onWall = this.onKerb = false;
    this.gripLossT = 0;
    this.stuckT = 0;
    this.goodS = this.s;
    this.placed++;
  }

  /**
   * Where the kart is in the lap (hint, s, offset; rejoin), from x/z. Progress follows the lap
   * continuously, so it never jumps to another part of it however close (hairpin infields,
   * crossings). step() calls this after moving.
   */
  locate(): Nearest {
    const t = this.track;
    const hw = t.halfWidth;
    let near = this.hint < 0 ? t.closest(this.x, this.z) : t.follow(this.x, this.z, this.hint);
    this.rejoin = null;
    if (near.dist > hw + t.runoff) {
      // Past this part's barrier but on another part's asphalt or kerb: carry on from there, and
      // say so (Race: a forward rejoin is a cut).
      const other = t.closest(this.x, this.z, near.i);
      if (other.dist <= hw + KERB) {
        this.rejoin = { from: near.i, to: other.i, gain: t.gain(near.i, other.i) };
        near = other;
      }
    }
    this.hint = near.i;
    this.s = near.s;
    this.offset = near.offset;
    return near;
  }

  get speed() {
    return Math.hypot(this.vx, this.vz);
  }

  get forwardSpeed() {
    return this.vx * Math.sin(this.heading) + this.vz * Math.cos(this.heading);
  }

  step(dt: number, c: Controls) {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const rx = -fz; // right vector
    const rz = fx;
    let vf = this.vx * fx + this.vz * fz;
    let vl = this.vx * rx + this.vz * rz;

    const grass = this.surface === 'grass';
    const kerb = this.surface === 'kerb';
    const vmax = grass ? 11 : this.vmax;

    // Longitudinal
    const engine = c.throttle * (vf < vmax ? 11 * (1 - Math.max(0, vf) / vmax) + 2.2 : 0);
    let accel = engine;
    if (c.brake > 0) accel -= vf > 0.5 ? 22 * c.brake : vf > -6 ? 6 * c.brake : 0; // brake, then reverse slowly
    accel -= 0.0028 * vf * Math.abs(vf) + (grass ? 2.5 * Math.sign(vf) + 0.12 * vf : 0.35 * Math.sign(vf));
    if (c.throttle === 0 && c.brake === 0 && Math.abs(vf) < 0.4) vf = 0;
    else vf += accel * dt;

    // Steering: less lock at speed, smoothed.
    const lock = 0.48 / (1 + Math.abs(vf) / 7.5);
    const target = c.steer * lock;
    this.steerAngle += (target - this.steerAngle) * Math.min(1, dt * 14);

    // Yaw: bicycle model, clamped by available lateral grip.
    const gripG = grass ? 0.75 : c.drift ? 1.3 : kerb ? 2.0 : 2.35;
    const hit = this.gripLossT > 0; // only ever after a wall hit: clean laps are untouched
    this.gripLossT = Math.max(0, this.gripLossT - dt);
    const maxLat = gripG * 9.81 * (hit ? 0.6 : 1);
    // Positive heading change turns left, so steering right means negative yaw.
    let desiredYaw = -(vf * Math.tan(this.steerAngle)) / this.wheelbase;
    const yawLimit = maxLat / Math.max(Math.abs(vf), 2) + (c.drift ? 0.9 : 0);
    desiredYaw = THREE.MathUtils.clamp(desiredYaw, -yawLimit, yawLimit);
    this.yawRate += (desiredYaw - this.yawRate) * Math.min(1, dt * (c.drift ? 6 : 12));
    this.heading += this.yawRate * dt;

    // Lateral velocity bleeds off according to grip; drifting keeps more slide.
    const lateralGrip = (grass ? 2.2 : c.drift ? 1.6 : kerb ? 7 : 11) * (hit ? 0.35 : 1);
    vl *= Math.exp(-lateralGrip * dt);
    if (c.drift && Math.abs(vf) > 8) vf -= 1.2 * dt * Math.sign(vf); // drifting scrubs a little speed
    this.slip = Math.abs(vl) + (c.drift ? Math.abs(this.yawRate) * 1.5 : 0);

    // Re-project onto the new heading.
    const nfx = Math.sin(this.heading);
    const nfz = Math.cos(this.heading);
    this.vx = nfx * vf + -nfz * vl;
    this.vz = nfz * vf + nfx * vl;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.odo += Math.hypot(this.vx, this.vz) * dt;
    this.wheelSpin += (vf / 0.135) * dt;

    // Track surface + barriers.
    const prevS = this.s;
    const near = this.locate();
    const hw = this.track.halfWidth;
    const wall = hw + this.track.runoff;
    let ds = Math.abs(near.s - prevS);
    ds = Math.min(ds, this.track.length - ds);
    if (near.dist <= hw && !this.rejoin && ds < 3) this.goodS = near.s;
    this.surface = near.dist <= hw ? 'track' : near.dist <= hw + KERB ? 'kerb' : 'grass';
    // Asphalt is asphalt: another part of the lap's road grips like the road (where sections merge
    // or cross). Limits and the reset point still go by this part's own road.
    if (near.dist > hw && this.track.nearestOther(this.x, this.z, near.i, hw) >= 0) this.surface = 'track';
    this.onKerb = this.surface === 'kerb' && hasKerb(this.track, near.i, near.offset > 0 ? 1 : -1);
    this.bump *= Math.exp(-dt * 6);
    this.impact = null;
    const touching = near.dist > wall;
    if (touching) {
      // n: unit normal pointing into the wall. Push the kart back out to the barrier line.
      const [nx0, nz0] = this.track.normal(near.i);
      const side = Math.sign(near.offset);
      const nx = nx0 * side;
      const nz = nz0 * side;
      const push = near.dist - wall;
      this.x -= nx * push;
      this.z -= nz * push;
      const vn = this.vx * nx + this.vz * nz;
      if (vn > 0) {
        // Impulse: the speed into the wall bounces back at WALL_E; the speed along it is kept, less
        // Coulomb friction from that impulse and a little more on a hard hit. Per contact step, but
        // after the first one the kart runs along the wall and vn is ~0, so it never pins.
        const tx = this.vx - nx * vn;
        const tz = this.vz - nz * vn;
        const vt = Math.hypot(tx, tz);
        const keep = vt > 1e-3 ? Math.max(0, 1 - (WALL_MU * (1 + WALL_E) * vn) / vt) * (1 - WALL_LOSS * Math.min(1, vn / 6)) : 0;
        this.vx = tx * keep - nx * vn * WALL_E;
        this.vz = tz * keep - nz * vn * WALL_E;
        // Turn the nose along the wall, the way it already points (along the race direction when
        // square on), so the throttle drives it along the wall rather than back into it.
        const fx = Math.sin(this.heading);
        const fz = Math.cos(this.heading);
        let ax = -nz;
        let az = nx;
        const facing = ax * fx + az * fz;
        if ((Math.abs(facing) < 0.05 ? ax * this.track.tx[near.i] + az * this.track.tz[near.i] : facing) < 0) {
          ax = -ax;
          az = -az;
        }
        // Moving along the wall the way the nose points: follow the velocity (it leans slightly off
        // the wall after the bounce); otherwise the wall line itself.
        const along = this.vx * ax + this.vz * az;
        const target = along > 1 ? Math.atan2(this.vx, this.vz) : Math.atan2(ax, az);
        const dh = Math.atan2(Math.sin(target - this.heading), Math.cos(target - this.heading));
        this.heading += dh * 0.7;
        this.yawRate = 0;
        if (vn > 1.5) this.gripLossT = Math.min(0.35, 0.1 + 0.03 * vn);
        this.bump = Math.min(1, this.bump + vn / 10);
        if (!this.onWall && vn > 0.5) this.impact = { speed: vn, x: this.x + nx * 0.65, z: this.z + nz * 0.65, nx: -nx, nz: -nz };
      }
    }
    this.onWall = touching;
    this.stuckT = this.speed < 2 && (c.throttle > 0 || c.brake > 0) ? this.stuckT + dt : 0;
  }
}
