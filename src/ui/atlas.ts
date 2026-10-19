// The home screen: a dark world map with every kart venue on OpenStreetMap, a dock with
// "Race now", country filters and a rail of circuits, and a sheet for the selected track.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { discoverTracks, layoutsNear, loopToTrack, trackFromId, type LatLon, type TrackData } from '../track/osm';
import { analyzeShape, type TrackShape } from '../track/shape';
import { ProfileMenu } from './profile';
import { LayoutEditor } from './layoutEditor';
import { api, type BoardResponse, type CommunityLayout, type Dir, type Driver, type FeedResponse } from '../net/api';
import { localPB } from '../game/race';
import { isNightAt } from '../game/sun';
import { timePref } from '../game/atmosphere';
import { coreBounds, distM, loadWorld, localeCountry, type Venue, type WorldIndex } from './world';
import * as V from './atlasViews';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const DARK = `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const DARK_LABELS = `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
const SAT = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`;
const LAST_KEY = 'ak:last'; // {id, dir} of the last circuit raced: what "Race now" offers
const SAME_VENUE_M = 700; // a venue dot this close to a known track is that track
const RAIL_BATCH = 36;
const TOP_COUNTRIES = 14;
const SAT_ZOOM = 14;

export interface AtlasOptions {
  root: HTMLElement;
  driver: Driver;
  onRace: (track: TrackData, dir: Dir) => void;
}

type Filter = { kind: 'featured' } | { kind: 'country'; cc: string } | { kind: 'near'; at: LatLon } | { kind: 'view'; bounds: L.LatLngBounds };
type RailItem = { kind: 'track'; t: TrackData } | { kind: 'venue'; v: Venue };

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

const isTyping = (e: Event) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
const small = () => innerWidth <= 760;

export class Atlas {
  private map!: L.Map;
  private base!: L.Layer;
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
  private profile: ProfileMenu;
  private toastTimer = 0;
  private aliases = new Map<string, string>(); // OSM id -> community layout id
  private pendingLayouts = new Map<string, CommunityLayout>();
  private editor: LayoutEditor | null = null;

  private world: WorldIndex | null = null;
  private dots: L.CircleMarker[] = [];
  private dotRenderer = L.canvas({ padding: 0.4 });
  private venueTip = L.tooltip({ direction: 'top', offset: [0, -6], className: 'venue-tip', opacity: 1 });
  private focusRing: L.CircleMarker | null = null;
  private hiddenVenues = new Set<number>(); // a known track already covers them
  private emptyVenues = new Set<number>(); // loaded, but OSM has no racing line there
  private loadingVenue: number | null = null;
  private dotBucket = -1;
  private localCC: string | null = null;
  private filter: Filter = { kind: 'featured' };
  private rail: RailItem[] = [];
  private railShown = 0;
  private railTotal = 0;
  private hits: V.SearchHit[] = [];
  private hitSel = 0;

  constructor(private o: AtlasOptions) {
    o.root.innerHTML = ATLAS_HTML;
    o.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.profile = new ProfileMenu(this.el.profileBtn, o.driver, () => {
      this.renderRail(true);
      if (this.board) this.renderBoard();
    });
    this.initMap();
    this.bind();
    this.fitPlaceholder();
    this.renderNow();
    this.load();
    if (import.meta.env.DEV) Object.assign(window as any, { __atlas: this, __L: L });
  }

  // ------------------------------------------------------------------ map

  private initMap() {
    this.map = L.map(this.el.map, { zoomControl: false, worldCopyJump: true, attributionControl: false, maxZoom: 19, minZoom: 2, zoomSnap: 0.25 }).setView(
      [30, 12],
      small() ? 1.5 : 2.5,
    );
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(this.map);
    this.base = L.layerGroup([
      L.tileLayer(DARK, { attribution: 'Esri · OpenStreetMap contributors', maxZoom: 16, className: 'tiles-dark' }),
      L.tileLayer(DARK_LABELS, { maxZoom: 16, className: 'tiles-dark' }),
    ]).addTo(this.map);
    this.sat = L.tileLayer(SAT, { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxZoom: 19, maxNativeZoom: 19 });
    this.outlines.addTo(this.map);
    this.map.on('zoomend moveend', () => this.onView());
    this.map.on('zoomend', () => this.sizeDots());
  }

  private onView() {
    const z = this.map.getZoom();
    const sat = z >= SAT_ZOOM;
    if (sat && !this.map.hasLayer(this.sat)) {
      this.map.addLayer(this.sat);
      this.map.removeLayer(this.base);
    } else if (!sat && this.map.hasLayer(this.sat)) {
      this.map.addLayer(this.base);
      this.map.removeLayer(this.sat);
    }
    const c = this.map.getContainer();
    c.classList.toggle('z-far', z < 4);
    c.classList.toggle('z-mid', z >= 4.5);
    c.classList.toggle('z-near', z >= 9);
    c.classList.toggle('z-sat', sat);
    this.updateHere();
    this.drawOutlines();
  }

  /** "List tracks here" once you've zoomed into a region; "Scan" where the index has nothing. */
  private updateHere() {
    const z = this.map.getZoom();
    const btn = this.el.here;
    if (z < 6 || this.selected || this.editor || this.loadingVenue !== null) return btn.classList.remove('show');
    const b = this.map.getBounds();
    const n = this.inBounds(b).length;
    const viewing = this.filter.kind === 'view' && this.filter.bounds.pad(0.05).contains(b);
    btn.dataset.mode = n ? 'list' : 'scan';
    btn.querySelector('span')!.textContent = n ? `List ${n} track${n > 1 ? 's' : ''} here` : 'Scan this area for tracks';
    btn.classList.toggle('show', (n > 0 && !viewing) || (!n && z >= 11 && !this.scanning));
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
      html: `<div class="pin${t.preset ? ' feat' : ''}"><i></i><span>${V.esc(t.name)}</span><b class="pin-live mono"></b></div>`,
      iconSize: [0, 0],
    });
    const m = L.marker(t.center, { icon, riseOnHover: true, keyboard: false, zIndexOffset: t.preset ? 500 : 100 }).on('click', () => this.open(t.id));
    m.addTo(this.map);
    this.pins.set(t.id, m);
    this.markLive(t.id);
  }

  private markLive(id: string) {
    const el = this.pins.get(id)?.getElement()?.querySelector<HTMLElement>('.pin');
    if (!el) return;
    const n = (this.feed?.live[`${id}|fwd`] ?? 0) + (this.feed?.live[`${id}|rev`] ?? 0);
    el.classList.toggle('is-live', n > 0);
    el.querySelector('.pin-live')!.textContent = n ? String(n) : '';
  }

  private hotPin(id: string | null) {
    for (const [pid, m] of this.pins) m.getElement()?.classList.toggle('hot', pid === id);
  }

  private markSelectedPin() {
    for (const [pid, m] of this.pins) m.getElement()?.classList.toggle('sel', pid === this.selected?.id);
  }

  // ------------------------------------------------------------------ world venues

  private drawDots() {
    const w = this.world!;
    this.dots = w.venues.map((v) => {
      const m = L.circleMarker(v.at, { renderer: this.dotRenderer, radius: 3, stroke: true, weight: 1, color: '#0b0b0a', fillColor: '#ff4d00', fillOpacity: 0.9, bubblingMouseEvents: false });
      m.on('click', () => this.openVenue(v));
      m.on('mouseover', () => {
        this.venueTip.setLatLng(v.at).setContent(`<b>${V.esc(v.name || 'Unnamed kart track')}</b>${v.cc ? `<span>${V.esc(w.countries.get(v.cc)?.name ?? v.cc)}</span>` : ''}`);
        this.venueTip.addTo(this.map);
      });
      m.on('mouseout', () => this.venueTip.remove());
      return m;
    });
    this.refreshVenues();
    this.sizeDots();
  }

  /** Hide dots that a known track already covers; dim the ones outside the country filter. */
  private refreshVenues() {
    if (!this.world) return;
    const known = [...this.tracks.values()];
    this.hiddenVenues.clear();
    for (const v of this.world.venues) if (known.some((t) => Math.abs(t.center[0] - v.at[0]) < 0.02 && distM(t.center, v.at) < SAME_VENUE_M)) this.hiddenVenues.add(v.i);
    const cc = this.filter.kind === 'country' ? this.filter.cc : null;
    for (const v of this.world.venues) {
      const m = this.dots[v.i];
      if (this.hiddenVenues.has(v.i)) {
        m.remove();
        continue;
      }
      const dim = cc !== null && v.cc !== cc;
      const empty = this.emptyVenues.has(v.i);
      m.setStyle({ fillColor: empty ? '#75716a' : '#ff4d00', fillOpacity: dim ? 0.16 : empty ? 0.6 : 0.9, opacity: dim ? 0.2 : 1 });
      if (!this.map.hasLayer(m)) m.addTo(this.map);
    }
    // Known tracks pick up their country from the venue they replaced.
    for (const t of known) if (!t.country) t.country = this.nearestVenue(t.center, 3000)?.cc || undefined;
  }

  private sizeDots() {
    const z = this.map.getZoom();
    const bucket = z < 3.5 ? 0 : z < 5.5 ? 1 : z < 8 ? 2 : 3;
    if (bucket === this.dotBucket) return;
    this.dotBucket = bucket;
    const r = [2.4, 3.2, 4.5, 6.5][bucket];
    for (const m of this.dots) m.setRadius(r);
  }

  private nearestVenue(at: LatLon, maxM: number): Venue | null {
    let best: Venue | null = null;
    let bestD = maxM;
    for (const v of this.world?.venues ?? []) {
      if (Math.abs(v.at[0] - at[0]) > 0.05) continue;
      const d = distM(v.at, at);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  private trackNear(at: LatLon, maxM: number): TrackData | null {
    let best: TrackData | null = null;
    let bestD = maxM;
    for (const t of this.tracks.values()) {
      const d = distM(t.center, at);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  private focusVenue(v: Venue | null) {
    if (!v) {
      this.focusRing?.remove();
      return;
    }
    this.focusRing ??= L.circleMarker(v.at, { radius: 11, color: '#f2eee5', weight: 2, fill: false, interactive: false, className: 'focus-ring' });
    this.focusRing.setLatLng(v.at).addTo(this.map);
  }

  /** A venue dot becomes a track: fetch its raceways, stitch the layouts, open the longest. */
  private async openVenue(v: Venue) {
    const known = this.trackNear(v.at, SAME_VENUE_M);
    if (known) return this.open(known.id);
    if (this.loadingVenue === v.i) return;
    this.loadingVenue = v.i;
    this.focusVenue(v);
    this.map.flyTo(v.at, 16, { duration: 1.1 });
    this.toast(`Loading ${v.name || 'this track'} from OpenStreetMap…`, 'busy');
    try {
      const { loops, elements } = await layoutsNear(v.at, 500);
      if (this.loadingVenue !== v.i) return;
      const found = loops.map((l) => ({ ...loopToTrack(l, elements, v.name || 'Unnamed kart track'), country: v.cc || undefined }));
      if (!found.length) {
        this.emptyVenues.add(v.i);
        this.refreshVenues();
        this.renderRail(true);
        this.toast('No racing line is mapped at this venue yet. Try another dot.', 'warn');
        return;
      }
      const fresh = found.filter((t) => !this.tracks.has(t.id));
      fresh.forEach((t) => this.addTrack(t));
      this.persist();
      this.refreshVenues();
      this.nameTracks(fresh);
      this.toast(found.length > 1 ? `${found.length} layouts at this venue` : '');
      this.open(found.sort((a, b) => b.lengthM - a.lengthM)[0].id);
    } catch {
      this.toast('OpenStreetMap is busy. Try again in a few seconds.', 'warn');
    } finally {
      if (this.loadingVenue === v.i) this.loadingVenue = null;
      this.focusVenue(null);
    }
  }

  // ------------------------------------------------------------------ filters and the rail

  private countryCounts(): Map<string, number> {
    const n = new Map<string, number>();
    for (const v of this.world?.venues ?? []) if (v.cc && !this.hiddenVenues.has(v.i)) n.set(v.cc, (n.get(v.cc) ?? 0) + 1);
    for (const t of this.tracks.values()) if (t.country) n.set(t.country, (n.get(t.country) ?? 0) + 1);
    return n;
  }

  private renderChips() {
    const counts = this.countryCounts();
    const f = this.filter;
    const activeCC = f.kind === 'country' ? f.cc : null;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cc]) => cc);
    const order = [...new Set([this.localCC, activeCC, ...top.slice(0, TOP_COUNTRIES)].filter((c): c is string => !!c && counts.has(c)))];
    const featured = [...this.tracks.values()].filter((t) => t.preset).length;
    const list: V.FilterChip[] = [
      { key: 'featured', label: 'Featured', n: featured, on: f.kind === 'featured' },
      { key: 'near', label: 'Near me', on: f.kind === 'near' },
      ...(f.kind === 'view' ? [{ key: 'view', label: 'This area', n: this.railTotal, on: true }] : []),
      ...order.map((cc) => ({ key: `cc:${cc}`, label: this.countryName(cc), cc, n: counts.get(cc), on: cc === activeCC })),
    ];
    this.el.chips.innerHTML = V.chips(list);
    this.el.allBtn.querySelector('b')!.textContent = String(counts.size);
    this.el.chips.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private countryName(cc: string) {
    return this.world?.countries.get(cc)?.name ?? cc;
  }

  /** What the rail lists for a filter. */
  private railFor(f: Filter): RailItem[] {
    const tracks = [...this.tracks.values()];
    const venues = (this.world?.venues ?? []).filter((v) => !this.hiddenVenues.has(v.i));
    const byName = (a: Venue, b: Venue) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.name.localeCompare(b.name);
    const T = (t: TrackData): RailItem => ({ kind: 'track', t });
    const Vn = (v: Venue): RailItem => ({ kind: 'venue', v });
    if (f.kind === 'featured') {
      const found = tracks.filter((t) => !t.preset).reverse();
      return [...tracks.filter((t) => t.preset), ...found].map(T);
    }
    if (f.kind === 'country') {
      const ts = tracks.filter((t) => t.country === f.cc).sort((a, b) => Number(!!b.preset) - Number(!!a.preset));
      return [...ts.map(T), ...venues.filter((v) => v.cc === f.cc).sort(byName).map(Vn)];
    }
    const at: LatLon = f.kind === 'near' ? f.at : [f.bounds.getCenter().lat, f.bounds.getCenter().lng];
    const inside = (p: LatLon) => (f.kind === 'near' ? distM(at, p) < 400_000 : f.bounds.contains(p));
    const items: [number, RailItem][] = [
      ...tracks.filter((t) => inside(t.center)).map((t) => [distM(at, t.center), T(t)] as [number, RailItem]),
      ...venues.filter((v) => inside(v.at)).map((v) => [distM(at, v.at), Vn(v)] as [number, RailItem]),
    ];
    return items.sort((a, b) => a[0] - b[0]).map(([, it]) => it);
  }

  private inBounds(b: L.LatLngBounds) {
    return this.railFor({ kind: 'view', bounds: b });
  }

  private applyFilter(f: Filter, fly = true) {
    this.filter = f;
    this.refreshVenues();
    this.renderRail();
    this.renderChips();
    this.updateHere();
    if (!fly) return;
    const pad = this.mapPadding();
    if (f.kind === 'featured') this.map.flyTo([30, 12], small() ? 1.5 : 2.5, { duration: 1.2 });
    else if (f.kind === 'near') this.map.flyTo(f.at, 8, { duration: 1.4 });
    else if (f.kind === 'country') {
      const pts = [...(this.world?.venues ?? []).filter((v) => v.cc === f.cc).map((v) => v.at), ...[...this.tracks.values()].filter((t) => t.country === f.cc).map((t) => t.center)];
      const b = coreBounds(pts);
      if (b) this.map.flyToBounds(L.latLngBounds(b).pad(0.1), { maxZoom: 9, duration: 1.4, ...pad });
    }
  }

  private filterHash() {
    return this.filter.kind === 'country' ? `#/c/${this.filter.cc}` : '';
  }

  private pickFilter(key: string) {
    this.closeCountries();
    if (key === 'near') return this.nearMe();
    if (key === 'view') return;
    const hash = key.startsWith('cc:') ? `#/c/${key.slice(3)}` : '';
    if (location.hash.replace(/^#$/, '') === hash) {
      // Same route: re-apply (e.g. back to Featured from "Near me", which has no route).
      this.applyFilter(key === 'featured' ? { kind: 'featured' } : { kind: 'country', cc: key.slice(3) });
    } else location.hash = hash;
  }

  private nearMe() {
    if (!navigator.geolocation) return this.toast('Location isn’t available here. Pick a country instead.', 'warn');
    this.toast('Finding tracks near you…', 'busy');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.toast('');
        if (location.hash.startsWith('#/c/')) history.replaceState(null, '', location.pathname + location.search);
        this.applyFilter({ kind: 'near', at: [p.coords.latitude, p.coords.longitude] });
      },
      () => this.toast('Location is off. Pick a country instead.', 'warn'),
      { timeout: 10000, maximumAge: 600000 },
    );
  }

  /** Rebuild the rail for the current filter; `keep` holds your place (for background refreshes). */
  private renderRail(keep = false) {
    const items = this.railFor(this.filter);
    const { scrollLeft } = this.el.rail;
    const shown = this.railShown;
    this.rail = items;
    this.railTotal = items.length;
    this.railShown = 0;
    this.el.rail.scrollLeft = 0;
    if (!items.length) {
      const f = this.filter;
      this.el.rail.innerHTML = V.emptyRail(
        f.kind === 'near' ? 'No kart tracks mapped within 400 km of you yet.' : f.kind === 'view' ? 'No tracks in this area.' : 'Loading tracks…',
      );
      return;
    }
    this.el.rail.innerHTML = '';
    this.moreRail();
    if (keep) {
      while (this.railShown < Math.min(shown, items.length)) this.moreRail();
      this.el.rail.scrollLeft = scrollLeft;
    }
    this.renderNow();
  }

  /** Cards render in batches as you scroll along the rail. */
  private moreRail() {
    const next = this.rail.slice(this.railShown, this.railShown + RAIL_BATCH);
    if (!next.length) return;
    this.railShown += next.length;
    const featured = [...this.tracks.values()].filter((t) => t.preset);
    const html = next
      .map((it) => {
        if (it.kind === 'venue') return V.venueCard(it.v, this.emptyVenues.has(it.v.i));
        const t = it.t;
        const rec = this.feed?.records[`${t.id}|fwd`];
        const idx = featured.indexOf(t);
        return V.trackCard({
          t,
          shape: shapeOf(t),
          num: idx >= 0 ? idx + 1 : undefined,
          record: rec?.ms,
          live: (this.feed?.live[`${t.id}|fwd`] ?? 0) + (this.feed?.live[`${t.id}|rev`] ?? 0),
          pb: localPB(t.id, 'fwd'),
        });
      })
      .join('');
    this.el.rail.querySelector('.card.more')?.remove();
    this.el.rail.insertAdjacentHTML('beforeend', html);
  }

  private onRailScroll() {
    const r = this.el.rail;
    if (r.scrollLeft + r.clientWidth > r.scrollWidth - 600) this.moreRail();
  }

  /** Light up a rail item on the map (pin for tracks, ring for venues). */
  private hoverItem(key: string | null) {
    if (!key) {
      this.hotPin(null);
      this.focusVenue(null);
      return;
    }
    if (key.startsWith('t:')) this.hotPin(key.slice(2));
    else {
      const v = this.world?.venues[Number(key.slice(2))];
      if (v) this.focusVenue(v);
    }
  }

  // ------------------------------------------------------------------ race now

  private nowPick(): { t: TrackData; dir: Dir; why: string } | null {
    try {
      const last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null') as { id: string; dir: Dir } | null;
      const t = last && this.tracks.get(this.aliases.get(last.id) ?? last.id);
      if (t) return { t, dir: last!.dir === 'rev' ? 'rev' : 'fwd', why: 'Last raced' };
    } catch {
      /* fall through */
    }
    const featured = [...this.tracks.values()].filter((t) => t.preset);
    const live = (t: TrackData) => (this.feed?.live[`${t.id}|fwd`] ?? 0) + (this.feed?.live[`${t.id}|rev`] ?? 0);
    const busiest = featured.slice().sort((a, b) => live(b) - live(a))[0];
    if (busiest && live(busiest)) return { t: busiest, dir: 'fwd', why: `${live(busiest)} on track` };
    return featured[0] ? { t: featured[0], dir: 'fwd', why: 'Featured' } : null;
  }

  private renderNow() {
    const p = this.nowPick();
    // On Live time of day, say so when the race will be under the floodlights.
    const why = p && timePref() === 'live' && isNightAt(p.t.center) ? `${p.why} · night race` : p?.why;
    this.el.now.innerHTML = V.nowTile(p ? { ...p, why: why!, shape: shapeOf(p.t), pb: localPB(p.t.id, p.dir) } : null);
  }

  private raceNow() {
    const p = this.nowPick();
    if (p) this.race(p.t, p.dir);
  }

  private race(t: TrackData, dir: Dir) {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ id: t.id, dir }));
    } catch {
      /* private mode */
    }
    this.closeSearch();
    this.o.onRace(t, dir);
  }

  // ------------------------------------------------------------------ events

  private bind() {
    const search = this.el.search as HTMLInputElement;
    search.addEventListener('input', () => this.renderSearch());
    search.addEventListener('focus', () => search.value && this.renderSearch());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.hitSel = (this.hitSel + (e.key === 'ArrowDown' ? 1 : -1) + this.hits.length) % Math.max(1, this.hits.length);
        this.el.searchPop.querySelectorAll('.sr').forEach((b, i) => b.classList.toggle('on', i === this.hitSel));
      } else if (e.key === 'Escape') {
        this.closeSearch();
        search.blur();
      }
    });
    (this.el.searchForm as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      const h = this.hits[this.hitSel];
      if (h) this.pickHit(h.key);
    });
    this.el.searchPop.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    this.el.searchPop.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-hit]');
      if (b) this.pickHit(b.dataset.hit!);
    });
    document.addEventListener('click', (e) => {
      const t = e.target as Node;
      if (!this.el.searchWrap.contains(t)) this.closeSearch();
      if (!this.el.ccPop.contains(t) && !this.el.allBtn.contains(t)) this.closeCountries();
    });

    addEventListener('keydown', (e) => {
      if (this.o.root.hidden || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.cl-page, .mp-lobby:not([hidden]), .profile-pop:not([hidden])')) return;
      const typing = isTyping(e);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        search.focus();
        search.select();
      } else if (e.key === 'Escape' && !typing) {
        if (!this.el.ccPop.hidden) this.closeCountries();
        else if (this.editor) this.stopEditing(true);
        else if (this.selected) location.hash = this.filterHash();
      } else if (e.key === 'Enter' && !typing && !(e.target as HTMLElement)?.closest?.('button, a')) {
        e.preventDefault();
        if (this.selected && !this.editor) this.race(this.selected, this.dir);
        else if (!this.selected) this.raceNow();
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (e.target as HTMLElement)?.closest?.('.rail')) {
        e.preventDefault();
        const hits = [...this.el.rail.querySelectorAll<HTMLElement>('.card-hit')];
        const i = hits.indexOf(document.activeElement as HTMLElement);
        hits[Math.max(0, Math.min(hits.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus();
      }
    });

    this.el.now.addEventListener('click', () => this.raceNow());

    this.el.chips.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
      if (b) this.pickFilter(b.dataset.filter!);
    });
    this.el.allBtn.addEventListener('click', () => (this.el.ccPop.hidden ? this.openCountries() : this.closeCountries()));
    this.el.ccPop.addEventListener('input', () => this.renderCountries());
    this.el.ccPop.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
      if (b) this.pickFilter(b.dataset.filter!);
    });

    const rail = this.el.rail;
    rail.addEventListener('scroll', () => this.onRailScroll(), { passive: true });
    rail.addEventListener(
      'wheel',
      (e) => {
        // A mouse wheel scrolls the rail sideways; trackpads already scroll in both axes.
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && rail.scrollWidth > rail.clientWidth) {
          rail.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    rail.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const go = t.closest<HTMLElement>('[data-go]');
      if (go) {
        const tr = this.tracks.get(go.dataset.go!);
        if (tr) this.race(tr, 'fwd');
        return;
      }
      const card = t.closest<HTMLElement>('[data-track]');
      if (card) return this.open(card.dataset.track!);
      const ven = t.closest<HTMLElement>('[data-venue]');
      const v = ven && this.world?.venues[Number(ven.dataset.venue)];
      if (v) this.openVenue(v);
    });
    rail.addEventListener('mouseover', (e) => this.hoverItem((e.target as HTMLElement).closest<HTMLElement>('[data-card]')?.dataset.card ?? null));
    rail.addEventListener('mouseleave', () => this.hoverItem(null));
    rail.addEventListener('focusin', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]');
      this.hoverItem(card?.dataset.card ?? null);
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });

    this.el.sheet.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-act=back]')) location.hash = this.filterHash();
      if (t.closest('[data-act=race]') && this.selected) this.race(this.selected, this.dir);
      const sib = t.closest<HTMLElement>('.sib[data-track]');
      if (sib && sib.dataset.track !== this.selected?.id) this.open(sib.dataset.track!);
      const act = t.closest<HTMLElement>('[data-act^=edit]')?.dataset.act;
      if (act) this.editAction(act);
      const d = t.closest<HTMLElement>('[data-dir]')?.dataset.dir as Dir | undefined;
      if (d && this.selected && d !== this.dir) location.hash = `#/t/${this.selected.id}/${d}`;
    });

    this.el.here.addEventListener('click', () => {
      if (this.el.here.dataset.mode === 'scan') return this.scan();
      if (location.hash.startsWith('#/c/')) history.replaceState(null, '', location.pathname + location.search);
      this.applyFilter({ kind: 'view', bounds: this.map.getBounds() }, false);
    });

    this.el.live.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-act=live-toggle]')) return this.el.live.classList.toggle('collapsed');
      const row = t.closest<HTMLElement>('[data-feed]');
      if (row) {
        this.el.live.classList.remove('open');
        location.hash = `#/t/${row.dataset.feed}/${row.dataset.dir}`;
      }
    });
    this.el.livePill.addEventListener('click', (e) => {
      e.stopPropagation();
      if (small()) this.el.live.classList.toggle('open');
      else this.el.live.classList.remove('collapsed');
    });
    addEventListener('hashchange', () => this.route());
    addEventListener('resize', () => {
      this.map.invalidateSize();
      this.fitPlaceholder();
    });
  }

  private fitPlaceholder() {
    (this.el.search as HTMLInputElement).placeholder = small() ? 'Search tracks & places' : 'Search circuits, countries or any city';
  }

  // ------------------------------------------------------------------ search

  private renderSearch() {
    const q = (this.el.search as HTMLInputElement).value.trim();
    if (!q) return this.closeSearch();
    const s = q.toLowerCase();
    const has = (x: string) => x.toLowerCase().includes(s);
    // Prefix matches first, then word starts ("ger" -> Germany before Rogers).
    const rank = (x: string) => {
      const l = x.toLowerCase();
      return l.startsWith(s) ? 0 : new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(l) ? 1 : 2;
    };
    const counts = this.countryCounts();
    const trackHits = [...this.tracks.values()]
      .filter((t) => has(`${t.name} ${t.location}`))
      .sort((a, b) => rank(a.name) - rank(b.name))
      .slice(0, 5)
      .map((t) => ({ key: `t:${t.id}`, title: t.name, sub: `${t.location || V.coords(t.center)} · ${(t.lengthM / 1000).toFixed(2)} km`, tag: t.country ?? 'OSM' }));
    const countryHits = [...(this.world?.countries.values() ?? [])]
      .filter((c) => counts.has(c.cc) && (has(c.name) || c.cc.toLowerCase() === s || c.cc2.toLowerCase() === s))
      .sort((a, b) => rank(a.name) - rank(b.name) || (counts.get(b.cc) ?? 0) - (counts.get(a.cc) ?? 0))
      .slice(0, 4)
      .map((c) => ({ key: `c:${c.cc}`, title: c.name, sub: `${counts.get(c.cc)} kart tracks`, tag: c.cc }));
    const venueHits =
      q.length < 2
        ? []
        : (this.world?.venues ?? [])
            .filter((v) => v.name && !this.hiddenVenues.has(v.i) && has(v.name))
            .sort((a, b) => rank(a.name) - rank(b.name))
            .slice(0, 5)
            .map((v) => ({ key: `v:${v.i}`, title: v.name, sub: `${this.countryName(v.cc)} · ${V.coords(v.at)}`, tag: v.cc || '—' }));
    const place = [{ key: 'place', title: `Find “${q}” on the map`, sub: 'Any city or region · scans it for tracks', tag: '↵' }];
    this.hits = [...trackHits, ...countryHits, ...venueHits, ...place];
    this.hitSel = 0;
    this.el.searchPop.innerHTML = V.searchResults(
      [
        { label: 'Circuits', hits: trackHits },
        { label: 'Countries', hits: countryHits },
        { label: 'Venues', hits: venueHits },
        { label: 'Places', hits: place },
      ],
      this.hitSel,
    );
    this.el.searchPop.hidden = false;
  }

  private closeSearch() {
    this.el.searchPop.hidden = true;
  }

  private pickHit(key: string) {
    const input = this.el.search as HTMLInputElement;
    const q = input.value.trim();
    this.closeSearch();
    input.blur();
    if (key === 'place') return this.findPlace(q);
    input.value = '';
    if (key.startsWith('t:')) this.open(key.slice(2));
    else if (key.startsWith('c:')) this.pickFilter(`cc:${key.slice(2)}`);
    else if (key.startsWith('v:')) {
      const v = this.world?.venues[Number(key.slice(2))];
      if (v) this.openVenue(v);
    }
  }

  private async findPlace(q: string) {
    if (!q) return;
    this.toast(`Finding ${q}…`, 'busy');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const [hit] = await res.json();
      if (!hit) return this.toast(`Couldn't find “${q}”. Try a city name.`, 'warn');
      this.toast('');
      if (this.selected) location.hash = this.filterHash();
      const bb = hit.boundingbox.map(Number);
      const bounds = L.latLngBounds([bb[0], bb[2]], [bb[1], bb[3]]);
      this.map.flyToBounds(bounds, { maxZoom: 11, duration: 1.4, ...this.mapPadding() });
      this.map.once('moveend', () => {
        const here = this.inBounds(this.map.getBounds().pad(0.3));
        if (here.length) {
          if (location.hash.startsWith('#/c/')) history.replaceState(null, '', location.pathname + location.search);
          this.applyFilter({ kind: 'view', bounds: this.map.getBounds().pad(0.3) }, false);
        } else {
          if (this.map.getZoom() < 10) this.map.setZoom(10, { animate: false });
          this.scan(hit.display_name.split(',')[0]);
        }
      });
    } catch {
      this.toast('Search is unavailable right now', 'warn');
    }
  }

  // ------------------------------------------------------------------ countries

  private openCountries() {
    this.el.ccPop.hidden = false;
    this.el.allBtn.classList.add('open');
    const input = this.el.ccPop.querySelector('input')!;
    input.value = '';
    this.renderCountries();
    if (!small()) input.focus();
  }

  private closeCountries() {
    this.el.ccPop.hidden = true;
    this.el.allBtn.classList.remove('open');
  }

  private renderCountries() {
    const q = this.el.ccPop.querySelector('input')!.value.trim().toLowerCase();
    const counts = this.countryCounts();
    const list = [...counts.entries()]
      .map(([cc, n]) => ({ cc, n, name: this.countryName(cc) }))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.cc.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.el.ccList.innerHTML = V.countryList(list, this.filter.kind === 'country' ? this.filter.cc : null);
  }

  // ------------------------------------------------------------------ data

  private async load() {
    const [presets, world] = await Promise.allSettled([fetch('/tracks/presets.json').then((r) => r.json() as Promise<TrackData[]>), loadWorld()]);
    if (presets.status === 'fulfilled') presets.value.forEach((t) => this.addTrack({ ...t, preset: true }));
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
    if (world.status === 'fulfilled') {
      this.world = world.value;
      this.localCC = localeCountry(this.world);
      this.drawDots();
    }
    this.nameTracks([...this.tracks.values()].filter((t) => !t.preset && !t.location));
    if (!this.route()) this.applyFilter({ kind: 'featured' }, false);
    this.renderNow();
    this.pollFeed();
    window.setInterval(() => !this.o.root.hidden && this.pollFeed(), 6000);
    window.setInterval(() => this.selected && !this.o.root.hidden && this.pollBoard(), 5000);
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
    } catch {
      this.el.liveBody.innerHTML = '<p class="lv-empty">Live timing is offline.</p>';
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
      if (this.el.dBoard) this.el.dBoard.innerHTML = '<p class="empty">Leaderboard is offline. You can still race; laps are saved on this device.</p>';
    }
  }

  private async scan(placeName?: string) {
    const b = this.map.getBounds();
    this.scanning?.abort();
    this.scanning = new AbortController();
    this.el.here.classList.remove('show');
    this.toast(placeName ? `Scanning ${placeName} for kart tracks…` : 'Scanning this area for kart tracks…', 'busy');
    try {
      const found = await discoverTracks([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], this.scanning.signal);
      const fresh = found.filter((t) => !this.tracks.has(t.id));
      fresh.forEach((t) => this.addTrack(t));
      this.persist();
      this.refreshVenues();
      this.nameTracks(fresh);
      this.drawOutlines();
      if (!found.length) this.toast('No kart tracks mapped here yet. Try another area.', 'warn');
      else {
        this.toast(`Found ${found.length} track${found.length > 1 ? 's' : ''}${fresh.length && fresh.length < found.length ? `, ${fresh.length} new` : ''}`);
        if (found.length === 1) this.open(found[0].id);
        else {
          this.map.flyToBounds(L.latLngBounds(found.map((t) => t.center)).pad(0.3), { maxZoom: 13, ...this.mapPadding() });
          this.applyFilter({ kind: 'view', bounds: L.latLngBounds(found.map((t) => t.center)).pad(0.3) }, false);
        }
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
          this.renderRail(true);
          if (this.selected?.id === t.id) this.renderDetail();
        }
      } catch {
        /* keep the coordinates */
      }
      await new Promise((res) => setTimeout(res, 1100)); // Nominatim allows ~1 request/second
    }
  }

  // ------------------------------------------------------------------ routing

  private route(): boolean {
    const h = location.hash;
    const m = /^#\/t\/([^/]+)\/?(fwd|rev)?/.exec(h);
    if (m) {
      this.dir = (m[2] as Dir) || 'fwd';
      const id = decodeURIComponent(m[1]);
      const alias = this.aliases.get(id);
      if (alias) {
        history.replaceState(null, '', `#/t/${alias}/${this.dir}`);
        this.select(alias);
      } else this.select(id);
      return true;
    }
    const wasOpen = !!this.selected;
    if (this.selected) this.closeDetail();
    const c = /^#\/c\/([A-Za-z]{3})$/.exec(h);
    if (c) {
      const cc = c[1].toUpperCase();
      const same = this.filter.kind === 'country' && this.filter.cc === cc;
      if (!same) this.applyFilter({ kind: 'country', cc });
      else if (wasOpen) this.applyFilter(this.filter); // back from a track: show the country again
      return true;
    }
    if (this.filter.kind === 'country') this.applyFilter({ kind: 'featured' });
    return false;
  }

  private open(id: string) {
    const hash = `#/t/${id}/${this.selected?.id === id ? this.dir : 'fwd'}`;
    if (location.hash === hash) this.select(id);
    else location.hash = hash;
  }

  private async select(id: string) {
    let t = this.tracks.get(id);
    if (!t) {
      const route = location.hash;
      this.toast('Loading track…', 'busy');
      try {
        const fetched = (await api.track(id).catch(() => null)) ?? (await trackFromId(id));
        if (!fetched) throw new Error('not found');
        const fromFeed = this.feed?.laps.find((l) => l.track === id) ?? this.feed?.onTrack?.find((l) => l.track === id && l.trackName);
        const name = fromFeed && ('trackName' in fromFeed ? fromFeed.trackName : null);
        if (name) fetched.name = name;
        this.addTrack(fetched);
        this.persist();
        this.refreshVenues();
        t = fetched;
        this.toast('');
        if (location.hash !== route) return; // you went elsewhere while it loaded
      } catch {
        this.toast("Couldn't load that track. OpenStreetMap may be busy.", 'warn');
        return;
      }
    }
    const changed = this.selected?.id !== t.id;
    this.selected = t;
    this.o.root.classList.add('detail-open');
    this.closeSearch();
    this.renderDetail();
    this.markSelectedPin();
    this.el.here.classList.remove('show');
    if (changed) {
      const bounds = L.latLngBounds(t.points.map((p) => L.latLng(p[0], p[1])));
      this.map.flyToBounds(bounds, { maxZoom: 18, duration: 1.4, ...this.mapPadding() });
      this.board = null;
      this.el.sheetScroll.scrollTop = 0;
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
    if (this.map.getZoom() > 12) this.map.flyTo(this.map.getCenter(), 10, { duration: 1 });
    this.updateHere();
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

  private mapPadding(): { paddingTopLeft: L.PointExpression; paddingBottomRight: L.PointExpression } {
    if (small()) {
      // The sheet covers the dock and the lower part of the map on phones.
      const mapH = this.el.map.clientHeight || innerHeight * 0.6;
      const cover = this.selected ? Math.max(0, innerHeight * 0.74 - (innerHeight - this.el.map.getBoundingClientRect().bottom)) : 0;
      return { paddingTopLeft: [20, 20], paddingBottomRight: [20, Math.min(mapH - 80, cover + 20)] };
    }
    const sheet = this.selected || location.hash.startsWith('#/t/') ? 440 : 40;
    const live = this.el.live.classList.contains('collapsed') ? 40 : 330;
    return { paddingTopLeft: [sheet, 40], paddingBottomRight: [live, 40] };
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
        <div><dt class="label">OSM trace</dt><dd class="mono">${loopLengthKm(original).toFixed(2)}<small>km</small></dd></div>
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
    this.el.edLen.innerHTML = `${loopLengthKm(this.editor.points).toFixed(2)}<small>km</small>`;
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
      this.renderRail();
    } catch (e) {
      this.el.edStatus.textContent = `Couldn't save: ${(e as Error).message}`;
    }
  }

  // ------------------------------------------------------------------ rendering

  private renderDetail() {
    const t = this.selected!;
    const featured = [...this.tracks.values()].filter((x) => x.preset);
    const idx = featured.indexOf(t);
    const siblings = [...this.tracks.values()].filter((x) => x.id !== t.id && distM(x.center, t.center) < 800);
    this.el.detail.innerHTML = V.sheet({
      t,
      shape: shapeOf(t),
      dir: this.dir,
      num: idx >= 0 ? idx + 1 : undefined,
      total: featured.length,
      pb: localPB(t.id, this.dir),
      siblings,
      shapeOf,
      countryName: t.country ? this.countryName(t.country) : undefined,
      nightNow: isNightAt(t.center),
    });
    this.el.detail.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    if (this.board) this.renderBoard();
  }

  private renderBoard() {
    if (!this.el.dBoard?.isConnected) return;
    const b = V.board(this.board!, this.o.driver.pid);
    this.el.dCount.textContent = b.count;
    this.el.dLive.innerHTML = b.live;
    this.el.dBoard.innerHTML = b.list;
  }

  private renderFeed() {
    const f = this.feed!;
    const live = Object.values(f.live).reduce((a, n) => a + n, 0);
    this.el.liveCount.textContent = String(live);
    this.el.liveCount2.textContent = String(live);
    this.el.livePill.classList.toggle('idle', !live);
    this.el.live.classList.toggle('idle', !live);
    const rows: V.LiveRow[] = (f.onTrack ?? []).map((o) => ({
      track: o.track,
      dir: o.dir,
      name: o.name,
      color: o.color,
      where: this.tracks.get(o.track)?.name ?? o.trackName ?? f.laps.find((l) => l.track === o.track)?.trackName ?? 'A kart track',
    }));
    this.el.liveBody.innerHTML = V.liveBody(rows, f.laps);
    for (const id of this.pins.keys()) this.markLive(id);
    // Tracks other drivers are using that this browser hasn't seen yet.
    const remote = [
      ...f.laps.map((l) => ({ id: l.track, name: l.trackName, center: l.center })),
      ...(f.onTrack ?? []).map((o) => ({ id: o.track, name: o.trackName ?? 'Kart track', center: o.center ?? undefined })),
    ];
    for (const r of remote) {
      if (this.tracks.has(r.id) || this.pins.has(r.id) || !r.center) continue;
      const icon = L.divIcon({ className: 'pin-wrap', html: `<div class="pin remote"><i></i><span>${V.esc(r.name)}</span><b class="pin-live mono"></b></div>`, iconSize: [0, 0] });
      const m = L.marker(r.center, { icon }).on('click', () => (location.hash = `#/t/${r.id}/fwd`));
      m.addTo(this.map);
      this.pins.set(r.id, m);
      this.markLive(r.id);
    }
    // Refresh live badges and records on the cards without re-rendering the rail.
    for (const card of this.el.rail.querySelectorAll<HTMLElement>('[data-card^="t:"]')) {
      const id = card.dataset.card!.slice(2);
      const n = (f.live[`${id}|fwd`] ?? 0) + (f.live[`${id}|rev`] ?? 0);
      const top = card.querySelector('.card-top')!;
      top.querySelector('.card-live')?.remove();
      if (n) top.insertAdjacentHTML('beforeend', `<span class="card-live"><i class="live-dot"></i>${n} live</span>`);
      const rec = card.querySelector('.card-rec');
      if (rec) rec.innerHTML = V.recordHtml(f.records[`${id}|fwd`]?.ms);
    }
    if (!this.selected) this.renderNow();
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
    this.renderRail(true);
    this.pollFeed();
  }

  hide() {
    this.o.root.hidden = true;
    this.profile.close();
    this.closeSearch();
    this.closeCountries();
  }
}

