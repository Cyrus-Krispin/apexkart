# 🏁 ApexKart

Browser kart racing on **real tracks**. Track layouts come from OpenStreetMap and are rebuilt as a
stylised 3D world, and every lap feeds a live worldwide leaderboard with ghost replays.

Start with **KF1 Karting Circuit, Singapore**, or pick any of the thousands of kart tracks on the
timing tower (every one mapped on OSM) and race it.

## Design

The UI is **Pit Wall**: every circuit is a live session, so the game reads like an F1 timing screen.
It's carbon black, with Barlow Condensed for broadcast type and Chivo Mono for numerals, and the
timing palette: yellow for actions and flags, green for Go and personal bests, purple for the
fastest, red for live. Circuits are drawn as layouts with timing-coloured sectors, not maps. The
spec is [docs/pit-wall.md](docs/pit-wall.md); tokens and shared components live in
`src/styles/base.css`.

## Features

- **Real tracks, anywhere**: raceway ways from OpenStreetMap are split at junctions and
  turned into closed loops (`src/track/osm.ts`), then spline-smoothed and resampled every
  metre (`src/game/track.ts`). The start/finish line is auto-placed on the longest straight.
- **The real place in 3D** (`src/game/world/`): OpenStreetMap buildings are extruded to their
  real height, land use is painted into a crisp stylised ground, and trees fill the mapped woods
  and parks. The circuit gets raised kerbs, a branded tyre wall on the physics barrier,
  floodlights, hoardings, a grandstand, a pit building and marshal posts. Featured circuits ship
  with baked surroundings in `public/tracks/env/`.
- **Renderer** (`src/game/render.ts`): golden-hour light, GTAO ambient occlusion, bloom, sky
  reflections, and quality levels that step down automatically if the frame rate drops.
- **Correct layouts**: the loop finder rejects routes that U-turn at a junction, so pit lanes and
  links can't sneak into a lap. When OpenStreetMap itself is wrong, **Fix the layout** on a circuit
  page opens a full-screen editor over satellite imagery (`src/ui/editorScreen.ts`). Corrections are shared through `/api/layout`
  and get their own leaderboard.
- **22 pre-built circuits** on five continents, baked with their surroundings into
  `public/tracks/presets.json` and `public/tracks/env/`: KF1 (Singapore), South Garda (Lonato), Genk,
  PF International, Kerpen, the Algarve, Adria, Zuera, Valencia, Franciacorta, Buckmore Park, Rye
  House, Ampfing, Paul Ricard, Sepang, Dubai, Bahrain, Eastern Creek, Granja Viana, New Castle,
  Orlando and SH Karting. Add one to `PRESETS` in `scripts/fetch-tracks.ts` and run
  `npm run tracks -- --new` (existing circuits keep their ids, and so their leaderboards).
- **Both directions**: every track can be raced in reverse (KF1 really is a dual-direction
  circuit), with separate leaderboards.
- **Timing like TV**: flying laps, three sectors with purple/green/yellow colours, a live delta
  to your PB, track limits (four wheels off), cut detection that follows the road you're on, and wrong-way detection, and five red lights before the start.
- **Ghosts**: race against your own PB and the top three drivers on the leaderboard, with
  name tags.
- **Multiplayer**: create a room, share the link or code, and race friends live (up to 8, N laps,
  synchronised start, positions and results). Peer-to-peer over WebRTC; see [MULTIPLAYER.md](MULTIPLAYER.md).
- **Live leaderboard**: per-track top 10, "who's on track now" presence, and a global feed
  of the latest laps.
- **Timing tower** (`src/ui/atlas.ts`): the home screen ranks circuits like a timing screen.
  **LIVE** ranks them by drivers on track, **NEAR ME** by distance (from you or any city you search
  for), and **WORLD** lists every kart venue on OpenStreetMap with a raceable loop
  (`public/tracks/world.json`) by country. A venue opens instantly: its layouts are pre-stitched
  into `public/tracks/venues/<cell>.json` by `scripts/build-venues.ts` (`npm run venues`). Today's
  daily circuit is a yellow bar with a Race button, and one search box covers circuits, countries,
  venues and cities. On desktop the tower sits beside the circuit
  as a broadcast wall, with race control (the latest laps) running along the bottom.
- **Circuit page**: the circuit and how you stand on it. It draws the layout with sector colours,
  numbered turns and dots for the drivers on track, with the direction under it (each direction has
  its own leaderboard). It shows your best lap and position, a medal ladder from bronze to platinum
  with you on it, and the leaderboard with a ghost to race on every lap (and a Today tab on the
  daily circuit). **Race** takes you to the grid, with racing friends and challenge links beside it.
- **Grid**: set up and go. A dot laps the circuit as the world loads, lighting each sector. Beside
  it are your times, the medal you're chasing, your controls and the time of day. Every race starts
  at **Live**, the real time there, and Day or Night is for that race only. Controls are switched
  from the pause menu and remembered on the device. **Start** (or any key) goes green when it's
  ready and runs the five red lights.
