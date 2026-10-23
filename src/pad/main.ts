// The phone wheel (pad.html#CODE): the page a phone opens from the QR code on the game's screen.
// Tilt to steer, thumbs on the pedals, a few buttons for the game's shortcuts. Everything goes to the
// screen over a direct WebRTC link (src/net/pad.ts). It doesn't load the game itself.
import '../styles/base.css';
import './pad.css';
import { PadLink, PadApiError, type PadCloseReason } from '../net/pad';
import { Tilt, type TiltFailure } from './tilt';
import { CODE_RE } from '../shared/room';
import type { PadKey, PadTuple } from '../shared/pad';

const root = document.getElementById('pad')!;
root.innerHTML = /* html */ `
  <section class="pd-join" data-el="join">
    <p class="label">ApexKart · Phone wheel</p>
    <h1 class="display">Your phone is the wheel</h1>
    <p class="pd-lede">Hold it sideways like a steering wheel and tilt to steer. Your thumbs work the pedals.</p>
    <label class="pd-field">
      <span class="label">Code on the screen</span>
      <input class="pd-code mono" data-el="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="K7QX" />
    </label>
    <button class="btn primary lg block" data-el="go">Connect <span class="arrow">→</span></button>
    <p class="pd-msg" data-el="msg" role="status"></p>
  </section>
  <section class="pd-drive" data-el="drive" hidden>
    <header class="pd-top">
      <span class="pd-status ui" data-el="status"><i></i><span></span></span>
      <span class="pd-warn ui" data-el="warn"></span>
      <span class="pd-tools">
        <button class="btn" data-act="recentre">Recentre</button>
        <button class="btn" data-key="r">Reset</button>
        <button class="btn" data-key="p">Start · Pause</button>
      </span>
    </header>
    <div class="pd-deck">
      <div class="pd-pedal brake" data-pedal="brake"><span class="display">Brake</span></div>
      <div class="pd-wheel" aria-hidden="true">
        <svg viewBox="-50 -50 100 100" data-el="wheel">
          <circle r="42" fill="none" stroke="currentColor" stroke-width="7"/>
          <path d="M-40 4h80M0 6v36" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
          <circle r="9" fill="currentColor"/>
          <rect x="-4" y="-50" width="8" height="12" rx="2" class="pd-wheel-mark"/>
        </svg>
        <p class="pd-hint">Tilt to steer · <b>Recentre</b> sets straight ahead</p>
      </div>
      <div class="pd-pedal gas" data-pedal="gas"><span class="display">Gas</span></div>
    </div>
  </section>`;

const $ = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-el="${name}"]`)!;
const codeInput = $<HTMLInputElement>('code');
const goBtn = $<HTMLButtonElement>('go');
const msg = $('msg');
const status = $('status');
const warn = $('warn');
const wheel = $('wheel');

const TILT_MSG: Record<TiltFailure, string> = {
  denied: 'Motion access was refused, so tilt can’t steer. Close this tab, scan the code again and tap Allow.',
  gesture: 'Tap Connect again to allow motion access.',
  silent: 'No tilt sensor answered. Open this page on a phone.',
};
const CLOSED_MSG: Record<PadCloseReason, string> = {
  gone: 'The game’s screen closed the pairing. Scan its new code to drive again.',
  replaced: 'Another phone took the wheel.',
  left: '',
};

let link: PadLink | null = null;
let seq = 0;
const pedals = { brake: 0, gas: 0 };

const tilt = new Tilt((why) => {
  warn.textContent = link ? TILT_MSG[why] : '';
  if (!link) msg.textContent = TILT_MSG[why];
});

codeInput.value = location.hash.replace('#', '').toUpperCase().slice(0, 4);
codeInput.addEventListener('input', () => (codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && connect());
goBtn.addEventListener('click', connect);

async function connect() {
  const code = codeInput.value.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    msg.textContent = 'Type the 4-character code shown on the game’s screen.';
    return;
  }
  // Inside the tap: iOS only asks for motion access from a user gesture.
  tilt.start();
  keepAwake();
  if (link) return;
  msg.textContent = 'Connecting…';
  goBtn.disabled = true;
  try {
    link = await PadLink.join(code);
  } catch (e) {
    msg.textContent = e instanceof PadApiError && e.status === 404 ? 'No game is showing that code. Check the screen, or open Phone wheel there again.' : e instanceof PadApiError ? e.message : 'Couldn’t reach ApexKart. Check your connection and try again.';
    goBtn.disabled = false;
    return;
  }
  history.replaceState(null, '', `#${code}`);
  msg.textContent = '';
  goBtn.disabled = false;
  link.onStatus = paintStatus;
  link.onCtl = (m) => {
    if (m.k === 'scheme') root.classList.toggle('classic', m.s === 'classic');
    if (m.k === 'buzz') navigator.vibrate?.(m.p);
  };
  link.onClosed = (why) => {
    link = null;
    $('drive').hidden = true;
    $('join').hidden = false;
    msg.textContent = CLOSED_MSG[why];
  };
  $('join').hidden = true;
  $('drive').hidden = false;
  paintStatus();
}

function paintStatus() {
  const s = link?.status ?? 'closed';
  status.dataset.s = s;
  status.querySelector('span')!.textContent =
    s === 'live' ? `Connected${link?.rtt != null ? ` · ${Math.round(link.rtt)} ms` : ''}` : s === 'closed' ? 'Disconnected' : 'Connecting…';
}

// ---------- pedals: each finger is tracked, so both thumbs can be down at once

root.querySelectorAll<HTMLElement>('[data-pedal]').forEach((el) => {
  const which = el.dataset.pedal as 'brake' | 'gas';
  const fingers = new Set<number>();
  const paint = () => {
    pedals[which] = fingers.size ? 1 : 0;
    el.classList.toggle('on', fingers.size > 0);
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    fingers.add(e.pointerId);
    paint();
  });
  const lift = (e: PointerEvent) => fingers.delete(e.pointerId) && paint();
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);
  el.addEventListener('lostpointercapture', lift);
});
// No scrolling, zooming, text selection or long-press menus while driving.
$('drive').addEventListener('touchstart', (e) => !(e.target as HTMLElement).closest('button') && e.preventDefault(), { passive: false });
root.addEventListener('contextmenu', (e) => e.preventDefault());

root.querySelector('[data-act="recentre"]')!.addEventListener('click', () => tilt.recentre());
root.querySelectorAll<HTMLButtonElement>('[data-key]').forEach((b) => b.addEventListener('click', () => link?.sendCtl({ k: 'key', key: b.dataset.key as PadKey })));

// ---------- the send loop: every frame while live (≈60 Hz, ~30 bytes, never queued)

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const steer = tilt.live ? tilt.read(dt) : 0;
  wheel.style.transform = `rotate(${(steer * 90).toFixed(1)}deg)`;
  if (link?.status === 'live') {
    const t: PadTuple = [++seq, +steer.toFixed(3), pedals.brake, pedals.gas];
    link.send(t);
  }
}
requestAnimationFrame(frame);

// ---------- keep the screen on while driving

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake() {
  const wl = (navigator as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (!wl || wakeLock) return;
  try {
    wakeLock = await wl.request('screen');
    (wakeLock as unknown as EventTarget).addEventListener?.('release', () => (wakeLock = null));
  } catch {
    /* not allowed now (battery saver): the phone may dim */
  }
}
document.addEventListener('visibilitychange', () => !document.hidden && link && keepAwake());
