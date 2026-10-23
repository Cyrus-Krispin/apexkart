// The phone controller page (pad.html): the phone steers a kart on another screen. Scanning the
// QR code on the laptop opens this page with the code (?c=K7QX); it connects at once, and a tap on
// Start asks for motion access (iOS), keeps the screen awake and goes full screen where it can.
// See docs/phone-controller.md.
import '../styles/base.css';
import './pad.css';
import { PadPhone, type PhoneStatus } from '../net/pad';
import { CODE_RE } from '../shared/room';
import type { PadButton, PadCtl, PadView } from '../shared/pad';
import { Tilt, type TiltFailure } from './tilt';

type Pad = 'left' | 'right' | 'brake' | 'gas';

const WHEEL = `<svg viewBox="0 0 120 120" aria-hidden="true">
  <circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" stroke-width="12"/>
  <path d="M12 60h36M72 60h36M60 72v36" stroke="currentColor" stroke-width="10"/>
  <circle cx="60" cy="60" r="14" fill="currentColor"/>
  <rect x="55" y="4" width="10" height="16" rx="2" fill="var(--yellow)"/>
</svg>`;

const root = document.getElementById('pad')!;
root.innerHTML = `
  <section class="pd-screen pd-code" data-screen="code">
    <div class="pd-card">
      <p class="label">ApexKart</p>
      <h1 class="display">Phone controller</h1>
      <p class="pd-lede">On the laptop, open ApexKart and choose <b>Phone</b>. Scan the code it shows, or type the four characters here.</p>
      <form class="pd-join" data-el="form">
        <input class="mono" data-el="input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7QX" aria-label="Code" />
        <button class="btn primary" type="submit">Connect</button>
      </form>
      <p class="pd-err" data-el="err" aria-live="polite"></p>
    </div>
  </section>

  <section class="pd-screen pd-start" data-screen="start">
    <div class="pd-card">
      <div class="pd-hold">${WHEEL}</div>
      <p class="pd-seat display" data-el="seat1" hidden></p>
      <h1 class="display">Hold it like a wheel</h1>
      <p class="pd-lede">Turn your phone sideways and tilt it to steer. Press the screen to brake.</p>
      <button class="btn go lg block" data-act="start">Start</button>
      <p class="pd-link-line"><i class="pd-dot"></i><span data-el="status1">Connecting to the game…</span></p>
    </div>
  </section>

  <section class="pd-screen pd-drive" data-screen="drive">
    <header class="pd-bar">
      <span class="pd-seat display" data-el="seat2" hidden></span>
      <span class="pd-link-line"><i class="pd-dot"></i><span data-el="status2">Connecting…</span></span>
      <span class="pd-note" data-el="note"></span>
      <nav class="pd-tools">
        <button class="btn" data-act="recentre" data-el="recentre" title="Straight ahead is how you hold the phone now">Recentre</button>
        <button class="btn" data-act="reset" data-el="reset" title="Back on track">Reset</button>
        <button class="btn primary" data-act="main" data-el="main">Pause</button>
      </nav>
    </header>
    <div class="pd-area simple" data-el="area">
      <div class="pd-pad pd-brake" data-pad="brake"><span class="display">Brake</span></div>
      <div class="pd-steer">
        <div class="pd-wheel" data-el="wheel">${WHEEL}</div>
        <p class="pd-steer-k label" data-el="steerK">Tilt to steer</p>
        <div class="pd-arrows"><div class="pd-pad" data-pad="left" aria-label="Steer left">◀</div><div class="pd-pad" data-pad="right" aria-label="Steer right">▶</div></div>
      </div>
      <div class="pd-pad pd-gas" data-pad="gas"><span class="display">Gas</span></div>
    </div>
    <p class="pd-turn label">Turn your phone sideways</p>
  </section>`;

const $ = <T extends HTMLElement = HTMLElement>(k: string) => root.querySelector<T>(`[data-el=${k}]`)!;
const show = (s: 'code' | 'start' | 'drive') => (root.dataset.screen = s);

