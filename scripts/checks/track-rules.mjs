// Headless checks of the track rules and the wall physics against the game's own code (TrackModel,
// KartPhysics, mpRace's RaceDistance), loaded through Vite's SSR loader. From the repo root:
//   node scripts/checks/track-rules.mjs
// Prints each check and exits 1 if any fails. Takes about 10 s. Rerun it after changing track.ts,
// kart.ts or the lap rules (e.g. the centreline sampling).
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });
const { TrackModel } = await vite.ssrLoadModule('/src/game/track.ts');
const { KartPhysics } = await vite.ssrLoadModule('/src/game/kart.ts');
const { gridPose } = await vite.ssrLoadModule('/src/game/raceMode.ts');
const { RaceDistance } = await vite.ssrLoadModule('/src/game/mpRace.ts');
const presets = JSON.parse(readFileSync(new URL('../../public/tracks/presets.json', import.meta.url), 'utf8'));
const preset = (name) => presets.find((p) => p.name.startsWith(name));

const STEP = 1 / 120;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const steerAt = (p, x, z) => {
  const a = Math.atan2(x - p.x, z - p.z) - p.heading;
  return Math.max(-1, Math.min(1, -Math.atan2(Math.sin(a), Math.cos(a)) * 3));
};
/** race.ts autoControls(), with an optional override of the point it steers at. */
const autopilot = (p, t, aim) => {
  const look = aim ?? t.at(p.s + 5 + p.speed * 0.45);
  let k = 0;
  for (let d = 0; d < 35; d += 2) k = Math.max(k, Math.abs(t.curv[t.at(p.s + d + p.speed * 0.3).i]));
  const vT = Math.min(p.vmax, Math.sqrt((2.1 * 9.81) / Math.max(k, 1e-3)));
  return { throttle: p.speed < vT ? 1 : 0, brake: p.speed > vT + 1.5 ? 1 : 0, steer: steerAt(p, look.x, look.z), drift: false };
};

// 1. Clean laps, every preset both ways: no rejoin, never shorter than the backstop, inside the
//    limits. (Zuera reverse is a known exception: the autopilot itself runs ~7.2 m wide out of the
//    corner after s147-156, where the centreline samples bunch up; T21 / overlap.md O7.)
{
  let rejoins = 0, short = 0;
  const wide = [];
  for (const data of presets)
    for (const rev of [false, true]) {
      const t = new TrackModel(data, rev);
      const p = new KartPhysics(t);
      p.place(gridPose(t).s);
      let last = p.s, crossings = 0, odo0 = 0, maxOff = 0;
      for (let k = 0; k < 120 * 300 && crossings < 3; k++) {
        p.step(STEP, autopilot(p, t));
        if (last > t.length - 40 && p.s < 40 && ++crossings === 2) odo0 = p.odo;
        last = p.s;
        if (crossings !== 2) continue;
        if (p.rejoin) rejoins++;
        maxOff = Math.max(maxOff, Math.abs(p.offset));
      }
      if (crossings < 3 || p.odo - odo0 < t.minLapLength) short++;
      if (maxOff > t.limit) wide.push(`${data.name}${rev ? ' rev' : ''} ${maxOff.toFixed(2)} m`);
    }
  check(rejoins === 0, 'clean laps (44): no rejoins', `${rejoins}`);
  check(short === 0, 'clean laps (44): finished and longer than minLapLength', `${short} short`);
  const unexpected = wide.filter((w) => !w.startsWith('Circuito Internacional de Zuera rev'));
  check(unexpected.length === 0, 'clean laps (44): inside the track limits', wide.length ? `past: ${wide.join('; ')}` : '');
}

