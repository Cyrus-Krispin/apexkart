// "Phone wheel" on the game's screen: a header button that shows a QR code for pad.html#CODE, and
// the pairing behind it (src/net/pad.ts). Once a phone is live its steering goes to remotePad, which
// every race's Input reads, so the pairing lasts across races and multiplayer rooms until either side
// closes. See MULTIPLAYER.md, "Phone as a wheel".
import './padPair.css';
import { PadLink, type PadCloseReason } from '../net/pad';
import { remotePad } from '../game/remotePad';
import { controlsPref } from '../game/input';
import { PAD_KEYS } from '../shared/pad';
import { escapeHtml } from '../net/api';

const PHONE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 18h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SLOW_CONNECT_MS = 25_000;
const CLOSED_MSG: Record<PadCloseReason, string> = {
  gone: 'The pairing expired. Here’s a new code.',
  replaced: '',
  left: '',
};

export function initPhoneWheel(o: { entryParent?: HTMLElement | null }) {
  let link: PadLink | null = null;
  let opening: Promise<void> | null = null;
  let page: HTMLElement | null = null;
  let lastSeq = 0;
  let slowTimer = 0;
  let connectingSince = 0;
  let autoClose = 0;
  let qr: { url: string; svg: string } | null = null;

  const btn = document.createElement('button');
  btn.className = 'btn primary mp-entry pp-entry';
  btn.innerHTML = `${PHONE_ICON}<span class="mp-entry-label">Phone wheel</span><i class="pp-dot"></i>`;
  btn.setAttribute('aria-label', 'Use your phone as a steering wheel');
  btn.title = 'Steer with your phone: scan a QR code, then tilt';
  btn.addEventListener('click', () => open());
  const friends = o.entryParent?.querySelector('.mp-entry'); // sits after "Race friends"
  if (friends) friends.after(btn);
  else o.entryParent?.prepend(btn);

  function wire(l: PadLink) {
    l.onStatus = () => {
      const live = l.status === 'live';
      btn.classList.toggle('on', live);
      if (live && !remotePad.connected) {
        remotePad.scheme(controlsPref()); // until a race says otherwise
        remotePad.attach({ scheme: (s) => l.sendCtl({ k: 'scheme', s }), buzz: (p) => l.sendCtl({ k: 'buzz', p }) });
      } else if (!live && remotePad.connected) remotePad.attach(null);
      clearTimeout(slowTimer);
      if (l.status !== 'connecting') connectingSince = 0;
      else if (!connectingSince) {
        connectingSince = performance.now();
        slowTimer = window.setTimeout(() => paint(), SLOW_CONNECT_MS);
      }
      // Connected: get the dialog out of the way so they can drive.
      clearTimeout(autoClose);
      if (live && page) autoClose = window.setTimeout(close, 1400);
      paint();
    };
    l.onData = ([seq, steer, brake, gas]) => {
      // Unordered channel: drop anything older than what we have (a reloaded phone starts again at 1).
      if (seq <= lastSeq && lastSeq - seq < 600) return;
      lastSeq = seq;
      remotePad.set(steer, brake, gas);
    };
    l.onCtl = (m) => {
      if (m.k !== 'key' || !PAD_KEYS.includes(m.key)) return;
      // The phone's buttons are the game's own shortcuts: press the key for whoever listens (briefing, race).
      dispatchEvent(new KeyboardEvent('keydown', { key: m.key }));
      setTimeout(() => dispatchEvent(new KeyboardEvent('keyup', { key: m.key })), 60);
    };
    l.onClosed = (why) => {
      if (link === l) link = null;
      lastSeq = 0;
      remotePad.attach(null);
      btn.classList.remove('on');
      clearTimeout(slowTimer);
      if (page) start(CLOSED_MSG[why]);
    };
  }

  /** Open a new pairing (the dialog shows its code). */
  function start(note = '') {
    opening ??= (async () => {
      paint(note || 'Getting a code…');
      try {
        link = await PadLink.create();
        link.watching = !!page;
        wire(link);
        paint(note);
      } catch (e) {
        paint(!isSecureContext ? 'Phone wheel needs the site on HTTPS (or localhost).' : `Couldn’t get a code: ${e instanceof Error ? e.message : e}`);
      } finally {
        opening = null;
      }
    })();
  }

  function open() {
    if (page) return;
    page = document.createElement('div');
    page.className = 'pp-page';
    page.innerHTML = /* html */ `
      <div class="pp-card" role="dialog" aria-label="Phone wheel">
        <header class="pp-bar">
          <span class="label">Phone wheel</span>
          <button class="pp-x mono" data-act="close" aria-label="Close">×</button>
        </header>
        <div class="pp-body" data-el="body"></div>
      </div>`;
    page.addEventListener('click', (e) => {
      if (e.target === page || (e.target as HTMLElement).closest('[data-act="close"]')) close();
      if ((e.target as HTMLElement).closest('[data-act="drop"]')) void link?.leave();
    });
    document.body.appendChild(page);
    addEventListener('keydown', onKey, true);
    if (link) link.watching = true;
    if (!link) start();
    else paint();
    link?.pollSoon(30);
  }

  function close() {
    if (!page) return;
    page.remove();
    page = null;
    clearTimeout(autoClose);
    removeEventListener('keydown', onKey, true);
    if (!link) return;
    link.watching = false;
    // Nobody scanned it: no point keeping the code alive.
    if (link.status === 'waiting') void link.leave();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  }

  function paint(note = '') {
    const body = page?.querySelector<HTMLElement>('[data-el="body"]');
    if (!body) return;
    if (!link) {
      body.innerHTML = `<p class="pp-status">${escapeHtml(note)}</p>`;
      return;
    }
    const s = link.status;
    const host = new URL(link.url).host;
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname) || location.hostname === '::1';
    const statusText =
      s === 'live'
        ? `Connected${link.rtt != null ? ` · ${Math.round(link.rtt)} ms` : ''}. Tilt to steer!`
        : s === 'connecting'
          ? 'Phone found, connecting…'
          : 'Waiting for a phone…';
    const slow =
      s === 'connecting' && connectingSince && performance.now() - connectingSince > SLOW_CONNECT_MS - 100
        ? '<p class="pp-note">Still connecting. Phone and laptop on the same Wi-Fi works best; some mobile networks can’t link directly.</p>'
        : '';
    body.innerHTML = /* html */ `
      <div class="pp-qr" data-el="qr" role="img" aria-label="QR code for ${escapeHtml(link.url)}">${qr?.url === link.url ? qr.svg : ''}</div>
      <div class="pp-side">
        <h2 class="display">Scan to steer</h2>
        <ol class="pp-steps">
          <li>Point your phone’s camera at the code.</li>
          <li>Tap <b>Connect</b>, and <b>Allow</b> motion access if asked.</li>
          <li>Hold it sideways like a wheel and tilt. Thumbs on the pedals.</li>
        </ol>
        <p class="pp-alt">Or open <span class="mono">${escapeHtml(host)}/pad.html</span> and type</p>
        <p class="pp-code mono">${escapeHtml(link.code)}</p>
        <p class="pp-status" data-s="${s}"><i></i>${escapeHtml(note || statusText)}</p>
        ${slow}
        ${local ? '<p class="pp-note">This page is on localhost, which a phone can’t open. Use the live site, or serve it on your network over HTTPS (phones only share motion with secure pages).</p>' : ''}
        <div class="pp-actions">
          ${s === 'live' ? '<button class="btn" data-act="drop">Disconnect phone</button>' : ''}
          <button class="btn primary" data-act="close">${s === 'live' ? 'Drive' : 'Done'}</button>
        </div>
      </div>`;
    if (qr?.url !== link.url) void drawQr(link.url);
  }

  /** The QR encoder loads on first use; the code is drawn once per pairing. */
  async function drawQr(url: string) {
    const { default: qrcode } = await import('qrcode-generator');
    const code = qrcode(0, 'M');
    code.addData(url);
    code.make();
    qr = { url, svg: code.createSvgTag({ cellSize: 4, margin: 3, scalable: true }) };
    const el = page?.querySelector<HTMLElement>('[data-el="qr"]');
    if (el && link?.url === url) el.innerHTML = qr.svg;
  }

  return { open };
}
