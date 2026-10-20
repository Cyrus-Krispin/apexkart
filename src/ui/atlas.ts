// The home screen in the Pit Wall design (docs/pit-wall.md). Every circuit is a live session, so
// home is a timing tower: circuits ranked by who's on track (LIVE), by distance (NEAR ME) or by
// country (WORLD, all 4,900 venues). Pick one and its pit board shows the track, your medal
// targets, the classification and a green Start. On desktop the tower and the pit board sit side
// by side as a broadcast wall, with race control running along the bottom.
import { centroid, trackFromId, waysFromId, type LatLon, type TrackData } from '../track/osm';
import { cellOf, unpackPoints, venueKey, type VenueCell } from '../shared/venues';
import { dailyStreak, dailyTrack, dayOf, msLeftToday } from '../shared/daily';
import { analyzeShape, type TrackShape } from '../track/shape';
import { ProfileMenu } from './profile';
import { openLayoutEditor } from './editorScreen';
import { api, type BoardResponse, type CommunityLayout, type DailyResponse, type Dir, type Driver, type FeedResponse } from '../net/api';
import { localPB, saveTimePref, timePref, type TimePref } from '../game/prefs';
import { controlsPref, saveControlsPref, type ControlScheme } from '../game/input';
import { earnedMedal, targets } from '../game/medals';
import { isNightAt } from '../game/sun';
import { distM, loadWorld, localeCountry, type Venue, type WorldIndex } from './world';
import { circuitCode, stripeStyle } from './pitwall';
import * as V from './atlasViews';

const LAST_KEY = 'ak:last'; // {id, dir} of the last circuit raced: what Box box offers
const SAME_VENUE_M = 700; // a venue this close to a known track is that track
const NEAR_KM = 400;
const BATCH = 80; // tower rows rendered at a time in the long lists
const FLASH_MS = 2200;

export interface AtlasOptions {
  root: HTMLElement;
  driver: Driver;
  /** `daily`: this is today's daily circuit, so laps also go on the day's board. `rival`: a driver's
   *  public id whose lap races along as a ghost (a challenge). */
  onRace: (track: TrackData, dir: Dir, daily: boolean, rival?: string) => void;
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

const isTyping = (e: Event) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
/** Phones: the pit board is a page of its own over the tower. */
const small = () => innerWidth <= 760;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

type Remote = { id: string; name: string; center?: LatLon };

export class Atlas {
  private tracks = new Map<string, TrackData>();
  private remote = new Map<string, Remote>(); // circuits others are racing that this browser hasn't loaded
  private selected: TrackData | null = null;
  private dir: Dir = 'fwd';
  private routed = false; // the pit board is open because the address says so (not the desktop default)
  private feed: FeedResponse | null = null;
  private board: BoardResponse | null = null;
  private daily: DailyResponse | null = null;
  private rival: { pid: string; name?: string; ms?: number } | null = null; // from a challenge link
  private el: Record<string, HTMLElement> = {};
  private profile: ProfileMenu;
  private toastTimer = 0;
  private aliases = new Map<string, string>(); // OSM id -> community layout id
  private pendingLayouts = new Map<string, CommunityLayout>();
  private closeEditor: (() => void) | null = null;

  private world: WorldIndex | null = null;
  private localCC: string | null = null;
  private covered = new Set<number>(); // venues a known track already stands for
  private coveredSig = '';
  private emptyVenues = new Set<number>(); // loaded, but no racing line there
  private cells = new Map<string, Promise<VenueCell | null>>(); // pre-stitched layouts per 5° cell
  private loadingVenue: number | null = null;

  private tab: V.Tab = 'live';
  private worldCC: string | null = null; // WORLD: one country, or null for all
  private near: { at: LatLon; label: string } | null = null;
  private rows: V.TowerRow[] = [];
  private shown = 0;
  private cursor: string | null = null; // keyboard position in the tower
  private hits: V.SearchHit[] = [];
  private hitSel = 0;
  private prevRecords = new Map<string, number>();
  private flashes = new Map<string, { kind: 'p' | 'g'; until: number }>();
  private pbSeen = new Map<string, number>();
  private feedFails = 0;
  private starting = false;

  constructor(private o: AtlasOptions) {
    o.root.innerHTML = ATLAS_HTML;
    o.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.profile = new ProfileMenu(this.el.profileBtn, o.driver, () => {
      if (this.board) this.renderBoard();
    });
    this.bind();
    this.renderTabs();
    this.renderTower();
    this.renderBox();
    this.load();
    window.setInterval(() => this.tickClock(), 1000);
    if (import.meta.env.DEV) Object.assign(window as any, { __atlas: this });
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
      for (const t of this.tracks.values()) if (!t.country) t.country = this.nearestVenue(t.center, 3000)?.cc || undefined;
      this.el.worldN.textContent = this.worldTotal().toLocaleString('en');
    }
    this.nameTracks([...this.tracks.values()].filter((t) => !t.preset && !t.location));
    this.route();
    this.renderTower();
    this.renderBox();
    this.renderDaily();
    this.pollFeed();
    this.pollDaily();
    window.setInterval(() => !this.o.root.hidden && this.pollFeed(), 6000);
    window.setInterval(() => !this.o.root.hidden && this.pollDaily(), 60000);
    window.setInterval(() => this.selected && !this.o.root.hidden && this.pollBoard(), 5000);
  }