// 2. The 39 snap cuts track.md found (straight chords between centreline points the old rules
//    missed): each must end in a forward rejoin or cross the limit.
{
  const cuts = {
    'KF1 Karting Circuit': [[0, 528, 571], [0, 624, 665], [0, 376, 403], [0, 776, 800], [0, 295, 319], [1, 317, 360], [1, 223, 263], [1, 486, 513], [1, 89, 112], [1, 569, 593]],
    'Circuito Internacional de Zuera': [[0, 1586, 1634], [1, 128, 176]],
    'Bahrain International Karting Circuit': [[0, 429, 467], [0, 1321, 1357], [0, 1151, 1187], [0, 1036, 1072], [1, 1032, 1070], [1, 142, 178], [1, 311, 347], [1, 427, 463]],
    'Kartódromo Internacional do Algarve': [[0, 1422, 1456], [0, 1524, 1558], [1, 275, 307], [1, 173, 207]],
    'Orlando Kart Center': [[0, 1034, 1059], [0, 417, 440], [0, 524, 554], [1, 111, 137], [1, 730, 754]],
    'Dubai Kartdrome': [[0, 780, 805], [0, 133, 161], [1, 381, 407], [1, 1023, 1049]],
    'Paul Ricard Karting': [[0, 406, 437], [0, 501, 525], [1, 553, 583], [1, 464, 487]],
    'Kartódromo Granja Viana': [[0, 101, 130], [1, 974, 1002]],
  };
  let n = 0;
  const missed = [];
  for (const [name, list] of Object.entries(cuts))
    for (const [rev, a, b] of list) {
      n++;
      const t = new TrackModel(preset(name), !!rev);
      const i = Math.round((a * t.n) / t.length) % t.n;
      const j = Math.round((b * t.n) / t.length) % t.n;
      const p = new KartPhysics(t);
      p.place(a);
      const steps = Math.ceil(Math.hypot(t.px[j] - t.px[i], t.pz[j] - t.pz[i]) / 0.15);
      let flagged = false;
      for (let k = 1; k <= steps + 260 && !flagged; k++) {
        const q = k <= steps ? { x: t.px[i] + ((t.px[j] - t.px[i]) * k) / steps, z: t.pz[i] + ((t.pz[j] - t.pz[i]) * k) / steps } : t.at(b + (k - steps) * 0.15);
        p.x = q.x;
        p.z = q.z;
        p.locate();
        flagged = (p.rejoin !== null && p.rejoin.gain > 0) || Math.abs(p.offset) > t.limit;
      }
      if (!flagged) missed.push(`${name}${rev ? ' rev' : ''} s${a}->s${b}`);
    }
  check(missed.length === 0, `snap cuts caught ${n - missed.length}/${n}`, missed.join(', '));
}

// 3. KF1, driven: cutting the s528->s571 hairpin infield is a forward rejoin past the limit; the
//    race distance of a multiplayer race (reset to goodS - 2 on the cut) still flags at the line.
{
  const t = new TrackModel(preset('KF1 Karting Circuit'), false);
  const p = new KartPhysics(t);
  p.place(gridPose(t, 0).s);
  const race = new RaceDistance(t.length, p);
  let cut = false, pastLimit = false, flagAt = null;
  for (let k = 0; k < 120 * 200 && flagAt === null; k++) {
    const chord = !cut && p.s > 520 && p.s < 575;
    p.step(STEP, autopilot(p, t, chord ? t.at(571) : undefined));
    if (chord && Math.abs(p.offset) > t.limit) pastLimit = true;
    if (p.rejoin && p.rejoin.gain > 0) {
      cut = true;
      p.place(p.goodS - 2);
    }
    const before = race.dist;
    race.update(p);
    if (before < 2 * t.length && race.dist >= 2 * t.length) flagAt = p.s;
  }
  check(cut && pastLimit, 'KF1 hairpin cut: past the limit and a forward rejoin');
  const off = flagAt === null ? Infinity : Math.min(flagAt, t.length - flagAt);
  check(off < 1, 'KF1 multiplayer: the flag falls at the line after a cut and reset', `${off.toFixed(2)} m`);
}