let phone: PadPhone | null = null;
let view: PadView = 'menu';
let scheme: 'simple' | 'classic' = 'simple';
let mp = false;
let useTilt = true;
let tiltNote = ''; // why the phone steers with buttons instead
let started = false;
let seat: { n: number; color: string } | null = null; // in a party: which kart this phone drives
const tilt = new Tilt((why) => tiltFailed(why));

// ---------------------------------------------------------------- code

function codeFromUrl(): string | null {
  const q = new URLSearchParams(location.search).get('c') ?? location.hash.replace(/^#\/?/, '');
  const c = q.trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

function askCode(err = '') {
  if (phone) $<HTMLInputElement>('input').value = phone.code; // one tap to take it back
  phone?.dispose();
  phone = null;
  $('err').textContent = err;
  show('code');
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('input');
  const c = input.value.trim().toUpperCase();
  if (!CODE_RE.test(c)) {
    $('err').textContent = 'The code is four letters and numbers, like K7QX.';
    return;
  }
  input.blur();
  history.replaceState(null, '', `${location.pathname}?c=${c}`);
  connect(c);
});

function connect(code: string) {
  phone?.dispose();
  phone = new PadPhone(code, { status: onStatus, ctl: onCtl });
  onStatus(phone.status);
  show(started ? 'drive' : 'start');
}

// ---------------------------------------------------------------- link

const STATUS_TEXT: Record<PhoneStatus, string> = {
  joining: 'Connecting to the game…',
  connecting: 'Connecting to the game…',
  live: 'Connected',
  retry: 'Reconnecting… keep the phone and the laptop on the same Wi-Fi',
  gone: '',
};

function onStatus(s: PhoneStatus) {
  if (s === 'gone') return askCode(`${phone?.error || 'That code has closed.'} Scan the code on the laptop again, or type it here.`);
  root.classList.toggle('live', s === 'live');
  root.classList.toggle('retry', s === 'retry');
  $('status1').textContent = $('status2').textContent = STATUS_TEXT[s];
  if (s === 'live') {
    phone!.send({ k: 'hello', tilt: useTilt });
    buzz(30);
  }
  paintView();
}

function onCtl(m: PadCtl) {
  if (m.k === 'view') {
    view = m.view;
    scheme = m.scheme;
    mp = m.mp;
    paintView();
  } else if (m.k === 'buzz') buzz(m.p);
  else if (m.k === 'seat') {
    seat = { n: m.n, color: m.color };
    for (const el of [$('seat1'), $('seat2')]) {
      el.hidden = false;
      el.textContent = `P${m.n + 1}`;
      el.style.setProperty('--c', m.color);
    }
    paintView();
  }
}

const MAIN: Record<PadView, { label: string; cls: string; btn: PadButton | null }> = {
  menu: { label: 'Pick a circuit', cls: '', btn: null },
  brief: { label: 'Start', cls: 'go', btn: 'go' },
  race: { label: 'Pause', cls: 'primary', btn: 'pause' },
  paused: { label: 'Resume', cls: 'primary', btn: 'pause' },
};

function paintView() {
  const live = phone?.live ?? false;
  const m = MAIN[view];
  const main = $<HTMLButtonElement>('main');
  main.textContent = live ? m.label : 'Waiting';
  main.className = `btn ${live ? m.cls : ''}`;
  main.disabled = !live || !m.btn;
  $('reset').hidden = !live || view !== 'race';
  const area = $('area');
  area.classList.toggle('classic', scheme === 'classic');
  area.classList.toggle('simple', scheme !== 'classic');
  area.classList.toggle('notilt', !useTilt);
  $('recentre').hidden = !useTilt;
  $('note').textContent =
    live && view === 'menu' ? (mp ? 'In the lobby' : 'Pick a circuit on the laptop') : live && seat && view === 'brief' && !tiltNote ? 'Everyone in? Start the race' : tiltNote;
}

function press(b: PadButton) {
  phone?.send({ k: 'btn', b });
  buzz(12);
}

root.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'start') return begin();
  if (act === 'recentre') {
    tilt.recentre();
    buzz(12);
  }
  if (act === 'reset') press('reset');
  if (act === 'main') {
    const b = MAIN[view].btn;
    if (b) press(b);
  }
});

