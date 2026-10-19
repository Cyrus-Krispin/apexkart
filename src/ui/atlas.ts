import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { discoverTracks, trackFromId, type LatLon, type TrackData } from '../track/osm';
import { analyzeShape, type TrackShape } from '../track/shape';
import { trackArt, rotationLabel } from './trackArt';
import { ProfileMenu } from './profile';
import { LayoutEditor } from './layoutEditor';
import { api, escapeHtml, formatMs, timeAgo, type BoardResponse, type CommunityLayout, type Dir, type Driver, type FeedResponse } from '../net/api';
import { localPB } from '../game/race';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const LIGHT = `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const LIGHT_LABELS = `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
const SAT = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`;

export interface AtlasOptions {
  root: HTMLElement;
  driver: Driver;
  onRace: (track: TrackData, dir: Dir) => void;
}

const shapes = new Map<string, TrackShape>();
export function shapeOf(t: TrackData): TrackShape {
  let s = shapes.get(t.id);
  if (!s) {
    s = analyzeShape(t.points);
    shapes.set(t.id, s);
  }
  return s;
}

/** Point at a fraction of the raw polyline's arc length (same parametrisation as the shape). */
function pointAtFrac(pts: LatLon[], frac: number): LatLon {
  const k = Math.cos((pts[0][0] * Math.PI) / 180);
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = Math.hypot((b[1] - a[1]) * k, b[0] - a[0]);
    seg.push(d);
    total += d;
  }
  let want = frac * total;
  for (let i = 0; i < pts.length; i++) {
    if (want <= seg[i]) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const t = seg[i] ? want / seg[i] : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    want -= seg[i];
  }
  return pts[0];
}

function loopLengthKm(pts: LatLon[]) {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    L += Math.hypot((b[0] - a[0]) * 110540, (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180));
  }
  return L / 1000;
}

function coords(c: LatLon) {
  const la = `${Math.abs(c[0]).toFixed(4)}°${c[0] >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(c[1]).toFixed(4)}°${c[1] >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}

export class Atlas {
  private map!: L.Map;
  private light!: L.Layer;
  private sat!: L.TileLayer;
  private tracks = new Map<string, TrackData>();
  private pins = new Map<string, L.Marker>();
  private outlines = L.layerGroup();
  private sfMarker: L.Marker | null = null;
  private selected: TrackData | null = null;
  private dir: Dir = 'fwd';
  private feed: FeedResponse | null = null;
  private board: BoardResponse | null = null;
  private el: Record<string, HTMLElement> = {};
  private scanning: AbortController | null = null;
  private lastScan: L.LatLngBounds | null = null;
  private query = '';
  private profile: ProfileMenu;
  private timers: number[] = [];
  private toastTimer = 0;
  private aliases = new Map<string, string>(); // OSM id -> community layout id
  private pendingLayouts = new Map<string, CommunityLayout>();
  private editor: LayoutEditor | null = null;

  constructor(private o: AtlasOptions) {
    o.root.innerHTML = ATLAS_HTML;
    o.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.profile = new ProfileMenu(this.el.profileBtn, o.driver, () => {
      this.renderList();
      if (this.board) this.renderBoard();
    });
    this.initMap();
    this.bind();
    this.load();
    if (import.meta.env.DEV) Object.assign(window as any, { __atlas: this, __L: L });
  }

  // ------------------------------------------------------------------ map

  private initMap() {
    this.map = L.map(this.el.map, { zoomControl: false, worldCopyJump: true, attributionControl: false, maxZoom: 19, minZoom: 2 }).setView([25, 30], 2);
    L.control.zoom({ position: 'topright' }).addTo(this.map);
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(this.map);
    this.light = L.layerGroup([
      L.tileLayer(LIGHT, { attribution: 'Esri · OpenStreetMap contributors', maxZoom: 16, className: 'tiles-paper' }),
      L.tileLayer(LIGHT_LABELS, { maxZoom: 16, className: 'tiles-paper' }),
    ]).addTo(this.map);
    this.sat = L.tileLayer(SAT, { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxZoom: 19, maxNativeZoom: 19 });
    this.outlines.addTo(this.map);
    this.map.on('zoomend moveend', () => this.onView());
  }

  private onView() {
    const z = this.map.getZoom();
    const sat = z >= 14;
    if (sat && !this.map.hasLayer(this.sat)) {
      this.map.addLayer(this.sat);
      this.map.removeLayer(this.light);
    } else if (!sat && this.map.hasLayer(this.sat)) {
      this.map.addLayer(this.light);
      this.map.removeLayer(this.sat);
    }
    const c = this.map.getContainer();
    c.classList.toggle('z-far', z < 5);
    c.classList.toggle('z-near', z >= 9);
    c.classList.toggle('z-sat', sat);
    // "Scan this area" appears once you're close enough and haven't scanned this view.
    const b = this.map.getBounds();
    const canScan = z >= 10 && !(this.lastScan && this.lastScan.pad(0.05).contains(b));
    this.el.scan.classList.toggle('show', canScan && !this.scanning && !this.selected);
    this.el.zoomHint.classList.toggle('show', z >= 5 && z < 10 && !this.selected);
    this.drawOutlines();
  }