// 4. TrackModel.nearest() with a stale hint re-acquires a point on another part's road (KF1 back
//    straight measured from the main straight).
{
  const t = new TrackModel(preset('KF1 Karting Circuit'), false);
  const q = t.at(491);
  const n = t.nearest(q.x + 0.3, q.z, 4);
  check(Math.abs(n.s - 491) < 3 && n.dist < 1, 'nearest(): re-acquires from a stale hint', `s${n.s.toFixed(0)}, ${n.dist.toFixed(2)} m`);
}

// 5. Walls, on an oval (400 m straights, so the barrier is far from any other part of the lap):
//    a graze keeps most of its speed and runs along the wall; no angle pins the kart.
{
  const R = 6378137;
  const pts = [];
  const push = (x, z) => pts.push([-(z / R) * (180 / Math.PI), (x / R) * (180 / Math.PI)]);
  for (let x = 0; x < 400; x += 2) push(x, 0);
  for (let a = 0; a < Math.PI; a += 2 / 60) push(400 + 60 * Math.sin(a), 60 - 60 * Math.cos(a));
  for (let x = 400; x > 0; x -= 2) push(x, 120);
  for (let a = 0; a < Math.PI; a += 2 / 60) push(-60 * Math.sin(a), 120 - (60 - 60 * Math.cos(a)));
  const t = new TrackModel({ id: 'oval', name: 'Oval', location: '', center: [0, 0], points: pts, width: 8, lengthM: 0, osmWays: [], source: '' }, false);
  const mid = t.closest(200, 0).i;
  const run = (deg, v) => {
    const p = new KartPhysics(t);
    p.place((mid * t.length) / t.n);
    const [nx, nz] = t.normal(p.hint);
    const wall = t.halfWidth + t.runoff;
    p.x += nx * (wall - 1.5);
    p.z += nz * (wall - 1.5);
    const base = Math.atan2(t.tx[p.hint], t.tz[p.hint]);
    p.heading = base - (deg * Math.PI) / 180; // aimed at the barrier on the right
    p.vx = Math.sin(p.heading) * v;
    p.vz = Math.cos(p.heading) * v;
    p.locate();
    let contact = -1, before = 0, after = 0, impacts = 0, impactSpeed = 0, at1 = -1, angle1 = 0;
    for (let k = 0; k < 120 * 3 && at1 < 0; k++) {
      const vb = p.speed;
      p.step(STEP, { throttle: 1, brake: 0, steer: 0, drift: false });
      if (p.impact && p.offset > 0) {
        impacts++;
        if (contact < 0) {
          contact = k;
          before = vb;
          after = p.speed;
          impactSpeed = p.impact.speed;
        }
      }
      if (contact >= 0 && k === contact + 120) {
        at1 = p.speed;
        const a = p.heading - Math.atan2(t.tx[p.hint], t.tz[p.hint]);
        angle1 = (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) * 180) / Math.PI;
      }
    }
    return { before, after, impacts, impactSpeed, at1: at1 < 0 ? p.speed : at1, angle1 };
  };
  const g = run(10, 25);
  check(g.after >= 0.75 * g.before, '10 deg graze at 90 km/h keeps >= 75% through the contact', `${(g.before * 3.6).toFixed(0)} -> ${(g.after * 3.6).toFixed(0)} km/h`);
  check(g.angle1 < 3, '10 deg graze: nose along the wall a second later', `${g.angle1.toFixed(1)} deg`);
  check(g.impacts >= 1 && g.impactSpeed > 3 && g.impactSpeed < 5, '10 deg graze: one impact event with the closing speed', `${g.impacts} events, first ${g.impactSpeed.toFixed(1)} m/s`);
  const pinned = [5, 10, 20, 35, 60, 90].flatMap((d) => [25, 15].map((v) => [d, v, run(d, v).at1])).filter(([, , s]) => s < 3);
  check(pinned.length === 0, 'walls never pin: > 3 m/s a second after any hit (5-90 deg, 54/90 km/h)', pinned.map(([d, v, s]) => `${d} deg ${v * 3.6} km/h: ${s.toFixed(1)} m/s`).join('; '));
}

await vite.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
