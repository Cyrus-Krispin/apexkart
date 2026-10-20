// The narrow interface between Race (src/game/race.ts) and add-ons such as multiplayer.
// A time trial passes no mode; see MULTIPLAYER.md for how each hook is used.
import type * as THREE from 'three';
import type { TrackModel } from './track';
import type { KartPhysics } from './kart';

export interface RaceMode {
  /** performance.now() time at which the lights go out. Replaces the random local start. */
  startAt?: number;
  /** Grid slot, 0 = pole. Rows of two, side by side (gridPose). */
  gridSlot?: number;
  /** Ghost karts (your PB, leaderboard top 3). Default true. */
  ghosts?: boolean;
  /** Poll and show the live leaderboard panel. Default true. */
  leaderboard?: boolean;
  /** Offer "Restart from grid" in the pause menu. Default true. */
  restart?: boolean;
  /** Label for the pause menu's exit button (default "Back to circuits"). */
  exitLabel?: string;
  /** Time of day shared by everyone in the session. Overrides (without changing) the player's
   * own Day/Night preference and hides the pause menu's Time of day toggle. */
  time?: 'day' | 'night';
  addon?: RaceAddon;
}

export interface RaceAddon {
  attach?(race: RaceContext): void;
  /** Fixed physics step (1/120 s), right after the local kart has moved. */
  tick?(dt: number): void;
  /** Once per rendered frame, just before the scene is drawn. */
  frame?(dt: number): void;
  /** Draw extra markers on the minimap. */
  minimap?(dot: (x: number, z: number, color: string, r: number, ring?: boolean) => void): void;
  dispose?(): void;
}

export interface RaceContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly track: TrackModel;
  /** The local kart. Add-ons may nudge x/z/vx/vz (e.g. kart-to-kart contact) in tick(). */
  readonly phys: KartPhysics;
  /** HUD root element; overlays can be appended here. */
  readonly hud: HTMLElement;
  readonly state: 'intro' | 'grid' | 'racing' | 'paused';
  /** Simulation clock in seconds (stops while paused). */
  readonly simT: number;
  /** performance.now() time of the instant this frame shows (the local kart is interpolated). */
  readonly viewTime: number;
  /** performance.now() time of the newest physics state (phys). */
  readonly physTime: number;
  /** Cached view size in CSS px (don't read clientWidth per frame). */
  readonly viewW: number;
  readonly viewH: number;
  toast(text: string, kind?: '' | 'warn' | 'gold'): void;
  /** Big centre banner (GO, FINAL LAP, …). */
  banner(text: string, kind?: 'go' | 'pb' | 'warn' | 'info', secs?: number): void;
  /** Hand the kart to the built-in driver (e.g. a cool-down lap after the flag). */
  setAutopilot(on: boolean): void;
  /** Same as "Back to track map" in the pause menu. */
  exit(): void;
}

// Multiplayer grid: rows of two side by side, laid out in real metres behind the start line so
// all 8 slots sit on the straight. The line itself never moves (stored ghosts and the leaderboard's
// lap checks depend on it); a short straight gets a tighter grid instead.
const GRID_FRONT = 14; // m behind the line: the front row, level with the time-trial start
const GRID_PITCH = 6; // m between rows when the straight is long enough...
const GRID_PITCH_MIN = 4; // ...squeezed down to this (a kart is 1.96 m long)...
const GRID_FRONT_MIN = 5; // ...then the front row moves up towards the line, down to this
const GRID_MARGIN = 2; // m of straight left behind the back row's centre (its rear is ~1 m back)
const CORNER = 0.028; // 1/m (radius under ~36 m): a corner, as for kerbs
const SPAN = 4; // m either side for the geometric curvature
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface GridLayout {
  back: Float64Array; // real metres behind the line of each sample walked back from it...
  idx: Int32Array; // ...and that sample's index (idx[0] = 0, the line)
  front: number;
  pitch: number;
  straight: number; // m of straight behind the line
}
const layouts = new WeakMap<TrackModel, GridLayout>();

