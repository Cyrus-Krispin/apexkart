// Stylised ground: OpenStreetMap land use painted into one large texture, plus a
// coarse land-class raster other world builders query (trees, grandstands...).
import * as THREE from 'three';
import type { EnvData, AreaKind, LineKind } from '../../track/env';
import type { TrackModel } from '../track';
import { footprintTouchesTrack, Land, projectRing, rng, type Extent, type LandClass, type Pt } from './common';

export const GROUND = {
  grass: '#7da457',
  grassDark: '#739b4f',
  mowA: '#86ae5e',
  mowB: '#78a052',
  apron: '#c8c1b1',
};

const AREA_STYLE: Record<AreaKind, { color: string; cls: LandClass }> = {
  farm: { color: '#b8b36d', cls: Land.Farm },
  residential: { color: '#b9b8a3', cls: Land.Paved },
  commercial: { color: '#b4afa4', cls: Land.Paved },
  industrial: { color: '#aca89e', cls: Land.Paved },
  grass: { color: '#87b062', cls: Land.Grass },
  park: { color: '#8cb767', cls: Land.Park },
  pitch: { color: '#79ad55', cls: Land.Park },
  scrub: { color: '#728b49', cls: Land.Grass },
  forest: { color: '#567f3c', cls: Land.Forest },
  sand: { color: '#d6c597', cls: Land.Sand },
  parking: { color: '#8e8b85', cls: Land.Paved },
  water: { color: '#5b8db0', cls: Land.Water },
};
const AREA_ORDER: AreaKind[] = ['farm', 'residential', 'commercial', 'industrial', 'grass', 'park', 'pitch', 'scrub', 'forest', 'sand', 'parking', 'water'];

const LINE_STYLE: Record<LineKind, { w: number; color: string; edge?: string; cls: LandClass }> = {
  stream: { w: 3, color: '#5b8db0', cls: Land.Water },
  path: { w: 2, color: '#cdbf9c', cls: Land.Paved },
  rail: { w: 4.5, color: '#7b6c5b', cls: Land.Paved },
  minor: { w: 6.5, color: '#6c6b68', edge: '#bdb6a6', cls: Land.Paved },
  major: { w: 12, color: '#5a5956', edge: '#e2dccd', cls: Land.Paved },
};

export class GroundPainter {
  readonly extent: Extent;
  readonly res: number; // canvas pixels per metre
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cls: Uint8Array; // 1 px per metre
  private clsW: number;
  private clsH: number;

  constructor(
    private track: TrackModel,
    private env: EnvData | null,
    extent: Extent,
    maxTex: number,
  ) {
    // Never paint more than ~2.4 km across.
    const cx = (extent.x0 + extent.x1) / 2;
    const cz = (extent.z0 + extent.z1) / 2;
    const half = Math.min(1200, Math.max(extent.x1 - extent.x0, extent.z1 - extent.z0) / 2);
    this.extent = { x0: Math.max(extent.x0, cx - half), x1: Math.min(extent.x1, cx + half), z0: Math.max(extent.z0, cz - half), z1: Math.min(extent.z1, cz + half) };
    const w = this.extent.x1 - this.extent.x0;
    const h = this.extent.z1 - this.extent.z0;
    this.res = Math.min(4, maxTex / Math.max(w, h));
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.ceil(w * this.res);
    this.canvas.height = Math.ceil(h * this.res);
    this.ctx = this.canvas.getContext('2d')!;
    this.clsW = Math.ceil(w);
    this.clsH = Math.ceil(h);
    this.cls = new Uint8Array(this.clsW * this.clsH);
  }

  /** Land class at a world position (Grass outside the painted area). */
  classAt(x: number, z: number): LandClass {
    const i = Math.floor(x - this.extent.x0);
    const j = Math.floor(z - this.extent.z0);
    if (i < 0 || j < 0 || i >= this.clsW || j >= this.clsH) return Land.Grass;
    return this.cls[j * this.clsW + i] as LandClass;
  }

  contains(x: number, z: number, margin = 0) {
    const e = this.extent;
    return x > e.x0 + margin && x < e.x1 - margin && z > e.z0 + margin && z < e.z1 - margin;
  }

