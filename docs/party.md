# Party: split screen, a phone each

Up to four players race on one screen (a laptop, or a TV it's plugged into), each in their own view,
each steering with their own phone. **Party** in the top bar opens it (`#/party`).

## How it plays

1. The lobby shows one QR code and four seats, P1 to P4. Each phone scans the code (or opens
   `/pad.html` and types it) and takes the first free seat. The phone shows its seat in its kart's
   colour: P1 red, P2 blue, P3 green, P4 pink.
2. The laptop picks the circuit, direction, laps and time of day. **Start** on the laptop, or Start
   on any phone, races everyone whose phone is connected.
3. Each view is one kart's chase camera with a trimmed HUD: position (1st, 2nd…) and lap, speed, map,
   the start lights and banners. Two players go one above the other or side by side, whichever gives
   views nearer 16:9 (one above the other on a laptop or TV); three or four share a 2 × 2 grid, and
   with three the fourth cell is the live standings.
4. The lights go out for everyone together once every view has built its world and every phone is
   connected.
5. Any phone's **Pause** pauses everyone (one menu over all the views), and any phone's **Resume** or
   Esc on the laptop resumes. **Reset** puts that phone's kart back on the track.
6. At the flag (or 45 s after the winner, as online) the classification comes up over the views.
   **Race again** (or Start on any phone) goes straight to the next race, with the grid turned round
   one place, so everyone gets a go on pole. **Back to the party** returns to the lobby.

## How it's built

```
phones (pad.html) ──WebRTC──▶ PartyScreen (src/net/pad.ts): one PadConn per seat
                                   │ steering, buttons
                                   ▼
PartyController (src/partyController.ts) ── lobby (src/ui/partyLobby.ts)
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
             Race + MultiplayerRace (one per player, each in its own grid cell)
                    └──────────────┼──────────────┘
                                   ▼
                    PartyHub (src/game/partyHub.ts): a room in this page
```

- **Pairing**: a party code is a phone-controller code (`api/pad.ts`) opened with `party: 1`. The
  hash `ak:pad:{code}` keeps a field per seat (`p0`..`p3`) holding that phone's id; a phone joining
  takes the first free one (`HSETNX`, so two phones can't take the same seat). A phone keeps its seat
  through a dropped link or a reload of either side; reconnecting never takes someone else's seat,
  and a phone the laptop removed (✕ in the lobby) is told so. The laptop answers each phone's offer
  with `to` naming the phone. A fifth phone is turned away.
- **One Race per player.** Each player's view is an ordinary `Race` (src/game/race.ts) mounted in its
  own cell, with its own WebGL context and world. `RaceOptions.party` gives it its phone (`PadSource`:
  steering for `Input`, vibration for `Haptics`), its share of the volume, a fixed quality tier (Low
  for two or more players: Auto would measure, and remember for this computer, a laptop drawing
  several races), and a callback once its world is warmed up. Party races save no personal bests and
  submit nothing to the leaderboards: they're guests' laps on this computer's profile.
- **One race.** Each Race has a `MultiplayerRace` (src/game/mpRace.ts), as online. Its room is a seat
  on a `PartyHub`, which implements the same small interface (`RaceRoom`) as `RoomClient`: poses and
  finishes from one kart go straight to the others, and the hub keeps the room state (grid, finishes,
  the result) and closes the race when everyone is done or `FINISH_GRACE_MS` after the winner. So the
  grid, contact, slipstream, standings and the finish are the multiplayer ones. Standings use the
  hub's copy of everyone's progress, so no two views disagree on the order.
- **The start.** Races are created with a start far in the future. When every view is ready and every
  phone is connected (or after 45 s for a slow world, or 20 s for a phone that doesn't come back),
  the start moves to 6 s from now in every race and its MultiplayerRace together.
- **Pause.** The hub's clock stops while the party is paused, and on resume every race's start moves
  later by the pause, so nobody's time includes it and karts don't jump.
- **Phones dropping.** A phone that drops mid-race (locked, out of range) pauses everyone; the menu
  waits for it and offers **Race on without P3**, which retires that kart (DNF).

## Testing

Headless, with simulated phones (see the Testing section of [phone-controller.md](phone-controller.md)):
three phones join, take P1–P3, start from a phone, lights out together, one phone's tilt steers only
its kart, pause and resume from different phones (the start moves by the pause), a phone dropping
pauses everyone, race on without it (DNF), the classification, race again with the grid turned
round, back to the lobby. Also two and four players, removing a phone and it scanning again, a full
party turning away a fifth phone, and the laptop reloading in the lobby (phones back in their seats
in ≈4 s).

Software GL draws about one frame a second for three views, so a headless run can't judge the frame
rate. Not yet measured on real hardware: four views draw four worlds, which is why a party races on
Low.
