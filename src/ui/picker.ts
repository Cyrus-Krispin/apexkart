import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { discoverTracks, trackFromId, type TrackData } from '../track/osm';
import { api, escapeHtml, formatMs, saveDriver, timeAgo, type Dir, type Driver, type FeedResponse } from '../net/api';
import { localPB } from '../game/race';

const COLORS = ['#ff5a1f', '#ffd60a', '#2ee66b', '#22d3ee', '#3b82f6', '#a855f7', '#f43f5e', '#f5f5f5'];
const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const DARK = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const DARK_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';

export interface PickerOptions {
  root: HTMLElement;
  driver: Driver;
  onRace: (track: TrackData, dir: Dir) => void;
}

export class Picker {
  private map!: L.Map;
  private tracks = new Map<string, TrackData>();
  private markers = new Map<string, L.Marker>();
  private outlines = L.layerGroup();
  private selected: TrackData | null = null;
  private dir: Dir = 'fwd';
  private feed: FeedResponse | null = null;
  private timers: number[] = [];
  private el: Record<string, HTMLElement> = {};
  private sat!: L.TileLayer;
  private dark!: L.Layer;
  private searching: AbortController | null = null;

  constructor(private o: PickerOptions) {
    o.root.innerHTML = PICKER_HTML;
    o.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.initMap();
    this.initDriver();
    this.bind();
    this.load();
  }

  // ---------- setup

  private initMap() {
    this.map = L.map(this.el.map, { zoomControl: false, worldCopyJump: true, attributionControl: true }).setView([20, 40], 2);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.dark = L.layerGroup([
      L.tileLayer(DARK, { attribution: 'Basemap © Esri · Tracks © OpenStreetMap contributors', maxZoom: 16 }),
      L.tileLayer(DARK_LABELS, { maxZoom: 16 }),
    ]);
    this.sat = L.tileLayer(SAT, { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxZoom: 19, maxNativeZoom: 19 });
    this.dark.addTo(this.map);
    this.outlines.addTo(this.map);
    this.map.on('zoomend moveend', () => this.updateLayers());
  }

  private updateLayers() {
    const z = this.map.getZoom();
    const wantSat = z >= 13;
    if (wantSat && !this.map.hasLayer(this.sat)) {
      this.map.addLayer(this.sat);
      this.map.removeLayer(this.dark);
    } else if (!wantSat && !this.map.hasLayer(this.dark)) {
      this.map.addLayer(this.dark);
      this.map.removeLayer(this.sat);
    }
    this.o.root.classList.toggle('zoomed', z >= 15); // outlines replace pins up close
    (this.el.explore as HTMLButtonElement).disabled = z < 10;
    this.el.explore.title = z < 10 ? 'Zoom in closer to search for tracks' : '';
    this.drawOutlines();
  }

  private drawOutlines() {
    this.outlines.clearLayers();
    if (this.map.getZoom() < 12) return;
    const bounds = this.map.getBounds().pad(0.3);
    for (const t of this.tracks.values()) {
      if (!bounds.contains(t.center)) continue;
      const sel = this.selected?.id === t.id;
      const pts = t.points.map((p) => L.latLng(p[0], p[1]));
      L.polyline([...pts, pts[0]], { color: '#000', weight: sel ? 9 : 6, opacity: 0.5 }).addTo(this.outlines);
      L.polyline([...pts, pts[0]], { color: sel ? '#ffd60a' : '#ff5a1f', weight: sel ? 5 : 3, opacity: 0.95 })
        .on('click', () => this.select(t.id))
        .addTo(this.outlines);
    }
  }

