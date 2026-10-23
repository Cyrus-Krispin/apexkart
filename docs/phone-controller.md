# Phone controller

A phone steers the kart on another screen. The laptop shows a QR code, the phone scans it, and
from then on the phone is the steering wheel: hold it sideways and tilt to steer, press the screen
to brake. It works in time trials and in multiplayer (each player pairs their own phone with their
own laptop). A party (split screen, [party.md](party.md)) seats up to four phones on one code.

## How it connects

The same pieces as multiplayer (see [MULTIPLAYER.md](../MULTIPLAYER.md)): a short code in Redis for
signaling, then a direct WebRTC link.

```
laptop (screen)                 /api/pad (Redis)                  phone (pad.html)
  open ───────────────────────▶ ak:pad:K7QX {scr}
  QR: /pad.html?c=K7QX ·····························▶ scan
                                ak:pad:K7QX {scr, pad} ◀───────── join
                                inbox:scr ◀─────────────────────── signal offer
  poll ◀──────────────────────  offer
  signal answer ─────────────▶  inbox:pad ──────────────────────▶ poll
  ◀════════════════════ WebRTC data channels, direct ════════════════════▶
```

- **Pairing code**: 4 characters from the room-code alphabet (no 0/O, 1/I/L), in its own Redis
  namespace (`ak:pad:{code}`), so a pairing code never clashes with a room. It expires 15 minutes
  after the screen's last poll. Identities are the per-tab secrets multiplayer uses
  (`tabIdentity()` in `src/net/room.ts`).
- **Signaling**: non-trickle ICE, as in the room mesh: one offer from the phone, one answer from the
  laptop, each a single `signal` call into the other side's inbox. ICE servers come from the same
  place (`iceServers()` in `src/net/mesh.ts`, so `VITE_ICE_SERVERS` adds TURN here too).
- **Channels** (negotiated, fixed ids):
  - `ctl`, reliable: Start / Pause / Reset presses, what the laptop is showing (briefing, race,
    paused, menu) and its control scheme, vibration, pings.
  - `in`, unordered with no retransmits: steering frames `[seq, steer, brake, gas]` at up to 60 Hz
    while they change and a few a second when they don't. Only the newest matters.
- **Polling**: the laptop polls every 1.2 s while it waits for a phone, then every 15 s once connected
  (to keep the code alive and to notice another phone scanning it). The phone polls every 0.7 s only
  while waiting for an answer. A waiting code with no phone closes after 5 minutes, or when the card
  is closed.

### Redis budget

| Situation | Commands |
| --- | --- |
| Laptop waiting for a phone | 3 per poll (`HGETALL`, `LPOP`, `EXPIRE`), every 1.2 s |
| Pairing (one offer and answer) | ~15 |
| Connected | 3 every 15 s (≈700 an hour) |

## What happens when

| Event | Result |
| --- | --- |
| Phone scans the code | It connects at once; tapping **Start** on the phone asks for motion access (iOS), keeps the screen awake and goes full screen (Android). |
| Briefing on the laptop | The phone shows **Start**, which starts the race like any key. |
| In the race | **Pause** and **Reset** (back on track). Paused: **Resume**. |
| Link drops mid-race (phone locked, out of range, app switched) | The laptop pauses the race and keeps the code open. The phone reconnects when it's back. |
| Laptop page reloads | The code is kept in `sessionStorage`; the phone reconnects to it by itself (≈5 s). |
| Another phone scans the code | It takes over. The first phone shows "Another phone took over" with the code filled in. A phone that's only reconnecting never takes the code back. |
| No motion sensor, or motion access refused | The phone shows ◀ ▶ buttons instead of the wheel. |
| Gamepad or keyboard steering at the same time | A key or the stick wins while it's held; the phone's pedals add to the others. |

## Tilt

`src/pad/tilt.ts` is the Tilt scheme from v0.14, now on the phone. It turns the sensor's beta and
gamma into gravity along the screen as it's held (either landscape direction, or portrait), so the
wheel angle doesn't depend on how far the phone is tipped back. Lightly smoothed, with a dead zone of
9% of full lock either side of straight ahead. Straight ahead is the phone held level; **Recentre**
sets it to however it's held now.

The **Tilt** button on the phone sets how far you tilt for full lock: Gentle 27° (the v0.14 feel),
Normal 18° (the default), Quick 13°, Sharp 9°. The phone keeps the choice in `localStorage`, so it
applies to every game that phone steers.

DeviceOrientation needs a secure context. Over plain http (a laptop on the LAN in development), phones
don't share the sensor and fall back to the ◀ ▶ buttons.

## Code

```
src/shared/pad.ts      protocol: messages, frame format, timings (client and API)
api/pad.ts             the pairing endpoint: open, join, signal, poll, close
src/net/pad.ts         Link (one RTCPeerConnection), PadConn (one phone, on the laptop's side),
                       PadScreen (phonePad, the laptop's one controller), PartyScreen (a
                       party's four seats) and PadPhone (the phone side)
src/ui/padCard.ts      the Phone button in the home header and the QR card
src/ui/pad.css         its styles
pad.html               the phone page (a second Vite entry, see vite.config.ts)
src/pad/main.ts        the phone page: code entry, Start, wheel, pedals, the send loop
src/pad/tilt.ts        tilt to steering
src/pad/pad.css        the phone page's styles
```

Where the game uses it:

- `src/game/input.ts`: `Input.read()` merges `phonePad.input()`; phone buttons become the matching
  key presses (Pause = `Esc`, Reset = `R`).
- `src/game/race.ts`: tells the phone what's on screen (`padView`), toasts connect and disconnect, and
  pauses when the phone drops mid-race. The pause menu has a **Phone** row.
- `src/ui/intro.ts`: the briefing shows the phone's state under the controls, and opens the card.
- `src/ui/lobby.ts`: a **Phone** button in the multiplayer lobby's header.
- `src/game/haptics.ts`: every vibration also goes to the phone.

## Testing

```bash
npm run dev -- --host   # then open the game at this computer's network address, not localhost
```

A phone can't reach `localhost`, and over plain http it steers with buttons rather than tilt. To try
tilt on a real phone in development, serve the dev server over https (a tunnel, or a Vercel preview).

In a desktop browser, open `http://localhost:5173/pad.html?c=CODE` in a second window: with no
motion sensor it shows the ◀ ▶ buttons. In DevTools, `__pad` is the laptop's controller (`__pad.input()`
is the steering it's getting). Headless, dispatch `DeviceOrientationEvent`s on the phone page to tilt it.

Tested with two headless Chromium contexts (a laptop at 1280×800 and a phone at 844×390 with touch):
QR and code, connecting before Start, tilt both ways (±15° gives ±0.95 steer on Normal), Brake, a laptop
reload (reconnects in ≈5 s), Start on the briefing, Pause and Resume from the phone, a tilted phone
turning the kart, the race pausing when the phone goes away, and a second phone taking over.
