// HTML for the atlas: the dock's Race now tile and rail cards, the track sheet, search results,
// the country list and the live panel. Pure functions of their inputs; atlas.ts wires them up.
import type { LatLon, TrackData } from '../track/osm';
import type { TrackShape } from '../track/shape';
import { trackArt, rotationLabel } from './trackArt';
import { escapeHtml as esc, formatMs, timeAgo, type BoardResponse, type Dir, type FeedItem } from '../net/api';
import type { Venue } from './world';
import { MEDALS, MEDAL_NAME, type Medal, type Targets } from '../game/medals';

export { esc };

export const SEARCH_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`;
const PLAY = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11L13.5 8z" fill="currentColor"/></svg>`;
const LOOP = `<svg viewBox="0 0 120 56" width="120" height="56" aria-hidden="true"><path d="M18 40c-8-4-9-18 2-22 9-3 18 6 30 4s16-14 30-12 24 12 20 24-18 12-30 8-26 6-36 4-10-3-16-6z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="5 5" stroke-linejoin="round"/><circle cx="18" cy="40" r="4" fill="currentColor"/></svg>`;
const SUN = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15M3 3l1.6 1.6M11.4 11.4L13 13M13 3l-1.6 1.6M4.6 11.4L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const MOON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M10.8 1.6A6.6 6.6 0 1 0 14.4 11 5.4 5.4 0 0 1 10.8 1.6z" fill="currentColor"/></svg>`;
const NEAR_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>`;

export function coords(c: LatLon) {
  const la = `${Math.abs(c[0]).toFixed(3)}°${c[0] >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(c[1]).toFixed(3)}°${c[1] >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}

const km = (m: number) => (m / 1000).toFixed(2);
const place = (t: TrackData) => (t.location ? t.location.split(',')[0] : coords(t.center));

// ------------------------------------------------------------------ dock

export function nowTile(p: { t: TrackData; shape: TrackShape; dir: Dir; why: string; pb: number | null } | null): string {
  if (!p) return `<button class="now" data-now disabled><span class="now-top"><span class="label">Race now</span></span><span class="now-name display">Loading…</span></button>`;
  const rot = rotationLabel(p.shape, p.dir === 'rev');
  return `<button class="now" data-now title="Race ${esc(p.t.name)} (Enter)">
    <span class="now-art" aria-hidden="true">${trackArt(p.shape, { w: 220, h: 150, pad: 12, reverse: p.dir === 'rev', arrows: false })}</span>
    <span class="now-top"><span class="label">Race now</span><kbd>↵</kbd></span>
    <span class="now-name display">${esc(p.t.name)}</span>
    <span class="now-why">${esc(p.why)}<span class="now-rot"> · ${rot.icon} ${rot.label.toLowerCase()}</span>${p.pb ? ` · PB <b class="mono">${formatMs(p.pb)}</b>` : ''}</span>
    <span class="now-go display">Go <span class="arrow">→</span></span>
  </button>`;
}

export interface FilterChip {
  key: string; // featured | near | view | cc:XXX
  label: string;
  n?: number;
  on: boolean;
  cc?: string;
}

export function chips(list: FilterChip[]): string {
  return list
    .map(
      (c) => `<button class="fchip${c.on ? ' on' : ''}" data-filter="${esc(c.key)}" aria-pressed="${c.on}">
        ${c.key === 'near' ? NEAR_ICON : c.cc ? `<span class="cc mono">${esc(c.cc)}</span>` : c.key === 'featured' ? '<span class="star">★</span>' : ''}
        <span class="fl">${esc(c.label)}</span>${c.n != null ? `<span class="n mono">${c.n.toLocaleString('en')}</span>` : ''}
      </button>`,
    )
    .join('');
}

export interface TrackCard {
  t: TrackData;
  shape: TrackShape;
  num?: number; // position among the featured circuits
  record?: number;
  live: number;
  pb: number | null;
  medal?: Medal | null; // best medal you've won here
}

const medalDot = (m: Medal) => `<i class="medal m-${m}" title="${MEDAL_NAME[m]} medal" aria-label="${MEDAL_NAME[m]} medal"></i>`;

