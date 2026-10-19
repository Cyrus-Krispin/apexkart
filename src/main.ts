import './styles/base.css';
import './styles/atlas.css';
import './styles/race.css';
import { Atlas } from './ui/atlas';
import { Race } from './game/race';
import { loadDriver } from './net/api';
import { initMultiplayer } from './multiplayer';
import { initChangelog } from './ui/changelog';

const driver = await loadDriver();
const atlasRoot = document.getElementById('atlas')!;
const gameRoot = document.getElementById('game')!;
let race: Race | null = null;

const atlas = new Atlas({
  root: atlasRoot,
  driver,
  onRace: (track, dir) => {
    atlas.hide();
    race?.dispose();
    race = new Race({
      track,
      dir,
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
    race?.dispose();
    race = null;
    atlas.hide();
  },
  leave: () => atlas.show(),
});

// What's new (#/changelog) and the version link in the top bar.
initChangelog({ entryParent: atlasRoot.querySelector<HTMLElement>('.top-right') });
