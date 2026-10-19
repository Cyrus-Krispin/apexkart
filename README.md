# 🏁 ApexKart

Browser kart racing on **real tracks**. Track layouts come from OpenStreetMap, the ground
under them is real satellite imagery, and every lap feeds a live worldwide leaderboard with
ghost replays.

Start with **KF1 Karting Circuit, Singapore**, or fly anywhere on the map, hit
**Find kart tracks here**, and race any kart track that someone has mapped on OSM.

## Design

The UI uses a style I call "Paddock Paper": the home screen reads like a printed race programme crossed
with a map atlas, with warm paper, ink, signal orange, real circuit outlines on graph paper, Archivo
Expanded for display type and JetBrains Mono for numerals. In the race, the HUD switches to dark
broadcast-style timing panels with F1 sector colours. Tokens live in `src/styles/base.css`.

## Features

- **Real tracks, anywhere**: raceway ways from OpenStreetMap are split at junctions and
  turned into closed loops (`src/track/osm.ts`), then spline-smoothed and resampled every
  metre (`src/game/track.ts`). The start/finish line is auto-placed on the longest straight.
- **Satellite world**: Esri World Imagery tiles are stitched into one ground texture and
  aligned to the track in metres (`src/game/satellite.ts`).
- **Seven featured circuits** baked into `public/tracks/presets.json`: KF1 (Singapore),
  Racing Underdog Medini, South Garda (Lonato), Genk, PF International, Kerpen and the
  Algarve.
- **Both directions**: every track can be raced in reverse (KF1 really is a dual-direction
  circuit), with separate leaderboards.
- **Timing like TV**: flying laps, three sectors with purple/green/yellow colours, a live delta
  to your PB, track limits and wrong-way detection, and five red lights before the start.
- **Ghosts**: race against your own PB and the top three drivers on the leaderboard, with
  name tags.
- **Live leaderboard**: per-track top 10, "who's on track now" presence, and a global feed
  of the latest laps.
- **Circuit atlas**: search filters circuits as you type, or flies to any city and scans it for tracks.
  Each circuit has a programme page with numbered turns, rotation and the live board.
- **Pre-race briefing**: the circuit drawing animates in while satellite tiles load, alongside
  controls and rules, then you press any key to go.
- Keyboard, gamepad and touch controls; synthesized engine and tyre audio; skid marks;
  four cameras.

### Controls

| Action | Keys |
| --- | --- |
| Drive | `W A S D` / arrow keys, or gamepad (RT/LT + stick) |
| Drift | `Space` / `Shift` |
| Reset onto track | `R` (invalidates the lap) |
| Camera | `C` |
| Ghosts on/off | `G` |
| Mute | `M` |
| Pause | `Esc` / `P` |

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (the /api routes run inside Vite too)
npm run build      # typecheck + production build
npm run tracks     # re-bake preset tracks from OpenStreetMap (npm run tracks -- KF1 for one)
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

Laps go through plausibility checks: top speed, the ghost's duration matching the lap time,
and the ghost path length matching the track. Submissions are rate-limited too. That
stops casual nonsense, but it isn't cheat-proof, because the client is trusted.

## Deploying to Vercel

1. Import this repo in Vercel (framework preset **Vite**, already set in `vercel.json`).
2. Storage → Marketplace → **Upstash Redis** → connect it to the project. This injects the
   `KV_REST_API_*` env vars.
3. Deploy. The `api/*.ts` files become serverless functions automatically.

## Data & attribution

- Track geometry © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL).
- Satellite imagery and basemap © Esri, Maxar, Earthstar Geographics. Check Esri's terms
  before any commercial use.
- Geocoding by Nominatim; live track discovery through the public Overpass API, which is
  sometimes overloaded. The app retries across mirrors.
