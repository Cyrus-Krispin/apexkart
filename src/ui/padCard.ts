// Phone controller, the screen side: the "Phone" button in the home header, and the card with the
// QR code a phone scans to become the steering wheel (src/net/pad.ts, docs/phone-controller.md).
// Also opened from the briefing and the pause menu.
import { phonePad, type PadStatus } from '../net/pad';
import { escapeHtml } from '../net/api';
import './pad.css';

export const PHONE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 17.5h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** Short state for menus and toggles. */
export const PAD_STATE: Record<PadStatus, string> = { off: 'Off', waiting: 'Pairing', connecting: 'Pairing', live: 'Connected', lost: 'Reconnecting' };

/** Home header button, reconnect after a reload, and the phone's Start button. Call once. */
export function initPhonePad(o: { entryParent?: HTMLElement | null }) {
  if (o.entryParent) {
    const b = document.createElement('button');
    b.className = 'btn primary mp-entry pc-entry';
    b.innerHTML = `${PHONE_ICON}<span class="mp-entry-label">Phone</span>`;
    b.setAttribute('aria-label', 'Phone controller');
    b.title = 'Steer with your phone';
    b.addEventListener('click', () => openPadCard());
    const mp = o.entryParent.querySelector('.mp-entry');
    if (mp) mp.after(b);
    else o.entryParent.prepend(b);
    const paint = (s: PadStatus) => b.classList.toggle('live', s === 'live');
    phonePad.on('status', paint);
  }
  // Start on the phone starts the race from the briefing, as any key does on the laptop.
  phonePad.on('button', (b) => {
    if (b !== 'go') return;
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
  });
  phonePad.resume();
  if (import.meta.env.DEV) (window as { __pad?: typeof phonePad }).__pad = phonePad;
}

let open: PadCard | null = null;

/** Show the pairing card (or bring the open one back). */
export function openPadCard() {
  open ??= new PadCard(() => (open = null));
}

class PadCard {
  private el: HTMLDivElement;
  private off: () => void;
  private closeTimer = 0;
  private tick = window.setInterval(() => this.paint(), 1000); // the link time settles after a few pings
  private wasLive = phonePad.live;
  private shownCode: string | null = null;

  constructor(private onClose: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'pc-scrim';
    this.el.innerHTML = `
      <div class="pc-card" role="dialog" aria-modal="true" aria-labelledby="pc-title">
        <header class="pc-head">
          <p class="label">Phone controller</p>
          <button class="pc-x" data-act="close" aria-label="Close">×</button>
        </header>
        <div class="pc-body">
          <div class="pc-qr" data-el="qr"><span class="pc-qr-wait mono">…</span></div>
          <div class="pc-side">
            <h2 class="display" id="pc-title">Your phone is the wheel</h2>
            <ol class="pc-steps">
              <li>Scan the code with your phone’s camera.</li>
              <li>Tap <b>Start</b> on the phone and allow motion if it asks.</li>
              <li>Hold it sideways and tilt to steer. Press the screen to brake.</li>
            </ol>
            <div class="pc-typed">
              <span class="pw-k">Or open <span class="mono" data-el="host"></span> and type</span>
              <b class="pc-code mono" data-el="code">····</b>
            </div>
          </div>
        </div>
        <p class="pc-warn" data-el="warn" hidden></p>
        <footer class="pc-foot">
          <p class="pc-status"><i class="pc-dot"></i><span data-el="status"></span></p>
          <button class="btn" data-act="disconnect" data-el="disconnect">Disconnect</button>
          <button class="btn" data-act="renew" data-el="renew" hidden>New code</button>
          <button class="btn primary" data-act="close" data-el="done">Done</button>
        </footer>
      </div>`;
    document.body.appendChild(this.el);
    this.$('host').textContent = `${location.host}/pad.html`;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) return this.close(); // the scrim
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close') this.close();
      if (act === 'disconnect') {
        phonePad.close();
        this.close();
      }
      if (act === 'renew') this.start();
    });
    addEventListener('keydown', this.onKey, true);
    this.off = phonePad.on('status', () => this.paint());
    this.warn();
    this.start();
    this.$<HTMLButtonElement>('done').focus();
  }

  private $<T extends HTMLElement = HTMLElement>(k: string) {
    return this.el.querySelector<T>(`[data-el=${k}]`)!;
  }

  /** A modal: keys don't reach the game behind it (any key starts a race from the briefing). */
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') this.close();
  };

  private async start() {
    this.paint();
    try {
      await phonePad.open();
    } catch (e) {
      this.$('status').textContent = 'Couldn’t open a code. Check the connection and try again.';
      this.$('renew').hidden = false;
      console.warn('[pad] open failed', e);
      return;
    }
    this.paint();
  }

  private paint() {
    const s = phonePad.status;
    const card = this.el.firstElementChild as HTMLElement;
    card.dataset.status = s;
    const text: Record<PadStatus, string> = {
      off: 'This code has expired.',
      waiting: 'Waiting for your phone…',
      connecting: 'Phone found, connecting…',
      live: `Connected${phonePad.rtt != null ? ` · ${Math.round(phonePad.rtt)} ms` : ''} · ${phonePad.tilt ? 'tilt to steer' : 'steer with the buttons on the phone'}`,
      lost: 'Phone dropped. Waiting for it to come back…',
    };
    this.$('status').textContent = text[s];
    this.$('disconnect').hidden = s === 'off' || s === 'waiting';
    this.$('renew').hidden = s !== 'off';
    if (phonePad.code !== this.shownCode) this.drawCode(phonePad.code);
    // Connected: say so for a moment, then get out of the way.
    if (s === 'live' && !this.wasLive) this.closeTimer = window.setTimeout(() => this.close(), 1600);
    this.wasLive = s === 'live';
  }

  private async drawCode(code: string | null) {
    this.shownCode = code;
    this.$('code').textContent = code ?? '····';
    const qr = this.$('qr');
    if (!code) {
      qr.innerHTML = '<span class="pc-qr-wait mono">…</span>';
      return;
    }
    const { encode } = await import('uqr'); // only when someone pairs a phone
    if (this.shownCode !== code) return;
    const { data, size } = encode(phonePad.url, { ecc: 'M', border: 2 });
    let d = '';
    data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    qr.innerHTML = `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code: ${escapeHtml(phonePad.url)}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0b0c10"/></svg>`;
  }

  /** Things that stop a phone joining from here, in development mostly. */
  private warn() {
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    const msg = local
      ? 'Your phone can’t reach “localhost”. Open the game at this computer’s network address instead (<code class="mono">npm run dev -- --host</code>).'
      : location.protocol !== 'https:'
        ? 'Over plain http, phones won’t share their motion sensor: the phone will offer steer buttons instead of tilt.'
        : '';
    this.$('warn').hidden = !msg;
    this.$('warn').innerHTML = msg;
  }

  close() {
    clearTimeout(this.closeTimer);
    clearInterval(this.tick);
    removeEventListener('keydown', this.onKey, true);
    this.off();
    // Nobody joined: no need to keep the code open (and polling) once the card is closed.
    if (phonePad.status === 'waiting') phonePad.close();
    this.el.classList.add('out');
    setTimeout(() => this.el.remove(), 200);
    this.onClose();
  }
}