const ATLAS_HTML = /* html */ `
<header class="topbar">
  <a class="wordmark" href="#" aria-label="ApexKart home"><span class="wm-chk"></span><span class="display">Apex<b>Kart</b></span></a>
  <div class="search-wrap" data-el="searchWrap">
    <form class="search" data-el="searchForm" role="search">
      ${V.SEARCH_ICON}
      <input data-el="search" type="search" placeholder="Search circuits, countries or any city" autocomplete="off" spellcheck="false" aria-label="Search circuits, countries or any city" />
      <kbd>/</kbd>
    </form>
    <div class="search-pop" data-el="searchPop" hidden></div>
  </div>
  <div class="top-right">
    <button class="live-pill idle" data-el="livePill" title="Drivers on track right now"><i class="live-dot"></i><b class="mono" data-el="liveCount">0</b><span>on track</span></button>
    <button class="profile-btn" data-el="profileBtn" aria-haspopup="dialog"></button>
  </div>
</header>
<main class="atlas">
  <div class="map" data-el="map"></div>
  <button class="here-btn" data-el="here">${V.SEARCH_ICON}<span>List tracks here</span></button>
  <div class="map-toast" data-el="toast"></div>
  <aside class="live idle" data-el="live" aria-label="Live timing">
    <header><span><i class="live-dot"></i><b class="mono" data-el="liveCount2">0</b> on track now</span><button data-act="live-toggle" aria-label="Collapse live timing">–</button></header>
    <div class="live-body" data-el="liveBody"><p class="lv-empty">Connecting…</p></div>
  </aside>
  <section class="sheet" data-el="sheet" aria-label="Circuit">
    <div class="sheet-scroll" data-el="sheetScroll"><div class="view-detail" data-el="detail"></div></div>
  </section>
</main>
<footer class="dock">
  <div class="dock-bar">
    <div class="chips" data-el="chips" role="group" aria-label="Show tracks"></div>
    <button class="all-btn" data-el="allBtn" aria-haspopup="dialog"><b class="mono">0</b> countries <span class="mono">▾</span></button>
  </div>
  <div class="dock-main">
    <div class="now-slot" data-el="now"></div>
    <div class="rail-wrap"><div class="rail" data-el="rail" aria-label="Circuits"></div></div>
  </div>
  <div class="cc-pop" data-el="ccPop" role="dialog" aria-label="All countries" hidden>
    <input type="search" placeholder="Filter countries" aria-label="Filter countries" autocomplete="off" spellcheck="false" />
    <div class="cc-list" data-el="ccList"></div>
  </div>
</footer>`;
