// Full-screen layout editor: fix a circuit's centreline over satellite imagery.
// The home screen has no map any more, so the editor brings its own (Leaflet, loaded only here).
// Contract used by the home screen (src/ui/atlas.ts); see docs/pit-wall.md.
import '../styles/editor.css';
import { api, escapeHtml, type CommunityLayout, type Driver } from '../net/api';
import { loopLength, type LatLon, type TrackData } from '../track/osm';
import { circuitCode, stripeStyle } from './pitwall';

export interface EditorOptions {
  track: TrackData; // the layout being fixed (points, center, width, name; corrected?.osmPoints is the original trace)
  driver: Driver; // who's saving
  /** Saved: the new layout, and the base id it replaces (track.corrected?.baseId ?? track.id). */
  onSaved: (layout: CommunityLayout, base: string) => void;
  /** Closed without saving. */
  onClose: () => void;
}

const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const km = (m: number) => `${(m / 1000).toFixed(2)}<small>KM</small>`;

/** Open the editor over everything. Returns a function that closes it. */
export function openLayoutEditor(o: EditorOptions): () => void {
  const t = o.track;
  const original = t.corrected?.osmPoints ?? t.points;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const tap = coarse ? 'Tap' : 'Click';

  const root = document.createElement('div');
  root.className = 'ed-screen';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', `Layout editor · ${t.name}`);
  root.innerHTML = /* html */ `
    <div class="ed-map" data-el="map"></div>
    <aside class="ed-panel">
      <header class="ed-top">
        <span class="label">Layout editor</span>
        <span class="ed-src label">OSM <b class="mono">${km(loopLength(original))}</b></span>
      </header>
      <div class="ed-trow">
        <span class="pw-stripe big" style="${stripeStyle(t.country)}"></span>
        <div class="ed-tname">
          <b class="display"><span class="pw-code">${escapeHtml(circuitCode(t.name))}</span> ${escapeHtml(t.name)}</b>
          <span class="ed-lede">Put the yellow line on the middle of the asphalt, in race direction. It replaces the trace for everyone and starts a fresh leaderboard.</span>
        </div>
      </div>
      <ol class="ed-steps">
        <li><b class="mono">01</b><span>Drag the points onto the centre of the track.</span></li>
        <li><b class="mono">02</b><span>${tap} a small dot to add a point. ${coarse ? 'Long-press' : 'Right-click'} a point to delete it.</span></li>
        <li><b class="mono">03</b><span>Way off? <b>Start over</b>, ${tap.toLowerCase()} your way round, then ${tap.toLowerCase()} the first point to close the loop.</span></li>
      </ol>
      <dl class="ed-stats">
        <div><dt class="label">Length</dt><dd class="mono" data-el="len">–</dd></div>
        <div><dt class="label">Points</dt><dd class="mono" data-el="pts">–</dd></div>
        <div><dt class="label">Loop</dt><dd class="ui" data-el="loop">–</dd></div>
      </dl>
      <div class="ed-tools">
        <button class="btn" data-act="restart">Start over</button>
        <button class="btn" data-act="reverse">Reverse</button>
        <button class="btn" data-act="reset">Reset to OSM</button>
      </div>
      <p class="ed-status ui" data-el="status" role="status" aria-live="polite">Loading satellite map…</p>
      <div class="ed-acts">
        <button class="btn" data-act="cancel">Cancel${coarse ? '' : ' <kbd>Esc</kbd>'}</button>
        <button class="btn primary lg" data-act="save" aria-disabled="true">Save layout <span class="arrow">→</span></button>
      </div>
    </aside>`;
  const $: Record<string, HTMLElement> = {};
  root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => ($[e.dataset.el!] = e));
  const saveBtn = root.querySelector<HTMLButtonElement>('[data-act="save"]')!;
  document.body.appendChild(root);

  let closed = false;
  let saving = false;
  let cleanup = () => {};
  let editor: import('./layoutEditor').LayoutEditor | null = null;

  const status = (msg: string, kind: '' | 'warn' | 'err' = '') => {
    $.status.textContent = msg;
    $.status.className = `ed-status ui ${kind}`;
  };
  const setStats = (points: number, lengthM: number, drawing: boolean) => {
    $.len.innerHTML = lengthM ? km(lengthM) : '–';
    $.pts.textContent = String(points);
    const ok = !drawing && points >= 6;
    $.loop.textContent = ok ? 'Closed' : 'Open';
    $.loop.className = `ui ${ok ? 'ok' : 'open'}`;
    saveBtn.setAttribute('aria-disabled', String(!ok));
  };

  const close = () => {
    if (closed) return;
    closed = true;
    removeEventListener('keydown', onKey, true);
    cleanup();
    root.remove();
  };
  const cancel = () => {
    if (saving) return;
    close();
    o.onClose();
  };
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // The editor is on top: Esc is ours, not the home screen's.
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  }
  addEventListener('keydown', onKey, true);

  const save = async () => {
    if (!editor || saving) return;
    if (!editor.valid) return status(`Close the loop first: ${tap.toLowerCase()} the first point.`, 'warn');
    saving = true;
    root.classList.add('saving');
    status('Saving…');
    try {
      const base = t.corrected?.baseId ?? t.id;
      const points = editor.points;
      const res = await api.saveLayout({ base, points, center: t.center, trackName: t.name, width: t.width, name: o.driver.name, driverId: o.driver.id });
      if (closed) return;
      const layout: CommunityLayout = { id: res.id, points, lengthM: res.lengthM, by: o.driver.name, pid: o.driver.pid, at: Date.now() };
      saving = false;
      close();
      o.onSaved(layout, base);
    } catch (e) {
      saving = false;
      root.classList.remove('saving');
      status(`Couldn’t save: ${(e as Error).message}`, 'err');
    }
  };

  root.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') return cancel();
    if (act === 'save') return void save();
    if (!editor || saving) return;
    if (act === 'restart') editor.startOver();
    if (act === 'reverse') editor.reverse();
    if (act === 'reset') editor.reset(original);
  });

  // Leaflet (and the editor built on it) stays out of the home screen's bundle.
  Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css'), import('./layoutEditor')])
    .then(([{ default: L }, , { LayoutEditor }]) => {
      if (closed) return;
      const map = L.map($.map, { zoomControl: false, attributionControl: false, maxZoom: 20, zoomSnap: 0.25, keyboard: false });
      L.control.zoom({ position: 'topleft' }).addTo(map);
      L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map);
      L.tileLayer(SAT, { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxZoom: 20, maxNativeZoom: 19 }).addTo(map);
      map.fitBounds(L.latLngBounds(t.points.map((p: LatLon) => L.latLng(p[0], p[1]))), { padding: [28, 28], maxZoom: 19 });
      // The bottom sheet grows and shrinks with its status line: keep the map's idea of its size right.
      const ro = new ResizeObserver(() => map.invalidateSize());
      ro.observe($.map);
      editor = new LayoutEditor(map, t.points, {
        onChange: (i) => {
          setStats(i.points, i.lengthM, i.drawing);
          status(i.drawing ? (i.points < 4 ? `${tap} along the track in race direction…` : `${tap} the first point to close the loop.`) : '');
        },
      });
      setStats(editor.points.length, loopLength(editor.points), false);
      status('');
      cleanup = () => {
        ro.disconnect();
        editor?.destroy();
        editor = null;
        map.remove();
      };
    })
    .catch((e) => {
      if (!closed) status(`Couldn’t load the map: ${(e as Error).message}`, 'err');
    });

  root.tabIndex = -1;
  root.focus({ preventScroll: true });
  return close;
}
