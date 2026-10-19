# Changelog

New features and fixes in ApexKart, newest first. Each release is a git tag on `main`
(`v0.3.0`, …) and version numbers follow [semantic versioning](https://semver.org).
`main` deploys straight to the live site, so anything under **Unreleased** is already live.

## [Unreleased]

### Added
- **Multiplayer**: create a room, share the link or the 4-letter code, and race up to 8 friends
  live on the same circuit.
  - The host picks the circuit, direction and number of laps; everyone readies up.
  - A synchronised start puts every kart on a staggered grid.
  - Your friends race as solid karts with name tags.
  - Live race positions, lap X/N and a results screen.
  - Karts talk to each other directly (WebRTC). When two networks can't connect directly,
    the game relays positions through the server instead.
- **Night sessions**: race any circuit under the floodlights, as KF1 runs in real life.
  - Choose Day or Night on the pre-race screen, or switch from **Time of day** in the pause menu.
  - Starry sky, warm light pools under every floodlight and a headlight on your kart.
  - Kerbs, edge lines and the tyre-wall belt stay readable through every corner.

## [0.3.0] - 2026-10-19

### Added
- A real 3D world around every circuit, built from OpenStreetMap:
  - buildings with windows and rooftop detail
  - ground painted by land use
  - trees that suit the local climate
- Trackside dressing: raised kerbs, a branded tyre wall, floodlights, hoardings, a grandstand with a crowd, a pit building and marshal posts.
- New renderer with ambient occlusion, bloom, a golden-hour sun and sky reflections.
- **Graphics** setting in the pause menu (Auto, High, Medium, Low). Auto steps down by itself if the frame rate can't keep up.
- **World** setting in the pause menu: switch between the stylised world and satellite imagery.
- Layout editor for circuits whose OpenStreetMap trace is wrong, with fixes shared with everyone.
- Surroundings for every featured circuit are pre-built, so they load instantly.

### Changed
- Smoother motion on every screen: karts and ghosts are drawn between physics steps instead of jumping from one to the next.
- Graphics start at Medium on Auto. Trees are split into chunks so off-screen ones cost nothing.
- The pre-race camera orbits closer to the kart, clear of trackside buildings.

### Fixed
- Stutter from per-frame memory churn and shaders compiling mid-lap.
- Buildings no longer appear on the track (at KF1 and the Algarve, a few garage canopies covered the circuit).
- The Algarve layout no longer doubles back through the pit lane.
- Track discovery copes better when the OpenStreetMap servers are busy.

### Removed
- Racing Underdog Medini from the featured circuits, until its layout is fixed. Its OpenStreetMap trace doesn't follow the asphalt.

## [0.2.0] - 2026-10-19

### Added
- New "Paddock Paper" look: paper and ink with signal orange, in the style of a printed race programme.
- Circuit atlas home page:
  - instant search
  - fly to any city and scan it for kart tracks
  - circuit cards with real track outlines
  - a detail page with numbered turns and direction of travel
- Profile menu to set your driver name and kart livery.
- Pre-race briefing with an animated circuit map, the controls, a loading bar and a cinematic orbit of your kart.
- Broadcast-style race HUD:
  - sector progress bars and a live delta
  - a timing tower and lap cards
  - F1-style start lights
  - a pause screen with session stats
  - a phone layout
- Discovered tracks get real place names.

### Changed
- A new kart model, a gradient sky, and satellite imagery that blends into the ground at the edges.

## [0.1.0] - 2026-10-19

### Added
- Kart racing on real circuits from OpenStreetMap, raced in 3D over satellite imagery. Scan anywhere in the world to find tracks.
- Time trials:
  - flying laps with three sectors and a live delta to your best
  - track limits and wrong-way detection
  - start lights
- Ghost replays of your personal best and the top three drivers.
- Live leaderboards per circuit and direction, with who's on track now and a feed of the latest laps.
- Seven featured circuits, starting with KF1 Karting Circuit in Singapore.
- Every track can be raced in reverse.
- Controls: keyboard, gamepad and on-screen touch.

### Fixed
- Leaderboard and lap submission on the live site.

[Unreleased]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Cyrus-Krispin/apexkart/releases/tag/v0.1.0
