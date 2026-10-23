// Party: split screen on one laptop or TV, a phone for each player (#/party). This is only the
// "Party" button and the route: the party itself (src/partyController.ts) loads when it first opens,
// so the home screen doesn't carry it. See docs/party.md.
export interface PartyHost {
  /** Element races are mounted in (the same one time trials use). */
  container: HTMLElement;
  /** The party is taking over the screen: hide the app and stop any time trial. */
  enter(): void;
  /** The party closed: show the app again. */
  leave(): void;
  /** Where to put the "Party" button. */
  entryParent?: HTMLElement | null;
}

export const PARTY_HASH = /^#\/party\/?$/;

const PARTY_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="4" width="8" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

export function initParty(host: PartyHost) {
  if (host.entryParent) {
    const b = document.createElement('button');
    b.className = 'btn primary mp-entry pt-entry';
    b.innerHTML = `${PARTY_ICON}<span class="mp-entry-label">Party</span>`;
    b.setAttribute('aria-label', 'Party: split screen');
    b.title = 'Split screen on this computer, with a phone for each player';
    b.addEventListener('click', () => (location.hash = '#/party'));
    const after = host.entryParent.querySelector('.pc-entry') ?? host.entryParent.querySelector('.mp-entry');
    if (after) after.after(b);
    else host.entryParent.prepend(b);
  }
  // Until the party first opens, remember where we were, to go back there.
  let returnHash = PARTY_HASH.test(location.hash) ? '' : location.hash;
  const route = () => {
    if (!PARTY_HASH.test(location.hash)) {
      returnHash = location.hash;
      return;
    }
    removeEventListener('hashchange', route); // the controller routes from now on
    import('./partyController').then(
      ({ PartyController }) => new PartyController(host, returnHash),
      () => addEventListener('hashchange', route), // offline: try again next time
    );
  };
  addEventListener('hashchange', route);
  route();
}
