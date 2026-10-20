# Changelog

New features and fixes in ApexKart, newest first. Each release is a git tag on `main`
(`v0.3.0`, …) and version numbers follow [semantic versioning](https://semver.org).
`main` deploys straight to the live site, so anything under **Unreleased** is already live.

## [Unreleased]

### Added
- **Choose how you drive**, in the pre-race briefing or the pause menu:
  - **Simple**: the kart accelerates by itself, so you only brake and steer. No drifting. Hold
    brake once you've stopped to back away from a wall.
  - **Classic**: the controls so far, with throttle, brake and drift.
  - **Tilt**, on phones and tablets: hold the phone sideways and steer by tilting it like a steering
    wheel. Hold the right side of the screen to brake. **Recentre** sets straight ahead.

### Changed
- Simple is the new default (Tilt on phones that support it). Pick Classic to keep throttle and drift.
- On phones, Simple has bigger steer buttons and a single brake button for your right thumb.
- The control hints no longer cover the track. The briefing lists them in its side panel, and in the
  race a small hint at the bottom fades after a few seconds.

### Fixed
- On phones, pressing just beside an on-screen button no longer highlights it and stops the other
  buttons responding. A thumb can also slide from one button to the next.

## [0.13.1] - 2026-10-20

### Added
- **7 more tracks on the world map**, in Togo, Venezuela, South Africa, Zambia and the USA. Every
  venue in the world has now been checked: the map shows all 4,901 that have a layout you can race.

## [0.13.0] - 2026-10-20

### Changed
- **The home screen opens much faster, especially on phones.** It now downloads about a quarter of
  what it used to. The 3D race engine loads quietly in the background while you browse the map, so
  races still start straight away.
- Switching country filters and scrolling the circuit rail are several times quicker on a busy map.

## [0.12.0] - 2026-10-20

### Changed
- **Every track on the world map is ready to race.** The map now shows only tracks whose layouts
  are already built (4,894 of them), so every dot opens instantly. Venues that couldn't be built
  are left off for now and come back as they're added.
- Searching for a place flies the map there and lists the tracks around it.

### Removed
- **Scan this area for tracks.** Every raceable venue is already on the map.

## [0.11.0] - 2026-10-20

### Changed
- **Most tracks on the world map now open instantly.** Their layouts are prepared ahead of time
  instead of being fetched from OpenStreetMap when you tap a dot. That covers four in five venues
  so far, and the rest follow in the next update. 713 dots that had no raceable layout are gone.

### Fixed
- Live timing keeps showing the latest times through a dropped connection instead of going blank.

## [0.10.1] - 2026-10-20

### Changed
- Anything still loaded from OpenStreetMap (shared links to other tracks, a venue's surroundings) is
  quicker when a map server is busy. The game asks the next server after a few seconds and uses
  whichever answers first, instead of waiting each one out in turn.

## [0.10.0] - 2026-10-20

### Added
- **Challenge links.** Once you're on a circuit's leaderboard, **Challenge a friend** copies a link
  (or opens the share sheet on a phone). It opens the circuit with your lap waiting as a ghost to
  beat, and they get a cheer at the line when they do.
- Race any leaderboard lap as a ghost: every row on a circuit's board has a ghost button.

## [0.9.0] - 2026-10-20

### Added
- **Daily circuit**: one featured circuit a day, the same for everyone, with its own leaderboard
  that starts fresh at midnight UTC.
  - It leads the rail on the home screen, with the day's leader, your place and the time left.
  - Your best lap of the day counts even when it isn't your all-time best.
  - Set a lap on consecutive days to build a streak.

## [0.8.0] - 2026-10-20

### Added
- **Medals** on every circuit, in each direction: bronze, silver, gold and platinum target times,
  set from the track record so they get tougher as the leaderboard gets faster. Platinum is record
  pace.
  - The circuit sheet shows all four targets and how far your best lap is from the next one.
  - While you drive, the next medal's time sits under your best lap, and beating it brings up a
    medal banner at the line.
  - Circuit cards show the best medal you've won, and your profile counts them all.

## [0.7.0] - 2026-10-20

### Added
- **16 new featured circuits**, for 22 on five continents. Each comes with its 3D surroundings
  built in:
  - Italy: Adria Karting Raceway, Kartodromo Franciacorta
  - Spain: Circuito Internacional de Zuera, Kartódromo Lucas Guerrero (Valencia)
  - Britain: Buckmore Park, Rye House
  - Elsewhere in Europe: Kartbahn Ampfing (Germany), Paul Ricard Karting (France)
  - Asia and the Gulf: Sepang International Kart Circuit, Dubai Kartdrome, Bahrain International
    Karting Circuit
  - Australia: Eastern Creek (Sydney)
  - The Americas: Kartódromo Granja Viana (Brazil), New Castle Motorsports Park and Orlando Kart
    Center (USA), SH Karting (Canada)

### Changed
- Races on tracks outside the featured set start straight away. The surrounding buildings and trees
  fill in when they arrive, instead of holding up the start.

### Fixed
- Opening the site from a link to a circuit no longer leaves the bottom dock empty.

## [0.6.0] - 2026-10-20

### Added
- **Live time of day**, now the default: you race at the real time of day at the circuit. KF1
  after dark is a night race under the floodlights, and by day the sun sits where it really is
  in the sky. Day and Night are still there if you'd rather pick.
- The circuit sheet on the home screen says whether it's day or night there right now.

### Fixed
- Switching from Day back to Night no longer washes the screen out in white. This had been
  happening since night sessions arrived.
- In multiplayer, the game-driven cool-down lap after the flag no longer goes onto the leaderboard
  as your lap.
- Long multiplayer races are no longer closed by the 30-minute idle timeout.
- A multiplayer finish lost on a bad connection is retried instead of counting as a DNF, and you're
  never dropped back into a race you left.
- If a long background tab drops you from a room, you now get your direct connection back instead
  of staying on the slower relay.
- Leaving a shared circuit link before it finished loading no longer leaves its panel stuck open.
- Switching the World setting twice quickly no longer stacks two worlds in the scene.

### Security
- Leaderboards and layouts are harder to vandalise. Featured circuits can't be re-traced, a layout
  fix has to match the circuit's real location, and a bogus first lap can no longer lock everyone
  else out of a track's leaderboard.

## [0.5.1] - 2026-10-20

### Fixed
- Circuit cards on the home screen show the track record as soon as live timing loads, instead of "Open".

## [0.5.0] - 2026-10-20

### Added
- **A new home screen built around a world map** of 5,784 kart tracks in 153 countries, from
  OpenStreetMap. Tap any dot and its layout loads, ready to race.
  - **Race now**: one tap, or Enter, puts you on the grid at the circuit you raced last.
  - Country filters along the bottom, with every country one click away.
  - A rail of circuits you can flick through, each with a ▶ to race it straight away.
  - Pins pulse where people are driving, and Live timing shows who's on track and where.
  - One search box for circuits, countries, venues and any city.
  - Venues with several layouts show each one, so you can pick.

### Changed
- The home screen's intro text is gone. The map, the dock and the circuit sheet say it with less.

## [0.4.1] - 2026-10-20

### Added
- **Night races with friends**: the host picks Day or Night in the room lobby, next to direction
  and laps, and everyone in the room races at that time of day. Your own Day/Night choice for solo
  laps stays as it was.

## [0.4.0] - 2026-10-20

### Added
- **Multiplayer**: create a room, share the link or the 4-letter code, and race up to 8 friends
  live on the same circuit.
  - The host picks the circuit, direction and number of laps; everyone readies up.
  - A synchronised start puts every kart on a staggered grid.
  - Your friends race as solid karts with name tags.
  - Live race positions, lap X/N and a results screen.
  - Karts talk to each other directly (WebRTC). When two networks can't connect directly,
    the game relays positions through the server instead.
- **What's new** page (`#/changelog`), opened from the version number in the top bar.
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

[Unreleased]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Cyrus-Krispin/apexkart/releases/tag/v0.1.0
