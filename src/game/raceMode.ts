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
  readonly state: 'grid' | 'racing' | 'paused';
  /** Simulation clock in seconds (stops while paused). */
  readonly simT: number;
  toast(text: string, kind?: string): void;
  centerMsg(text: string, secs: number, kind?: string): void;
  /** Hand the kart to the built-in driver (e.g. a cool-down lap after the flag). */
  setAutopilot(on: boolean): void;
  /** Same as "Back to track map" in the pause menu. */
  exit(): void;
}
