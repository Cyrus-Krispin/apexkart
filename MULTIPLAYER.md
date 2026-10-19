# Multiplayer

Players create a room, share a link (`/#/room/K7QX`) or the 4-character code, and race each other
live on the same track. The host picks track, direction and laps (default 3), everyone readies up,
and a synchronised countdown starts the race for all. Up to 8 players per room.

## Transport: WebRTC mesh, signaling through Redis

Vercel functions can't hold WebSockets, so live traffic can't go through our own backend. Options:

| Option | Latency | Works on every network | New account / key | Cost |
| --- | --- | --- | --- | --- |
| **WebRTC data channels between players, signaling via `/api/room` on the existing Upstash Redis** (chosen) | lowest (direct) | most pairs (typically 80–90%) with STUN only; the rest fall back to a slow relay (below) | none | a few Redis commands per player per few seconds; no per-message cost |
| Managed realtime (PartyKit/Durable Objects, Ably, Pusher, Supabase Realtime, Liveblocks) | low (via their edge) | yes | yes | free tiers are message-capped: 20 Hz × 8 players burns through them quickly |
| Polling Redis at 15–20 Hz | — | yes | none | impossible on the free tier (≈100+ commands/s per room) |

We went with WebRTC because it needs nothing new. A managed service would be the upgrade if strict-NAT
players turn out to be common (see *Limitations*).

- **Mesh**: one `RTCPeerConnection` per pair, with two negotiated data channels: `ctl` (reliable:
  pings, "state changed" nudges, finish events, bye) and `pos` (unordered, no retransmits: poses at 20 Hz).
- **Signaling**: non-trickle ICE, so a connection costs exactly one offer and one answer, each a
  single `signal` call into the peer's Redis inbox. The *later joiner* always makes the offer, so
  there's never glare.
- **STUN only** (`stun.l.google.com`, `stun.cloudflare.com`: public, no key). Symmetric NAT / CGNAT
  pairs (common on mobile data) can't connect without TURN. Once an attempt fails (after ~10–25 s), that pair
  uses the **relay**: during a race, each such player posts its pose to `/api/room` (`relay`) about
  3×/s and reads the others'. Remote karts stay usable thanks to extrapolation (median error ≈1 m
  in tests) but look less smooth. The lobby shows each link as `● 12 ms` (direct), `● relayed`
  or `● connecting…`. P2P is retried every 45 s in the background.
- **Adding TURN later**: set `VITE_ICE_SERVERS` at build time to a JSON `RTCIceServer[]` (e.g. Cloudflare
  TURN or metered.ca credentials). No code changes needed.

## How it fits together

```
src/shared/room.ts        protocol: types, limits, timings (shared by client and API)
api/room.ts               the room endpoint (POST actions + GET track), on api/_lib/store.ts
src/net/room.ts           RoomClient: API calls, adaptive polling, server clock, per-tab identity, relay
src/net/mesh.ts           Mesh: WebRTC peers, signaling, link state, ping/RTT
src/game/raceMode.ts      the narrow hook interface Race exposes to add-ons
src/game/mpRace.ts        MultiplayerRace add-on: progress, finish, pose streaming, standings
src/game/remoteKarts.ts   other players' karts: dead reckoning, smoothing, name tags, contact
src/ui/raceOverlay.ts     in-race HUD: position, lap X/N, standings, countdown, results card
src/ui/lobby.ts           lobby: create/join, players, track/dir/laps, ready/start, last results
src/ui/multiplayer.css    all multiplayer styles (.mp-* classes, variables with fallbacks)
src/multiplayer.ts        controller: #/room routing, owns RoomClient + lobby + multiplayer Race
dev/mp-test.html          dev-only bench: N players side by side in one tab
```

### Rooms (`api/room.ts`)

All writes are authenticated by a per-tab secret (`mid = sha256(secret)[:12]`, as with lap
submissions). The secret lives in `sessionStorage`, so **each tab is a player** (two tabs can race
each other) and a reload keeps your seat. Duplicated tabs are detected over a `BroadcastChannel`.

Redis keys (all short-lived):

| Key | Contents | Expiry |
| --- | --- | --- |
| `ak:room:{code}` (hash) | `cfg` (settings, phase, grid, last results) and per player `p:` profile, `s:` last seen, `r:` ready, `f:` finish, `m:` signal count, `k:` kicked | 120 s after the last heartbeat |
| `ak:room:{code}:in:{mid}` | that player's pending offers/answers | 120 s |
| `ak:room:{code}:trk` | the room's track geometry, so every client races identical geometry | 6 h |
| `ak:room:{code}:rl:{mid}` | latest relayed pose | 5 s |