// ---------------------------------------------------------------- start: sensor, wake lock, full screen

function begin() {
  // First, inside the tap and before anything awaits: iOS only asks for motion access from a gesture.
  tilt.start();
  started = true;
  show('drive');
  keepAwake();
  const el = document.documentElement;
  if (el.requestFullscreen && !document.fullscreenElement)
    el
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
      .catch(() => undefined);
  paintView();
}

function tiltFailed(why: TiltFailure) {
  useTilt = false;
  $('steerK').textContent = '';
  const note: Record<TiltFailure, string> = {
    denied: 'Motion access is off, so steer with ◀ ▶. To tilt, reload and tap Allow.',
    gesture: 'Steer with ◀ ▶.',
    silent: 'No motion sensor here, so steer with ◀ ▶.',
  };
  tiltNote = note[why];
  phone?.send({ k: 'hello', tilt: false });
  paintView();
}

type WakeLock = { release(): Promise<void> };
let wake: WakeLock | null = null;
async function keepAwake() {
  try {
    wake = (await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<WakeLock> } }).wakeLock?.request('screen')) ?? null;
  } catch {
    /* not offered (older iOS); the screen may sleep */
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && started && wake) keepAwake(); // the lock is released when the page is hidden
});

function buzz(p: number | number[]) {
  try {
    navigator.vibrate?.(p);
  } catch {
    /* iOS has no vibration */
  }
}

// ---------------------------------------------------------------- pedals and buttons

const fingers = new Map<number, Pad | null>();
const area = $('area');
const padAt = (e: PointerEvent) => (document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-pad]')?.dataset.pad as Pad | undefined) ?? null;
const held = (p: Pad) => [...fingers.values()].includes(p);
function paintPads() {
  area.querySelectorAll<HTMLElement>('[data-pad]').forEach((el) => el.classList.toggle('on', held(el.dataset.pad as Pad)));
}
area.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  const p = padAt(e);
  fingers.set(e.pointerId, p);
  if (p === 'brake' || p === 'gas') buzz(8);
  paintPads();
});
area.addEventListener('pointermove', (e) => {
  if (!fingers.has(e.pointerId)) return;
  const p = padAt(e);
  if (p === fingers.get(e.pointerId)) return;
  fingers.set(e.pointerId, p);
  paintPads();
});
const lift = (e: PointerEvent) => fingers.delete(e.pointerId) && paintPads();
area.addEventListener('pointerup', lift);
area.addEventListener('pointercancel', lift);
area.addEventListener('lostpointercapture', lift);
area.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false }); // no text selection or loupe on iOS
area.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- the loop: read, show, send

let last = performance.now();
let lastSent = 0;
let sent = '';
let btnSteer = 0;
const wheel = $('wheel');
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // Buttons ramp like the keyboard does in the game: taps are gentle, holds are full lock.
  const target = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
  const rate = target === 0 ? 9 : Math.sign(target) !== Math.sign(btnSteer) ? 10 : 4.5;
  btnSteer += Math.max(-rate * dt, Math.min(rate * dt, target - btnSteer));
  const steer = useTilt && tilt.live && target === 0 ? tilt.read(dt) : btnSteer;
  const brake = held('brake') ? 1 : 0;
  const gas = held('gas') ? 1 : 0;
  wheel.style.transform = `rotate(${(steer * 90).toFixed(1)}deg)`;
  if (!phone?.live) return;
  // Up to ~60 a second while something changes, and a few a second when nothing does (so the game
  // knows the phone is still there, Start tapped or not).
  const key = `${steer.toFixed(3)} ${brake} ${gas}`;
  if ((key !== sent && now - lastSent > 15) || now - lastSent > 150) {
    phone.sendFrame(steer, brake, gas);
    sent = key;
    lastSent = now;
  }
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- go

const code = codeFromUrl();
if (code) connect(code);
else askCode();