export function trackCard(d: TrackCard): string {
  const { t, shape } = d;
  const tag = d.num ? String(d.num).padStart(2, '0') : t.corrected ? 'Fixed' : 'OSM';
  const badge = d.live
    ? `<span class="card-live"><i class="live-dot"></i>${d.live} live</span>`
    : t.needsFix && !t.corrected
      ? '<span class="card-warn">Trace off</span>'
      : '';
  return `<article class="card" data-card="t:${esc(t.id)}">
    <button class="card-hit" data-track="${esc(t.id)}" aria-label="${esc(t.name)}, ${km(t.lengthM)} km"></button>
    <div class="card-art graph-paper">${trackArt(shape, { w: 228, h: 64, pad: 8, arrows: false })}</div>
    <div class="card-body">
      <div class="card-top">${t.country ? `<span class="cc mono">${esc(t.country)}</span>` : ''}<span class="label">${tag}</span>${d.medal ? medalDot(d.medal) : ''}${badge}</div>
      <h3 class="display">${esc(t.name)}</h3>
      <p class="card-sub">${esc(place(t))} · ${km(t.lengthM)} km · ${shape.corners.length} turns</p>
      <div class="card-foot">
        <span class="label">Rec</span><span class="card-rec">${recordHtml(d.record)}</span>
        ${d.pb ? `<span class="card-pb mono" title="Your best">You ${formatMs(d.pb)}</span>` : ''}
        <button class="card-go" data-go="${esc(t.id)}" title="Race now" aria-label="Race ${esc(t.name)} now">${PLAY}</button>
      </div>
    </div>
  </article>`;
}

/** The record slot on a track card (refreshed in place when the live feed updates). */
export function recordHtml(ms: number | undefined): string {
  return ms ? `<b class="mono">${formatMs(ms)}</b>` : '<span class="muted">Open</span>';
}

export function venueCard(v: Venue, empty: boolean): string {
  const name = v.name || 'Unnamed kart track';
  return `<article class="card venue${empty ? ' empty' : ''}" data-card="v:${v.i}">
    <button class="card-hit" data-venue="${v.i}" aria-label="${esc(name)}: load the layout"></button>
    <div class="card-art venue-art">${LOOP}</div>
    <div class="card-body">
      <div class="card-top">${v.cc ? `<span class="cc mono">${esc(v.cc)}</span>` : ''}<span class="label">Venue</span></div>
      <h3 class="display${v.name ? '' : ' unnamed'}">${esc(name)}</h3>
      <p class="card-sub">${coords(v.at)}</p>
      <div class="card-foot"><span class="muted">${empty ? 'No racing line mapped yet' : 'Open to load the layout'}</span><span class="card-arrow mono" aria-hidden="true">→</span></div>
    </div>
  </article>`;
}

export function moreTile(n: number): string {
  return `<div class="card more"><p class="display">+${n.toLocaleString('en')}</p><p class="label">more on the map</p><p class="more-tip">Zoom in and press <b>List tracks here</b></p></div>`;
}

export function emptyRail(msg: string): string {
  return `<div class="rail-empty"><p>${msg}</p></div>`;
}

// ------------------------------------------------------------------ sheet

export interface SheetData {
  t: TrackData;
  shape: TrackShape;
  dir: Dir;
  num?: number;
  total: number;
  pb: number | null;
  siblings: TrackData[]; // other layouts at the same venue
  shapeOf: (t: TrackData) => TrackShape;
  countryName?: string;
  nightNow: boolean; // the sun is down at the circuit right now
  medals: { targets: Targets; earned: Medal | null };
}

/** The four targets, what you've won, and how far your best is from the next one. */
function medalLadder(m: SheetData['medals'], pb: number | null): string {
  const got = m.earned ? MEDALS.indexOf(m.earned) : -1;
  const next = MEDALS[got + 1];
  const note = !next
    ? 'Platinum: you’re on record pace here.'
    : pb
      ? `${MEDAL_NAME[next]} is <b class="mono">${((pb - m.targets[next]) / 1000).toFixed(3)} s</b> away.`
      : `Beat <b class="mono">${formatMs(m.targets.bronze)}</b> for bronze.`;
  return `<div class="d-medals" role="list" aria-label="Medal targets">${MEDALS.map(
    (k, i) =>
      `<div class="dm${i <= got ? ' got' : ''}${k === next ? ' next' : ''}" role="listitem">${medalDot(k)}<span class="label">${MEDAL_NAME[k]}</span><b class="mono">${formatMs(m.targets[k])}</b></div>`,
  ).join('')}</div><p class="d-medal-note">${note}</p>`;
}

