// Map-based editor for correcting a circuit's centreline over satellite imagery.
import L from 'leaflet';
import { loopLength, type LatLon } from '../track/osm';

/** Douglas-Peucker on a closed loop (tolerance in metres) so editing has a sane number of handles. */
export function simplifyLoop(pts: LatLon[], tol = 1.2): LatLon[] {
  if (pts.length < 8) return pts.slice();
  const k = Math.cos((pts[0][0] * Math.PI) / 180) * 111320;
  const xy = pts.map(([la, lo]) => [lo * k, la * 110540]);
  const keep = new Uint8Array(pts.length);
  const rec = (a: number, b: number) => {
    let best = -1;
    let bestD = 0;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2));
      const d = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0 && bestD > tol) {
      keep[best] = 1;
      rec(a, best);
      rec(best, b);
    }
  };
  const mid = Math.floor(pts.length / 2);
  keep[0] = keep[mid] = 1;
  rec(0, mid);
  rec(mid, pts.length - 1);
  keep[pts.length - 1] = 1;
  return pts.filter((_, i) => keep[i]);
}

export interface EditorCallbacks {
  onChange: (info: { points: number; lengthM: number; drawing: boolean }) => void;
}

export class LayoutEditor {
  private pts: LatLon[];
  private layer = L.layerGroup();
  private casing: L.Polyline;
  private line: L.Polyline;
  private handles: L.Marker[] = [];
  private mids: L.Marker[] = [];
  private drawing = false;
  private onMapClick = (e: L.LeafletMouseEvent) => this.mapClick(e);

  constructor(
    private map: L.Map,
    initial: LatLon[],
    private cb: EditorCallbacks,
  ) {
    this.pts = simplifyLoop(initial);
    // Pit Wall yellow on a dark casing, so it reads over bright concrete and dark trees alike.
    this.casing = L.polyline([], { color: '#0b0c10', weight: 8, opacity: 0.55, interactive: false });
    this.line = L.polyline([], { color: '#ffd60a', weight: 3.5, opacity: 1, interactive: false });
    this.layer.addTo(map);
    this.casing.addTo(this.layer);
    this.line.addTo(this.layer);
    map.on('click', this.onMapClick);
    map.getContainer().classList.add('editing');
    this.render();
  }

  get points(): LatLon[] {
    return this.pts.map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)] as LatLon);
  }

  private emit() {
    this.cb.onChange({ points: this.pts.length, lengthM: this.pts.length > 2 ? loopLength(this.pts) : 0, drawing: this.drawing });
  }

  private setLine(ll: LatLon[]) {
    this.casing.setLatLngs(ll);
    this.line.setLatLngs(ll);
  }

  private render() {
    this.handles.forEach((h) => h.remove());
    this.mids.forEach((h) => h.remove());
    this.handles = [];
    this.mids = [];
    const closed = !this.drawing && this.pts.length > 2;
    this.setLine(closed ? [...this.pts, this.pts[0]] : this.pts);
    this.pts.forEach((p, i) => {
      const first = i === 0;
      const h = L.marker(p, {
        draggable: true,
        // A 26px hit area (thumbs); editor.css draws the visible dot inside it.
        icon: L.divIcon({ className: `ed-handle${first ? ' first' : ''}${this.drawing && first && this.pts.length > 3 ? ' closable' : ''}`, iconSize: [26, 26] }),
        title: first ? 'Start / finish' : 'Drag onto the middle of the track. Right-click to delete.',
      });
      h.on('drag', () => {
        const ll = h.getLatLng();
        this.pts[i] = [ll.lat, ll.lng];
        this.setLine(closed ? [...this.pts, this.pts[0]] : this.pts);
      });
      h.on('dragend', () => {
        this.render();
        this.emit();
      });
      h.on('contextmenu', () => {
        if (this.pts.length <= 6) return;
        this.pts.splice(i, 1);
        this.render();
        this.emit();
      });
      h.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (this.drawing && first && this.pts.length > 3) {
          this.drawing = false;
          this.render();
          this.emit();
        }
      });
      h.addTo(this.layer);
      this.handles.push(h);
    });
    if (!closed) return;
    // Midpoint handles: click to insert a point there.
    for (let i = 0; i < this.pts.length; i++) {
      const a = this.pts[i];
      const b = this.pts[(i + 1) % this.pts.length];
      const m = L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { icon: L.divIcon({ className: 'ed-mid', iconSize: [20, 20] }), title: 'Add a point here' });
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this.pts.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        this.render();
        this.emit();
      });
      m.addTo(this.layer);
      this.mids.push(m);
    }
  }

  private mapClick(e: L.LeafletMouseEvent) {
    if (!this.drawing) return;
    this.pts.push([e.latlng.lat, e.latlng.lng]);
    this.render();
    this.emit();
  }

  startOver() {
    this.pts = [];
    this.drawing = true;
    this.render();
    this.emit();
  }

  reverse() {
    if (this.drawing) return;
    this.pts = [this.pts[0], ...this.pts.slice(1).reverse()];
    this.render();
    this.emit();
  }

  reset(points: LatLon[]) {
    this.pts = simplifyLoop(points);
    this.drawing = false;
    this.render();
    this.emit();
  }

  get valid() {
    return !this.drawing && this.pts.length >= 6;
  }

  destroy() {
    this.map.off('click', this.onMapClick);
    this.map.getContainer().classList.remove('editing');
    this.layer.remove();
  }
}
