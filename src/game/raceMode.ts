// The narrow interface between Race (src/game/race.ts) and add-ons such as multiplayer.
// A time trial passes no mode; see MULTIPLAYER.md for how each hook is used.
import type * as THREE from 'three';
import type { TrackModel } from './track';
import type { KartPhysics } from './kart';

export interface RaceMode {
  /** performance.now() time at which the lights go out. Replaces the random local start. */
  startAt?: number;
  /** Grid slot, 0 = pole. Slots are staggered left/right, 4 m apart. */
  gridSlot?: number;
  /** Ghost karts (your PB, leaderboard top 3). Default true. */
  ghosts?: boolean;
  /** Poll and show the live leaderboard panel. Default true. */
  leaderboard?: boolean;
  /** Offer "Restart from grid" in the pause menu. Default true. */
  restart?: boolean;
  /** Label for the pause menu's exit button (default "Back to circuits"). */
  exitLabel?: string;
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

/**
 * Grid position for a slot: 14 m behind the line on the centreline without a slot (time trial),
 * otherwise staggered left/right 4 m apart.
 */
export function gridPose(track: TrackModel, slot?: number) {
  const s = track.length - 14 - (slot ?? 0) * 4;
  const p = track.at(s);
  if (slot === undefined) return { s, x: p.x, z: p.z, heading: p.heading };
  const [nx, nz] = track.normal(p.i);
  const side = (slot % 2 ? 1 : -1) * Math.min(2, track.halfWidth * 0.45);
  return { s, x: p.x + nx * side, z: p.z + nz * side, heading: p.heading };
}