export function sheet(d: SheetData): string {
  const { t, shape, dir } = d;
  const rev = dir === 'rev';
  const rot = rotationLabel(shape, rev);
  const other = rotationLabel(shape, !rev);
  const off = t.needsFix && !t.corrected;
  const canFix = !t.preset; // featured circuits are curated (the server refuses edits to them)
  return `
    <div class="d-top">
      <button class="back" data-act="back" aria-label="Close"><span class="mono">←</span> Back</button>
      <span class="label">${d.num ? `${String(d.num).padStart(2, '0')} / ${String(d.total).padStart(2, '0')} featured` : t.corrected ? 'Community layout' : 'From OpenStreetMap'}</span>
    </div>
    <h1 class="display d-name">${esc(t.name)}</h1>
    <p class="d-loc">${t.country ? `<span class="cc mono">${esc(t.country)}</span>` : ''}<span>${esc(t.location || d.countryName || coords(t.center))}</span><span class="d-now${d.nightNow ? ' night' : ''}" title="Race on Live time of day to match it">${d.nightNow ? MOON : SUN}${d.nightNow ? 'Night' : 'Day'} there now</span></p>
    <div class="d-art graph-paper">${trackArt(shape, { w: 400, h: 200, pad: 24, reverse: rev, turns: true, arrows: true, road: true })}</div>
    <dl class="d-stats">
      <div><dt class="label">Length</dt><dd class="mono">${km(t.lengthM)}<small>km</small></dd></div>
      <div><dt class="label">Turns</dt><dd class="mono">${shape.corners.length}</dd></div>
      <div><dt class="label">Width</dt><dd class="mono">${Math.max(t.width, 8.5).toFixed(1)}<small>m</small></dd></div>
    </dl>
    ${
      d.siblings.length
        ? `<div class="d-sibs"><p class="label">${d.siblings.length + 1} layouts here</p><div class="sib-row">${[t, ...d.siblings]
            .sort((a, b) => b.lengthM - a.lengthM)
            .map(
              (s) =>
                `<button class="sib${s.id === t.id ? ' on' : ''}" data-track="${esc(s.id)}" aria-pressed="${s.id === t.id}" aria-label="${esc(s.name)}, ${km(s.lengthM)} km">${trackArt(d.shapeOf(s), { w: 72, h: 44, pad: 5, arrows: false })}<span class="mono">${km(s.lengthM)}</span></button>`,
            )
            .join('')}</div></div>`
        : ''
    }
    <div class="seg" role="radiogroup" aria-label="Direction">
      <button data-dir="${dir}" class="on" role="radio" aria-checked="true"><span>${rot.icon}</span>${rot.label}</button>
      <button data-dir="${rev ? 'fwd' : 'rev'}" role="radio" aria-checked="false"><span>${other.icon}</span>${other.label}</button>
    </div>
    ${off && canFix ? '<button class="d-warn-top" data-act="edit-start"><b>This trace is off the asphalt.</b> Fix the layout →</button>' : ''}
    <button class="btn primary lg block" data-act="race">Race <span class="arrow">→</span></button>
    <p class="d-pb">${d.pb ? `Your best <b class="mono">${formatMs(d.pb)}</b>` : 'Your first clean lap goes straight onto the board.'}</p>
    ${medalLadder(d.medals, d.pb)}
    <div class="sec-head"><h2 class="label">Leaderboard · ${rot.label.toLowerCase()}</h2><span class="label" data-el="dCount"></span></div>
    <div class="d-live" data-el="dLive"></div>
    <div data-el="dBoard"><p class="empty">Loading…</p></div>
    <div class="d-layout">
      <p>${
        t.corrected
          ? `<span class="cc mono fixed">Fixed</span> Layout corrected by <b>${esc(t.corrected.by)}</b> ${timeAgo(t.corrected.at)}. Times on the old trace are on a separate board.`
          : `Traced from OpenStreetMap${t.osmWays.length ? ` (<a target="_blank" rel="noopener" href="https://www.openstreetmap.org/way/${t.osmWays[0]}">way ${t.osmWays[0]}${t.osmWays.length > 1 ? ` +${t.osmWays.length - 1}` : ''}</a>)` : ''}.`
      }</p>
      ${canFix ? `<button class="link" data-act="edit-start">${off ? 'Fix the layout' : 'Line off the asphalt? Fix it'} →</button>` : ''}
    </div>`;
}

