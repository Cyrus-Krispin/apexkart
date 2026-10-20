// HTML for the home screen in the Pit Wall design (docs/pit-wall.md): the timing tower, the daily
// and Box box bars, the pit board for a circuit, search results and the live sheet. Pure functions
// of their inputs; atlas.ts wires them up.
import type { TrackData } from '../track/osm';
import type { TrackShape } from '../track/shape';
import { cornersInRaceOrder } from '../track/shape';
import { trackArt, rotationLabel, type ArtOptions } from './trackArt';
import { escapeHtml as esc, formatMs, timeAgo, type BoardResponse, type DailyResponse, type Dir, type FeedItem } from '../net/api';
import { MEDALS, MEDAL_NAME, type Medal, type Targets } from '../game/medals';
import type { ControlScheme } from '../game/input';
import type { TimePref } from '../game/prefs';
import { stripeStyle } from './pitwall';

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

const MEDAL_SHORT: Record<Medal, string> = { bronze: 'BRNZ', silver: 'SILV', gold: 'GOLD', platinum: 'PLAT' };
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
  const tag = mine ? `P${mine.rank}` : d.streak ? `STREAK ${d.streak}` : 'NEW';
  return `<button class="pw-daily" data-act="daily" aria-label="Today's daily circuit: ${esc(d.t.name)}">
    <span class="chq"></span><span class="dl-k">DAILY</span><b class="dl-nm">${esc(d.t.name)}</b>
    <span class="dl-clk mono" data-el="dailyClock">${clock(d.msLeft)}</span><span class="dl-tag">${tag}</span>
  </button>`;
}

export function boxBar(p: { code: string; name: string; why: string } | null): string {
  if (!p) return `<button class="pw-box" disabled><span class="bx-k">BOX BOX</span><span class="bx-main"><b>LOADING…</b></span></button>`;
  return `<button class="pw-box" data-act="box" aria-label="Race ${esc(p.name)} (Enter)">
    <span class="bx-k">BOX BOX</span><span class="bx-main"><b>RACE ${esc(p.code)}</b><small>${esc(p.why)}</small></span><kbd>↵</kbd>
  </button>`;
}

// ------------------------------------------------------------------ pit board (one circuit)

export interface PitData {
  t: TrackData;
  shape: TrackShape;
  code: string;
  dir: Dir;
  pb: number | null;
  rank: number | null; // your place on the board
  live: number;
  siblings: TrackData[]; // other layouts at the venue
  shapeOf: (t: TrackData) => TrackShape;
  countryName?: string;
  nightNow: boolean; // at the circuit, right now
  medals: { targets: Targets; earned: Medal | null };
  daily?: string; // the daily board html when this is today's circuit
  challenge?: { name?: string; ms?: number };
  time: TimePref;
  controls: ControlScheme;
  lapS: number; // seconds per lap for the live dots
}

/** The next medal to chase and how far off it you are. */
export function nextMedal(pb: number | null, t: Targets): { m: Medal; gap: number | null } | null {
  for (const m of MEDALS) if (!pb || pb > t[m]) return { m, gap: pb ? pb - t[m] : null };
  return null; // platinum done
}

