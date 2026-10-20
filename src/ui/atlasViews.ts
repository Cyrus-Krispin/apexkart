// HTML for the home screen in the Pit Wall design (docs/pit-wall.md): the timing tower, the daily
// circuit bar, the pit board for a circuit, search results and the live sheet. Pure functions
// of their inputs; atlas.ts wires them up.
import type { TrackData } from '../track/osm';
import type { TrackShape } from '../track/shape';
import { cornersInRaceOrder } from '../track/shape';
import { trackArt, rotationLabel, type ArtOptions } from './trackArt';
import { escapeHtml as esc, formatMs, timeAgo, type BoardResponse, type DailyResponse, type Dir, type FeedItem } from '../net/api';
import { MEDALS, MEDAL_NAME, type Medal, type Targets } from '../game/medals';
import { stripeStyle } from './pitwall';
import type { ControlScheme } from '../game/input';
import type { TimePref } from '../game/prefs';

export { esc, formatMs };

/** Track drawings are pure functions of the shape and options, and screens redraw often: cache them. */
const artCache = new WeakMap<TrackShape, Map<string, string>>();
function art(shape: TrackShape, o: ArtOptions): string {
  let byOpts = artCache.get(shape);
  if (!byOpts) artCache.set(shape, (byOpts = new Map()));
  const key = JSON.stringify(o);
  let svg = byOpts.get(key);
  if (!svg) byOpts.set(key, (svg = trackArt(shape, o)));
  return svg;
}

export const ICON = {
  search: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/></svg>`,
  ghost: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5c-3 0-5 2.2-5 5.2v7.3l1.7-1.3 1.6 1.3L8 12.7l1.7 1.3 1.6-1.3 1.7 1.3V6.7c0-3-2-5.2-5-5.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="6.2" cy="6.6" r="1" fill="currentColor"/><circle cx="9.8" cy="6.6" r="1" fill="currentColor"/></svg>`,
  pin: `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>`,
};

