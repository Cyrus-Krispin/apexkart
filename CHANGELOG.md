# Changelog

New features and fixes in ApexKart, newest first. Each release is a git tag on `main`
(`v0.3.0`, …) and version numbers follow [semantic versioning](https://semver.org).
`main` deploys straight to the live site, so anything under **Unreleased** is already live.

## [Unreleased]

### Added
- **Your phone is the steering wheel.** Press **Phone** on the laptop (in the top bar, the multiplayer
  lobby, the grid screen or the pause menu) and scan the QR code. Hold the phone sideways and tilt it
  to steer, and press the screen to brake. In Classic it has Brake and Gas pedals.
  - The phone also has **Start**, **Pause**/**Resume**, **Reset** and **Recentre**, and buzzes on
    impacts, kerbs and the start lights (Android).
  - On iPhone, tapping Start on the phone asks for motion access. Without it, or on a phone with no
    motion sensor, you steer with ◀ ▶ buttons on the phone instead.
  - It connects straight to the laptop, so steering arrives in a few milliseconds. If the link
    drops mid-race the game pauses, and the phone reconnects by itself, even after reloading the
    laptop page. Scanning the code with another phone hands it over.
  - No QR scanner? Open the game's `/pad.html` on the phone and type the 4-character code.

## [0.29.1] - 2026-10-21

### Fixed
- **No more hiss on the road.** The tyres only squeal when you're properly sliding or locking a
  wheel (they squealed through a third of every clean lap), and the squeal is a lower howl rather
  than a hiss.
- **Calmer at top speed**: the rush of air is a low whoosh near top speed instead of a constant
  "sss", the engine no longer buzzes flat out, and the rev-limiter stutter is gone.

## [0.29.0] - 2026-10-21

### Changed
- **Ghosts are a clean see-through outline** in their colour with a soft glowing edge, instead of a
  jumble of parts showing through each other. They fade out near the camera and no longer turn
  into a glowing blob at night.
- **Karts have more detail**: the steering wheel turns, the driver's helmet leans into corners,
  there's a number plate on the back, the tyres have tread you can see spinning, and a small red
  rear light glows at night.
- **Karts draw much faster**: each kart is 7 pieces instead of 39 and each ghost 2 instead of 38,
  which helps most in multiplayer and on phones.

## [0.28.0] - 2026-10-21

### Changed
- **Clouds**: soft cumulus drift slowly across the day sky, lit on the sun side, with faint clouds at
  night. Kart paint reflects them.
- **The world has an edge**: a ring of low-poly hills with a tree line, fading into haze, so the
  ground no longer meets the sky in a hard line.
- **Steadier shadows**: no more crawling or shimmering edges while you drive, softer edges, and day
  shadows keep a little sky colour.
- **Grass**: crisper close up, with mowing stripes that follow the track and a thin seam where the
  concrete meets the grass (Medium and High).
- **Things sit on the ground**: a soft shadow under your kart, and darker ground at the foot of tyre
  walls, boards and buildings.
- **Night**: faint light beams under the floodlights (Medium and High).
- **Kerbs** have rubber marks on the edge the tyres hit, and 1 m stripes.
- **Phones on Low quality** do about a third less graphics work for the main picture, with simpler
  world materials.

## [0.27.0] - 2026-10-21

### Added
- **Instant flying-lap restart** in time trials: press Backspace, gamepad Select, or ↺ in the lap
  panel. You're put about 150 m before the line at a sensible speed, with no lights, and the next
  time you cross the line starts a clean timed lap.
- **Chase a target**: a new Chase setting in the pause menu picks whose lap the gap beside your lap
  time is measured against: your best, the board lap nearest your next medal, the driver one place
  above you, or a challenge's rival. That ghost's name tag gets a yellow ring, and your choice is
  remembered on this device.

### Fixed
- The gap beside your lap time no longer creeps up and snaps back every 10 m, and it's no longer cut
  off on phones.
- On phones, the map credit no longer sits over the pause menu's stats.

## [0.26.0] - 2026-10-21

### Added
- **Slipstream in multiplayer**: tuck in behind another kart for a tow worth 2–4 km/h on a straight,
  with a small Tow sign beside your speed. Time-trial ghosts never give a tow, so leaderboards are
  unaffected.
- With Classic controls, the multiplayer grid tells you to hold Gas: you launch at lights out.

### Changed
- **Kart-to-kart contact makes sense**: a bump costs the hitter and gives the kart in front a sensible
  amount of speed, with a thump, a buzz and a small camera kick, instead of bouncing you both apart.
  Karts you can't fairly hit pass through you, drawn see-through: anyone who has finished, a laggy
  player, someone who just reset, or a kart that's stuck.
- **The multiplayer grid is rows of two**, so every slot sits on the straight on every circuit in
  both directions. The back of the grid no longer starts in the first corner.

### Fixed
- The cool-down lap the game drives for you after the flag stays on the track, with no "Lap invalid"
  messages.

## [0.25.0] - 2026-10-21

### Added
- **Particles**: wheels in the grass throw clods and dust, wall hits spark and puff smoke, and hard
  braking and big slides leave tyre smoke. Skid marks fade over about half a minute, and the grass
  gets brown ruts.
- **Sound**: a thump on wall hits, kerb rumble, grass and gravel crunch, wind that rises with speed
  and a scrape along the barriers. The engine has a rev limiter, pops when you lift off and a
  slipping clutch at the launch.
- **Vibration** on Android phones and gamepads for wall hits, kerbs, the start lights and a personal
  best. It's off when muted or when your system asks for reduced motion.
- **Sector flash**: when you finish a sector, its chip flashes purple, green or yellow with the gap to
  your best sector, and a purple sector plays a short chime.

### Changed
- **Portrait phones see the corners**: the camera shows much more of the road ahead and sits a
  little higher.
- **Wall hits kick the camera smoothly** instead of shaking it, and the camera looks slightly into
  corners.
- **The kart moves like a kart**: the nose dips under braking, lifts under power, and the body rolls
  with cornering force.
- Kerb rumble only happens on the painted kerbs, not along every track edge.

## [0.24.0] - 2026-10-21

### Fixed
- **No more stutter in the first seconds of a race.** The grid screen now shows "Warming up" while
  the game quietly prepares every shader, texture, shadow, ghost and skid mark, and START lights up
  once that's done. Switching day or night on the grid briefly does the same for the new lighting.
- **Auto graphics settles before you race.** It picks the graphics level once, on the grid, and
  remembers it for your device; during a race it only adjusts sharpness. Phones that are fast
  enough now render sharper (up to twice the resolution).
- On tracks where buildings and trees arrive after you've started, they're added while you're on
  the grid, paused, or crossing the line, without a stutter.

### Changed
- **New colours**: start lights that are truly red, a bluer sky, warm sunlight with cool shadows,
  brand reds and oranges that stay true, and a night look that stays readable.

## [0.23.0] - 2026-10-21

### Changed
- **Kerbs sit where a real kart track has them**: on the inside of each corner from turn-in to just
  past the apex, on the outside of corner exits, and round the outside of hairpins. Kinks and
  straights no longer get kerbs, fast corners do, and each direction gets its own.
- **A crisp concrete strip lines the track edge** instead of a blurry painted band.
- **The road has more to read**: grid boxes with slot numbers at the start, a subtle rubbered racing
  line, and braking marks into the big corners.
- **3-2-1 braking boards** stand before the biggest stops.

### Fixed
- Where the track crosses or merges with itself, the road is one clean surface: no flickering
  speckle, and no edge lines painted across the other road.
- Kerbs, start-gantry posts and tyre walls no longer stand on another part of the track where the
  layout runs close to itself.
- Sponsor names on the tyre walls read the right way round, and stray bits of wall in infields and
  at tight corners are gone.

## [0.22.0] - 2026-10-21

### Fixed
- **Cutting across a hairpin no longer counts.** Lap progress now follows the road you're actually
  on, so driving across an infield (KF1's hairpin, for one) voids the lap with "Cut the track", and
  a lap shorter than the track allows is never valid.
- **Track limits are "four wheels off"**: the lap is invalid once the whole kart is past the kerb.
- **Sectors only count when you drive through them**; a lap that skips one says "Missed a sector".
- **Reversing back over the line cancels the lap** instead of logging a short invalid one.
- **No more invisible walls** after spinning onto another part of the circuit: you carry on from
  where you are.
- **Wrong way** no longer fires when you're going the right way on a neighbouring stretch, and it
  now works before your first lap too.
- **Where two parts of a circuit merge or cross**, the other road grips like road, not grass.
- In multiplayer, cutting the track puts you back where you left it, and the chequered flag always
  falls at the line.
- **The leaderboard checks every lap's ghost** and turns away laps that cut the track.

### Changed
- **Walls don't stop you dead.** Brush one and you keep most of your speed and slide along it; a
  head-on crash still costs you.
- **Stuck? Press Reset.** If you're wedged, lost on the grass or facing the wrong way, a Reset
  button appears (`R` on a keyboard) and puts you back on the track just behind where you left it.

## [0.21.0] - 2026-10-20

### Changed
- **The middle of the screen is clear while you race.**
  - The track map sits top right.
  - The lap timer has the gap to your best lap right beside it, green when you're ahead and red
    when behind.
  - The medal target and live timing sit under the timer on the left.
- **Smaller messages appear at the side and fade away**, under the map: personal bests, medals,
  "cross the line to start the clock", leaderboard news and the lap summary.
- **Only the big moments use the top centre**: the start lights, GO, track limits, wrong way and
  your finish in multiplayer.
- On phones: the timer is on the left; the buttons, map and messages are on the right; big moments
  show in a band above the kart.
- In multiplayer, race standings sit under the timer.

## [0.20.0] - 2026-10-20

### Changed
- **Every race starts at Live**, the real time of day at the circuit. Pick Day or Night on the grid,
  or in the pause menu, for that race only; the next race starts at Live again.
- **Controls aren't on the grid any more.** It shows which ones you're using and their keys. Switch
  them from the pause menu any time; your choice is remembered on this device.

## [0.19.0] - 2026-10-20

### Changed
- **The circuit page is just the circuit and how you stand on it**: the track, your best lap and
  position, the medal ladder and the leaderboard. The direction stays under the track, because
  each direction has its own leaderboard.
- **Set up on the grid.** Controls and time of day moved to the grid, alongside your times and the
  medal you're chasing, right before you press Start.
- The medal the grid says you're chasing now matches the circuit page: the first one your best lap
  doesn't reach yet.

## [0.18.0] - 2026-10-20

### Changed
- **A cleaner circuit page.** Everything before a race is on one page:
  - the track
  - your best lap and position
  - a medal ladder that shows how close you are to the next medal
  - the leaderboard, with a Today tab on the daily circuit
  - one **Setup** card for direction, time of day and controls

  **Race** takes you to the grid, with buttons beside it to race friends or send a challenge.
- **The grid is the moment before the race.** The world loads as a lap of the track, and the grid
  shows the medal you're chasing and your setup. **Start** goes green when it's ready. This brings
  back the Start button that v0.17.0 removed; all the settings are now on the circuit page instead.
- **One number for your gap.** The ghost bar is gone. Your gap to your best lap sits on top of the
  track map: green when you're ahead, red when you're behind. The medal panel now just shows the
  target time.
- **Calmer on phones**: bigger rows with one line per circuit, a lighter header (What's new is in
  your profile menu now), and a simpler timing panel in the race.

## [0.17.0] - 2026-10-20

### Changed
- **One tap to race.** Tap a circuit, press **Start**, and you're on the grid. The screen before the
  race no longer asks you to start again: it draws the track while the world loads, then goes
  straight to the start lights.
- Today's daily circuit bar at the top has a **Race** button, so it's clear you can race it. It opens
  today's circuit like any other track.

### Removed
- **Box box**, the bar that raced your last circuit. On desktop the circuit you raced last is already
  on screen, one Start away.

## [0.16.0] - 2026-10-20

### Changed
- **A new look: Pit Wall.** Every circuit is a live session, so ApexKart now reads like a race timing
  screen: carbon black, broadcast type, and timing colours (purple for fastest, green for your
  best, yellow for actions).
- **The home screen is a timing tower** instead of a world map.
  - **Live** ranks circuits by who's on track.
  - **Near me** sorts them by distance, from you or any city you search for.
  - **World** lists every track by country.
  - The daily circuit sits on a yellow bar at the top, and **Box box** races your last circuit.
  - It opens faster too: the home screen now downloads less than half as much.
- **Tap a circuit to see its layout**, drawn with sector colours, numbered turns and a dot for
  everyone on track, with no map behind it. Its pit board shows your position, best lap and gap
  to the next medal, the classification with a ghost on every lap, and a green **Start**.
- On desktop the tower and the circuit sit side by side, with the latest laps running along the
  bottom.
- **The grid screen before a race** draws the circuit, and a dot laps it as the world loads.
- **The race display** is restyled. On desktop the track map now sits at the top in the middle.
  The pause menu shows your session on a pit board.
- **Classic controls** are throttle, brake and steer. Space brakes in both schemes.
- The multiplayer lobby, race results, this page and the layout editor have the new look. The
  editor now opens full screen.
- The 22 featured circuits are no longer a separate list; they're on the tower with every other
  track.

### Removed
- **Drift**, including the Drift button, Space/Shift and the gamepad drift buttons.
- **The satellite world option.** Races always use the stylised world built from OpenStreetMap.

## [0.15.0] - 2026-10-20

### Changed
- Phones can race either way up again. Starting a race no longer goes full screen or asks you to
  turn the phone sideways. Held sideways, the briefing and the race still lay out to fit.

### Removed
- **Tilt steering.** If you had picked it, you're back on Simple.

## [0.14.0] - 2026-10-20

### Added
- **Choose how you drive**, in the pre-race briefing or the pause menu:
  - **Simple**: the kart accelerates by itself, so you only brake and steer. No drifting. Hold
    brake once you've stopped to back away from a wall.
  - **Classic**: the controls so far, with throttle, brake and drift.
  - **Tilt**, on phones and tablets: hold the phone sideways and steer by tilting it like a steering
    wheel. Hold the right side of the screen to brake. **Recentre** sets straight ahead.

### Changed
- Simple is the new default. Pick Classic to keep throttle and drift.
- On phones, races are played sideways. The game goes full screen in landscape when you start (on
  Android), or asks you to turn the phone and waits until you do.
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

[Unreleased]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.29.1...HEAD
[0.29.1]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.29.0...v0.29.1
[0.29.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Cyrus-Krispin/apexkart/compare/v0.13.1...v0.14.0
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
