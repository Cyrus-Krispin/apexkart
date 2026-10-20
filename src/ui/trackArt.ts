// SVG circuit drawings in the Pit Wall style: a light line (or road) on carbon, chequered
// start/finish, direction chevrons, and optionally turn numbers, timing-coloured sectors and
// dots lapping for the drivers on track.
import { cornersInRaceOrder, type TrackShape } from '../track/shape';

export interface ArtOptions {
  w: number;
  h: number;
  pad?: number;
  reverse?: boolean;
  turns?: boolean; // numbered corners
  arrows?: boolean;
  road?: boolean; // thick road with casing instead of a single line
  draw?: boolean; // animate the line drawing itself
  sectors?: boolean; // colour S1 / S2 / S3 (purple, green, yellow) from the line in race direction
  live?: number; // dots lapping the circuit, one per driver on track
  lapS?: number; // seconds per lap for those dots
  className?: string;
}

let artSeq = 0;

export function trackArt(shape: TrackShape, o: ArtOptions): string {
  const pad = o.pad ?? 16;
  const { x, y, n } = shape;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x[i]);
    maxX = Math.max(maxX, x[i]);
    minY = Math.min(minY, y[i]);
    maxY = Math.max(maxY, y[i]);
  }
  const s = Math.min((o.w - 2 * pad) / (maxX - minX || 1), (o.h - 2 * pad) / (maxY - minY || 1));
  const ox = (o.w - (maxX - minX) * s) / 2;
  const oy = (o.h - (maxY - minY) * s) / 2;
  const P = (i: number): [number, number] => {
    const q = ((i % n) + n) % n;
    return [ox + (x[q] - minX) * s, oy + (y[q] - minY) * s];
  };
  const stride = Math.max(1, Math.floor(n / 360));
  let d = '';
  for (let i = 0; i < n; i += stride) {
    const [px, py] = P(i);
    d += `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  d += 'Z';

  const tangent = (i: number): [number, number] => {
    const [ax, ay] = P(i - 2);
    const [bx, by] = P(i + 2);
    const l = Math.hypot(bx - ax, by - ay) || 1;
    return [(bx - ax) / l, (by - ay) / l];
  };
  const lw = o.road ? Math.max(5, Math.min(11, o.w / 60)) : Math.max(2.2, Math.min(3.4, o.w / 90));
  const parts: string[] = [];

  if (o.road) {
    parts.push(`<path class="ta-casing" d="${d}" stroke-width="${(lw + 4).toFixed(1)}"/>`);
    parts.push(`<path class="ta-road" d="${d}" stroke-width="${lw.toFixed(1)}"${o.draw ? ' pathLength="1"' : ''}/>`);
    parts.push(`<path class="ta-center" d="${d}" stroke-width="1"/>`);
  } else {
    parts.push(`<path class="ta-line" d="${d}" stroke-width="${lw.toFixed(1)}"${o.draw ? ' pathLength="1"' : ''}/>`);
  }

  const dir = o.reverse ? -1 : 1;
  const start = Math.round(shape.startFrac * n);
  if (o.sectors) {
    // Thirds of the lap from the start line, in the direction of travel.
    const third = Math.ceil(n / 3);
    for (let k = 0; k < 3; k++) {
      let sd = '';
      const from = k * third;
      const to = Math.min(n, (k + 1) * third);
      for (let j = from; j <= to; j += Math.min(stride, Math.max(1, to - j)) || 1) {
        const [px, py] = P(start + dir * j);
        sd += `${j === from ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`;
        if (j === to) break;
      }
      parts.push(`<path class="ta-sector ta-s${k + 1}" d="${sd}" stroke-width="${Math.max(2, lw * (o.road ? 0.42 : 1)).toFixed(1)}"/>`);
    }
  }
  if (o.live && o.live > 0) {
    // Drivers on track: dots running the lap, spread around it.
    const id = `ta-p${++artSeq}`;
    parts.push(`<path id="${id}" d="${d}" fill="none" stroke="none"/>`);
    const lap = Math.max(20, o.lapS ?? 50);
    const startAt = shape.startFrac; // the path begins at index 0; offset so dots leave from the line
    for (let k = 0; k < Math.min(o.live, 12); k++) {
      const phase = (startAt + k / Math.min(o.live, 12)) % 1;
      const keys = o.reverse ? `keyPoints="1;0" keyTimes="0;1" calcMode="linear"` : '';
      parts.push(
        `<circle class="ta-live ta-live-${k % 6}" r="${Math.max(2.4, lw * 0.6).toFixed(1)}"><animateMotion dur="${lap.toFixed(1)}s" begin="-${(phase * lap).toFixed(2)}s" repeatCount="indefinite" ${keys}><mpath href="#${id}"/></animateMotion></circle>`,
      );
    }
  }
  if (o.arrows) {
    for (const f of [0.12, 0.45, 0.78]) {
      const i = Math.round((shape.startFrac + dir * f) * n);
      const [px, py] = P(i);
      let [tx, ty] = tangent(i);
      tx *= dir;
      ty *= dir;
      const a = (Math.atan2(ty, tx) * 180) / Math.PI;
      const c = lw * 0.9 + 2.5;
      parts.push(
        `<path class="ta-arrow" transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${a.toFixed(1)})" d="M${-c} ${-c}L0 0L${-c} ${c}" stroke-width="${Math.max(1.6, lw * 0.35).toFixed(1)}"/>`,
      );
    }
  }

  if (o.turns) {
    const list = cornersInRaceOrder(shape, !!o.reverse);
    list.forEach((c, k) => {
      const i = Math.round(c.frac * n);
      const [px, py] = P(i);
      const [tx, ty] = tangent(i);
      // Label on the outside of the corner: left of travel (ty, -tx) for a right-hander.
      const out = c.right ? 1 : -1;
      const nx = ty * out;
      const ny = -tx * out;
      const off = lw + 11;
      const lx = px + nx * off;
      const ly = py + ny * off;
      parts.push(
        `<g class="ta-turn" transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)})"><circle r="8"/><text dy="3.5">${k + 1}</text></g>`,
      );
    });
  }

  // Start/finish: a small chequered block across the line.
  {
    const i = Math.round(shape.startFrac * n);
    const [px, py] = P(i);
    const [tx, ty] = tangent(i);
    const a = (Math.atan2(ty, tx) * 180) / Math.PI;
    const cell = Math.max(2.4, lw * 0.55);
    const rows = 2;
    const cols = 4;
    let cells = '';
    for (let r = 0; r < rows; r++)
      for (let q = 0; q < cols; q++)
        cells += `<rect x="${(r - rows / 2) * cell}" y="${(q - cols / 2) * cell}" width="${cell}" height="${cell}" class="${(r + q) % 2 ? 'ta-chk-b' : 'ta-chk-w'}"/>`;
    parts.push(
      `<g class="ta-sf" transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${a.toFixed(1)})"><rect class="ta-sf-frame" x="${-cell - 1}" y="${-2 * cell - 1}" width="${2 * cell + 2}" height="${4 * cell + 2}"/>${cells}</g>`,
    );
  }

  return `<svg class="track-art ${o.className ?? ''}${o.draw ? ' draw' : ''}" viewBox="0 0 ${o.w} ${o.h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${parts.join('')}</svg>`;
}

