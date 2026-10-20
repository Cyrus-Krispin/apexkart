// Full-screen layout editor: fix a circuit's centreline over satellite imagery.
// The home screen has no map any more, so the editor brings its own (Leaflet, loaded only here).
// Contract used by the home screen (src/ui/atlas.ts); see docs/pit-wall.md.
import '../styles/editor.css';
import type { CommunityLayout, Driver } from '../net/api';
import type { TrackData } from '../track/osm';

export interface EditorOptions {
  track: TrackData; // the layout being fixed (points, center, width, name; corrected?.osmPoints is the original trace)
  driver: Driver; // who's saving
  /** Saved: the new layout, and the base id it replaces (track.corrected?.baseId ?? track.id). */
  onSaved: (layout: CommunityLayout, base: string) => void;
  /** Closed without saving. */
  onClose: () => void;
}

/** Open the editor over everything. Returns a function that closes it. */
export function openLayoutEditor(o: EditorOptions): () => void {
  // Placeholder until the editor screen lands (pit-pages work): say so and close.
  void o.track;
  queueMicrotask(() => o.onClose());
  return () => {};
}
