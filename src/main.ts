import './styles/base.css';
import './styles/atlas.css';
import './styles/race.css';
import { Atlas } from './ui/atlas';
import { Race } from './game/race';
import { loadDriver } from './net/api';

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
