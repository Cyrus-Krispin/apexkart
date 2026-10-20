import { escapeHtml, saveDriver, type Driver } from '../net/api';
import { kartIcon } from './trackArt';
import { MEDALS, MEDAL_NAME, medalCounts } from '../game/medals';
import { APP_VERSION } from './changelog';

export const LIVERIES = ['#ff4d00', '#141414', '#f2eee5', '#e5383b', '#ffc600', '#16a34a', '#0ea5e9', '#2f4bff', '#8b5cf6', '#ec4899'];

export function cleanDriverName(s: string): string {
  return s.replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, 16);
}

/** Driver chip in the top bar + popover to edit name and livery. */
export class ProfileMenu {
  private pop: HTMLDivElement;
  private open = false;

  constructor(
    private btn: HTMLElement,
    private driver: Driver,
    private onChange: () => void,
  ) {
    this.pop = document.createElement('div');
    this.pop.className = 'profile-pop';
    this.pop.hidden = true;
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'Your driver');
    document.body.appendChild(this.pop);
    this.renderChip();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.open ? this.close() : this.show();
    });
    document.addEventListener('click', (e) => {
      if (this.open && !this.pop.contains(e.target as Node)) this.close();
    });
    addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  private renderChip() {
    this.btn.innerHTML = `<span class="pb-kart">${kartIcon(this.driver.color, 26)}</span><span class="pb-name">${escapeHtml(this.driver.name)}</span><span class="pb-caret mono">▾</span>`;
  }

  private show() {
    const r = this.btn.getBoundingClientRect();
    this.pop.style.top = `${r.bottom + 8}px`;
    this.pop.style.right = `${Math.max(12, innerWidth - r.right)}px`;
    this.pop.innerHTML = `
      <div class="pp-head"><span class="label">Your driver</span><span class="label">Saved on this device</span></div>
      <div class="pp-kart graph-paper">${kartIcon(this.driver.color, 84)}</div>
      <label class="pp-field"><span class="label">Name on the board</span>
        <input maxlength="16" value="${escapeHtml(this.driver.name)}" spellcheck="false" autocomplete="off" /></label>
      <div class="pp-field"><span class="label">Livery</span>
        <div class="pp-swatches">${LIVERIES.map((c) => `<button style="--c:${c}" data-c="${c}" class="${c === this.driver.color ? 'on' : ''}" aria-label="Livery ${c}"></button>`).join('')}</div></div>
      ${this.medalRow()}
      <a class="pp-link" href="#/changelog">What’s new <span class="mono">v${APP_VERSION}</span></a>`;
    const input = this.pop.querySelector('input')!;
    input.addEventListener('input', () => {
      const v = cleanDriverName(input.value);
      if (v !== input.value) input.value = v;
      this.driver.name = v.trim() || 'Driver';
      saveDriver(this.driver);
      this.renderChip();
      this.onChange();
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && this.close());
    this.pop.querySelector('.pp-swatches')!.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).dataset.c;
      if (!c) return;
      this.driver.color = c;
      saveDriver(this.driver);
      this.pop.querySelectorAll<HTMLElement>('.pp-swatches button').forEach((b) => b.classList.toggle('on', b.dataset.c === c));
      this.pop.querySelector('.pp-kart')!.innerHTML = kartIcon(c, 84);
      this.renderChip();
      this.onChange();
    });
    this.pop.hidden = false;
    this.open = true;
    this.btn.classList.add('open');
    requestAnimationFrame(() => this.pop.classList.add('in'));
  }

  private medalRow() {
    const n = medalCounts();
    const total = MEDALS.reduce((a, m) => a + n[m], 0);
    return `<div class="pp-field"><span class="label">Medals</span>${
      total
        ? `<div class="pp-medals">${[...MEDALS].reverse().map((m) => `<span title="${MEDAL_NAME[m]}"><i class="medal m-${m}"></i><b class="mono">${n[m]}</b></span>`).join('')}</div>`
        : '<p class="pp-none">Beat a target time on any circuit to win your first.</p>'
    }</div>`;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.pop.classList.remove('in');
    this.btn.classList.remove('open');
    this.pop.hidden = true;
  }
}