/** Signed rotation label for a direction. */
export function rotationLabel(shape: TrackShape, reverse: boolean): { label: string; icon: string } {
  const cw = shape.clockwise !== reverse;
  return cw ? { label: 'Clockwise', icon: '↻' } : { label: 'Anticlockwise', icon: '↺' };
}

/** Top-down kart in a livery colour (profile preview). */
export function kartIcon(color: string, size = 56): string {
  return `<svg viewBox="0 0 40 56" width="${size * (40 / 56)}" height="${size}" aria-hidden="true" class="kart-icon">
    <rect x="1" y="6" width="7" height="11" rx="2" fill="#141414"/><rect x="32" y="6" width="7" height="11" rx="2" fill="#141414"/>
    <rect x="0" y="38" width="8" height="13" rx="2" fill="#141414"/><rect x="32" y="38" width="8" height="13" rx="2" fill="#141414"/>
    <path d="M12 3h16l3 8-2 6h-18l-2-6z" fill="${color}"/>
    <rect x="13" y="16" width="14" height="26" rx="3" fill="#2a2926"/>
    <rect x="6" y="21" width="5" height="16" rx="2" fill="${color}"/><rect x="29" y="21" width="5" height="16" rx="2" fill="${color}"/>
    <circle cx="20" cy="30" r="6" fill="#F2EEE5" stroke="#141414" stroke-width="1.5"/><rect x="15.5" y="25.5" width="9" height="3" rx="1.5" fill="#141414"/>
    <rect x="6" y="49" width="28" height="4" rx="2" fill="#141414"/>
  </svg>`;
}