  private initDriver() {
    const name = this.el.name as HTMLInputElement;
    name.value = this.o.driver.name;
    name.addEventListener('input', () => {
      this.o.driver.name = name.value.replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, 16) || 'Driver';
      saveDriver(this.o.driver);
    });
    this.el.colors.innerHTML = COLORS.map((c) => `<button class="swatch" data-color="${c}" style="--c:${c}" aria-label="Kart colour ${c}"></button>`).join('');
    const mark = () =>
      this.el.colors.querySelectorAll<HTMLElement>('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.color === this.o.driver.color));
    this.el.colors.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).dataset.color;
      if (!c) return;
      this.o.driver.color = c;
      saveDriver(this.o.driver);
      mark();
    });
    mark();
  }

  private bind() {
    this.el.explore.addEventListener('click', () => this.explore());
    this.el.back.addEventListener('click', () => {
      location.hash = '';
    });
    this.el.race.addEventListener('click', () => this.selected && this.o.onRace(this.selected, this.dir));
    this.el.dirs.addEventListener('click', (e) => {
      const d = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]')?.dataset.dir as Dir | undefined;
      if (!d || !this.selected) return;
      location.hash = `#/t/${this.selected.id}/${d}`;
    });
    (this.el.searchForm as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = (this.el.search as HTMLInputElement).value.trim();
      if (!q) return;
      this.status('Searching…');
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
        const [hit] = await res.json();
        if (!hit) return this.status(`Couldn't find “${q}”`, true);
        const bb = hit.boundingbox.map(Number);
        this.map.flyToBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 12, duration: 1.4, paddingTopLeft: [this.sidePad(), 0] });
        this.status(`Now tap “Find kart tracks here” to scan ${hit.display_name.split(',')[0]}`);
      } catch {
        this.status('Search failed', true);
      }
    });
    this.el.list.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-track]')?.dataset.track;
      if (id) location.hash = `#/t/${id}/fwd`;
    });
    this.el.feed.addEventListener('click', (e) => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('[data-track]');
      if (it) location.hash = `#/t/${it.dataset.track}/${it.dataset.dir}`;
    });
    addEventListener('hashchange', () => this.route());
  }

  private async load() {
    try {
      const presets: TrackData[] = await fetch('/tracks/presets.json').then((r) => r.json());
      presets.forEach((t) => this.addTrack({ ...t, preset: true }));
    } catch {
      /* no presets: discovery still works */
    }
    try {
      const saved: TrackData[] = JSON.parse(localStorage.getItem('ak:tracks') || '[]');
      saved.forEach((t) => this.tracks.has(t.id) || this.addTrack(t));
    } catch {
      /* ignore */
    }
    this.renderList();
    if (!this.route()) {
      const kf1 = [...this.tracks.values()].find((t) => /KF1/.test(t.name));
      const all = [...this.tracks.values()];
      if (all.length) this.map.fitBounds(L.latLngBounds(all.map((t) => t.center)).pad(0.15), { maxZoom: 4, paddingTopLeft: [this.sidePad(), 0] });
      if (kf1) this.el.hero.innerHTML = `New here? Start with <a href="#/t/${kf1.id}/fwd">${escapeHtml(kf1.name)}</a> in Singapore.`;
    }
    this.pollFeed();
    this.timers.push(window.setInterval(() => this.pollFeed(), 6000));
    this.timers.push(window.setInterval(() => this.selected && this.pollBoard(), 5000));
  }

  private addTrack(t: TrackData) {
    this.tracks.set(t.id, t);
    if (this.markers.has(t.id)) return;
    const icon = L.divIcon({ className: 'trk-pin' + (t.preset ? ' preset' : ''), html: '<span>🏁</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
    const m = L.marker(t.center, { icon, title: t.name }).on('click', () => (location.hash = `#/t/${t.id}/fwd`));
    m.bindTooltip(`<b>${escapeHtml(t.name)}</b><br>${(t.lengthM / 1000).toFixed(2)} km`, { direction: 'top', offset: [0, -12] });
    m.addTo(this.map);
    this.markers.set(t.id, m);
  }

  private persistDiscovered() {
    const list = [...this.tracks.values()].filter((t) => !t.preset).slice(-60);
    try {
      localStorage.setItem('ak:tracks', JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  // ---------- routing / selection

  private route(): boolean {
    const m = /^#\/t\/([^/]+)\/?(fwd|rev)?/.exec(location.hash);
    if (!m) {
      this.deselect();
      return false;
    }
    this.dir = (m[2] as Dir) || 'fwd';
    this.select(decodeURIComponent(m[1]));
    return true;
  }

  private async select(id: string) {
    let t = this.tracks.get(id);
    if (!t) {
      this.status('Fetching track from OpenStreetMap…');
      try {
        // Tracks people have raced are stored by the API; fall back to OpenStreetMap.
        const fetched = (await api.track(id).catch(() => null)) ?? (await trackFromId(id));
        if (!fetched) throw new Error('not found');
        const fromFeed = this.feed?.laps.find((l) => l.track === id);
        if (fromFeed) fetched.name = fromFeed.trackName;
        this.addTrack(fetched);
        this.persistDiscovered();
        t = fetched;
        this.status('');
      } catch {
        this.status('Could not load that track (OpenStreetMap may be busy). Try again in a moment.', true);
        return;
      }
    }
    if (location.hash !== `#/t/${id}/${this.dir}`) history.replaceState(null, '', `#/t/${id}/${this.dir}`);
    const same = this.selected?.id === t.id;
    this.selected = t;
    this.o.root.classList.add('has-sel');
    const bounds = L.latLngBounds(t.points.map((p) => L.latLng(p[0], p[1])));
    if (!same) this.map.flyToBounds(bounds, { paddingTopLeft: [this.sidePad(), 40], paddingBottomRight: [40, 40], duration: 1.6, maxZoom: 18 });
    this.el.dName.textContent = t.name;
    this.el.dLoc.textContent = t.location || `${t.center[0].toFixed(4)}, ${t.center[1].toFixed(4)}`;
    this.el.dStats.innerHTML = `
      <div><b>${(t.lengthM / 1000).toFixed(2)}</b><span>km</span></div>
      <div><b>${Math.max(t.width, 8.5).toFixed(1)}</b><span>m wide</span></div>
      <div><b>${this.dir === 'rev' ? 'REV' : 'FWD'}</b><span>layout</span></div>`;
    this.el.dSource.innerHTML = `Geometry from <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/way/${t.osmWays[0]}">OpenStreetMap way${t.osmWays.length > 1 ? 's' : ''} ${t.osmWays.slice(0, 3).join(', ')}${t.osmWays.length > 3 ? '…' : ''}</a>`;
    this.el.dirs.querySelectorAll<HTMLElement>('[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === this.dir));
    const pb = localPB(t.id, this.dir);
    this.el.dPb.textContent = pb ? `Your best: ${formatMs(pb)}` : 'No lap set yet';
    this.drawOutlines();
    this.el.dBoard.innerHTML = '<div class="muted">Loading leaderboard…</div>';
    this.pollBoard();
  }

  private deselect() {
    this.selected = null;
    this.o.root.classList.remove('has-sel');
    this.drawOutlines();
  }

  // ---------- data

  private async pollBoard() {
    const t = this.selected;
    if (!t) return;
    try {
      const b = await api.board(t.id, this.dir);
      if (this.selected !== t) return;
      const me = this.o.driver.pid;
      const lead = b.entries[0]?.ms;
      this.el.dBoard.innerHTML = b.entries.length
        ? `<ol class="lb">${b.entries
            .map(
              (e) => `<li class="${e.pid === me ? 'me' : ''}"><span class="pos">${e.rank}</span><span class="dot" style="background:${escapeHtml(e.color)}"></span><span class="nm">${escapeHtml(e.name)}</span><span class="tm">${formatMs(e.ms)}</span><span class="gap">${e.rank > 1 ? '+' + ((e.ms - lead) / 1000).toFixed(3) : ''}</span></li>`,
            )
            .join('')}</ol>`
        : '<div class="muted">No laps yet. Be the first on the board!</div>';
      this.el.dLive.innerHTML = b.onTrack.length
        ? `<span class="live-dot"></span> ${b.onTrack.length} racing now: ${b.onTrack.map((o) => escapeHtml(o.name)).join(', ')}`
        : '';
      this.el.dStorage.hidden = b.storage !== 'memory';
    } catch {
      this.el.dBoard.innerHTML = '<div class="muted">Leaderboard offline. You can still race; laps are saved on this device.</div>';
    }
  }

  private async pollFeed() {
    try {
      this.feed = await api.feed();
      this.renderFeed();
      this.renderList();
    } catch {
      this.el.feed.innerHTML = '<div class="muted">Live feed offline</div>';
    }
  }

  private renderFeed() {
    const f = this.feed!;
    this.el.feed.innerHTML = f.laps.length
      ? f.laps
          .slice(0, 12)
          .map(
            (l) => `<div class="feed-item" data-track="${escapeHtml(l.track)}" data-dir="${l.dir}">
              <span class="dot" style="background:${escapeHtml(l.color)}"></span>
              <div><b>${escapeHtml(l.name)}</b> ${l.rank === 1 ? '<span class="tag gold">P1</span>' : `<span class="tag">P${l.rank}</span>`} <span class="mono">${formatMs(l.ms)}</span>
              <small>${escapeHtml(l.trackName)}${l.dir === 'rev' ? ' (rev)' : ''} · ${timeAgo(l.at)}</small></div>
            </div>`,
          )
          .join('')
      : '<div class="muted">No laps yet. The feed lights up as people race.</div>';
    // Feed may mention tracks we haven't loaded (discovered by someone else): add markers.
    for (const l of f.laps) {
      if (!this.tracks.has(l.track) && l.center && !this.markers.has(l.track)) {
        const icon = L.divIcon({ className: 'trk-pin remote', html: '<span>🏁</span>', iconSize: [26, 26], iconAnchor: [13, 13] });
        const m = L.marker(l.center, { icon, title: l.trackName }).on('click', () => (location.hash = `#/t/${l.track}/${l.dir}`));
        m.bindTooltip(escapeHtml(l.trackName), { direction: 'top' });
        m.addTo(this.map);
        this.markers.set(l.track, m);
      }
    }
  }

  private renderList() {
    const rec = this.feed?.records ?? {};
    const live = this.feed?.live ?? {};
    const card = (t: TrackData) => {
      const wr = rec[`${t.id}|fwd`];
      const n = (live[`${t.id}|fwd`] ?? 0) + (live[`${t.id}|rev`] ?? 0);
      const pb = localPB(t.id, 'fwd');
      return `<button class="track-card" data-track="${escapeHtml(t.id)}">
        <div class="tc-top"><b>${escapeHtml(t.name)}</b>${n ? `<span class="live-badge"><span class="live-dot"></span>${n}</span>` : ''}</div>
        <small>${escapeHtml(t.location || 'Discovered on OSM')} · ${(t.lengthM / 1000).toFixed(2)} km</small>
        <div class="tc-times">${wr ? `<span>🏆 ${formatMs(wr.ms)} <em>${escapeHtml(wr.name)}</em></span>` : '<span class="muted">No record yet</span>'}${pb ? `<span>You ${formatMs(pb)}</span>` : ''}</div>
      </button>`;
    };
    const all = [...this.tracks.values()];
    const presets = all.filter((t) => t.preset);
    const found = all.filter((t) => !t.preset).reverse();
    this.el.list.innerHTML =
      `<h3>Featured circuits</h3>${presets.map(card).join('') || '<div class="muted">Loading…</div>'}` +
      (found.length ? `<h3>Discovered by you</h3>${found.map(card).join('')}` : '');
  }

  private async explore() {
    const b = this.map.getBounds();
    this.searching?.abort();
    this.searching = new AbortController();
    this.status('Scanning OpenStreetMap for kart tracks in view…');
    this.el.explore.classList.add('busy');
    try {
      const found = await discoverTracks([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], this.searching.signal);
      const fresh = found.filter((t) => !this.tracks.has(t.id));
      fresh.forEach((t) => this.addTrack(t));
      this.persistDiscovered();
      this.renderList();
      this.drawOutlines();
      this.status(
        found.length
          ? `Found ${found.length} track${found.length > 1 ? 's' : ''}${fresh.length < found.length ? ` (${fresh.length} new)` : ''}. Tap a 🏁 to race.`
          : 'No closed raceway loops mapped here. Try another area, or map one on OpenStreetMap!',
        !found.length,
      );
      if (fresh.length === 1) location.hash = `#/t/${fresh[0].id}/fwd`;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.status('OpenStreetMap is busy right now. Try again in a few seconds.', true);
    } finally {
      this.el.explore.classList.remove('busy');
    }
  }

  private sidePad() {
    return innerWidth > 800 ? 410 : 0;
  }

  private status(msg: string, warn = false) {
    this.el.status.textContent = msg;
    this.el.status.className = 'status' + (warn ? ' warn' : '') + (msg ? ' show' : '');
  }

  show() {
    this.o.root.hidden = false;
    setTimeout(() => this.map.invalidateSize(), 0);
    if (this.selected) this.select(this.selected.id);
    this.renderList();
  }

  hide() {
    this.o.root.hidden = true;
  }
}

const PICKER_HTML = /* html */ `
<div class="map" data-el="map"></div>
<aside class="side glass">
  <header class="brand">
    <div class="logo"><span class="chk"></span>APEX<b>KART</b></div>
    <p>Race real kart tracks, pulled live from OpenStreetMap and laid over satellite imagery.</p>
  </header>
  <section class="driver">
    <label>Driver <input data-el="name" maxlength="16" autocomplete="off" spellcheck="false" /></label>
    <div class="colors" data-el="colors"></div>
  </section>

  <section class="browse">
    <p class="hero" data-el="hero"></p>
    <form class="search" data-el="searchForm"><input data-el="search" placeholder="Fly to a city or place…" /><button>Go</button></form>
    <button class="btn explore" data-el="explore" disabled>🔍 Find kart tracks here</button>
    <div class="status" data-el="status"></div>
    <div class="list" data-el="list"></div>
  </section>

  <section class="detail">
    <button class="back" data-el="back">← All tracks</button>
    <h2 data-el="dName"></h2>
    <div class="loc" data-el="dLoc"></div>
    <div class="stats" data-el="dStats"></div>
    <div class="seg" data-el="dirs"><button data-dir="fwd">Normal</button><button data-dir="rev">Reverse</button></div>
    <button class="btn primary race-btn" data-el="race">RACE <span>▶</span></button>
    <div class="pb" data-el="dPb"></div>
    <div class="board-h"><span><span class="live-dot"></span> LIVE LEADERBOARD</span></div>
    <div class="live-now" data-el="dLive"></div>
    <div data-el="dBoard"></div>
    <div class="note" data-el="dStorage" hidden>Dev mode: leaderboard is in memory and resets on restart.</div>
    <div class="src" data-el="dSource"></div>
  </section>
</aside>
<aside class="feed glass">
  <div class="board-h"><span><span class="live-dot"></span> LIVE · LATEST LAPS</span></div>
  <div data-el="feed"><div class="muted">Connecting…</div></div>
</aside>`;
