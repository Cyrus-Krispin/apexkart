// "What's new" page (#/changelog), rendered from CHANGELOG.md at build time.
// CHANGELOG.md is the single source of truth: the newest numbered release there is the
// version the site shows (and must match package.json; scripts/release.ts keeps them in step).
import '../styles/changelog.css';
import raw from '../../CHANGELOG.md?raw';
import { escapeHtml } from '../net/api';

interface Item {
  text: string;
  children: string[];
}

interface Release {
  version: string; // "0.3.0" or "Unreleased"
  date: string;
  sections: { title: string; items: Item[] }[];
}

export function parseChangelog(md: string): { intro: string; releases: Release[] } {
  const releases: Release[] = [];
  const intro: string[] = [];
  let rel: Release | null = null;
  let sec: Release['sections'][number] | null = null;
  let item: Item | null = null;
  let nested = false;
  for (const line of md.split('\n')) {
    let m: RegExpExecArray | null;
    if (/^# /.test(line) || /^\[[^\]]+\]:\s*\S+/.test(line)) continue; // title, link references
    if ((m = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line))) {
      rel = { version: m[1], date: m[2] ?? '', sections: [] };
      releases.push(rel);
      sec = null;
      item = null;
    } else if ((m = /^### (.+)/.exec(line)) && rel) {
      sec = { title: m[1].trim(), items: [] };
      rel.sections.push(sec);
      item = null;
    } else if ((m = /^( *)- (.*)/.exec(line)) && sec) {
      nested = m[1].length >= 2 && !!item;
      if (nested) item!.children.push(m[2]);
      else sec.items.push((item = { text: m[2], children: [] }));
    } else if (/^\s+\S/.test(line) && item) {
      // Wrapped continuation of the previous bullet.
      if (nested) item.children[item.children.length - 1] += ' ' + line.trim();
      else item.text += ' ' + line.trim();
    } else if (!rel && line.trim()) intro.push(line.trim());
  }
  return { intro: intro.join(' '), releases };
}

/** Escape, then a small Markdown subset: **bold**, `code`, [text](https://…). */
function inline(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

const log = parseChangelog(raw);

/** The live version: the newest numbered release in CHANGELOG.md. */
export const APP_VERSION = log.releases.find((r) => r.version !== 'Unreleased')?.version ?? '0.0.0';

const ROUTE = /^#\/changelog\/?$/;
const SECTION_KIND: Record<string, string> = { Added: 'added', Changed: 'changed', Fixed: 'fixed', Removed: 'removed', Security: 'fixed', Deprecated: 'removed' };

function formatDate(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(+d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderPage() {
  const releases = log.releases
    .filter((r) => r.sections.some((s) => s.items.length))
    .map((r) => {
      const unreleased = r.version === 'Unreleased';
      const id = unreleased ? 'unreleased' : `v${r.version}`;
      const sections = r.sections
        .filter((s) => s.items.length)
        .map(
          (s) => `<h3 class="cl-kind ${SECTION_KIND[s.title] ?? ''}"><i></i><span class="label">${escapeHtml(s.title)}</span></h3>
          <ul>${s.items
            .map((it) => `<li>${inline(it.text)}${it.children.length ? `<ul>${it.children.map((c) => `<li>${inline(c)}</li>`).join('')}</ul>` : ''}</li>`)
            .join('')}</ul>`,
        )
        .join('');
      return `<section class="cl-rel${r.version === APP_VERSION ? ' current' : ''}" id="${id}">
        <header>
          <h2 class="display">${unreleased ? 'Unreleased' : `<span class="cl-v">v</span>${escapeHtml(r.version)}`}</h2>
          <span class="label">${unreleased ? 'Live now · not yet in a numbered release' : escapeHtml(formatDate(r.date))}</span>
          ${r.version === APP_VERSION ? '<span class="cl-now mono">Current</span>' : ''}
        </header>
        ${sections}
      </section>`;
    })
    .join('');
  return /* html */ `
    <article class="cl-card">
      <header class="cl-head">
        <div><p class="label">Changelog · version ${escapeHtml(APP_VERSION)}</p><h1 class="display">What’s new</h1></div>
        <button class="cl-back" data-act="close"><span class="mono">←</span> Circuits</button>
      </header>
      <p class="cl-intro">${inline(log.intro)}</p>
      ${releases}
    </article>`;
}

/**
 * Mount the changelog route and the version link. `entryParent` gets a small "vX.Y.Z" link
 * (the atlas top bar); the page itself is an overlay, so the atlas underneath keeps its state.
 */
export function initChangelog(o: { entryParent?: HTMLElement | null }) {
  if (o.entryParent) {
    const a = document.createElement('a');
    a.className = 'ver-chip mono';
    a.href = '#/changelog';
    a.title = 'What’s new in ApexKart';
    a.textContent = `v${APP_VERSION}`;
    o.entryParent.prepend(a);
  }
  let page: HTMLElement | null = null;
  let returnHash = ROUTE.test(location.hash) ? '' : location.hash;
  const close = () => {
    location.hash = ROUTE.test(returnHash) ? '' : returnHash;
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const route = () => {
    const open = ROUTE.test(location.hash);
    if (open && !page) {
      page = document.createElement('div');
      page.className = 'cl-page graph-paper';
      page.setAttribute('role', 'dialog');
      page.setAttribute('aria-label', 'Changelog');
      page.innerHTML = renderPage();
      page.querySelector('[data-act="close"]')!.addEventListener('click', close);
      document.body.appendChild(page);
      addEventListener('keydown', onKey);
    } else if (!open && page) {
      page.remove();
      page = null;
      removeEventListener('keydown', onKey);
    }
  };
  addEventListener('hashchange', (e) => {
    const from = new URL(e.oldURL).hash;
    if (!ROUTE.test(from)) returnHash = from;
    route();
  });
  route();
}
