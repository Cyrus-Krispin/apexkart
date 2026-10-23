// Watching a multiplayer room on a screen that doesn't race (#/watch/CODE): a TV for everyone in
// the room, or a friend following along. This is only the route: the watching itself
// (src/watchController.ts) loads when it first opens. See docs/watch.md.
import type { Driver } from './net/api';

export interface WatchHost {
  /** Whose screen this is: the name the room's players see. */
  driver: Driver;
  /** Element races are mounted in (the same one time trials use). */
  container: HTMLElement;
  /** Watching is taking over the screen: hide the app and stop any time trial. */
  enter(): void;
  /** Watching closed: show the app again. */
  leave(): void;
}

export const WATCH_HASH = /^#\/watch(?:\/([A-Za-z0-9]{4}))?\/?$/;

export function initWatch(host: WatchHost) {
  // Until watching first opens, remember where we were, to go back there.
  let returnHash = WATCH_HASH.test(location.hash) ? '' : location.hash;
  const route = () => {
    if (!WATCH_HASH.test(location.hash)) {
      returnHash = location.hash;
      return;
    }
    removeEventListener('hashchange', route); // the controller routes from now on
    import('./watchController').then(
      ({ WatchController }) => new WatchController(host, returnHash),
      () => addEventListener('hashchange', route), // offline: try again next time
    );
  };
  addEventListener('hashchange', route);
  route();
}
