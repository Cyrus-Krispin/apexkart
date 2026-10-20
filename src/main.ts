import './styles/base.css';
import './styles/atlas.css';
import './styles/race.css';
import { Atlas } from './ui/atlas';
import type { Race } from './game/race';
import { loadDriver } from './net/api';
import { initMultiplayer } from './multiplayer';
import { initChangelog } from './ui/changelog';

const driver = await loadDriver();
const atlasRoot = document.getElementById('atlas')!;
const gameRoot = document.getElementById('game')!;
let race: Race | null = null;
let starting = 0; // a newer start (or leaving) cancels one still loading the race code

// The race (and Three.js, most of the code) loads on demand, so the home screen is quick on phones.
// Fetch it once the home screen is idle, so starting a race is still instant.
const loadRace = () => import('./game/race');
const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
if (idle) idle(() => loadRace(), { timeout: 4000 });
else setTimeout(() => loadRace(), 2500);

const atlas = new Atlas({
  root: atlasRoot,
  driver,
  onRace: async (track, dir, daily, rival) => {
    atlas.hide();
    race?.dispose();
    race = null;
    const ticket = ++starting;
    const { Race } = await loadRace();
    if (ticket !== starting) return;
    race = new Race({
      track,
      dir,
      daily,
      rival,
      driver,
      container: gameRoot,
      onExit: () => {
        race?.dispose();
        race = null;
        atlas.show();
      },
    });
  },
});

// Multiplayer rooms (#/room/CODE). See MULTIPLAYER.md.
initMultiplayer({
  driver,
  container: gameRoot,
  entryParent: atlasRoot.querySelector<HTMLElement>('.top-right') ?? atlasRoot,
  enter: () => {
    starting++;
    race?.dispose();
    race = null;
    atlas.hide();
  },
  leave: () => atlas.show(),
});

// What's new (#/changelog) and the version link in the top bar.
initChangelog({ entryParent: atlasRoot.querySelector<HTMLElement>('.top-right') });