export function board(b: BoardResponse, me: string): { count: string; live: string; list: string } {
  const lead = b.entries[0]?.ms;
  return {
    count: b.total ? `${b.total} driver${b.total > 1 ? 's' : ''}` : '',
    live: b.onTrack.length
      ? `<i class="live-dot"></i>On track: ${b.onTrack.map((o) => `<span class="chip"><i style="background:${esc(o.color)}"></i>${esc(o.name)}</span>`).join('')}`
      : '',
    list: b.entries.length
      ? `<ol class="board">${b.entries
          .map(
            (e) => `<li class="${e.pid === me ? 'me' : ''}">
              <span class="pos mono">${String(e.rank).padStart(2, '0')}</span>
              <span class="bar" style="background:${esc(e.color)}"></span>
              <span class="nm">${esc(e.name)}${e.pid === me ? ' <em>you</em>' : ''}</span>
              <span class="tm mono">${e.rank === 1 ? formatMs(e.ms) : `+${((e.ms - lead) / 1000).toFixed(3)}`}</span>
            </li>`,
          )
          .join('')}</ol>`
      : '<p class="empty">No times yet. Set the benchmark.</p>',
  };
}

// ------------------------------------------------------------------ search

export interface SearchHit {
  key: string; // t:ID | c:CCC | v:i | place
  title: string;
  sub: string;
  tag: string; // cc or kind
}

export function searchResults(groups: { label: string; hits: SearchHit[] }[], sel: number): string {
  let i = 0;
  const html = groups
    .filter((g) => g.hits.length)
    .map(
      (g) => `<div class="sr-group"><p class="label">${esc(g.label)}</p>${g.hits
        .map((h) => {
          const n = i++;
          return `<button class="sr${n === sel ? ' on' : ''}" data-hit="${esc(h.key)}" data-i="${n}"><span class="sr-tag mono">${esc(h.tag)}</span><span class="sr-main"><b>${esc(h.title)}</b><small>${esc(h.sub)}</small></span></button>`;
        })
        .join('')}</div>`,
    )
    .join('');
  return html || '<p class="sr-none">Nothing matches. Try a city name.</p>';
}

// ------------------------------------------------------------------ countries

export function countryList(list: { cc: string; name: string; n: number }[], active: string | null): string {
  return list.length
    ? list
        .map(
          (c) =>
            `<button class="cp-row${c.cc === active ? ' on' : ''}" data-filter="cc:${esc(c.cc)}"><span class="cc mono">${esc(c.cc)}</span><span class="cp-name">${esc(c.name)}</span><span class="n mono">${c.n}</span></button>`,
        )
        .join('')
    : '<p class="sr-none">No country by that name.</p>';
}

// ------------------------------------------------------------------ live

export interface LiveRow {
  track: string;
  dir: Dir;
  name: string;
  color: string;
  where: string;
}

export function liveBody(rows: LiveRow[], laps: FeedItem[]): string {
  const drivers = rows.length
    ? rows
        .slice(0, 6)
        .map(
          (r) => `<button class="lv-row" data-feed="${esc(r.track)}" data-dir="${r.dir}">
            <span class="bar" style="background:${esc(r.color)}"></span>
            <span class="lv-main"><b>${esc(r.name)}</b><small>${esc(r.where)}${r.dir === 'rev' ? ' · reverse' : ''}</small></span>
            <span class="lv-tag mono"><i class="live-dot"></i>Live</span>
          </button>`,
        )
        .join('') + (rows.length > 6 ? `<p class="lv-more">+${rows.length - 6} more driving now</p>` : '')
    : '<p class="lv-empty">Nobody on track right now. Set the pace.</p>';
  const recent = laps
    .slice(0, 3)
    .map(
      (l) => `<button class="lv-row" data-feed="${esc(l.track)}" data-dir="${l.dir}">
        <span class="bar" style="background:${esc(l.color)}"></span>
        <span class="lv-main"><b>${esc(l.name)}</b><small>${esc(l.trackName)}${l.dir === 'rev' ? ' · rev' : ''}</small></span>
        <span class="lv-time"><span class="mono">${formatMs(l.ms)}</span><small class="${l.rank === 1 ? 'p1' : ''}">P${l.rank} · ${timeAgo(l.at)}</small></span>
      </button>`,
    )
    .join('');
  return `<div class="lv-sec">${drivers}</div>${recent ? `<p class="lv-head label">Latest laps</p><div class="lv-sec">${recent}</div>` : ''}`;
}