export function pit(d: PitData): string {
  const { t, shape } = d;
  const rot = rotationLabel(shape, d.dir === 'rev');
  const turns = cornersInRaceOrder(shape, d.dir === 'rev').length;
  const nx = nextMedal(d.pb, d.medals.targets);
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
        <p class="label">${esc(where)}</p>
        <h1 class="display">${esc(t.name)}</h1>
        <p class="pit-meta mono">${km(t.lengthM)} KM · ${turns} TURNS · ${rot.icon} ${rot.label.toUpperCase()} · ${d.nightNow ? 'NIGHT' : 'DAY'} THERE NOW</p>
      </div>
    </div>
    ${
      d.challenge
        ? `<div class="pit-chal"><span class="chq"></span><div><b>CHALLENGE${d.challenge.name ? ` FROM ${esc(d.challenge.name.toUpperCase())}` : ''}</b><span>${d.challenge.ms ? `Beat ${formatMs(d.challenge.ms)}. Their lap races with you as a ghost.` : 'Their lap races with you as a ghost.'}</span></div></div>`
        : ''
    }
    <div class="pit-track graph-paper">
      ${art(shape, { w: 560, h: 380, pad: 34, reverse: d.dir === 'rev', turns: true, arrows: true, road: true, sectors: true, live: d.live, lapS: d.lapS })}
      <div class="pit-dir pw-tabs" role="group" aria-label="Direction">
        <button data-dir="fwd" aria-pressed="${d.dir === 'fwd'}">${fwd.icon} ${fwd.label}</button>
        <button data-dir="rev" aria-pressed="${d.dir === 'rev'}">${rev.icon} ${rev.label}</button>
      </div>
      <div class="pit-legend"><span><i class="p"></i>S1</span><span><i class="g"></i>S2</span><span><i class="y"></i>S3</span>${d.live ? `<span><i class="w"></i>${d.live} ON TRACK</span>` : ''}</div>
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
    <div class="pw-board" aria-label="Your pit board">
      <div class="pw-board-in">
        <div class="pw-board-row"><span>${esc(d.code)}</span><span class="y">${Math.round(t.lengthM)}M</span></div>
        <div class="pw-board-row"><span data-el="pitRank">P${d.rank ?? '–'}</span><span class="sm">${d.pb ? formatMs(d.pb) : 'NO TIME'}</span></div>
        <div class="pw-board-row">${
          nx
            ? `<span class="y">${MEDAL_SHORT[nx.m]}</span><span class="sm">${nx.gap !== null ? gap(nx.gap) : formatMs(d.medals.targets[nx.m])}</span>`
            : `<span class="y">PLAT ✓</span><span class="sm">${d.pb ? formatMs(d.pb) : ''}</span>`
        }</div>
      </div>
    </div>
    <p class="label">MEDAL TARGETS</p>
    ${medalGrid(d.medals.targets, d.pb)}
    ${d.daily ?? ''}
    <p class="label pit-cls-h">CLASSIFICATION <span class="mono" data-el="dCount"></span></p>
    <div class="pit-cls" data-el="dBoard"><p class="pit-empty">Loading times…</p></div>
    <p class="pit-on" data-el="dLive"></p>
    <p class="label">SESSION</p>
    <div class="pw-tabs pit-sess" role="group" aria-label="Session">
      <button class="on" aria-pressed="true">TIME TRIAL</button>
      <button data-act="friends">RACE FRIENDS</button>
      <button data-act="challenge">CHALLENGE</button>
    </div>
    <div class="pit-set">
      <span class="label">TIME OF DAY</span>
      <div class="pw-tabs soft" role="group" aria-label="Time of day">${(['live', 'day', 'night'] as const)
        .map((k) => `<button data-time="${k}" aria-pressed="${d.time === k}">${k === 'live' ? `LIVE · ${d.nightNow ? 'NIGHT' : 'DAY'}` : k.toUpperCase()}</button>`)
        .join('')}</div>
      <span class="label">CONTROLS</span>
      <div class="pw-tabs soft" role="group" aria-label="Controls">${(['simple', 'classic'] as const)
        .map((k) => `<button data-controls="${k}" aria-pressed="${d.controls === k}">${k.toUpperCase()}</button>`)
        .join('')}</div>
    </div>
    ${fixable ? `<button class="pit-fix" data-act="edit">Layout looks wrong? <b>Fix it</b></button>` : ''}
    <div class="pit-go">
      <div class="pit-lights" aria-hidden="true">${'<i><b></b><b></b></i>'.repeat(5)}</div>
      <button class="btn go lg block" data-act="race">START ${esc(d.code)} <kbd>↵</kbd></button>
    </div>
  </div>`;
}

export function medalGrid(t: Targets, pb: number | null): string {
  const nx = nextMedal(pb, t);
  return `<div class="pit-med">${MEDALS.map((m) => {
    const won = !!pb && pb <= t[m];
    return `<div class="${won ? 'won' : ''}${nx?.m === m ? ' nx' : ''}"><i class="medal ${m}"></i><span>${MEDAL_SHORT[m]}</span><b class="mono">${formatMs(t[m])}</b><em class="mono">${won ? '✓' : pb ? gap(pb - t[m]) : ''}</em></div>`;
  }).join('')}</div>`;
}

/** The classification: top ten, gaps to the leader, a ghost button on every lap but yours. */
export function classification(b: BoardResponse, me: string): { count: string; live: string; list: string } {
  const lead = b.entries[0]?.ms;
  const mine = b.entries.find((e) => e.pid === me);
  return {
    count: b.total ? `· ${b.total} DRIVER${b.total > 1 ? 'S' : ''}` : '',
    live: b.onTrack.length ? `<i class="live-dot"></i>ON TRACK: ${b.onTrack.map((o) => `<span><i style="background:${esc(o.color)}"></i>${esc(o.name)}</span>`).join('')}` : '',
    list: b.entries.length
      ? `${b.entries
          .map(
            (e, k) => `<div class="cls-row${e.pid === me ? ' you' : ''}">
              <span class="cls-p">${e.rank}</span>
              <span class="cls-bar" style="background:${esc(e.color)}"></span>
              <span class="cls-n">${esc(e.name)}${e.pid === me ? ' <em>YOU</em>' : ''}</span>
              <b class="mono${k === 0 ? ' p' : ''}">${formatMs(e.ms)}</b>
              <span class="cls-gap mono">${k ? gap(e.ms - lead) : 'REC'}</span>
              ${e.pid === me ? '<span></span>' : `<button class="cls-ghost" data-rival="${esc(e.pid)}" aria-label="Race ${esc(e.name)}'s ghost">GHOST</button>`}
            </div>`,
          )
          .join('')}${mine ? `<button class="pit-share" data-act="challenge">Challenge a friend to beat your ${formatMs(mine.ms)} →</button>` : ''}`
      : '<p class="pit-empty">No times yet. Set the benchmark.</p>',
  };
}

export function dailyBoard(board: DailyResponse | null, me: string, msLeft: number): string {
  const rows = board?.entries.slice(0, 5) ?? [];
  return `<div class="pit-daily">
    <div class="pit-daily-h"><span class="chq"></span><b>DAILY CIRCUIT</b><span class="mono">ENDS ${clock(msLeft)}</span></div>
    ${
      rows.length
        ? rows
            .map(
              (e) =>
                `<div class="cls-row${e.pid === me ? ' you' : ''}"><span class="cls-p">${e.rank}</span><span class="cls-bar" style="background:${esc(e.color)}"></span><span class="cls-n">${esc(e.name)}${e.pid === me ? ' <em>YOU</em>' : ''}</span><b class="mono">${formatMs(e.ms)}</b><span></span><span></span></div>`,
            )
            .join('')
        : '<p class="pit-empty">Nobody has set a time today. Your first clean lap leads.</p>'
    }
  </div>`;
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