  private addTrack(t: TrackData) {
    const lay = this.pendingLayouts.get(t.id);
    if (lay) {
      this.pendingLayouts.delete(t.id);
      t = this.withLayout(t, lay);
    }
    if (!t.country && this.world) t.country = this.nearestVenue(t.center, 3000)?.cc || undefined;
    this.tracks.set(t.id, t);
    this.remote.delete(t.id);
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
      this.tracks.set(fixed.id, fixed);
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
      const f = await api.feed();
      this.feedFails = 0;
      this.noteRecords(f);
      this.feed = f;
      this.renderFeed();
    } catch {
      // One dropped request isn't an outage: keep the last timing until a few fail in a row.
      if (++this.feedFails >= 3 || !this.feed) this.el.liveBody.innerHTML = '<p class="pit-empty">Live timing is offline.</p>';
    }
  }

  /** New track records flash purple on the tower. */
  private noteRecords(f: FeedResponse) {
    const now = Date.now();
    for (const [k, r] of Object.entries(f.records)) {
      const prev = this.prevRecords.get(k);
      if (prev !== undefined && r.ms < prev) this.flashes.set(k.split('|')[0], { kind: 'p', until: now + FLASH_MS });
      this.prevRecords.set(k, r.ms);
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
      if (this.el.dBoard?.isConnected) this.el.dBoard.innerHTML = '<p class="pit-empty">Leaderboard is offline. You can still race; laps are saved on this device.</p>';
    }
  }

  private async pollDaily() {
    try {
      this.daily = await api.daily();
      this.renderDaily();
    } catch {
      /* the bar still shows today's circuit */
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
          this.persist();
          this.renderTower(true);
          if (this.selected?.id === t.id) this.renderPit();
        }
      } catch {
        /* keep what we have */
      }
      await new Promise((res) => setTimeout(res, 1100)); // Nominatim allows ~1 request/second
    }
  }

  // ------------------------------------------------------------------ venues

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

  /** Venues a known track already stands for (worked out again only when the tracks change). */
  private coveredVenues(): Set<number> {
    const known = [...this.tracks.values()];
    const sig = known.map((t) => t.id).join();
    if (sig !== this.coveredSig && this.world) {
      this.coveredSig = sig;
      this.covered.clear();
      for (const v of this.world.venues) if (known.some((t) => Math.abs(t.center[0] - v.at[0]) < 0.02 && distM(t.center, v.at) < SAME_VENUE_M)) this.covered.add(v.i);
    }
    return this.covered;
  }

  private venues(): Venue[] {
    const cov = this.coveredVenues();
    return (this.world?.venues ?? []).filter((v) => !cov.has(v.i) && !this.emptyVenues.has(v.i));
  }

  private worldTotal() {
    return this.venues().length + this.tracks.size;
  }

  /** The pre-stitched layouts file for a venue's cell (fetched once, then cached). */
  private venueCell(v: Venue): Promise<VenueCell | null> {
    const key = cellOf(v.at[0], v.at[1]);
    let p = this.cells.get(key);
    if (!p) {
      p = fetch(`/tracks/venues/${key}.json`)
        .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? (r.json() as Promise<VenueCell>) : null))
        .catch(() => null);
      this.cells.set(key, p);
      p.then((c) => c || this.cells.delete(key)); // let a failed fetch be retried
    }
    return p;
  }

  /** A venue's layouts, pre-stitched and served from the CDN. */
  private async venueLayouts(v: Venue): Promise<TrackData[]> {
    const cell = await this.venueCell(v);
    if (!cell) throw new Error('offline');
    // The baker keys each venue by its position; fall back to the nearest baked venue in the cell.
    let packed = cell[venueKey(v.at[0], v.at[1])];
    if (!packed) {
      let best = 600;
      for (const [k, layouts] of Object.entries(cell)) {
        const [la, lo] = k.split(',').map(Number);
        const d = distM([la, lo], v.at);
        if (d < best) {
          best = d;
          packed = layouts;
        }
      }
    }
    return (packed ?? []).map(([id, name, width, lengthM, pts]) => {
      const points = unpackPoints(pts);
      return { id, name, location: '', center: centroid(points), points, width, lengthM, osmWays: waysFromId(id) ?? [], source: 'OpenStreetMap', country: v.cc || undefined };
    });
  }

  /** A venue row becomes a track: get its layouts and open the longest. */
  private async openVenue(v: Venue) {
    const known = this.trackNear(v.at, SAME_VENUE_M);
    if (known) return this.open(known.id);
    if (this.loadingVenue === v.i) return;
    this.loadingVenue = v.i;
    this.toast(`Loading ${v.name || 'the track'}…`, 'busy');
    try {
      const found = await this.venueLayouts(v);
      if (this.loadingVenue !== v.i) return;
      if (!found.length) {
        this.emptyVenues.add(v.i);
        this.renderTower(true);
        this.toast('This track isn’t ready yet, so it’s off the list for now.', 'warn');
        return;
      }
      found.filter((t) => !this.tracks.has(t.id)).forEach((t) => this.addTrack(t));
      this.persist();
      this.nameTracks(found);
      this.toast(found.length > 1 ? `${found.length} layouts at this venue` : '');
      this.open(found.sort((a, b) => b.lengthM - a.lengthM)[0].id);
    } catch {
      this.toast('Couldn’t load this track. Check your connection and try again.', 'warn');
    } finally {
      if (this.loadingVenue === v.i) this.loadingVenue = null;
    }
  }

  private countryName(cc: string | undefined) {
    return (cc && this.world?.countries.get(cc)?.name) || cc || '';
  }

  // ------------------------------------------------------------------ the tower

  /** One row per venue: a venue's other layouts are on its pit board. The busiest (then featured,
   *  then longest) layout stands for the venue. */
  private venueTracks(list: TrackData[]): TrackData[] {
    const kept: TrackData[] = [];
    const rank = (t: TrackData) => this.liveOf(t.id) * 1e6 + (t.id === this.selected?.id ? 1e5 : 0) + (t.preset ? 1e4 : 0) + t.lengthM;
    for (const t of list.slice().sort((a, b) => rank(b) - rank(a)))
      if (!kept.some((k) => Math.abs(k.center[0] - t.center[0]) < 0.01 && distM(k.center, t.center) < 800)) kept.push(t);
    return kept;
  }

  private liveOf(id: string) {
    return (this.feed?.live[`${id}|fwd`] ?? 0) + (this.feed?.live[`${id}|rev`] ?? 0);
  }

  private recordOf(id: string) {
    const a = this.feed?.records[`${id}|fwd`]?.ms;
    const b = this.feed?.records[`${id}|rev`]?.ms;
    return a && b ? Math.min(a, b) : (a ?? b ?? null);
  }

  private flashOf(id: string): '' | 'p' | 'g' {
    const f = this.flashes.get(id);
    return f && f.until > Date.now() ? f.kind : '';
  }

  private trackRow(t: TrackData, extra: Partial<V.TowerRow> = {}): V.TowerRow {
    const city = t.location?.split(',')[0];
    return {
      key: `t:${t.id}`,
      code: circuitCode(t.name),
      name: t.name,
      sub: [city, this.countryName(t.country)].filter(Boolean).join(' · ') || 'OpenStreetMap',
      cc: t.country,
      best: this.recordOf(t.id),
      flash: this.flashOf(t.id),
      live: this.liveOf(t.id),
      medal: earnedMedal(t.id, 'fwd') ?? earnedMedal(t.id, 'rev'),
      daily: t.id === this.dailyId(),
      ...extra,
    };
  }

  private venueRow(v: Venue, extra: Partial<V.TowerRow> = {}): V.TowerRow {
    return { key: `v:${v.i}`, code: circuitCode(v.name || 'Kart track'), name: v.name || 'Unnamed kart track', sub: this.countryName(v.cc) || 'Kart track', cc: v.cc, best: null, live: 0, ...extra };
  }

  /** LIVE: every circuit with a session, ranked by drivers on track, then today's laps, then records. */
  private liveRows(): V.TowerRow[] {
    const lastLap = new Map<string, number>();
    for (const l of this.feed?.laps ?? []) lastLap.set(l.track, Math.max(lastLap.get(l.track) ?? 0, l.at));
    const dayAgo = Date.now() - 86_400_000;
    const score = (r: V.TowerRow, id: string) => r.live * 1e9 + ((lastLap.get(id) ?? 0) > dayAgo ? 1e6 + (lastLap.get(id)! - dayAgo) / 1e3 : 0) + (r.best ? 1e3 : 0) + (r.daily ? 500 : 0);
    const list: { r: V.TowerRow; s: number }[] = [];
    for (const t of this.venueTracks([...this.tracks.values()])) {
      const r = this.trackRow(t);
      list.push({ r, s: score(r, t.id) });
    }
    for (const x of this.remote.values()) {
      const r: V.TowerRow = { key: `t:${x.id}`, code: circuitCode(x.name), name: x.name, sub: 'Raced by others', best: this.recordOf(x.id), flash: this.flashOf(x.id), live: this.liveOf(x.id) };
      list.push({ r, s: score(r, x.id) });
    }
    return list.sort((a, b) => b.s - a.s || a.r.name.localeCompare(b.r.name)).map((x) => x.r);
  }

  private nearRows(at: LatLon): V.TowerRow[] {
    const items: [number, V.TowerRow][] = [];
    for (const t of this.venueTracks([...this.tracks.values()])) {
      const d = distM(at, t.center) / 1000;
      if (d < NEAR_KM) items.push([d, this.trackRow(t, { distKm: d })]);
    }
    for (const v of this.venues()) {
      if (Math.abs(v.at[0] - at[0]) > 4) continue;
      const d = distM(at, v.at) / 1000;
      if (d < NEAR_KM) items.push([d, this.venueRow(v, { distKm: d })]);
    }
    return items.sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  }

  private worldRows(cc: string | null): V.TowerRow[] {
    const ts = this.venueTracks([...this.tracks.values()].filter((t) => !cc || t.country === cc)).map((t) => this.trackRow(t));
    ts.sort((a, b) => b.live - a.live || Number(!!b.best) - Number(!!a.best) || a.name.localeCompare(b.name));
    const named = (a: Venue, b: Venue) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.name.localeCompare(b.name);
    const vs = this.venues().filter((v) => !cc || v.cc === cc);
    vs.sort(cc ? named : (a, b) => this.countryName(a.cc).localeCompare(this.countryName(b.cc)) || named(a, b));
    return [...ts, ...vs.map((v) => this.venueRow(v))];
  }

  private computeRows(): V.TowerRow[] {
    if (this.tab === 'near') return this.near ? this.nearRows(this.near.at) : [];
    if (this.tab === 'world') return this.worldRows(this.worldCC);
    return this.liveRows();
  }

  /** Rebuild the tower. `keep` holds your scroll place (background refreshes); LIVE rows glide to their new places. */
  private renderTower(keep = false): void {
    if (this.searching()) return this.renderSearch();
    const list = this.el.tower;
    const before = new Map<string, number>();
    if (keep && this.tab === 'live' && !reduceMotion()) for (const r of list.querySelectorAll<HTMLElement>('[data-key]')) before.set(r.dataset.key!, r.getBoundingClientRect().top);
    const scroll = list.scrollTop;
    const shown = this.shown;
    this.rows = this.computeRows();
    this.el.head.innerHTML = V.towerHead(this.tab);
    this.el.head.hidden = false;
    this.renderSub();
    if (!this.rows.length) {
      this.shown = 0;
      list.innerHTML =
        this.tab === 'near'
          ? this.near
            ? V.towerEmpty(`No kart tracks within ${NEAR_KM} km of ${this.near.label}.`)
            : V.towerEmpty('See the tracks closest to you.', { act: 'locate', label: 'Use my location' })
          : V.towerEmpty(this.world || this.tracks.size ? 'No tracks here yet.' : 'Loading tracks…');
      return;
    }
    this.shown = 0;
    list.innerHTML = '';
    this.more(keep ? Math.max(shown, BATCH) : BATCH);
    if (keep) list.scrollTop = scroll;
    else list.scrollTop = 0;
    // FLIP: rows that moved slide from where they were.
    if (before.size)
      for (const r of list.querySelectorAll<HTMLElement>('[data-key]')) {
        const was = before.get(r.dataset.key!);
        if (was === undefined) continue;
        const dy = was - r.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 600, easing: 'cubic-bezier(.3,.9,.2,1)' });
      }
  }

  /** Append the next rows of a long list. */
  private more(n = BATCH) {
    const from = this.shown;
    const to = Math.min(this.rows.length, from + n);
    if (to <= from) return;
    const sel = this.selected ? `t:${this.selected.id}` : null;
    let html = '';
    for (let i = from; i < to; i++) {
      const r = this.rows[i];
      html += V.towerRow(r, i + 1, r.key === sel || r.key === this.cursor, this.tab);
    }
    this.el.tower.insertAdjacentHTML('beforeend', html);
    this.shown = to;
  }

  private renderTabs() {
    for (const b of this.el.tabs.querySelectorAll<HTMLElement>('[data-tab]')) {
      const on = b.dataset.tab === this.tab && !this.searching();
      b.setAttribute('aria-selected', String(on));
      b.classList.toggle('on', on);
    }
  }

  private renderSub() {
    const s = this.el.sub;
    if (this.tab === 'world') {
      const name = this.worldCC ? this.countryName(this.worldCC) : 'All countries';
      s.innerHTML = `<button class="tw-cc" data-act="countries" aria-haspopup="dialog"><span class="pw-stripe" style="${stripeStyle(this.worldCC)}"></span><b>${V.esc(name.toUpperCase())}</b><span class="mono">${this.rows.length.toLocaleString('en')}</span><span class="tw-caret">▾</span></button>`;
      s.hidden = false;
    } else if (this.tab === 'near' && this.near) {
      s.innerHTML = `<p class="tw-near">${V.ICON.pin}<span>NEAR <b>${V.esc(this.near.label.toUpperCase())}</b></span><button class="tw-link" data-act="locate">Use my location</button></p>`;
      s.hidden = false;
    } else s.hidden = true;
  }

  private setTab(tab: V.Tab) {
    this.clearSearch();
    if (tab === 'world' && this.worldCC === null && !this.tabTouched) this.worldCC = this.localCC;
    this.tabTouched = true;
    this.tab = tab;
    this.cursor = null;
    this.renderTabs();
    if (tab === 'near' && !this.near) this.locate();
    this.renderTower();
    const hash = this.tabHash();
    if (!this.routed && location.hash !== hash && (location.hash.startsWith('#/c/') || hash)) history.replaceState(null, '', hash || location.pathname + location.search);
  }
  private tabTouched = false;

  private tabHash() {
    return this.tab === 'world' && this.worldCC ? `#/c/${this.worldCC}` : '';
  }

  private locate() {
    if (!navigator.geolocation) return this.toast('Location isn’t available here. Search for a city instead.', 'warn');
    this.toast('Finding tracks near you…', 'busy');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.toast('');
        this.near = { at: [p.coords.latitude, p.coords.longitude], label: 'you' };
        this.tab = 'near';
        this.renderTabs();
        this.renderTower();
      },
      () => this.toast('Location is off. Search for a city instead.', 'warn'),
      { timeout: 10000, maximumAge: 600000 },
    );
  }

  // ------------------------------------------------------------------ countries

  private openCountries() {
    const pop = this.el.ccPop;
    pop.hidden = false;
    const input = pop.querySelector('input')!;
    input.value = '';
    this.renderCountries();
    if (!small()) input.focus();
  }

  private closeCountries() {
    this.el.ccPop.hidden = true;
  }

  private renderCountries() {
    const q = this.el.ccPop.querySelector('input')!.value.trim().toLowerCase();
    const n = new Map<string, number>();
    for (const v of this.venues()) if (v.cc) n.set(v.cc, (n.get(v.cc) ?? 0) + 1);
    for (const t of this.tracks.values()) if (t.country) n.set(t.country, (n.get(t.country) ?? 0) + 1);
    const list = [...n.entries()]
      .map(([cc, k]) => ({ cc, n: k, name: this.countryName(cc) }))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.cc.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.el.ccList.innerHTML = V.countryList(list, this.worldCC, this.worldTotal());
  }

  private pickCountry(cc: string | null) {
    this.closeCountries();
    this.tabTouched = true;
    this.worldCC = cc;
    this.tab = 'world';
    this.renderTabs();
    this.renderTower();
    const hash = this.tabHash();
    if (this.routed) location.hash = hash;
    else history.replaceState(null, '', hash || location.pathname + location.search);
  }

  // ------------------------------------------------------------------ search

  private searching() {
    return !!(this.el.search as HTMLInputElement).value.trim();
  }

  private clearSearch() {
    const s = this.el.search as HTMLInputElement;
    if (!s.value) return;
    s.value = '';
    this.o.root.classList.remove('searching');
    this.renderTabs();
  }

  private renderSearch(): void {
    const q = (this.el.search as HTMLInputElement).value.trim();
    this.o.root.classList.toggle('searching', !!q);
    this.renderTabs();
    if (!q) return this.renderTower();
    const s = q.toLowerCase();
    const has = (x: string) => x.toLowerCase().includes(s);
    // Prefix matches first, then word starts ("ger" -> Germany before Rogers).
    const rank = (x: string) => {
      const l = x.toLowerCase();
      return l.startsWith(s) ? 0 : new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(l) ? 1 : 2;
    };
    const trackHits = [...this.tracks.values()]
      .filter((t) => has(`${t.name} ${t.location} ${circuitCode(t.name)}`))
      .sort((a, b) => rank(a.name) - rank(b.name))
      .slice(0, 6)
      .map((t) => ({ key: `t:${t.id}`, title: t.name, sub: `${t.location || this.countryName(t.country)} · ${(t.lengthM / 1000).toFixed(2)} km`, tag: circuitCode(t.name), cc: t.country }));
    const counts = new Map<string, number>();
    for (const v of this.venues()) if (v.cc) counts.set(v.cc, (counts.get(v.cc) ?? 0) + 1);
    const countryHits = [...(this.world?.countries.values() ?? [])]
      .filter((c) => counts.has(c.cc) && (has(c.name) || c.cc.toLowerCase() === s || c.cc2.toLowerCase() === s))
      .sort((a, b) => rank(a.name) - rank(b.name) || (counts.get(b.cc) ?? 0) - (counts.get(a.cc) ?? 0))
      .slice(0, 4)
      .map((c) => ({ key: `c:${c.cc}`, title: c.name, sub: `${counts.get(c.cc)} kart tracks`, tag: c.cc, cc: c.cc }));
    const venueHits =
      q.length < 2
        ? []
        : this.venues()
            .filter((v) => v.name && has(v.name))
            .sort((a, b) => rank(a.name) - rank(b.name))
            .slice(0, 6)
            .map((v) => ({ key: `v:${v.i}`, title: v.name, sub: this.countryName(v.cc) || 'Kart track', tag: circuitCode(v.name), cc: v.cc }));
    const place = [{ key: 'place', title: `Tracks near “${q}”`, sub: 'Any city or region', tag: '↵' }];
    this.hits = [...trackHits, ...countryHits, ...venueHits, ...place];
    this.hitSel = 0;
    this.el.head.hidden = true;
    this.el.sub.innerHTML = `<p class="tw-near">${V.ICON.search}<span>RESULTS FOR <b>“${V.esc(q.toUpperCase())}”</b></span></p>`;
    this.el.sub.hidden = false;
    this.el.tower.innerHTML = V.searchResults(
      [
        { label: 'CIRCUITS', hits: trackHits },
        { label: 'COUNTRIES', hits: countryHits },
        { label: 'VENUES', hits: venueHits },
        { label: 'PLACES', hits: place },
      ],
      this.hitSel,
    );
    this.el.tower.scrollTop = 0;
  }

  private pickHit(key: string) {
    const input = this.el.search as HTMLInputElement;
    const q = input.value.trim();
    input.blur();
    if (key === 'place') return this.findPlace(q);
    this.clearSearch();
    if (key.startsWith('t:')) {
      this.renderTower();
      this.open(key.slice(2));
    } else if (key.startsWith('c:')) this.pickCountry(key.slice(2));
    else if (key.startsWith('v:')) {
      this.renderTower();
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
      this.clearSearch();
      this.near = { at: [Number(hit.lat), Number(hit.lon)], label: hit.display_name.split(',')[0] };
      this.tab = 'near';
      this.renderTabs();
      this.renderTower();
      if (this.routed) location.hash = '';
    } catch {
      this.toast('Search is unavailable right now', 'warn');
    }
  }

  // ------------------------------------------------------------------ Box box, the daily circuit

  private nowPick(): { t: TrackData; dir: Dir; why: string } | null {
    try {
      const last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null') as { id: string; dir: Dir } | null;
      const t = last && this.tracks.get(this.aliases.get(last.id) ?? last.id);
      if (t) return { t, dir: last!.dir === 'rev' ? 'rev' : 'fwd', why: 'LAST RACED' };
    } catch {
      /* fall through */
    }
    const busiest = [...this.tracks.values()].sort((a, b) => this.liveOf(b.id) - this.liveOf(a.id))[0];
    if (busiest && this.liveOf(busiest.id)) return { t: busiest, dir: 'fwd', why: `${this.liveOf(busiest.id)} ON TRACK` };
    const daily = this.tracks.get(this.dailyId() ?? '');
    if (daily) return { t: daily, dir: 'fwd', why: 'DAILY CIRCUIT' };
    const first = [...this.tracks.values()][0];
    return first ? { t: first, dir: 'fwd', why: 'START HERE' } : null;
  }

  private renderBox() {
    const p = this.nowPick();
    const night = p && timePref() === 'live' && isNightAt(p.t.center);
    this.el.box.innerHTML = V.boxBar(p ? { code: circuitCode(p.t.name), name: p.t.name, why: `${p.why}${night ? ' · NIGHT RACE' : ''}` } : null);
  }

  /** Today's circuit, worked out here (the same way the server does) so it shows even offline. */
  private dailyId() {
    return dailyTrack(dayOf(), [...this.tracks.values()].filter((t) => t.preset).map((t) => t.id));
  }

  private isDaily(t: TrackData, dir: Dir) {
    return dir === 'fwd' && t.id === this.dailyId();
  }

  private renderDaily() {
    const t = this.tracks.get(this.dailyId() ?? '');
    this.el.daily.innerHTML = V.dailyBar(t ? { t, msLeft: msLeftToday(), streak: dailyStreak(), board: this.daily?.track === t.id ? this.daily : null, me: this.o.driver.pid } : null);
    this.el.dailyClock = this.el.daily.querySelector('[data-el=dailyClock]') as HTMLElement;
    if (this.selected && this.isDaily(this.selected, this.dir) && !this.closeEditor) this.renderPit();
  }

  private tickClock() {
    if (this.o.root.hidden) return;
    if (this.el.dailyClock?.isConnected) this.el.dailyClock.textContent = V.clock(msLeftToday());
  }

  // ------------------------------------------------------------------ racing

  private race(t: TrackData, dir: Dir, rival?: string) {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ id: t.id, dir }));
    } catch {
      /* private mode */
    }
    this.o.onRace(t, dir, this.isDaily(t, dir), rival);
  }

  /** START: the five red lights come on and go out, then you're on the grid. */
  private start(rival?: string) {
    const t = this.selected;
    if (!t || this.starting) return;
    const lights = [...this.el.pit.querySelectorAll<HTMLElement>('.pit-lights i')];
    if (!lights.length || reduceMotion()) return this.race(t, this.dir, rival);
    this.starting = true;
    this.el.pit.classList.add('lights');
    lights.forEach((l, k) => setTimeout(() => l.classList.add('on'), k * 90));
    setTimeout(() => {
      lights.forEach((l) => l.classList.remove('on'));
      this.el.pit.classList.remove('lights');
      this.starting = false;
      if (this.selected === t) this.race(t, this.dir, rival);
    }, lights.length * 90 + 160);
  }

  // ------------------------------------------------------------------ events

  private bind() {
    const root = this.o.root;
    const search = this.el.search as HTMLInputElement;
    search.addEventListener('input', () => this.renderSearch());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.hitSel = (this.hitSel + (e.key === 'ArrowDown' ? 1 : -1) + this.hits.length) % Math.max(1, this.hits.length);
        this.el.tower.querySelectorAll('.sr').forEach((b, i) => b.classList.toggle('sel', i === this.hitSel));
      } else if (e.key === 'Escape') {
        this.clearSearch();
        this.renderTower();
        search.blur();
        root.classList.remove('search-open');
      }
    });
    (this.el.searchForm as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      const h = this.hits[this.hitSel];
      if (h) this.pickHit(h.key);
    });

    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'search-open') {
        root.classList.add('search-open');
        search.focus();
        return;
      }
      if (act === 'search-clear') {
        this.clearSearch();
        this.renderTower();
        root.classList.remove('search-open');
        return;
      }
      if (act === 'box') return this.boxRace();
      if (act === 'daily') {
        const id = this.dailyId();
        if (id) location.hash = `#/t/${id}/fwd`;
        return;
      }
      if (act === 'locate') return this.locate();
      if (act === 'countries') return this.el.ccPop.hidden ? this.openCountries() : this.closeCountries();
      if (act === 'live-close') return this.toggleLive(false);
      const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab as V.Tab | undefined;
      if (tab) return this.setTab(tab);
      const cc = t.closest<HTMLElement>('[data-cc]')?.dataset.cc;
      if (cc) return this.pickCountry(cc === 'ALL' ? null : cc);
      const hit = t.closest<HTMLElement>('[data-hit]')?.dataset.hit;
      if (hit) return this.pickHit(hit);
      const row = t.closest<HTMLElement>('.tw-row[data-key]');
      if (row) return this.openKey(row.dataset.key!);
      const feed = t.closest<HTMLElement>('[data-feed]');
      if (feed) {
        this.toggleLive(false);
        location.hash = `#/t/${feed.dataset.feed}/${feed.dataset.dir}`;
        return;
      }
      if (t.closest('[data-el=livePill]')) return this.toggleLive();
    });
    document.addEventListener('click', (e) => {
      const t = e.target as Node;
      if (!this.el.ccPop.contains(t) && !(t as HTMLElement).closest?.('[data-act=countries]')) this.closeCountries();
      if (!this.el.liveSheet.contains(t) && !this.el.livePill.contains(t)) this.toggleLive(false);
    });
    this.el.ccPop.addEventListener('input', () => this.renderCountries());

    this.el.tower.addEventListener('scroll', () => {
      const l = this.el.tower;
      if (!this.searching() && l.scrollTop + l.clientHeight > l.scrollHeight - 400) this.more();
    });

    this.el.pit.addEventListener('click', (e) => this.pitClick(e));

    addEventListener('keydown', (e) => {
      if (root.hidden || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || this.closeEditor) return;
      if (document.querySelector('.cl-page, .mp-lobby:not([hidden]), .profile-pop:not([hidden])')) return;
      const typing = isTyping(e);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        root.classList.add('search-open');
        search.focus();
        search.select();
      } else if (e.key === 'Escape' && !typing) {
        if (!this.el.ccPop.hidden) this.closeCountries();
        else if (!this.el.liveSheet.hidden) this.toggleLive(false);
        else if (this.routed) location.hash = this.tabHash();
      } else if (e.key === 'Enter' && !typing && !(e.target as HTMLElement)?.closest?.('button, a')) {
        e.preventDefault();
        if (this.cursor && this.cursor !== (this.selected ? `t:${this.selected.id}` : null)) this.openKey(this.cursor);
        else if (this.selected && (this.routed || !small())) this.start(this.rival?.pid);
        else this.boxRace();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing) {
        e.preventDefault();
        this.moveCursor(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
    addEventListener('hashchange', () => this.route());
  }

  private pitClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'back') {
      location.hash = this.tabHash();
      return;
    }
    if (act === 'race') return this.start(this.rival?.pid);
    if (act === 'challenge') return void this.shareChallenge();
    if (act === 'friends') {
      location.hash = '#/room';
      return;
    }
    if (act === 'edit') return this.editLayout();
    const ghost = t.closest<HTMLElement>('[data-rival]');
    if (ghost) return this.start(ghost.dataset.rival);
    const sib = t.closest<HTMLElement>('.sib[data-track]');
    if (sib && sib.dataset.track !== this.selected?.id) return this.open(sib.dataset.track!);
    const d = t.closest<HTMLElement>('[data-dir]')?.dataset.dir as Dir | undefined;
    if (d && this.selected && d !== this.dir) {
      if (this.routed) location.hash = `#/t/${this.selected.id}/${d}`;
      else {
        this.dir = d;
        this.board = null;
        this.renderPit();
        this.pollBoard();
      }
      return;
    }
    const time = t.closest<HTMLElement>('[data-time]')?.dataset.time as TimePref | undefined;
    if (time) {
      saveTimePref(time);
      this.renderPit();
      this.renderBox();
      return;
    }
    const ctl = t.closest<HTMLElement>('[data-controls]')?.dataset.controls as ControlScheme | undefined;
    if (ctl) {
      saveControlsPref(ctl);
      this.renderPit();
    }
  }

  private boxRace() {
    const p = this.nowPick();
    if (p) this.race(p.t, p.dir);
  }

  /** Open a tower row: a known circuit's pit board, or load a venue's layouts first. */
  private openKey(key: string) {
    this.cursor = null;
    if (key.startsWith('t:')) return this.open(key.slice(2));
    const v = this.world?.venues[Number(key.slice(2))];
    if (v) this.openVenue(v);
  }

  /** ↑/↓ through the tower. On desktop a known circuit goes up on the wall straight away. */
  private moveCursor(step: number) {
    if (!this.rows.length) return;
    const cur = this.cursor ?? (this.selected ? `t:${this.selected.id}` : null);
    let i = this.rows.findIndex((r) => r.key === cur);
    i = Math.max(0, Math.min(this.rows.length - 1, i + step));
    if (i >= this.shown) this.more(i - this.shown + BATCH);
    const key = this.rows[i].key;
    this.cursor = key;
    for (const r of this.el.tower.querySelectorAll<HTMLElement>('[data-key]')) r.classList.toggle('sel', r.dataset.key === key);
    this.el.tower.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
    if (!small() && key.startsWith('t:') && this.tracks.has(key.slice(2))) {
      this.cursor = null;
      this.select(key.slice(2), true);
    }
  }

  private toggleLive(open?: boolean) {
    const s = this.el.liveSheet;
    const show = open ?? s.hidden;
    if (show === !s.hidden) return;
    s.hidden = !show;
    this.el.livePill.setAttribute('aria-expanded', String(show));
  }

  // ------------------------------------------------------------------ routing and the pit board

  private route() {
    const h = location.hash;
    const m = /^#\/t\/([^/]+)\/?(fwd|rev)?(?:\/vs\/([0-9a-f]{12}))?/.exec(h);
    if (m) {
      this.dir = (m[2] as Dir) || 'fwd';
      const id = decodeURIComponent(m[1]);
      this.setRival(m[3] ?? null, id);
      const alias = this.aliases.get(id);
      if (alias) {
        history.replaceState(null, '', `#/t/${alias}/${this.dir}`);
        this.select(alias);
      } else this.select(id);
      return;
    }
    this.routed = false;
    this.o.root.classList.remove('pit-open');
    const c = /^#\/c\/([A-Za-z]{3})$/.exec(h);
    if (c) {
      this.worldCC = c[1].toUpperCase();
      this.tab = 'world';
      this.tabTouched = true;
      this.renderTabs();
      this.renderTower();
    }
    this.rival = null;
    // On desktop the wall always shows a circuit: the one you'd race with Box box.
    if (!small()) {
      const p = this.nowPick();
      if (p && (!this.selected || this.selected.id !== p.t.id)) {
        this.dir = p.dir;
        this.select(p.t.id, true);
      } else if (this.selected) this.renderPit();
    } else {
      this.selected = null;
      this.board = null;
      this.el.pit.innerHTML = '';
      this.markSelected();
    }
  }

  private open(id: string) {
    const hash = `#/t/${id}/${this.selected?.id === id ? this.dir : 'fwd'}`;
    if (location.hash === hash) this.select(id);
    else location.hash = hash;
  }

  /** Put a circuit on the pit board. `quiet`: the desktop wall's own pick, not an address. */
  private async select(id: string, quiet = false) {
    let t = this.tracks.get(id);
    if (!t) {
      const route = location.hash;
      this.toast('Loading track…', 'busy');
      try {
        const fetched = (await api.track(id).catch(() => null)) ?? (await trackFromId(id));
        if (!fetched) throw new Error('not found');
        const r = this.remote.get(id);
        if (r?.name) fetched.name = r.name;
        this.addTrack(fetched);
        this.persist();
        t = fetched;
        this.toast('');
        if (location.hash !== route) return; // you went elsewhere while it loaded
        this.renderTower(true);
      } catch {
        this.toast("Couldn't load that track. OpenStreetMap may be busy.", 'warn');
        return;
      }
    }
    const changed = this.selected?.id !== t.id;
    this.selected = t;
    this.routed = !quiet;
    this.o.root.classList.toggle('pit-open', this.routed);
    if (changed) this.board = null;
    this.renderPit();
    this.markSelected();
    if (changed) this.el.pit.scrollTop = 0;
    this.pollBoard();
  }

  private markSelected() {
    const key = this.selected ? `t:${this.selected.id}` : null;
    for (const r of this.el.tower.querySelectorAll<HTMLElement>('[data-key]')) r.classList.toggle('sel', r.dataset.key === key);
  }

  private renderPit() {
    const t = this.selected;
    if (!t) return;
    const record = this.feed?.records[`${t.id}|${this.dir}`]?.ms;
    const siblings = [...this.tracks.values()].filter((x) => x.id !== t.id && distM(x.center, t.center) < 800);
    const mine = this.board?.entries.find((e) => e.pid === this.o.driver.pid);
    this.el.pit.innerHTML = V.pit({
      t,
      shape: shapeOf(t),
      code: circuitCode(t.name),
      dir: this.dir,
      pb: localPB(t.id, this.dir),
      rank: mine?.rank ?? null,
      live: this.liveOf(t.id),
      siblings,
      shapeOf,
      countryName: t.country ? this.countryName(t.country) : undefined,
      nightNow: isNightAt(t.center),
      medals: { targets: targets(record, t.lengthM), earned: earnedMedal(t.id, this.dir) },
      daily: this.isDaily(t, this.dir) ? V.dailyBoard(this.daily?.track === t.id ? this.daily : null, this.o.driver.pid, msLeftToday()) : undefined,
      challenge: this.rival && this.rival.pid !== this.o.driver.pid ? { name: this.rival.name, ms: this.rival.ms } : undefined,
      time: timePref(),
      controls: controlsPref(),
      lapS: (record ?? t.lengthM * 80) / 1000,
    });
    this.el.pit.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.pitRecord = record;
    if (this.board) this.renderBoard();
  }
  private pitRecord: number | undefined;

  private renderBoard() {
    if (!this.el.dBoard?.isConnected || !this.board) return;
    const b = V.classification(this.board, this.o.driver.pid);
    this.el.dCount.textContent = b.count;
    this.el.dLive.innerHTML = b.live;
    this.el.dBoard.innerHTML = b.list;
    const mine = this.board.entries.find((e) => e.pid === this.o.driver.pid);
    if (this.el.pitRank?.isConnected) this.el.pitRank.textContent = `P${mine?.rank ?? '–'}`;
  }

  /** A challenge link (#/t/ID/DIR/vs/PID): look up whose lap it is. */
  private setRival(pid: string | null, track: string) {
    if (!pid) return void (this.rival = null);
    if (this.rival?.pid === pid) return;
    this.rival = { pid };
    api
      .ghost(track, this.dir, pid)
      .then((r) => {
        if (this.rival?.pid !== pid) return;
        this.rival = { pid, name: r.name, ms: r.ms };
        if (this.selected) this.renderPit();
      })
      .catch(() => undefined);
  }

  /** Copy (or share) a link that opens this circuit with your best lap as a ghost to beat. */
  private async shareChallenge() {
    const t = this.selected;
    if (!t) return;
    const url = `${location.origin}${location.pathname}#/t/${t.id}/${this.dir}/vs/${this.o.driver.pid}`;
    const mine = this.board?.entries.find((e) => e.pid === this.o.driver.pid);
    const text = `Beat my ${mine ? V.formatMs(mine.ms) : 'lap'} at ${t.name} on ApexKart`;
    try {
      if (small() && 'share' in navigator) await navigator.share({ title: 'ApexKart challenge', text, url });
      else {
        await navigator.clipboard.writeText(url);
        this.toast('Challenge link copied. Send it to a friend.');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.toast(`Copy this link: ${url}`, 'warn');
    }
  }

  private editLayout() {
    const t = this.selected;
    if (!t || this.closeEditor) return;
    this.closeEditor = openLayoutEditor({
      track: t,
      driver: this.o.driver,
      onSaved: (lay, base) => {
        this.closeEditor = null;
        this.applyLayouts({ [base]: lay });
        this.persist();
        this.toast('Layout saved. It now has its own leaderboard.');
        location.hash = `#/t/${lay.id}/fwd`;
        this.renderTower(true);
      },
      onClose: () => (this.closeEditor = null),
    });
  }

  // ------------------------------------------------------------------ live timing

  private renderFeed() {
    const f = this.feed!;
    const live = Object.values(f.live).reduce((a, n) => a + n, 0);
    this.el.liveCount.textContent = String(live);
    this.el.livePill.classList.toggle('idle', !live);
    // Circuits others are racing that this browser hasn't loaded go on the tower too.
    for (const l of f.laps) if (!this.tracks.has(l.track) && !this.remote.has(l.track)) this.remote.set(l.track, { id: l.track, name: l.trackName, center: l.center });
    for (const x of f.onTrack ?? []) if (!this.tracks.has(x.track) && !this.remote.has(x.track)) this.remote.set(x.track, { id: x.track, name: x.trackName ?? 'Kart track', center: x.center ?? undefined });
    for (const t of this.tracks.values())
      for (const dir of ['fwd', 'rev'] as Dir[]) {
        // Your own new best goes green on the tower.
        const pb = localPB(t.id, dir);
        const k = `${t.id}|${dir}`;
        const seen = this.pbSeen.get(k);
        if (pb && seen !== undefined && pb < seen) this.flashes.set(t.id, { kind: 'g', until: Date.now() + FLASH_MS });
        if (pb) this.pbSeen.set(k, pb);
      }
    const rows: V.LiveRow[] = (f.onTrack ?? []).map((o) => ({
      track: o.track,
      dir: o.dir,
      name: o.name,
      color: o.color,
      where: this.tracks.get(o.track)?.name ?? o.trackName ?? f.laps.find((l) => l.track === o.track)?.trackName ?? 'A kart track',
    }));
    this.el.liveBody.innerHTML = V.liveSheet(rows, f.laps);
    const items = f.laps.slice(0, 10).map((l) => V.rcLine(l));
    this.el.rcm.innerHTML = items.length ? items.join('') + items.join('') : '<span class="rc-item">ALL QUIET · SET THE FIRST LAP OF THE DAY</span>';
    this.el.rcm.classList.toggle('run', items.length > 0);
    if (!this.searching()) this.renderTower(true);
    this.renderBox();
    if (this.selected && !this.closeEditor) {
      // A new record moves the medal targets; the live count changes the dots.
      const t = this.selected;
      if (f.records[`${t.id}|${this.dir}`]?.ms !== this.pitRecord) this.renderPit();
      else if (this.el.pitLive?.isConnected) {
        const n = this.liveOf(t.id);
        this.el.pitLive.textContent = `${n} ON TRACK`;
        this.el.pitLive.classList.toggle('z', !n);
      }
    }
  }

  private toast(msg: string, kind: '' | 'warn' | 'busy' = '') {
    clearTimeout(this.toastTimer);
    this.el.toast.textContent = msg;
    this.el.toast.className = `pw-toast ${kind}${msg ? ' show' : ''}`;
    if (msg && kind !== 'busy') this.toastTimer = window.setTimeout(() => this.el.toast.classList.remove('show'), 4200);
  }

  show() {
    this.o.root.hidden = false;
    if (this.selected) {
      this.renderPit();
      this.pollBoard();
    }
    this.renderTower(true);
    this.renderBox();
    this.renderDaily();
    this.pollFeed();
    this.pollDaily();
  }

  hide() {
    this.o.root.hidden = true;
    this.profile.close();
    this.closeCountries();
    this.toggleLive(false);
  }
}

