import * as THREE from 'three';
import type { TrackModel } from './track';

const TILE_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const y2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export interface SatelliteGround {
  mesh: THREE.Mesh;
  /** Average imagery colour, used to tint the surrounding ground so the edge disappears. */
  edgeColor: THREE.Color;
}

/** Stitch satellite tiles around the track into one ground texture, positioned in track space. */
export async function buildSatelliteGround(
  track: TrackModel,
  maxAniso: number,
  onProgress?: (done: number, total: number) => void,
): Promise<SatelliteGround | null> {
  const pts = track.data.points;
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (const [la, lo] of pts) {
    minLat = Math.min(minLat, la);
    maxLat = Math.max(maxLat, la);
    minLon = Math.min(minLon, lo);
    maxLon = Math.max(maxLon, lo);
  }
  const padLat = 180 / 111000;
  const padLon = padLat / Math.cos((track.proj.lat0 * Math.PI) / 180);
  minLat -= padLat;
  maxLat += padLat;
  minLon -= padLon;
  maxLon += padLon;

  let z = 19;
  let x0 = 0,
    x1 = 0,
    y0 = 0,
    y1 = 0;
  for (; z >= 12; z--) {
    x0 = Math.floor(lon2x(minLon, z));
    x1 = Math.floor(lon2x(maxLon, z));
    y0 = Math.floor(lat2y(maxLat, z));
    y1 = Math.floor(lat2y(minLat, z));
    if ((x1 - x0 + 1) * 256 <= 4096 && (y1 - y0 + 1) * 256 <= 4096) break;
  }
  const w = (x1 - x0 + 1) * 256;
  const h = (y1 - y0 + 1) * 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3d4a2f';
  ctx.fillRect(0, 0, w, h);

  const jobs: Promise<void>[] = [];
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  let ok = 0;
  let done = 0;
  onProgress?.(0, total);
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      jobs.push(
        loadImage(TILE_URL(z, x, y)).then((img) => {
          if (img) {
            ctx.drawImage(img, (x - x0) * 256, (y - y0) * 256);
            ok++;
          }
          onProgress?.(++done, total);
        }),
      );
  await Promise.all(jobs);
  if (!ok) return null;

  // Average colour of the image border, then feather all four edges into it.
  const probe = document.createElement('canvas');
  probe.width = probe.height = 16;
  const pctx = probe.getContext('2d')!;
  pctx.drawImage(canvas, 0, 0, 16, 16);
  const px = pctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0, cnt = 0;
  for (let i = 0; i < 16; i++)
    for (let j = 0; j < 16; j++) {
      if (i > 1 && i < 14 && j > 1 && j < 14) continue;
      const o = (j * 16 + i) * 4;
      r += px[o];
      g += px[o + 1];
      b += px[o + 2];
      cnt++;
    }
  const avg = `rgb(${Math.round(r / cnt)},${Math.round(g / cnt)},${Math.round(b / cnt)})`;
  const fx = w * 0.14;
  const fy = h * 0.14;
  const fade = (x0g: number, y0g: number, x1g: number, y1g: number, rx: number, ry: number, rw: number, rh: number) => {
    const grad = ctx.createLinearGradient(x0g, y0g, x1g, y1g);
    grad.addColorStop(0, avg);
    grad.addColorStop(1, avg.replace('rgb', 'rgba').replace(')', ',0)'));
    ctx.fillStyle = grad;
    ctx.fillRect(rx, ry, rw, rh);
  };
  fade(0, 0, fx, 0, 0, 0, fx, h);
  fade(w, 0, w - fx, 0, w - fx, 0, fx, h);
  fade(0, 0, 0, fy, 0, 0, w, fy);
  fade(0, h, 0, h - fy, 0, h - fy, w, fy);

  const nw = track.proj.toLocal(y2lat(y0, z), x2lon(x0, z));
  const se = track.proj.toLocal(y2lat(y1 + 1, z), x2lon(x1 + 1, z));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  const geo = new THREE.PlaneGeometry(se.x - nw.x, se.z - nw.z);
  geo.rotateX(-Math.PI / 2);
  // PlaneGeometry's UV v=1 is at -z after rotation, which is north: matches the image top.
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((nw.x + se.x) / 2, 0, (nw.z + se.z) / 2);
  mesh.receiveShadow = true;
  const edgeColor = new THREE.Color(avg);
  return { mesh, edgeColor };
}
