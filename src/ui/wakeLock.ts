// Keeping the screen on while nobody touches it: a screen that's watching a race, a party split
// screen steered by phones, a laptop steered by a phone wheel, and the phone itself. Each of those
// holds the lock while it's up; the screen may sleep again once none does. The browser drops the lock
// whenever the page is hidden, so it's asked for again when the page comes back.

type Sentinel = { release(): Promise<void>; addEventListener?(type: 'release', fn: () => void): void };
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> };

const holders = new Set<object>();
let sentinel: Sentinel | null = null;
let asking = false;
let listening = false;

const api = () => (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;

async function acquire() {
  const wl = api();
  if (!wl || sentinel || asking || !holders.size || document.hidden) return;
  asking = true;
  try {
    const s = await wl.request('screen');
    if (!holders.size) {
      s.release().catch(() => undefined); // let go while we were asking
      return;
    }
    sentinel = s;
    s.addEventListener?.('release', () => sentinel === s && (sentinel = null));
  } catch {
    // Refused: battery saver, or (some browsers) no tap on the page yet. Try again on the next one.
    addEventListener('pointerdown', retry, { once: true, capture: true });
    addEventListener('keydown', retry, { once: true, capture: true });
  } finally {
    asking = false;
  }
}

function retry() {
  removeEventListener('pointerdown', retry, { capture: true });
  removeEventListener('keydown', retry, { capture: true });
  acquire();
}

/** Keep the screen on until the returned function is called. */
export function keepAwake(): () => void {
  if (!listening) {
    listening = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) sentinel = null; // the browser released it
      else acquire();
    });
  }
  const me = {};
  holders.add(me);
  acquire();
  return () => {
    if (!holders.delete(me) || holders.size) return;
    sentinel?.release().catch(() => undefined);
    sentinel = null;
  };
}
