import './styles.css';
import { Picker } from './ui/picker';
import { Race } from './game/race';
import { loadDriver } from './net/api';

const driver = await loadDriver();
const pickerRoot = document.getElementById('picker')!;
const gameRoot = document.getElementById('game')!;
let race: Race | null = null;

const picker = new Picker({
  root: pickerRoot,
  driver,
  onRace: (track, dir) => {
    picker.hide();
    race?.dispose();
    race = new Race({
      track,
      dir,
      driver,
      container: gameRoot,
      onExit: () => {
        race?.dispose();
        race = null;
        picker.show();
      },
    });
  },
});