  paint() {
    const g = this.ctx;
    const { x0, z0 } = this.extent;
    const R = this.res;
    // Class raster drawn in parallel on a small canvas, colour-coded in the red channel.
    const cc = document.createElement('canvas');
    cc.width = this.clsW;
    cc.height = this.clsH;
    const c = cc.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    const clsColor = (k: LandClass) => `rgb(${k * 20},0,0)`;

    const path = (ctx: CanvasRenderingContext2D, pts: Pt[], scale: number, close: boolean) => {
      ctx.beginPath();
      pts.forEach(([x, z], i) => {
        const u = (x - x0) * scale;
        const v = (z - z0) * scale;
        i ? ctx.lineTo(u, v) : ctx.moveTo(u, v);
      });
      if (close) ctx.closePath();
    };
    const fill = (pts: Pt[], color: string | CanvasPattern, cls: LandClass) => {
      path(g, pts, R, true);
      g.fillStyle = color;
      g.fill();
      path(c, pts, 1, true);
      c.fillStyle = clsColor(cls);
      c.fill();
    };
    const stroke = (pts: Pt[], wM: number, color: string | CanvasPattern, cls: LandClass | null, close = false, dash?: number[]) => {
      g.lineJoin = g.lineCap = 'round';
      g.setLineDash(dash ? dash.map((d) => d * R) : []);
      path(g, pts, R, close);
      g.strokeStyle = color;
      g.lineWidth = wM * R;
      g.stroke();
      g.setLineDash([]);
      if (cls !== null) {
        c.lineJoin = c.lineCap = 'round';
        path(c, pts, 1, close);
        c.strokeStyle = clsColor(cls);
        c.lineWidth = wM;
        c.stroke();
      }
    };

    // Base grass with large soft variation.
    g.fillStyle = GROUND.grass;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.fillStyle = clsColor(Land.Grass);
    c.fillRect(0, 0, cc.width, cc.height);
    const rand = rng(this.track.n * 7919 + 13);
    for (let i = 0; i < 260; i++) {
      const u = rand() * this.canvas.width;
      const v = rand() * this.canvas.height;
      const r = (14 + rand() * 50) * R;
      const grd = g.createRadialGradient(u, v, 0, u, v, r);
      const tone = rand() > 0.5 ? '255,250,200' : '40,60,20';
      grd.addColorStop(0, `rgba(${tone},${0.05 + rand() * 0.06})`);
      grd.addColorStop(1, `rgba(${tone},0)`);
      g.fillStyle = grd;
      g.fillRect(u - r, v - r, r * 2, r * 2);
    }

    // Land use areas, then linear features.
    const env = this.env;
    if (env) {
      for (const kind of AREA_ORDER) {
        const st = AREA_STYLE[kind];
        for (const a of env.areas) if (a.k === kind) fill(projectRing(this.track, a.p), st.color, st.cls);
      }
      // Forest floor gets darker speckle so woods read as woods even between trees.
      for (const a of env.areas) {
        if (a.k !== 'forest') continue;
        g.save();
        path(g, projectRing(this.track, a.p), R, true);
        g.clip();
        for (let i = 0; i < 400; i++) {
          g.fillStyle = `rgba(30,55,20,${0.08 + rand() * 0.12})`;
          g.beginPath();
          g.arc(rand() * this.canvas.width, rand() * this.canvas.height, (1.5 + rand() * 4) * R, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }
      const order: LineKind[] = ['stream', 'path', 'rail', 'minor', 'major'];
      for (const kind of order) {
        const st = LINE_STYLE[kind];
        const lines = env.lines.filter((l) => l.k === kind).map((l) => projectRing(this.track, l.p));
        if (st.edge) for (const l of lines) stroke(l, st.w + 1.2, st.edge, st.cls);
        for (const l of lines) stroke(l, st.w, st.color, st.cls);
        if (kind === 'rail') for (const l of lines) stroke(l, 3.2, '#4f4338', null, false, [0.35, 0.55]);
        if (kind === 'major') for (const l of lines) stroke(l, 0.25, '#efe9da', null, false, [3, 6]);
      }
      // Contact shadows where buildings meet the ground (skipping any that overlap the circuit,
      // which the building builder drops too).
      const standing = env.buildings.map((b) => projectRing(this.track, b.p)).filter((pts) => pts.length > 2 && !footprintTouchesTrack(this.track, pts));
      g.save();
      g.filter = `blur(${Math.max(2, 3 * R)}px)`;
      for (const pts of standing) {
        path(g, pts.map(([x, z]) => [x + 1.2, z + 1.2] as Pt), R, true);
        g.fillStyle = 'rgba(20,25,10,0.45)';
        g.fill();
      }
      g.restore();
      for (const pts of standing) fill(pts, '#9c998f', Land.Building);
    }

    // The circuit's own surroundings: mowed runoff with stripes aligned to the
    // main straight, then a concrete apron at the track edge.
    const t = this.track;
    const loop: Pt[] = [];
    for (let i = 0; i < t.n; i += 2) loop.push([t.px[i], t.pz[i]]);
    const stripe = document.createElement('canvas');
    const sw = Math.max(4, Math.round(5 * R));
    stripe.width = sw * 2;
    stripe.height = 4;
    const sg = stripe.getContext('2d')!;
    sg.fillStyle = GROUND.mowA;
    sg.fillRect(0, 0, sw, 4);
    sg.fillStyle = GROUND.mowB;
    sg.fillRect(sw, 0, sw, 4);
    const pattern = g.createPattern(stripe, 'repeat')!;
    pattern.setTransform(new DOMMatrix().rotate((Math.atan2(t.tz[0], t.tx[0]) * 180) / Math.PI + 90));
    stroke(loop, 2 * (t.halfWidth + t.runoff), pattern, Land.Track, true);
    stroke(loop, 2 * (t.halfWidth + 1.8), GROUND.apron, Land.Track, true);
    stroke(loop, 2 * t.halfWidth + 0.6, '#55534e', Land.Track, true);

    // Fine grain over everything so nothing reads as a flat fill.
    const grain = document.createElement('canvas');
    grain.width = grain.height = 128;
    const gg = grain.getContext('2d')!;
    const img = gg.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (rand() - 0.5) * 70;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    gg.putImageData(img, 0, 0);
    g.save();
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = 0.22;
    g.fillStyle = g.createPattern(grain, 'repeat')!;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.restore();

    // Read the class raster back.
    const data = c.getImageData(0, 0, cc.width, cc.height).data;
    for (let i = 0; i < this.cls.length; i++) this.cls[i] = Math.min(8, Math.round(data[i * 4] / 20));
  }

  /** Soft dark blobs under trees and objects (fake ambient occlusion). */
  blobShadows(list: { x: number; z: number; r: number; a?: number }[]) {
    const g = this.ctx;
    const R = this.res;
    for (const s of list) {
      const u = (s.x - this.extent.x0) * R;
      const v = (s.z - this.extent.z0) * R;
      const r = s.r * R;
      const grd = g.createRadialGradient(u, v, 0, u, v, r);
      grd.addColorStop(0, `rgba(15,25,8,${s.a ?? 0.38})`);
      grd.addColorStop(1, 'rgba(15,25,8,0)');
      g.fillStyle = grd;
      g.fillRect(u - r, v - r, r * 2, r * 2);
    }
  }

  /** Bake into a ground mesh. Edges fade into the base grass colour of the endless plane. */
  toMesh(maxAniso: number): THREE.Mesh {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const f = Math.min(W, H) * 0.08;
    const fade = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
      const grd = g.createLinearGradient(x0, y0, x1, y1);
      grd.addColorStop(0, GROUND.grass);
      grd.addColorStop(1, 'rgba(125,164,87,0)');
      g.fillStyle = grd;
      g.fillRect(rx, ry, rw, rh);
    };
    fade(0, 0, f, 0, 0, 0, f, H);
    fade(W, 0, W - f, 0, W - f, 0, f, H);
    fade(0, 0, 0, f, 0, 0, W, f);
    fade(0, H, 0, H - f, 0, H - f, W, f);

    const tex = new THREE.CanvasTexture(this.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const e = this.extent;
    const geo = new THREE.PlaneGeometry(e.x1 - e.x0, e.z1 - e.z0);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0 });
    addDetail(mat, 2.2, 0.26);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((e.x0 + e.x1) / 2, -0.02, (e.z0 + e.z1) / 2);
    mesh.receiveShadow = true;
    return mesh;
  }
}