- Two control schemes (Simple and Classic) on keyboard, gamepad and touch;
  synthesized engine and tyre audio; skid marks; four cameras.

### Controls

Pick a scheme in the pre-race briefing or the pause menu (**Controls**). The choice is kept on
the device (`ak:controls` in localStorage).

- **Simple** (the default): the kart accelerates by itself, so you only brake and
  steer. Hold brake when you've stopped to reverse, say off a wall.
- **Classic**: throttle and brake yourself. There's no drift in either scheme.

| Action | Simple | Classic |
| --- | --- | --- |
| Steer | `A D` / `← →` | `A D` / `← →` |
| Throttle | automatic | `W` / `↑` |
| Brake (and reverse when stopped) | `Space` / `S` / `↓` | `Space` / `S` / `↓` |
| Gamepad | stick or d-pad steers, LT or B brakes | RT or A throttle, LT or B brake, stick steers |
| Touch | ◀ ▶ on the left, Brake on the right | ◀ ▶ on the left, Brake and Gas on the right |

In every scheme:

| Action | Keys |
| --- | --- |
| Reset onto track | `R` or the Reset button that appears when you're stuck (invalidates the lap), gamepad Y |
| Camera | `C` |
| Ghosts on/off | `G` |
| Mute | `M` |
| Pause | `Esc` / `P`, gamepad Start |

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (the /api routes run inside Vite too)
npm run build      # typecheck + production build
npm run tracks     # re-bake preset tracks + surroundings (falls back to the OSM API if Overpass is down)
npm run world      # re-collect every kart venue on OpenStreetMap into world.json (two planet-wide queries)
npm run venues     # pre-stitch every venue's layouts (a few hundred queries: run the "Bake venue layouts" workflow instead)
```

In dev, the leaderboard lives in memory and resets when the server restarts.

## The leaderboard: do we need a database?

Some kind of persistent store is unavoidable. Serverless functions are stateless, so lap
times have to live somewhere between requests. The lightest option is **Upstash Redis**: it's
serverless, has a free tier, and can be added in one click from the Vercel Marketplace. There's
no server to run and nothing to migrate. Sorted sets are a natural fit for leaderboards.

`api/_lib/store.ts` uses Redis when `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or the
`UPSTASH_REDIS_REST_*` equivalents) are set. Otherwise it falls back to memory.

| Endpoint | What it does |
| --- | --- |
| `GET /api/board?track&dir` | top 10 + who's on track (passing `pid` is a presence heartbeat) |
| `POST /api/lap` | submit a lap; keeps each driver's PB, ghost, and posts to the feed |
| `GET /api/ghost?track&dir&pid` | a driver's PB ghost |
| `GET /api/feed` | latest laps, every track record, live counts (CDN-cached 3s) |
| `GET /api/track?id` | geometry for raced tracks, so shared links don't depend on Overpass |
| `GET/POST /api/layout` | community-corrected layouts (list / save) |
| `POST /api/room` | multiplayer rooms: lobby state, WebRTC signaling, pose relay ([MULTIPLAYER.md](MULTIPLAYER.md)) |

Laps go through plausibility checks: top speed, the ghost's duration matching the lap time,
and the ghost path length matching the track. Submissions are rate-limited too. That
stops casual nonsense, but it isn't cheat-proof, because the client is trusted.

## Changelog and releases

`CHANGELOG.md` lists what's new in each version, and the site shows it at **`#/changelog`**
(linked from the version number in the top bar). Each release is an annotated git tag on
`main` (`v0.1.0`, `v0.2.0`, `v0.3.0`, …) following [semantic versioning](https://semver.org).

1. With every feature or fix that lands on `main`, add a line under `## [Unreleased]` in
   `CHANGELOG.md`. `main` deploys straight away, so Unreleased notes are already live.
2. To cut a release from an up-to-date `main`:
   ```bash
   npm run release -- minor          # or patch / major / an explicit 0.4.0
   git push origin main v0.4.0       # or pass --push to the release command
   ```
   This moves the Unreleased notes under the new version and bumps `package.json`. It then commits
   and creates the tag, with the release notes as the tag message.
3. `npm run build` checks that `package.json` matches the newest release in the changelog
   (`npm run version:check`).

## Deploying to Vercel

1. Import this repo in Vercel (framework preset **Vite**, already set in `vercel.json`).
2. Storage → Marketplace → **Upstash Redis** → connect it to the project. This injects the
   `KV_REST_API_*` env vars.
3. Deploy. The `api/*.ts` files become serverless functions automatically.

## Data & attribution

- Track geometry © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL).
- Satellite imagery in the layout editor © Esri, Maxar, Earthstar Geographics. Check Esri's terms
  before any commercial use.
- Geocoding by Nominatim; live track discovery through the public Overpass API, which is
  sometimes overloaded. The app retries across mirrors.