  private drawOutlines() {
    this.outlines.clearLayers();
    if (this.map.getZoom() < 12 || this.editor) return;
    const view = this.map.getBounds().pad(0.4);
    for (const t of this.tracks.values()) {
      if (!view.contains(t.center)) continue;
      const sel = this.selected?.id === t.id;
      const ll = t.points.map((p) => L.latLng(p[0], p[1]));
      ll.push(ll[0]);
      L.polyline(ll, { color: '#141414', weight: sel ? 10 : 7, opacity: 0.75, interactive: false }).addTo(this.outlines);
      L.polyline(ll, { color: sel ? '#ff4d00' : '#f2eee5', weight: sel ? 5 : 3.5, opacity: 1 })
        .on('click', () => this.open(t.id))
        .addTo(this.outlines);
    }
  }

  private addPin(t: TrackData) {
    if (this.pins.has(t.id)) return;
    const icon = L.divIcon({
      className: 'pin-wrap',
      html: `<div class="pin${t.preset ? ' feat' : ''}"><i></i><span>${escapeHtml(t.name)}</span></div>`,
      iconSize: [0, 0],
    });
    const m = L.marker(t.center, { icon, riseOnHover: true, keyboard: false, zIndexOffset: t.preset ? 500 : 0 }).on('click', () => this.open(t.id));
    m.addTo(this.map);
    this.pins.set(t.id, m);
  }

  private hotPin(id: string | null) {
    for (const [pid, m] of this.pins) m.getElement()?.classList.toggle('hot', pid === id);
  }

  private markSelectedPin() {
    for (const [pid, m] of this.pins) m.getElement()?.classList.toggle('sel', pid === this.selected?.id);
  }

  // ------------------------------------------------------------------ events