Actions (`POST /api/room {a, code, s, ...}`): `create`, `join`, `poll`, `leave` (`soft` on tab
close), `signal`, `relay`, `ready`, `profile`, `config` (host), `start` (host), `finish`, `end` (host),
`kick` (host). `GET /api/room?code=&trk=1` returns the track.

Lifecycle and rules (housekeeping runs lazily inside any request that loads the room):

- **Ready** is versioned: a player is ready when `r:` equals `cfg.v`. Any settings change, or the end
  of a race, bumps `v`, which un-readies everyone without touching their fields.
- **Start** (host; everyone else ready) shuffles the grid and sets `startAt = now + 7 s` (server time).
- **Race end**: when every grid player has finished, retired or left, or 45 s after the winner, or
  at a hard cap. The results go to `cfg.last`, and the phase returns to `lobby`.
- **Leaving**: *Leave* removes you immediately. Closing or reloading the tab sends a `soft` leave
  (via `sendBeacon`) that drops you 8 s later unless you come back, so a reload keeps host and ready
  state. Silent players (crash, lost network) are dropped after 35 s without a heartbeat.
- **Host migration**: the earliest-joined remaining player becomes host. The last player out deletes the room.
- **Expiry**: a room with no activity (join, settings, start) for 30 min closes. Keys expire 2 min
  after the last heartbeat, so abandoned rooms clean themselves up.
- Concurrent `cfg` writes use compare-and-set (a tiny Lua script on Redis; plain compare in the
  in-memory dev store).
- Colours are unique per room: joiners with a taken colour get a free one, and taken swatches are disabled.

### Netcode

- **Clock**: every API response carries server time; the client keeps the lowest-RTT sample
  (NTP-style). `startAt` and pose timestamps use this clock.
- **Synchronised start**: `Race` derives its grid timer from `startAt` (`mode.startAt`), so every
  client's lights go out together, including clients that arrive late or were in a background tab.
  Race times are measured from your own lights-out to your own flag on the same local clock, so
  clock error between players doesn't affect results.
- **Poses** (`PoseTuple`): `[t, x, z, heading, vx, vz, yawRate, steer, progress, raceId]`, ~100 bytes
  of JSON, 20 Hz.
- **Rendering others**: instead of interpolating ~100 ms in the past, each remote kart is
  dead-reckoned to *now* along an arc (velocity + yaw rate, capped at 350 ms), then the displayed pose
  moves with the kart's velocity and is pulled towards that target (no steady-state lag, smooth corrections, snap
  beyond 8 m). Measured on localhost: median 4 cm / p90 17 cm off at racing speed (direct link),
  ≈1 m through the relay.
- **Contact**: each client resolves its own kart against the karts it sees (ellipse footprints, push
  out and remove closing speed). This is symmetric enough without a server.
- **Progress / laps**: `MultiplayerRace` integrates distance along the centreline. It wraps at the
  line and ignores jumps no kart could make in one step, so going back and forth over the line or
  cutting across the infield earns nothing. The flag is at `laps × length`, and the crossing
  is interpolated within the physics step. After the flag the kart drives a cool-down lap on autopilot.
- **Standings**: finished players by time, then by progress, then DNF / left. Every client computes
  the same order. Position badges also appear on name tags and the minimap.
- **Trust**: like the leaderboard, the client is trusted. The server only rejects implausible
  finish times (faster than 30 m/s average).

### Upstash budget (free tier: 500K commands/month)

| Situation | Commands |
| --- | --- |
| Lobby poll (every 2 s; 0.6 s while connecting; 8 s in a background tab) | 1 (`HGETALL`), +1 when signals are waiting |
| Heartbeat (every 8 s, rides on a poll) | +2 |
| Race poll (every 3 s) | 1 |
| Connection setup per pair | ~10 |
| Relay (only for pairs without p2p, while racing) | 2 per ~0.3 s per relayed player |

A 4-player session with a 3-minute lobby and a 4-minute race uses ≈1.5–2K commands, roughly
250 such sessions a month alongside the leaderboard. In multiplayer races the per-player leaderboard
polling (≈9 commands every 4 s) is switched off, which more than pays for the room.

## Integration points (for the redesign)

The multiplayer code doesn't depend on the picker, the HUD markup or `styles.css`. Wiring it into
the new UI takes these points:

1. **`src/main.ts`**: `initMultiplayer({ driver, container, enter, leave, entryParent? })`.
   - `enter()`: hide the app and dispose any time-trial race (multiplayer takes the screen).
   - `leave()`: show the app again.
   - `entryParent`: where the temporary floating "👥 Race friends" button goes. Omit it once the new UI
     has its own button, and call `open()` (returned by `initMultiplayer`) or set `location.hash = '#/room'`.
   - When the lobby is opened from `#/t/{id}/{dir}`, that track is preselected. If the atlas uses
     other routes, set `lobby.preferred` or keep a `#/t/...` hash.
2. **`src/game/race.ts`**: `RaceOptions.mode?: RaceMode` (`src/game/raceMode.ts`). The hooks, which
   must survive the HUD moving to `hud.ts`:
   - constructor: `ghosts:false` → `showGhosts=false`; `leaderboard:false` → hide the board panel;
     `restart:false` → hide "Restart from grid"; then `addon.attach(context())` after `resetToGrid()`.
   - `resetToGrid()`: `gridSlot` sets the staggered grid position; `startAt` fixes `goAt` (`SYNC_GO`).
   - `tick()`: grid timer from `startAt` when set; `addon.tick(dt)` after physics.
   - `render()`: `addon.frame(dt)` just before `renderer.render`.
   - `drawHud()` minimap: `addon.minimap(dot)` after the ghost dots.
   - `refreshBoard()`: return early when `leaderboard === false`.
   - `dispose()`: `addon.dispose()` first (plus `renderer.forceContextLoss()`, because multiplayer creates a race every round).
   - `context()`: what add-ons may touch: `scene`, `camera`, `track`, `phys`, `hud` (the overlay
     root), `state`, `simT`, `toast`, `centerMsg`, `setAutopilot`, `exit`.
3. **HUD layout**: `.mp-standings` sits where the leaderboard panel was (top right, 226 px down,
   under the minimap). The new HUD should give it a slot. Name tags go in their own `.mp-tags`
   layer, and the results card is centred.
4. **Styles**: everything is in `src/ui/multiplayer.css`, using `--bg --panel --line --text --muted
   --accent --green --yellow --red --font` with fallbacks. Restyle freely. The JS only relies on the
   `data-el` / `data-act` attributes inside `lobby.ts` and `raceOverlay.ts`.
5. **Laps still count**: valid laps in a multiplayer race are submitted to the leaderboard like
   time-trial laps (`Race.finishLap`). To change that, add a `submit:false` mode flag.

## Testing

```bash
npm run dev            # then open two tabs at http://localhost:5173/#/room
```

- **Two tabs** work as two players (identity is per tab). Or use the bench at
  `http://localhost:5173/dev/mp-test.html?n=2` (up to 4 players side by side; `?player=N` gives
  each iframe its own identity). In the dev console, `__race.autopilot = true` drives a kart.
- **Production build**: `npm run build && npx vite preview`. The preview server now serves `api/*.ts`
  too (`vite.config.ts`), so the built bundle can be tested with the API.
- In dev, rooms live in memory (like the leaderboard) and reset when the server restarts. On
  Vercel they're in Upstash.

What was tested, with two to four headless Chrome players (separate profiles) racing on autopilot
against `npm run dev` and against `vite preview`:

- create, join by link, join by typed code
- p2p link up in ~3 s
- start skew 1 ms
- standings agree on all clients
- 1-lap race to the flag, with identical final results everywhere
- a player with WebRTC blocked falls back to the relay
- reload mid-race puts you back on the grid of the running race
- retiring from the pause menu gives a DNF
- a late joiner waits for the next race
- the host closing the tab migrates host in ~8 s
- kick, leave, close to the track map
- time trial unchanged (random start, leaderboard, ghosts, restart)

## Limitations and follow-ups

- **No TURN**: strict-NAT pairs use the 3 Hz relay. If that's common, add TURN through
  `VITE_ICE_SERVERS` (that needs a provider account), or move live traffic to a managed service.
- **Mesh** scales to the 8-player cap. Each client uploads 7 × 20 Hz × ~100 B ≈ 14 KB/s.
- **Reloading mid-race** puts you back at your grid slot (the race goes on without you).
- **No spectating**: late joiners wait in the lobby until the race ends.
- **Client-trusted** results, as with the leaderboard.
- Background tabs freeze your kart, as browsers pause `requestAnimationFrame`. The race clock keeps running.
