# Watching a room

A screen can join a multiplayer room to watch rather than race: a TV in the room while everyone
races on their own phones, or a friend following along from somewhere else. It opens at
`#/watch/CODE`.

## How it plays

1. In a room's lobby, **Watch link** copies the link. Or, on the multiplayer home, type the room's
   code and press **Watch** instead of **Join**.
2. Between races the screen shows the room: the code, the circuit, who's in and whether they're
   ready, the last results, and a QR code that opens the room to join it and race. The players' lobby
   lists the screens watching ("Watching: …").
3. When the host starts a race, the race opens on the screen by itself, a few seconds before the
   lights. A screen that arrives mid-race opens the race in progress.
4. In the race:
   - The camera follows the leader. When someone takes the lead, it switches to them once they've
     held it for a moment. After the winner's flag it stays on them briefly, then moves to the race
     behind.
   - Click a driver in the timing tower, or press **1**–**8** for a position, to follow them. **Follow
     leader** or **A** goes back to the leader.
   - **C** or the camera button cycles Chase, Far chase (the default) and TV, an overhead camera.
   - The tower shows positions, laps and gaps, the map shows every kart (the one on camera ringed in
     white), and the speedometer is the followed kart's speed.
   - **Esc** or **Room** shows the room over the race, and Esc or **Back to race** returns.
5. When everyone is home the classification comes up. After 15 seconds the screen goes back to the
   room, ready for the next race.

There's no sound, since the screen has no kart of its own.

## How it's built

```
players' race views ──WebRTC poses──▶ RoomClient.watch (src/net/room.ts)
                                           │
                     WatchController (src/watchController.ts)
                       │                                 │
                 WatchBoard (between races)     Race { mode.watch } + WatchRace add-on
                 src/ui/watchBoard.ts           src/game/race.ts, src/game/watchRace.ts
                                                         │
                                                WatchOverlay (src/ui/watchOverlay.ts)
```

- **The room** (`api/room.ts`): `watch` adds the screen to the room as a watcher (`w:{mid}` in the
  room hash, listed in `state.watchers`, up to 8). A watcher polls and heartbeats like a player and is
  dropped the same way after 35 s of silence, but it isn't on the grid, can't ready, start or finish,
  never becomes host, and doesn't keep the room open. Signaling is allowed between a player and a
  watcher, never between two watchers. See [MULTIPLAYER.md](../MULTIPLAYER.md).
- **The links**: `RoomClient` links a player with every player and every watcher, and a watcher with
  every player (`links()`). The mesh needs nothing new: a player's poses already go to every peer, so
  a watcher receives them like another player would. If a direct link fails, a watcher reads the
  players' poses through the relay without posting one.
- **The race view**: a `Race` with `mode.watch`. Its own kart is hidden and never steps, there's no
  sound, no phone and no pause menu. Each frame it asks the add-on's `follow()` for the kart to film
  (where it's drawn, its heading, speed and yaw rate) and points the usual cameras at it. A different
  kart cuts the camera instead of sweeping across the circuit. The cockpit camera is skipped.
- **WatchRace** (`src/game/watchRace.ts`): draws the whole field with `RemoteKarts`, every kart solid
  (no contact rules, since nobody here races them), and works out the standings the way
  `MultiplayerRace` does. It picks who the camera follows, draws the minimap dots and feeds the
  overlay.
- **The controller** (`src/watchController.ts`) loads on the first `#/watch` (`src/watch.ts` is just
  the route). It opens a race view for each race the room starts, shows the board between races, and
  handles Esc. While it's open it holds a screen wake lock (`src/ui/wakeLock.ts`, shared with the
  party screen, a laptop with a live phone wheel and the phone page), so the screen doesn't dim.

## Testing

`npm run dev`, create a room in one tab, then open `#/watch/CODE` in another (or press Watch on the
multiplayer home). In development `window.__watch` is the controller: `__watch.watchRace.rows` has
the standings and `.target` who the camera is on.

The end-to-end check runs headless Chromium with two light players and one watching screen. The
players are the room and the mesh, driving the centreline at set speeds. With software GL, several
race views in one browser starve each other for longer than a room waits for a heartbeat. It checks:

- watchers in the API: they can't ready or start, they link only with players, a watcher who joins
  becomes a player, and the room closes with its last player
- the Watch button, the board's QR code, and "Watching: …" in the players' lobby
- a direct link to each player
- the race opening by itself, the karts moving, and the camera on the leader
- following by click, Follow leader and A
- the camera button and C (never the cockpit)
- the camera switching when the leader changes
- Esc to the room and back
- the classification, then the room again with the last results
- leaving

An online race between a real player and a light one still works: direct link, standings, the
classification and the lobby. The party and the phone controller tests still pass too.