  private bind() {
    const search = this.el.search as HTMLInputElement;
    search.addEventListener('input', () => {
      this.query = search.value.trim();
      if (this.selected && this.query) location.hash = '';
      this.renderList();
    });
    (this.el.searchForm as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitSearch();
    });
    addEventListener('keydown', (e) => {
      if (this.o.root.hidden) return;
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        search.focus();
        search.select();
      } else if (e.key === 'Escape') {
        if (typing) (e.target as HTMLInputElement).blur();
        else if (this.selected) location.hash = '';
      }
    });

    this.el.panel.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const card = t.closest<HTMLElement>('[data-track]');
      if (card) return this.open(card.dataset.track!);
      if (t.closest('[data-act=back]')) location.hash = '';
      if (t.closest('[data-act=race]') && this.selected) this.o.onRace(this.selected, this.dir);
      if (t.closest('[data-act=geosearch]')) this.submitSearch(true);
      const act = t.closest<HTMLElement>('[data-act^=edit]')?.dataset.act;
      if (act) this.editAction(act);
      const d = t.closest<HTMLElement>('[data-dir]')?.dataset.dir as Dir | undefined;
      if (d && this.selected && d !== this.dir) location.hash = `#/t/${this.selected.id}/${d}`;
    });
    this.el.panel.addEventListener('mouseover', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-track]');
      this.hotPin(card?.dataset.track ?? null);
    });
    this.el.panel.addEventListener('mouseleave', () => this.hotPin(null));

    this.el.scan.addEventListener('click', () => this.scan());
    this.el.ticker.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-feed]');
      if (row) location.hash = `#/t/${row.dataset.feed}/${row.dataset.dir}`;
      if ((e.target as HTMLElement).closest('[data-act=collapse]')) this.el.ticker.classList.toggle('collapsed');
    });
    this.el.livePill.addEventListener('click', () => this.el.ticker.classList.remove('collapsed'));
    addEventListener('hashchange', () => this.route());
  }

  private async submitSearch(forceGeo = false) {
    const q = (this.el.search as HTMLInputElement).value.trim();
    if (!q) return;
    const local = this.matches(q);
    if (!forceGeo && local.length === 1) return this.open(local[0].id);
    this.toast(`Finding ${q}…`);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const [hit] = await res.json();
      if (!hit) return this.toast(`Couldn't find “${q}”. Try a city name.`, 'warn');
      location.hash = '';
      const bb = hit.boundingbox.map(Number);
      const bounds = L.latLngBounds([bb[0], bb[2]], [bb[1], bb[3]]);
      this.map.flyToBounds(bounds, { maxZoom: 11, duration: 1.4, ...this.mapPadding() });
      // Scan for tracks automatically once the camera lands.
      this.map.once('moveend', () => {
        if (this.map.getZoom() < 10) this.map.setZoom(10, { animate: false });
        this.scan(hit.display_name.split(',')[0]);
      });
    } catch {
      this.toast('Search is unavailable right now', 'warn');
    }
  }

  private matches(q: string) {
    const s = q.toLowerCase();
    return [...this.tracks.values()].filter((t) => `${t.name} ${t.location}`.toLowerCase().includes(s));
  }

  private mapPadding(): { paddingTopLeft: L.PointExpression; paddingBottomRight: L.PointExpression } {
    // The panel overlays the map on small screens; on desktop the map has its own column.
    return innerWidth <= 900
      ? { paddingTopLeft: [24, 24], paddingBottomRight: [24, Math.round(innerHeight * (this.selected ? 0.78 : 0.52))] }
      : { paddingTopLeft: [40, 40], paddingBottomRight: [40, 120] };
  }

  // ------------------------------------------------------------------ data

  private async load() {
    try {
      const presets: TrackData[] = await fetch('/tracks/presets.json').then((r) => r.json());
      presets.forEach((t) => this.addTrack({ ...t, preset: true }));
    } catch {
      /* discovery still works */
    }
    try {
      const saved: TrackData[] = JSON.parse(localStorage.getItem('ak:tracks') || '[]');
      saved.forEach((t) => this.tracks.has(t.id) || this.addTrack(t));
    } catch {
      /* ignore */
    }
    try {
      this.applyLayouts(await api.layouts());
    } catch {
      /* layouts are optional */
    }
    this.renderList();
    this.nameTracks([...this.tracks.values()].filter((t) => !t.preset && !t.location));
    if (!this.route()) this.fitAll(false);
    this.pollFeed();
    this.timers.push(window.setInterval(() => this.pollFeed(), 6000));
    this.timers.push(window.setInterval(() => this.selected && !this.o.root.hidden && this.pollBoard(), 5000));
  }

  private fitAll(animate = true) {
    const all = [...this.tracks.values()];
    if (!all.length) return;
    const b = L.latLngBounds(all.map((t) => t.center)).pad(0.2);
    // Keep pins clear of the live timing card in the bottom-right corner on desktop.
    const pad = innerWidth > 900 ? { paddingTopLeft: [60, 60] as L.PointExpression, paddingBottomRight: [380, 80] as L.PointExpression } : this.mapPadding();
    if (animate) this.map.flyToBounds(b, { maxZoom: 4, duration: 1.2, ...pad });
    else this.map.fitBounds(b, { maxZoom: 4, ...pad });
  }

  private addTrack(t: TrackData) {
    const lay = this.pendingLayouts.get(t.id);
    if (lay) {
      this.pendingLayouts.delete(t.id);
      t = this.withLayout(t, lay);
    }
    this.tracks.set(t.id, t);
    this.addPin(t);
  }

  /** Swap a track's OSM trace for a community-corrected layout (new id, new leaderboard). */
  private withLayout(t: TrackData, lay: CommunityLayout): TrackData {
    const baseId = t.corrected?.baseId ?? t.id;
    const osmPoints = t.corrected?.osmPoints ?? t.points;
    this.aliases.set(baseId, lay.id);
    return { ...t, id: lay.id, points: lay.points, lengthM: lay.lengthM, corrected: { by: lay.by, at: lay.at, baseId, osmPoints } };
  }

  private applyLayouts(all: Record<string, CommunityLayout>) {
    for (const [base, lay] of Object.entries(all)) {
      const current = this.tracks.get(base) ?? [...this.tracks.values()].find((x) => x.corrected?.baseId === base);
      if (!current) {
        this.pendingLayouts.set(base, lay);
        continue;
      }
      if (current.id === lay.id) continue;
      const fixed = this.withLayout(current, lay);
      this.tracks.delete(current.id);
      this.pins.get(current.id)?.remove();
      this.pins.delete(current.id);
      this.tracks.set(fixed.id, fixed);
      this.addPin(fixed);
      if (this.selected?.id === current.id) this.selected = fixed;
    }
  }

  private persist() {
    const list = [...this.tracks.values()].filter((t) => !t.preset).slice(-60);
    try {
      localStorage.setItem('ak:tracks', JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  private async pollFeed() {
    try {
      this.feed = await api.feed();
      this.renderFeed();
      this.renderList(true);
    } catch {
      this.el.tickerBody.innerHTML = '<p class="tk-empty">Live timing is offline.</p>';
    }
  }

  private async pollBoard() {
    const t = this.selected;
    if (!t) return;
    try {
      const b = await api.board(t.id, this.dir);
      if (this.selected !== t) return;
      this.board = b;
      this.renderBoard();
    } catch {
      this.el.dBoard.innerHTML = '<p class="empty">Leaderboard is offline. You can still race; laps are saved on this device.</p>';
    }
  }

  private async scan(placeName?: string) {
    const b = this.map.getBounds();
    this.scanning?.abort();
    this.scanning = new AbortController();
    this.el.scan.classList.remove('show');
    this.toast(placeName ? `Scanning ${placeName} for kart tracks…` : 'Scanning this area for kart tracks…', 'busy');
    try {
      const found = await discoverTracks([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], this.scanning.signal);
      this.lastScan = b;
      const fresh = found.filter((t) => !this.tracks.has(t.id));
      fresh.forEach((t) => this.addTrack(t));
      this.persist();
      this.nameTracks(fresh);
      this.renderList();
      this.drawOutlines();
      if (!found.length) this.toast('No kart tracks mapped here yet. Try another area.', 'warn');
      else {
        this.toast(`Found ${found.length} track${found.length > 1 ? 's' : ''}${fresh.length && fresh.length < found.length ? `, ${fresh.length} new` : ''}`);
        if (found.length === 1) this.open(found[0].id);
        else this.map.flyToBounds(L.latLngBounds(found.map((t) => t.center)).pad(0.3), { maxZoom: 13, ...this.mapPadding() });
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.toast('OpenStreetMap is busy. Try again in a few seconds.', 'warn');
    } finally {
      this.scanning = null;
      this.onView();
    }
  }

  /** Give discovered tracks a place name ("Jurong West kart track") via reverse geocoding. */
  private async nameTracks(list: TrackData[]) {
    for (const t of list.slice(0, 6)) {
      if (t.location) continue;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&lat=${t.center[0]}&lon=${t.center[1]}`);
        const a = (await r.json()).address ?? {};
        const place = a.suburb || a.neighbourhood || a.town || a.city_district || a.village || a.city || a.county;
        const region = a.city || a.state || a.country;
        if (place) {
          t.location = [place, region !== place ? region : '', a.country].filter(Boolean).join(', ');
          if (/^Unnamed/i.test(t.name)) t.name = `${place} kart track`;
          this.pins.get(t.id)?.remove();
          this.pins.delete(t.id);
          this.addPin(t);
          this.persist();
          this.renderList();
        }
      } catch {
        /* keep the coordinates */
      }
      await new Promise((res) => setTimeout(res, 1100)); // Nominatim allows ~1 request/second
    }
  }

  // ------------------------------------------------------------------ routing

  private route(): boolean {
    const m = /^#\/t\/([^/]+)\/?(fwd|rev)?/.exec(location.hash);
    if (!m) {
      if (this.selected) this.closeDetail();
      return false;
    }
    this.dir = (m[2] as Dir) || 'fwd';
    const id = decodeURIComponent(m[1]);
    const alias = this.aliases.get(id);
    if (alias) {
      history.replaceState(null, '', `#/t/${alias}/${this.dir}`);
      this.select(alias);
    } else this.select(id);
    return true;
  }

  private open(id: string) {
    const hash = `#/t/${id}/${this.selected?.id === id ? this.dir : 'fwd'}`;
    if (location.hash === hash) this.select(id);
    else location.hash = hash;
  }

  private async select(id: string) {
    let t = this.tracks.get(id);
    if (!t) {
      this.toast('Loading track…', 'busy');
      try {
        const fetched = (await api.track(id).catch(() => null)) ?? (await trackFromId(id));
        if (!fetched) throw new Error('not found');
        const fromFeed = this.feed?.laps.find((l) => l.track === id);
        if (fromFeed) fetched.name = fromFeed.trackName;
        this.addTrack(fetched);
        this.persist();
        t = fetched;
        this.toast('');
      } catch {
        this.toast("Couldn't load that track. OpenStreetMap may be busy.", 'warn');
        return;
      }
    }
    const changed = this.selected?.id !== t.id;
    this.selected = t;
    this.o.root.classList.add('detail-open');
    this.renderDetail();
    this.markSelectedPin();
    if (changed) {
      const bounds = L.latLngBounds(t.points.map((p) => L.latLng(p[0], p[1])));
      this.map.flyToBounds(bounds, { maxZoom: 18, duration: 1.5, ...this.mapPadding() });
      this.board = null;
      this.el.dBoard.innerHTML = '<p class="empty">Loading leaderboard…</p>';
      this.el.panelScroll.scrollTop = 0;
    }
    this.placeStartMarker();
    this.drawOutlines();
    this.pollBoard();
  }

  private closeDetail() {
    this.stopEditing();
    this.selected = null;
    this.board = null;
    this.o.root.classList.remove('detail-open');
    this.sfMarker?.remove();
    this.sfMarker = null;
    this.markSelectedPin();
    this.drawOutlines();
    this.renderList();
    if (this.map.getZoom() > 12) this.map.flyTo(this.map.getCenter(), 10, { duration: 1 });
  }

  private placeStartMarker() {
    this.sfMarker?.remove();
    const t = this.selected;
    if (!t) return;
    const at = pointAtFrac(t.points, shapeOf(t).startFrac);
    this.sfMarker = L.marker(at, {
      icon: L.divIcon({ className: 'sf-wrap', html: '<div class="sf-flag"><i></i><span>Start / finish</span></div>', iconSize: [0, 0] }),
      interactive: false,
    }).addTo(this.map);
  }

  // ------------------------------------------------------------------ layout editor

  private editAction(act: string) {
    if (act === 'edit-start') return this.startEditing();
    if (!this.editor || !this.selected) return;
    if (act === 'edit-cancel') this.stopEditing(true);
    if (act === 'edit-restart') this.editor.startOver();
    if (act === 'edit-reverse') this.editor.reverse();
    if (act === 'edit-reset') this.editor.reset(this.selected.corrected?.osmPoints ?? this.selected.points);
    if (act === 'edit-save') this.saveLayout();
  }

  private startEditing() {
    const t = this.selected;
    if (!t || this.editor) return;
    this.sfMarker?.remove();
    this.o.root.classList.add('editing');
    const original = t.corrected?.osmPoints ?? t.points;
    this.el.detail.innerHTML = `
      <div class="d-top"><button class="back" data-act="edit-cancel"><span class="mono">←</span> Cancel</button><span class="label">Layout editor</span></div>
      <h1 class="display d-name">Fix the layout</h1>
      <p class="ed-lede">Line the orange route up with the <b>middle of the asphalt</b>, in race direction. Your version replaces the OpenStreetMap trace for everyone and starts a fresh leaderboard.</p>
      <ol class="ed-steps">
        <li><b class="mono">01</b><span>Drag the white points onto the centre of the track.</span></li>
        <li><b class="mono">02</b><span>Click a small dot on the line to add a point. Right-click (or long-press) a point to remove it.</span></li>
        <li><b class="mono">03</b><span>Way off? <b>Start over</b> and click your way round, then click the first point to close the loop.</span></li>
      </ol>
      <dl class="d-stats ed-stats">
        <div><dt class="label">Length</dt><dd class="mono" data-el="edLen">–</dd></div>
        <div><dt class="label">Points</dt><dd class="mono" data-el="edPts">–</dd></div>
        <div><dt class="label">OSM trace</dt><dd class="mono">${(loopLengthKm(original)).toFixed(2)}<small>km</small></dd></div>
      </dl>
      <div class="ed-tools">
        <button class="btn" data-act="edit-restart">Start over</button>
        <button class="btn" data-act="edit-reverse">Reverse</button>
        <button class="btn" data-act="edit-reset">Reset to OSM</button>
      </div>
      <p class="ed-status" data-el="edStatus"></p>
      <button class="btn primary lg block" data-act="edit-save">Save layout <span class="arrow">→</span></button>`;
    this.el.detail.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.drawOutlines();
    this.map.flyToBounds(L.latLngBounds(t.points.map((p) => L.latLng(p[0], p[1]))), { maxZoom: 19, duration: 0.8, ...this.mapPadding() });
    this.editor = new LayoutEditor(this.map, t.points, {
      onChange: (i) => {
        this.el.edLen.innerHTML = `${(i.lengthM / 1000).toFixed(2)}<small>km</small>`;
        this.el.edPts.textContent = String(i.points);
        this.el.edStatus.textContent = i.drawing ? (i.points < 4 ? 'Click along the track in race direction…' : 'Click the first point to close the loop.') : '';
      },
    });
    this.el.edPts.textContent = String(this.editor.points.length);
    this.el.edLen.innerHTML = `${(loopLengthKm(this.editor.points)).toFixed(2)}<small>km</small>`;
  }

  private stopEditing(rerender = false) {
    if (!this.editor) return;
    this.editor.destroy();
    this.editor = null;
    this.o.root.classList.remove('editing');
    if (rerender && this.selected) {
      this.renderDetail();
      this.placeStartMarker();
      this.drawOutlines();
      this.pollBoard();
    }
  }

  private async saveLayout() {
    const t = this.selected;
    const ed = this.editor;
    if (!t || !ed) return;
    if (!ed.valid) {
      this.el.edStatus.textContent = 'Close the loop first: click the first point.';
      return;
    }
    this.el.edStatus.textContent = 'Saving…';
    try {
      const base = t.corrected?.baseId ?? t.id;
      const res = await api.saveLayout({ base, points: ed.points, center: t.center, trackName: t.name, width: t.width, name: this.o.driver.name, driverId: this.o.driver.id });
      const lay: CommunityLayout = { id: res.id, points: ed.points, lengthM: res.lengthM, by: this.o.driver.name, pid: this.o.driver.pid, at: Date.now() };
      this.stopEditing();
      this.applyLayouts({ [base]: lay });
      this.persist();
      this.toast('Layout saved. It now has its own leaderboard.');
      location.hash = `#/t/${res.id}/fwd`;
      this.renderList();
    } catch (e) {
      this.el.edStatus.textContent = `Couldn't save: ${(e as Error).message}`;
    }
  }

  // ------------------------------------------------------------------ rendering

  private card(t: TrackData, idx: number) {
    const shape = shapeOf(t);
    const rec = this.feed?.records[`${t.id}|fwd`] as { ms: number; name: string } | undefined;
    const live = (this.feed?.live[`${t.id}|fwd`] ?? 0) + (this.feed?.live[`${t.id}|rev`] ?? 0);
    const pb = localPB(t.id, 'fwd');
    const where = t.location ? t.location.split(',')[0] : coords(t.center);
    return `<button class="card" data-track="${escapeHtml(t.id)}">
      <div class="card-top"><span class="label">${t.preset ? String(idx + 1).padStart(2, '0') : 'OSM'}${t.country ? ` · ${t.country}` : ''}</span>${t.needsFix && !t.corrected ? '<span class="card-warn">Trace off</span>' : live ? `<span class="card-live"><i class="live-dot"></i>${live} live</span>` : ''}</div>
      <div class="card-art graph-paper">${trackArt(shape, { w: 240, h: 130, pad: 14, arrows: false })}</div>
      <h3 class="display">${escapeHtml(t.name)}</h3>
      <p class="card-sub">${escapeHtml(where)} · ${(t.lengthM / 1000).toFixed(2)} km · ${shape.corners.length} turns</p>
      <div class="card-foot">
        ${rec ? `<span class="label">Record</span><span class="mono strong">${formatMs(rec.ms)}</span>` : `<span class="label">Record</span><span class="muted">Open</span>`}
        ${pb ? `<span class="card-pb mono">You ${formatMs(pb)}</span>` : ''}
      </div>
    </button>`;
  }

  private renderList(soft = false) {
    if (soft && (this.selected || this.query)) return; // don't fight the user while they type or browse a track
    const all = [...this.tracks.values()];
    const q = this.query.toLowerCase();
    const filt = (t: TrackData) => !q || `${t.name} ${t.location}`.toLowerCase().includes(q);
    const presets = all.filter((t) => t.preset);
    const found = all.filter((t) => !t.preset).reverse();
    const fp = presets.filter(filt);
    const ff = found.filter(filt);
    const scrollTop = this.el.panelScroll.scrollTop;

    let html = '';
    if (!q) {
      html += `<section class="intro">
        <p class="label">Real circuits · Satellite worlds · Live timing</p>
        <h1 class="display">Race the world's real kart tracks</h1>
        <p class="lede">Every layout is traced from OpenStreetMap and dropped onto satellite imagery of the real place. Pick a circuit, or search any city to scan it for tracks.</p>
        <ol class="steps"><li><b class="mono">01</b>Pick a circuit</li><li><b class="mono">02</b>Set flying laps</li><li><b class="mono">03</b>Climb the live board</li></ol>
      </section>`;
    } else {
      html += `<div class="search-head"><p class="label">${fp.length + ff.length} match${fp.length + ff.length === 1 ? '' : 'es'} for “${escapeHtml(this.query)}”</p>
        <button class="btn block" data-act="geosearch">Scan “${escapeHtml(this.query)}” on the map <span class="arrow">↵</span></button></div>`;
    }
    if (fp.length) {
      html += `<div class="sec-head"><h2 class="label">Featured circuits</h2><span class="label">${String(fp.length).padStart(2, '0')}</span></div>
        <div class="grid">${fp.map((t) => this.card(t, presets.indexOf(t))).join('')}</div>`;
    }
    if (ff.length) {
      html += `<div class="sec-head"><h2 class="label">Discovered on the map</h2><span class="label">${String(ff.length).padStart(2, '0')}</span></div>
        <div class="grid">${ff.map((t, i) => this.card(t, i)).join('')}</div>`;
    } else if (!q) {
      html += `<div class="tip graph-paper"><p class="label">Find more tracks</p><p>Search a city above, or zoom into the map and press <b>Scan this area</b>. Any kart track mapped on OpenStreetMap becomes raceable.</p></div>`;
    }
    this.el.list.innerHTML = html;
    this.el.panelScroll.scrollTop = scrollTop;
  }

  private renderDetail() {
    const t = this.selected!;
    const shape = shapeOf(t);
    const rev = this.dir === 'rev';
    const rot = rotationLabel(shape, rev);
    const other = rotationLabel(shape, !rev);
    const presets = [...this.tracks.values()].filter((x) => x.preset);
    const idx = presets.indexOf(t);
    const pb = localPB(t.id, this.dir);
    this.el.detail.innerHTML = `
      <div class="d-top">
        <button class="back" data-act="back"><span class="mono">←</span> All circuits</button>
        <span class="label">${idx >= 0 ? `${String(idx + 1).padStart(2, '0')} / ${String(presets.length).padStart(2, '0')}` : 'Discovered'}</span>
      </div>
      <h1 class="display d-name">${escapeHtml(t.name)}</h1>
      <p class="d-loc">${t.country ? `<span class="cc mono">${t.country}</span>` : ''}${escapeHtml(t.location || 'Mapped on OpenStreetMap')}<span class="label">${coords(t.center)}</span></p>
      <div class="d-art graph-paper">${trackArt(shape, { w: 440, h: 300, pad: 30, reverse: rev, turns: true, arrows: true, road: true })}
        <span class="d-art-tag label">${rot.icon} ${rot.label}</span></div>
      <dl class="d-stats">
        <div><dt class="label">Length</dt><dd class="mono">${(t.lengthM / 1000).toFixed(2)}<small>km</small></dd></div>
        <div><dt class="label">Turns</dt><dd class="mono">${shape.corners.length}</dd></div>
        <div><dt class="label">Width</dt><dd class="mono">${Math.max(t.width, 8.5).toFixed(1)}<small>m</small></dd></div>
      </dl>
      <div class="seg" role="radiogroup" aria-label="Direction">
        <button data-dir="${this.dir}" class="on" role="radio" aria-checked="true"><span>${rot.icon}</span>${rot.label}</button>
        <button data-dir="${rev ? 'fwd' : 'rev'}" role="radio" aria-checked="false"><span>${other.icon}</span>${other.label}</button>
      </div>
      ${t.needsFix && !t.corrected ? '<button class="d-warn-top" data-act="edit-start"><b>Trace doesn’t match the asphalt.</b> Fix the layout →</button>' : ''}
      <button class="btn primary lg block" data-act="race">Start engine <span class="arrow">→</span></button>
      <p class="d-pb">${pb ? `Your best here <b class="mono">${formatMs(pb)}</b>` : 'No lap yet. Your first clean lap goes straight onto the board.'}</p>
      <div class="sec-head"><h2 class="label">Live leaderboard · ${rot.label.toLowerCase()}</h2><span class="label" data-el="dCount"></span></div>
      <div class="d-live" data-el="dLive"></div>
      <div data-el="dBoard"><p class="empty">Loading leaderboard…</p></div>
      <div class="d-layout">
        ${
          t.needsFix && !t.corrected
            ? `<p class="d-warn"><b>This layout is off.</b> The OpenStreetMap trace for this circuit doesn't follow the real asphalt, so the lap you drive won't match the satellite view. If you know the track, fix it below for everyone.</p>`
            : ''
        }
        ${
          t.corrected
            ? `<p><span class="cc mono">FIXED</span> Layout corrected by <b>${escapeHtml(t.corrected.by)}</b> ${timeAgo(t.corrected.at)}. Times on the old OSM trace are on a separate board.</p>`
            : `<p>Traced from OpenStreetMap${t.osmWays.length ? ` (<a target="_blank" rel="noopener" href="https://www.openstreetmap.org/way/${t.osmWays[0]}">way ${t.osmWays[0]}${t.osmWays.length > 1 ? ` +${t.osmWays.length - 1}` : ''}</a>)` : ''}. If the line doesn't sit on the asphalt, you can fix it.</p>`
        }
        <button class="btn block" data-act="edit-start">Fix the layout <span class="arrow">→</span></button>
      </div>`;
    this.el.detail.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    if (this.board) this.renderBoard();
  }

  private renderBoard() {
    const b = this.board!;
    const me = this.o.driver.pid;
    const lead = b.entries[0]?.ms;
    this.el.dCount.textContent = b.total ? `${b.total} driver${b.total > 1 ? 's' : ''}` : '';
    this.el.dLive.innerHTML = b.onTrack.length
      ? `<i class="live-dot"></i>On track now: ${b.onTrack.map((o) => `<span class="chip"><i style="background:${escapeHtml(o.color)}"></i>${escapeHtml(o.name)}</span>`).join('')}`
      : '';
    this.el.dBoard.innerHTML = b.entries.length
      ? `<ol class="board">${b.entries
          .map(
            (e) => `<li class="${e.pid === me ? 'me' : ''}">
              <span class="pos mono">${String(e.rank).padStart(2, '0')}</span>
              <span class="bar" style="background:${escapeHtml(e.color)}"></span>
              <span class="nm">${escapeHtml(e.name)}${e.pid === me ? ' <em>you</em>' : ''}</span>
              <span class="tm mono">${e.rank === 1 ? formatMs(e.ms) : `+${((e.ms - lead) / 1000).toFixed(3)}`}</span>
            </li>`,
          )
          .join('')}</ol>`
      : '<p class="empty">No times yet. Set the benchmark.</p>';
  }

  private renderFeed() {
    const f = this.feed!;
    const live = Object.values(f.live).reduce((a, n) => a + n, 0);
    this.el.liveCount.textContent = String(live);
    this.el.livePill.classList.toggle('idle', !live);
    this.el.tickerBody.innerHTML = f.laps.length
      ? f.laps
          .slice(0, 4)
          .map(
            (l) => `<button class="tk-row" data-feed="${escapeHtml(l.track)}" data-dir="${l.dir}">
              <span class="bar" style="background:${escapeHtml(l.color)}"></span>
              <span class="tk-main"><b>${escapeHtml(l.name)}</b><small>${escapeHtml(l.trackName)}${l.dir === 'rev' ? ' · rev' : ''}</small></span>
              <span class="tk-time"><span class="mono">${formatMs(l.ms)}</span><small class="${l.rank === 1 ? 'p1' : ''}">P${l.rank} · ${timeAgo(l.at)}</small></span>
            </button>`,
          )
          .join('')
      : '<p class="tk-empty">No laps yet. Times appear here the moment anyone finishes a lap.</p>';
    for (const l of f.laps) {
      if (this.tracks.has(l.track) || this.pins.has(l.track) || !l.center) continue;
      const icon = L.divIcon({ className: 'pin-wrap', html: `<div class="pin remote"><i></i><span>${escapeHtml(l.trackName)}</span></div>`, iconSize: [0, 0] });
      const m = L.marker(l.center, { icon }).on('click', () => (location.hash = `#/t/${l.track}/${l.dir}`));
      m.addTo(this.map);
      this.pins.set(l.track, m);
    }
  }

  private toast(msg: string, kind: '' | 'warn' | 'busy' = '') {
    clearTimeout(this.toastTimer);
    this.el.toast.textContent = msg;
    this.el.toast.className = `map-toast ${kind}${msg ? ' show' : ''}`;
    if (msg && kind !== 'busy') this.toastTimer = window.setTimeout(() => this.el.toast.classList.remove('show'), 4200);
  }

  show() {
    this.o.root.hidden = false;
    setTimeout(() => this.map.invalidateSize(), 0);
    if (this.selected) {
      this.renderDetail();
      this.pollBoard();
    }
    this.renderList();
  }

  hide() {
    this.o.root.hidden = true;
    this.profile.close();
  }
}

const SEARCH_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`;

const ATLAS_HTML = /* html */ `
<header class="topbar">
  <a class="wordmark" href="#" aria-label="ApexKart home"><span class="wm-chk"></span><span class="display">Apex<b>Kart</b></span></a>
  <form class="search" data-el="searchForm" role="search">
    ${SEARCH_ICON}
    <input data-el="search" type="search" placeholder="Search circuits or any city" autocomplete="off" spellcheck="false" aria-label="Search circuits or any city" />
    <kbd>/</kbd>
  </form>
  <div class="top-right">
    <button class="live-pill idle" data-el="livePill" title="Drivers on track right now"><i class="live-dot"></i><b class="mono" data-el="liveCount">0</b><span>on track</span></button>
    <button class="profile-btn" data-el="profileBtn" aria-haspopup="dialog"></button>
  </div>
</header>
<main class="atlas">
  <section class="panel" data-el="panel">
    <div class="panel-scroll" data-el="panelScroll">
      <div class="view-list" data-el="list"></div>
      <div class="view-detail" data-el="detail"></div>
    </div>
  </section>
  <section class="mapwrap">
    <div class="map" data-el="map"></div>
    <button class="scan-btn" data-el="scan">${SEARCH_ICON}<span>Scan this area for kart tracks</span></button>
    <div class="zoom-hint label" data-el="zoomHint">Zoom in to scan for kart tracks</div>
    <div class="map-toast" data-el="toast"></div>
    <aside class="ticker" data-el="ticker">
      <header><span><i class="live-dot"></i>Live timing</span><button data-act="collapse" aria-label="Collapse live timing">–</button></header>
      <div data-el="tickerBody"><p class="tk-empty">Connecting…</p></div>
    </aside>
  </section>
</main>`;