let detailTex: THREE.Texture | null = null;
function detailTexture(): THREE.Texture {
  if (detailTex) return detailTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const img = g.createImageData(256, 256);
  const rand = rng(424242);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (rand() - 0.5) * 120;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // A few blade-like streaks so close-up grass has direction.
  for (let i = 0; i < 900; i++) {
    g.strokeStyle = `rgba(${rand() > 0.5 ? '255,255,255' : '0,0,0'},0.18)`;
    g.lineWidth = 1;
    const x = rand() * 256;
    const y = rand() * 256;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rand() - 0.5) * 3, y + 3 + rand() * 4);
    g.stroke();
  }
  detailTex = new THREE.CanvasTexture(c);
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
  return detailTex;
}

/** Multiply a tiling world-space detail texture into a material's colour (crisp close up). */
export function addDetail(mat: THREE.MeshStandardMaterial | THREE.MeshLambertMaterial, metres: number, strength: number) {
  const tex = detailTexture();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: tex };
    shader.uniforms.detailScale = { value: 1 / metres };
    shader.uniforms.detailStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAkWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvAkWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAkWorld;\nuniform sampler2D detailMap;\nuniform float detailScale;\nuniform float detailStrength;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float akD = texture2D(detailMap, vAkWorld.xz * detailScale).r * 0.6 + texture2D(detailMap, vAkWorld.xz * detailScale * 0.23).r * 0.4;
        diffuseColor.rgb *= 1.0 + (akD - 0.5) * detailStrength * 2.0;`,
      );
  };
  mat.customProgramCacheKey = () => `ak-detail-${metres}-${strength}`;
}