const km = (m: number) => (m / 1000).toFixed(2);
const gap = (ms: number) => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)}`;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** "12:04:51" until the daily circuit resets. */
export function clock(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}

// ------------------------------------------------------------------ tower

export type Tab = 'live' | 'near' | 'world';

export interface TowerRow {
  key: string; // t:ID (a raceable layout) or v:i (a venue whose layouts load on tap)
  code: string;
  name: string;
  sub: string; // city · country, or why it's here
  cc?: string;
  best?: number | null; // track record, ms
  flash?: '' | 'p' | 'g';
  live: number;
  distKm?: number; // near me
  medal?: Medal | null;
  daily?: boolean;
}

export function towerHead(tab: Tab): string {
  return `<span>POS</span><span>CIRCUIT</span><span>RECORD</span><span>${tab === 'near' ? 'KM' : 'LIVE'}</span>`;
}

export function towerRow(r: TowerRow, pos: number, sel: boolean, tab: Tab): string {
  const right =
    tab === 'near' && r.distKm !== undefined
      ? `<span class="tw-km mono${r.live ? ' on' : ''}">${r.distKm < 10 ? r.distKm.toFixed(1) : Math.round(r.distKm)}</span>`
      : `<span class="pw-lv${r.live ? '' : ' z'}">${r.live}</span>`;
  return `<button class="pw-row tw-row${sel ? ' sel' : ''}${r.daily ? ' daily' : ''}" data-key="${esc(r.key)}" aria-label="${esc(r.name)}${r.live ? `, ${r.live} on track` : ''}">
    <span class="pw-pos">${pos}</span>
    <span class="pw-stripe" style="${stripeStyle(r.cc)}"></span>
    <span class="tw-id"><b class="pw-code">${esc(r.code)}</b><span class="tw-nm">${esc(r.name)}<small>${esc(r.sub)}</small></span></span>
    <span class="tw-best">${r.medal ? `<i class="medal ${r.medal}" title="${MEDAL_NAME[r.medal]} medal"></i>` : ''}<span class="pw-t${r.best ? '' : ' none'}${r.flash ? ' ' + r.flash : ''}">${r.best ? formatMs(r.best) : '—'}</span></span>
    ${right}
  </button>`;
}

export function towerEmpty(msg: string, action?: { act: string; label: string }): string {
  return `<div class="tw-empty"><p>${esc(msg)}</p>${action ? `<button class="btn" data-act="${action.act}">${esc(action.label)}</button>` : ''}</div>`;
}

export function dailyBar(d: { t: TrackData; msLeft: number; streak: number; board: DailyResponse | null; me: string } | null): string {
  if (!d) return '';
  const mine = d.board?.entries.find((e) => e.pid === d.me);
  const tag = mine ? `YOU P${mine.rank}` : d.streak ? `STREAK ${d.streak}` : '';
  return `<button class="pw-daily" data-act="daily" aria-label="Race today's daily circuit, ${esc(d.t.name)}">
    <span class="chq"></span>
    <span class="dl-t"><span class="dl-k">TODAY'S DAILY · ENDS <span class="mono" data-el="dailyClock">${clock(d.msLeft)}</span>${tag ? ` · ${tag}` : ''}</span><b class="dl-nm">${esc(d.t.name)}</b></span>
    <span class="dl-go">RACE <span aria-hidden="true">›</span></span>
  </button>`;
}

// ------------------------------------------------------------------ pit board (one circuit)

export interface PitData {
  t: TrackData;
  shape: TrackShape;
  code: string;
  dir: Dir;
  pb: number | null;
  live: number;
  siblings: TrackData[]; // other layouts at the venue
  shapeOf: (t: TrackData) => TrackShape;
  countryName?: string;
  medals: Targets;
  daily: boolean; // today's daily circuit: the leaderboard gets a Today tab
  challenge?: { name?: string; ms?: number };
  lapS: number; // seconds per lap for the live dots
  // Setup: everything you can choose before a race lives here, on the circuit page.
  time: TimePref;
  nightNow: boolean; // at the circuit right now, for "Live"
  controls: ControlScheme;
}

/** The next medal to chase and how far off it you are. */
export function nextMedal(pb: number | null, t: Targets): { m: Medal; gap: number | null } | null {
  for (const m of MEDALS) if (!pb || pb > t[m]) return { m, gap: pb ? pb - t[m] : null };
  return null; // platinum done
}

const ICON_FRIENDS = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="9" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.8 19.5c.6-3.4 3.1-5.3 6.2-5.3s5.6 1.9 6.2 5.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15.5 4.9a3.3 3.3 0 0 1 0 6.3M17.6 14.6c2 .7 3.3 2.4 3.7 4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICON_SHARE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3.5v11M7.5 8 12 3.5 16.5 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 12.5v6.5h14v-6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * The circuit page: everything before a race on one page. The track, you (best, place, medals),
 * the leaderboard, and the setup (direction, time of day, controls). RACE takes you to the grid,
 * which only loads and starts: there's nothing to set there.
 */
export function pit(d: PitData): string {
  const { t, shape } = d;
  const turns = cornersInRaceOrder(shape, d.dir === 'rev').length;
  const where = [d.countryName, t.location?.split(',')[0]].filter(Boolean).join(' · ') || 'OpenStreetMap';
  const fixable = !t.preset || !!t.corrected;
  const fwd = rotationLabel(shape, false);
  const rev = rotationLabel(shape, true);
  return `
  <div class="pit-main">
    <header class="pit-hd">
      <button class="pit-back" data-act="back" aria-label="Back to the tower"><span class="mono">‹</span> TOWER</button>
      <span class="pw-lv${d.live ? '' : ' z'}" data-el="pitLive">${d.live} ON TRACK</span>
    </header>
    <div class="pit-name">
      <span class="pw-stripe big" style="${stripeStyle(t.country)}"></span>
      <div class="pit-name-t">
        <p class="label">${d.daily ? '<b class="pit-daily-tag">TODAY’S DAILY</b> ' : ''}${esc(where)}</p>
        <h1 class="display">${esc(t.name)}</h1>
        <p class="pit-meta mono">${km(t.lengthM)} KM · ${turns} TURNS</p>
      </div>
    </div>
    ${
      d.challenge
        ? `<div class="pit-chal"><span class="chq"></span><div><b>CHALLENGE${d.challenge.name ? ` FROM ${esc(d.challenge.name.toUpperCase())}` : ''}</b><span>${d.challenge.ms ? `Beat ${formatMs(d.challenge.ms)}. Their lap races with you as a ghost.` : 'Their lap races with you as a ghost.'}</span></div></div>`
        : ''
    }
    <div class="pit-track graph-paper">
      ${art(shape, { w: 560, h: 380, pad: 30, reverse: d.dir === 'rev', turns: true, arrows: true, road: true, sectors: true, live: d.live, lapS: d.lapS })}
    </div>
    ${
      d.siblings.length
        ? `<div class="pit-sibs" role="group" aria-label="Layouts at this venue"><p class="label">${d.siblings.length + 1} LAYOUTS HERE</p><div class="pit-sib-row">${[t, ...d.siblings]
            .sort((a, b) => b.lengthM - a.lengthM)
            .map(
              (s) =>
                `<button class="sib${s.id === t.id ? ' on' : ''}" data-track="${esc(s.id)}" aria-pressed="${s.id === t.id}" aria-label="${esc(s.name)}, ${km(s.lengthM)} km">${art(d.shapeOf(s), { w: 72, h: 44, pad: 5, arrows: false })}<span class="mono">${km(s.lengthM)}</span></button>`,
            )
            .join('')}</div></div>`
        : ''
    }
  </div>
  <div class="pit-side">
    ${you(d.pb, d.medals)}
    <section class="pit-lb${d.daily ? ' has-today today' : ''}" data-el="lb">
      <header class="pit-lb-h">
        <span class="label">LEADERBOARD <span class="mono" data-el="dCount"></span></span>
        ${d.daily ? `<div class="pw-tabs soft pit-lb-tabs" role="group" aria-label="Leaderboard"><button data-lb="all" aria-pressed="false">ALL TIME</button><button data-lb="today" aria-pressed="true">TODAY</button></div>` : ''}
      </header>
      <div class="pit-cls lb-all" data-el="dBoard"><p class="pit-empty">Loading times…</p></div>
      ${d.daily ? `<div class="pit-cls lb-today" data-el="dDaily"><p class="pit-empty">Loading today’s times…</p></div>` : ''}
      <p class="pit-on" data-el="dLive"></p>
    </section>
    <section class="pit-setup" aria-label="Setup">
      <span class="label">SETUP</span>
      <div class="pit-set">
        <span class="pw-k">Direction</span>
        <div class="pw-tabs soft" role="group" aria-label="Direction">
          <button data-dir="fwd" aria-pressed="${d.dir === 'fwd'}">${fwd.icon} ${fwd.label}</button>
          <button data-dir="rev" aria-pressed="${d.dir === 'rev'}">${rev.icon} ${rev.label}</button>
        </div>
        <span class="pw-k">Time</span>
        <div class="pw-tabs soft" role="group" aria-label="Time of day">${(['live', 'day', 'night'] as const)
          .map((k) => `<button data-time="${k}" aria-pressed="${d.time === k}">${k === 'live' ? `Live <small>${d.nightNow ? 'night' : 'day'}</small>` : k === 'day' ? 'Day' : 'Night'}</button>`)
          .join('')}</div>
        <span class="pw-k">Controls</span>
        <div class="pw-tabs soft" role="group" aria-label="Controls">${(['simple', 'classic'] as const)
          .map((k) => `<button data-controls="${k}" aria-pressed="${d.controls === k}">${k === 'simple' ? 'Simple <small>auto gas</small>' : 'Classic'}</button>`)
          .join('')}</div>
      </div>
    </section>
    ${fixable ? `<button class="pit-fix" data-act="edit">Layout looks wrong? <b>Fix it</b></button>` : ''}
    <div class="pit-go">
      <button class="btn go lg pit-start" data-act="race">RACE ${esc(d.code)} <span class="arrow">›</span></button>
      <button class="btn pit-icon" data-act="friends" aria-label="Race friends here" title="Race friends">${ICON_FRIENDS}</button>
      <button class="btn pit-icon" data-act="challenge" aria-label="Challenge a friend to beat your lap" title="Challenge a friend"${d.pb ? '' : ' aria-disabled="true"'}>${ICON_SHARE}</button>
    </div>
  </div>`;
}

/**
 * You at this circuit: your best and place, and a medal ladder. The four medals sit evenly from
 * bronze to platinum (record pace) and you sit between the two you're between, so the next medal
 * and how close it is read at a glance.
 */
export function you(pb: number | null, t: Targets): string {
  const stops = MEDALS.map((m) => t[m]); // slowest to fastest
  const at = (ms: number) => {
    if (ms >= stops[0]) return 0;
    for (let k = 1; k < stops.length; k++) if (ms >= stops[k]) return (k - 1 + (stops[k - 1] - ms) / (stops[k - 1] - stops[k] || 1)) / (stops.length - 1);
    return 1;
  };
  const nx = nextMedal(pb, t);
  const marker = pb ? at(pb) : null;
  const behind = pb !== null && pb > t.bronze;
  const note = !pb
    ? `Set a lap to start on the medals. <b>Bronze is ${formatMs(t.bronze)}</b>.`
    : nx
      ? `<i class="medal ${nx.m}"></i> <b>${MEDAL_NAME[nx.m]}</b> is ${formatMs(t[nx.m])}: find <b class="mono">${((nx.gap ?? 0) / 1000).toFixed(3)}s</b>`
      : `<i class="medal platinum"></i> <b>All medals won.</b> Platinum is record pace.`;
  return `<section class="pit-you">
    <div class="you-top">
      <div><span class="label">YOUR BEST</span><b class="you-best mono${pb ? '' : ' none'}">${pb ? formatMs(pb) : 'No time yet'}</b></div>
      <div class="you-pos"><span class="label">POSITION</span><b data-el="pitRank">–</b></div>
    </div>
    <div class="ladder${behind ? ' behind' : ''}" aria-hidden="true">
      <div class="ld-rail"><i class="ld-fill" style="transform:scaleX(${(marker ?? 0).toFixed(3)})"></i></div>
      ${MEDALS.map((m, k) => `<span class="ld-stop${pb && pb <= t[m] ? ' won' : ''}${nx?.m === m ? ' next' : ''}" style="left:${((k / (MEDALS.length - 1)) * 100).toFixed(1)}%"><i class="medal ${m}"></i><em class="mono">${formatMs(t[m])}</em></span>`).join('')}
      ${marker !== null ? `<span class="ld-you" style="left:${(marker * 100).toFixed(1)}%">YOU</span>` : ''}
    </div>
    <p class="you-next">${note}</p>
  </section>`;
}

/** Leaderboard rows: place, colour, name, time, gap, and a ghost to race on every lap but yours. */
export function classification(b: BoardResponse, me: string): { count: string; live: string; list: string; rank: string } {
  const lead = b.entries[0]?.ms;
  const mine = b.entries.find((e) => e.pid === me);
  return {
    count: b.total ? `· ${b.total}` : '',
    rank: mine ? `P${mine.rank}<small>/${b.total}</small>` : '–',
    live: b.onTrack.length ? `<i class="live-dot"></i>ON TRACK: ${b.onTrack.map((o) => `<span><i style="background:${esc(o.color)}"></i>${esc(o.name)}</span>`).join('')}` : '',
    list: b.entries.length
      ? b.entries
          .map(
            (e, k) => `<div class="cls-row${e.pid === me ? ' you' : ''}">
              <span class="cls-p">${e.rank}</span>
              <span class="cls-bar" style="background:${esc(e.color)}"></span>
              <span class="cls-n">${esc(e.name)}${e.pid === me ? ' <em>YOU</em>' : ''}</span>
              <b class="mono${k === 0 ? ' p' : ''}">${formatMs(e.ms)}</b>
              <span class="cls-gap mono">${k ? gap(e.ms - lead) : ''}</span>
              ${e.pid === me ? '<span></span>' : `<button class="cls-ghost" data-rival="${esc(e.pid)}" aria-label="Race ${esc(e.name)}'s ghost" title="Race their ghost">${ICON.ghost}</button>`}
            </div>`,
          )
          .join('')
      : '<p class="pit-empty">No times yet. Set the benchmark.</p>',
  };
}

/** Today's board on the daily circuit. */
export function dailyBoard(board: DailyResponse | null, me: string, msLeft: number): string {
  const rows = board?.entries.slice(0, 10) ?? [];
  const lead = rows[0]?.ms;
  return `<p class="pit-today-h mono">RESETS IN ${clock(msLeft)}</p>${
    rows.length
      ? rows
          .map(
            (e, k) =>
              `<div class="cls-row${e.pid === me ? ' you' : ''}"><span class="cls-p">${e.rank}</span><span class="cls-bar" style="background:${esc(e.color)}"></span><span class="cls-n">${esc(e.name)}${e.pid === me ? ' <em>YOU</em>' : ''}</span><b class="mono${k === 0 ? ' p' : ''}">${formatMs(e.ms)}</b><span class="cls-gap mono">${k ? gap(e.ms - lead) : ''}</span><span></span></div>`,
          )
          .join('')
      : '<p class="pit-empty">Nobody has set a time today. Your first clean lap leads.</p>'
  }`;
}

// ------------------------------------------------------------------ search

export interface SearchHit {
  key: string; // t:ID | c:CCC | v:i | place
  title: string;
  sub: string;
  tag: string;
  cc?: string;
}

export function searchResults(groups: { label: string; hits: SearchHit[] }[], sel: number): string {
  let i = 0;
  const html = groups
    .filter((g) => g.hits.length)
    .map(
      (g) =>
        `<p class="label sr-h">${esc(g.label)}</p>${g.hits
          .map((h) => {
            const n = i++;
            return `<button class="pw-row sr${n === sel ? ' sel' : ''}" data-hit="${esc(h.key)}"><span class="pw-stripe" style="${stripeStyle(h.cc)}"></span><span class="tw-nm">${esc(h.title)}<small>${esc(h.sub)}</small></span><span class="sr-tag mono">${esc(h.tag)}</span></button>`;
          })
          .join('')}`,
    )
    .join('');
  return html || towerEmpty('Nothing matches. Try a city name.');
}

// ------------------------------------------------------------------ countries

export function countryList(list: { cc: string; name: string; n: number }[], active: string | null, total: number): string {
  return `<button class="cc-row${active === null ? ' on' : ''}" data-cc="ALL"><span class="pw-stripe"></span><span>All countries</span><span class="mono">${total.toLocaleString('en')}</span></button>${list
    .map(
      (c) =>
        `<button class="cc-row${c.cc === active ? ' on' : ''}" data-cc="${esc(c.cc)}"><span class="pw-stripe" style="${stripeStyle(c.cc)}"></span><span>${esc(c.name)}</span><span class="mono">${c.n}</span></button>`,
    )
    .join('')}`;
}

// ------------------------------------------------------------------ live

export interface LiveRow {
  track: string;
  dir: Dir;
  name: string;
  color: string;
  where: string;
}

/** The live sheet: who's on track now, then race control (the latest laps). */
export function liveSheet(rows: LiveRow[], laps: FeedItem[]): string {
  const on = rows.length
    ? rows
        .map(
          (r) =>
            `<button class="pw-row lv-row" data-feed="${esc(r.track)}" data-dir="${r.dir}"><span class="cls-bar" style="background:${esc(r.color)}"></span><span class="tw-nm">${esc(r.name)}<small>${esc(r.where)}</small></span><span class="pw-lv">1</span></button>`,
        )
        .join('')
    : '<p class="pit-empty">Nobody is on track right now. Be the first.</p>';
  return `<p class="label">ON TRACK NOW</p>${on}<p class="label">RACE CONTROL</p>${laps.length ? laps.slice(0, 12).map((l) => rcLine(l, true)).join('') : '<p class="pit-empty">No laps yet today.</p>'}`;
}

/** One race-control line: "19:02 NINA 0:47.612 AT KF1 KARTING CIRCUIT · P3". */
export function rcLine(l: FeedItem, button = false): string {
  const t = new Date(l.at);
  const body = `<span class="mono">${pad2(t.getHours())}:${pad2(t.getMinutes())}</span> <b>${esc(l.name.toUpperCase())}</b> <span class="mono${l.rank === 1 ? ' p' : ''}">${formatMs(l.ms)}</span> AT ${esc(l.trackName.toUpperCase())}${l.rank === 1 ? ' · <em>RECORD</em>' : ` · P${l.rank}`}`;
  return button ? `<button class="rc-line" data-feed="${esc(l.track)}" data-dir="${l.dir}" title="${esc(timeAgo(l.at))}">${body}</button>` : `<span class="rc-item">${body}</span>`;
}
