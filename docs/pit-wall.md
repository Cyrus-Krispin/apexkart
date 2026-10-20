# Pit Wall: the ApexKart design system

**Thesis: every circuit is a live session, so the game reads like a timing screen.**

ApexKart looks like the pit wall at a race: carbon black, condensed broadcast type, mono numerals,
and the timing palette. It's dense and scannable, but every screen has **one obvious next action**.
The reference mockups are Direction B in the design artifact
(https://claude.ai/artifact/4cXnNeVmCWcGk1JEUTpLUW). This document wins where they differ.

Tokens and shared components live in `src/styles/base.css`; helpers in `src/ui/pitwall.ts`
(`circuitCode`, `flagColors`, `stripeStyle`) and `src/ui/trackArt.ts` (`sectors`, `live` options).
Use them, and don't redefine colours or fonts locally.

## Colour: what each one means

| Token | Use it for | Never for |
| --- | --- | --- |
| `--carbon` (+ `--hatch`) | page background | |
| `--panel`, `--panel-2`, `--panel-3` | rows, cards, inputs (raise one step per layer) | |
| `--carbon-2` | recessed wells, top/bottom bars | |
| `--text`, `--text-2`, `--muted`, `--dim` | text, by importance | |
| `--yellow` | **the** action on a screen (Box box, Create room), flags, the daily circuit, focus rings | decoration |
| `--green` | **Start / Go**, personal best | anything else that's clickable |
| `--purple` | fastest overall (track record, purple sector) | |
| `--red` | live (dots, "on track"), brake | errors that aren't urgent |
| medal tokens | medal dots only | |

One yellow action per screen. If two things want yellow, one of them is a `.btn` (panel).

## Type

- **Headlines** `.display`: Barlow Condensed 800 italic, uppercase. Circuit names, screen titles,
  big numbers on the pit board.
- **Labels** `.label` / `.pw-k`: Barlow Condensed 700, 12px, letter-spacing .14em, uppercase,
  `--muted`. Use them above data ("POS", "BEST TODAY", "MEDAL TARGETS").
- **UI text** `.ui`: Barlow Condensed 700 uppercase. Buttons, tabs, rows.
- **Numbers** `.mono`: Chivo Mono, tabular. Every time, gap, count and distance.
- **Body** (prose, help text, which is rare): Barlow 400/500, 14–15px, `--text-2`. Sentence case.

Copy is short and broadcast-like: `START KF1`, `BOX BOX · RACE KF1`, `3 ON TRACK`, `NO TIME`,
`+0.214`. Prose explanations are one sentence, in sentence case.

## Components (base.css)

- `.pw-row`: tower row (dark gradient bar, 42px; 30px compact). Set `grid-template-columns`
  per use. `.sel` = yellow inset ring.
- `.pw-pos`: white position block, black italic number (`.me` = yellow).
- `.pw-stripe`: country stripe; `style="${stripeStyle(cc)}"`. `.big` for headers.
- `.pw-code`: three-letter circuit code from `circuitCode(name)`.
- `.pw-t`: timing cell; `.p` purple (fastest) / `.g` green (PB) flash, `.none` for no time.
- `.pw-lv`: live count with red dot; `.z` when zero.
- `.pw-tabs`: segmented tabs, white block for the picked one; `.soft` for settings rows.
- `.pw-board` > `.pw-board-in` > `.pw-board-row`: the pit board signboard.
- `.pw-sec`: S1/S2/S3 chips (`i.p`, `i.g`, `i.y`).
- `.btn`, `.btn.primary` (yellow), `.btn.go` (green), `.btn.lg`, `.btn.block`.
- `.chq`: chequered strip. `.live-dot`: pulsing red dot. `.medal.gold` (etc.): medal dot.
- Track drawings: `trackArt(shape, { road, sectors, live, lapS, turns, arrows })`. They're light on
  carbon, with sectors purple / green / yellow from the start line in race direction, and `live`
  dots lapping.

## Layout and behaviour

- **Phones first.** 44px minimum touch targets, the primary action in the bottom thumb zone,
  nothing that only works on hover, and no horizontal page scroll. Respect `env(safe-area-inset-*)`.
- **Desktop is a broadcast wall:** a top bar, panels side by side, and a race-control ticker along
  the bottom.
- **Motion:** rows trade places with `transform: translateY` over `.6s cubic-bezier(.3,.9,.2,1)`;
  timing cells flash purple or green for ~1.5s. Respect `prefers-reduced-motion` (base.css does).
- Radii 3–4px. No soft shadows except the pit board and overlays.
- Keyboard: Enter is the primary action, Esc goes back, ↑/↓ move through towers.
  Focus is the yellow ring.

## Screens

1. **Tower (home):** header (logo · `● LIVE · N ON TRACK` · race friends · profile), the yellow
   **Daily** bar, tabs **LIVE · NEAR ME · WORLD**, the timing tower, and the yellow **BOX BOX** bar
   at the bottom (races your last circuit). There's no featured list: the 22 pre-built circuits are
   rows like any other.
2. **Pit board (circuit):** the track design large (sectors, start line, direction, turn numbers,
   live dots), the pit board (code/length · your P and time · next medal and gap), the name row,
   medal targets, the classification with GHOST buttons, session tabs (TIME TRIAL · RACE FRIENDS ·
   CHALLENGE LINK), settings (time of day, controls) and a green **START {CODE}**.
3. **Grid (pre-race briefing), race HUD and pause.**
4. **Lobby, results, changelog, layout editor.**

## Who owns which files (during the redesign)

| Work | Files |
| --- | --- |
| Home: tower, pit board, profile | `src/ui/atlas.ts`, `src/ui/atlasViews.ts`, `src/styles/atlas.css`, `src/ui/profile.ts`, `src/ui/world.ts`, `src/main.ts` |
| Race: grid, HUD, pause | `src/ui/intro.ts`, `src/game/hud.ts`, `src/styles/race.css`, `src/game/race.ts` (only if a hook is needed) |
| Pages: lobby, results, changelog, editor | `src/ui/lobby.ts`, `src/ui/raceOverlay.ts`, `src/ui/multiplayer.css`, `src/ui/changelog.ts`, `src/styles/changelog.css`, `src/ui/editorScreen.ts`, `src/ui/layoutEditor.ts`, `src/styles/editor.css` |
| Shared (foundation, change only by agreement) | `src/styles/base.css`, `src/ui/pitwall.ts`, `src/ui/trackArt.ts`, `index.html`, this file |

### Editor contract

`openLayoutEditor({ track, driver, onSaved(layout, base), onClose }) => close` in
`src/ui/editorScreen.ts`. It opens a full-screen editor with its own Leaflet satellite map (Esri
World Imagery) and the existing `LayoutEditor`, and saves with `api.saveLayout`. The home screen
calls it from the pit board ("Layout looks wrong? Fix it") and handles `onSaved`.