/**
 * Where the straight behind the line ends and how the grid fits on it. Measured in real metres:
 * centreline samples are 1 m apart in lap distance but bunch up or stretch where the OSM points
 * do, so lap distance alone can put two slots on top of each other.
 */
export function gridLayout(track: TrackModel): GridLayout {
  let g = layouts.get(track);
  if (g) return g;
  const { n, px, pz } = track;
  const seg = (i: number) => {
    const j = i + 1 === n ? 0 : i + 1;
    return Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  };
  const back = [0];
  const idx = [0];
  for (let i = 0, acc = 0; acc < 120 && idx.length < n; ) {
    i = i === 0 ? n - 1 : i - 1;
    acc += seg(i);
    back.push(acc);
    idx.push(i);
  }
  // The sample SPAN real metres from sample i (dir +1 ahead, -1 behind).
  const walk = (i: number, dir: number) => {
    let k = i;
    for (let acc = 0; acc < SPAN; ) {
      const b = (k + dir + n) % n;
      acc += Math.hypot(px[b] - px[k], pz[b] - pz[k]);
      k = b;
    }
    return k;
  };
  // Curvature from the stored (per-sample) value and from the circle through the points SPAN
  // metres either side, whichever is larger: the stored one reads low where samples bunch up.
  const bend = (i: number) => {
    const a = walk(i, -1);
    const c = walk(i, 1);
    const area2 = Math.abs((px[i] - px[a]) * (pz[c] - pz[a]) - (pz[i] - pz[a]) * (px[c] - px[a]));
    const sides = Math.hypot(px[i] - px[a], pz[i] - pz[a]) * Math.hypot(px[c] - px[i], pz[c] - pz[i]) * Math.hypot(px[c] - px[a], pz[c] - pz[a]);
    return Math.max(Math.abs(track.curv[i]), sides > 1e-9 ? (2 * area2) / sides : 0);
  };
  let straight = back[back.length - 1];
  for (let k = 0; k < idx.length; k++) {
    if (bend(idx[k]) >= CORNER) {
      straight = back[k];
      break;
    }
  }
  const room = straight - GRID_MARGIN; // for the four rows' centres
  let pitch = clamp((room - GRID_FRONT) / 3, GRID_PITCH_MIN, GRID_PITCH);
  const front = clamp(room - 3 * pitch, GRID_FRONT_MIN, GRID_FRONT);
  if (front + 3 * pitch > room) pitch = Math.max(3.2, (room - front) / 3); // a very short straight: as tight as karts allow
  g = { back: Float64Array.from(back), idx: Int32Array.from(idx), front, pitch, straight };
  layouts.set(track, g);
  return g;
}

/** Lap distance of the point `d` real metres behind the start line, along the centreline. */
function behindLine(track: TrackModel, g: GridLayout, d: number) {
  const { back, idx } = g;
  let k = 0;
  while (k < back.length - 2 && back[k + 1] < d) k++;
  const f = clamp((d - back[k]) / Math.max(1e-6, back[k + 1] - back[k]), 0, 1);
  return ((idx[k] === 0 ? track.n : idx[k]) - f) * (track.length / track.n);
}

/**
 * Grid position for a slot. Without one (time trial): 14 m behind the line on the centreline,
 * as always. Multiplayer slots: rows of two side by side (slot 0 left, 1 right, 2 left, …), the
 * front row 14 m back and 6 m between rows, squeezed (rows 4 m apart, the front row nearer the
 * line) where the straight behind the line is short, so every slot is on the straight.
 */
export function gridPose(track: TrackModel, slot?: number) {
  if (slot === undefined) {
    const s = track.length - 14;
    const p = track.at(s);
    return { s, x: p.x, z: p.z, heading: p.heading };
  }
  const g = gridLayout(track);
  const s = behindLine(track, g, g.front + Math.floor(slot / 2) * g.pitch);
  const p = track.at(s);
  const [nx, nz] = track.normal(p.i);
  // The same side and offset trackMesh.ts paints the grid boxes with.
  const side = (slot % 2 ? 1 : -1) * Math.min(2, track.halfWidth * 0.45);
  return { s, x: p.x + nx * side, z: p.z + nz * side, heading: p.heading };
}