const ATLAS_HTML = /* html */ `
<header class="pw-top">
  <a class="pw-logo" href="#" aria-label="ApexKart home"><span class="chq"></span><span>APEX<b>KART</b></span></a>
  <button class="pw-livep idle" data-el="livePill" aria-haspopup="dialog" aria-expanded="false" title="Drivers on track right now"><i></i><span class="lp-k">LIVE</span><b class="mono" data-el="liveCount">0</b><span class="lp-on">ON TRACK</span></button>
  <form class="pw-search" data-el="searchForm" role="search">
    ${V.ICON.search}
    <input data-el="search" type="search" placeholder="Search circuits, countries, cities" autocomplete="off" spellcheck="false" aria-label="Search circuits, countries or cities" />
    <kbd class="ps-kbd">/</kbd>
    <button type="button" class="ps-x" data-act="search-clear" aria-label="Close search">${V.ICON.close}</button>
  </form>
  <button class="pw-icon ps-open" data-act="search-open" aria-label="Search">${V.ICON.search}</button>
  <div class="top-right"><button class="profile-btn" data-el="profileBtn" aria-haspopup="dialog"></button></div>
</header>
<section class="pw-towercol" aria-label="Timing tower">
  <div class="tw-daily" data-el="daily"></div>
  <nav class="pw-tabs tw-tabs" data-el="tabs" role="tablist" aria-label="Show">
    <button data-tab="live" role="tab">LIVE</button>
    <button data-tab="near" role="tab">NEAR ME</button>
    <button data-tab="world" role="tab">WORLD <span class="mono" data-el="worldN"></span></button>
  </nav>
  <div class="tw-sub" data-el="sub" hidden></div>
  <div class="tw-head" data-el="head"></div>
  <div class="tw-list" data-el="tower"></div>
  <div class="tw-box" data-el="box"></div>
</section>
<section class="pw-pit" data-el="pit" aria-label="Circuit"></section>
<aside class="pw-live" data-el="liveSheet" aria-label="Live timing" hidden>
  <header><span><i class="live-dot"></i> LIVE TIMING</span><button data-act="live-close" aria-label="Close live timing">${V.ICON.close}</button></header>
  <div class="pw-live-body" data-el="liveBody"><p class="pit-empty">Connecting…</p></div>
</aside>
<footer class="pw-rc" aria-label="Race control"><span class="pw-rck">RACE CONTROL</span><div class="pw-rcm-wrap"><div class="pw-rcm" data-el="rcm"></div></div></footer>
<div class="cc-pop" data-el="ccPop" role="dialog" aria-label="Countries" hidden>
  <input type="search" placeholder="Filter countries" aria-label="Filter countries" autocomplete="off" spellcheck="false" />
  <div class="cc-list" data-el="ccList"></div>
</div>
<div class="pw-toast" data-el="toast" role="status"></div>`;
