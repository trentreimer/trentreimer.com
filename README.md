# test-site-1 — terminal theme redesign prototype

A self-contained, one-page scrolling redesign of trentreimer.com. Static HTML/CSS/JS —
no build step, no dependencies, no PHP. All scroll effects are plain
IntersectionObserver + CSS; all sounds are synthesized with the Web Audio API
(no audio files needed).

## Preview

From this folder:

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

or from the repo root:

```sh
php -S localhost:8080 -t test-site-1
```

Opening `index.html` directly from disk also works (fonts fall back to local
monospace if offline).

## What's inside

| File | Purpose |
|---|---|
| `index.html` | the whole page, content and structure |
| `assets/styles.css` | CRT terminal theme, scroll animations, layout |
| `assets/app.js` | boot sequence, typing, observers, pac-man bar, sounds, easter egg |
| `assets/arcade.js` | bonus cabinet shell — loop, HUD, input, hi-scores, game rotation |
| `assets/games/*.js` | the three cartridges: tetris, pacman, invaders |
| `assets/favicon.png` | copied from `public/images/tr-icon-96.png` |
| `screenshots/` | headless-browser captures of every stage (desktop + mobile) |

## Dev hooks (query params)

- `?instant=1` — skip boot and all animation; renders the final state (good for
  screenshots and print).
- `?only=<id>` — render a single section pinned at the top
  (`home`, `about`, `network`, `ai`, `skills`, `contact`).
- `?goto=<id>` — jump to a section on load.
- `?debug=1` — log stage trigger/queue/typing order to the console.
- `?boot=1` — force the boot overlay on a screen that would skip it (small
  screens skip it by default).
- `?play=<key>` — open straight into an arcade game
  (`tetris`, `pacman`, `invaders`, `donkeykong`).
Combine them, e.g. `?instant=1&only=ai`.

## Tests

Node suites (jsdom, with a stubbed IntersectionObserver driving the real
animation mode) — run each with `node tests/<file>`:

- `tests/queue.test.js` — one stage types at a time; entering a stage starts it
  immediately and completes earlier stages on the spot; number-key and nav-link
  jumps animate at once; a mid-page return skips the boot screen.
- `tests/reveal.test.js` — a stage approached from below (scroll-up, or landing
  mid-page) reveals instantly without queueing; an on-screen stage never waits
  behind an off-screen backlog.
- `tests/pac.test.js` — the pac-man progress bar eats the dot under the sprite
  at page load and never leaves a dot behind it.
- `tests/games.test.js` — each cartridge loads in a bare VM sandbox, keeps to
  the agreed canvas size, renders in every state, responds to input (scores
  rise, lives fall) and avoids the DOM/timers the shell owns; plus Pac-Man's
  maze is validated — row lengths, sealed border, and a flood fill proving every
  dot and the ghost house are reachable from the player start.

Browser check (needs the folder served, e.g. `python3 -m http.server 8000`):

- `tests/caret-layout.test.html` — typing layout, measured in a real browser: the
  caret is zero-advance, so it stays on the text line even when typing fills a
  line exactly (the "cursor skips down a line" regression); and an INLINE `.t`
  that wraps keeps its whole box for the live overlay instead of one line
  fragment's width (the boot command breaking one character per line on a phone,
  before the webfont loads).
- `tests/arcade.test.html` — the lazy-load guarantee (nothing arcade-related is
  fetched at the top; scrolling to the bottom fetches the cabinet and exactly
  one cartridge) and all four games played through in the real page.
- `tests/sprites.html` — not a suite: a driven board for inspecting sprite work.
  It steps the Donkey Kong cartridge directly (so barrels are actually out on the
  board, which the cabinet's READY state never shows) and draws the board at 3x
  beside two zoomed strips that follow a single barrel — one on a ladder, one on
  a ramp; `screenshots/donkeykong-barrels.png` came from it.

```sh
node tests/queue.test.js
node tests/reveal.test.js
node tests/pac.test.js
node tests/games.test.js
# browser suites — note: plain --headless, not --headless=new
chromium --headless --virtual-time-budget=90000 --dump-dom \
  http://localhost:8000/tests/caret-layout.test.html | grep RESULT
chromium --headless --virtual-time-budget=90000 --dump-dom \
  http://localhost:8000/tests/arcade.test.html | grep RESULT
```

The browser suites need the plain headless mode: the new headless under a
virtual clock never delivers IntersectionObserver notifications, and the arcade
test dispatches the scroll event itself for the same reason — the assertion is
about the page's rule (load only once the arcade is near), not harness timing.

## Theme map (old site → new)

- Same phosphor-green CRT identity, upgraded with scanlines, vignette and
  a CRT power-on flash. Fonts: VT323 (arcade display) + Share Tech Mono (body).
- The old `type-in` effect is kept and now drives every stage, triggered by scroll.
- The old multi-page nav (Home/About/Contact + number-key shortcuts) becomes a
  fixed "process list" side nav with the 6 stages plus a bonus entry; keys 1–7
  still jump.
- Old audio assets (beeps, waka, Pac-Man theme) stay in `public/audio/` — the
  prototype synthesizes its own retro bleeps instead. Sound is off by default,
  toggle with the button or `m`.

## Stages and scroll effects

1. **home** — boot overlay (BIOS lines, skippable) plays when the visitor
   starts at the top — fresh visit or a reload made while scrolled up.
   Landing mid-page (scroll restoration, `#fragment` link) skips it so
   content is immediate, and so does a small screen (≤780px, where the overlay
   is mostly a delay in front of the content — `?boot=1` forces it back); the
   terminal then types the intro, focus-area chips pop in.
2. **about** — the `whois` command types, then the bio and the `/etc/trent`
   system card fade in together as one block.
3. **network** — SVG topology draws its links in as you scroll, packets
   (cyan/green/amber) loop along the wires, radar rings pulse on nodes,
   a traceroute log prints.
4. **ai** — ASCII neural net fires layer-by-layer in a loop; a training log
   types epochs and converges.
5. **skills** — `ls -la` listing where each skill fills an RPG-style HP meter.
6. **contact** — the email link front and centre, copy button, and a playful `ping` demo.

**Bonus — the arcade.** Scroll past the contact stage and a cabinet appears with
four games: **Tetris**, **Pac-Man**, **Space Invaders** and **Donkey Kong**
(the 25m barrel board — climb the girders, jump the barrels, grab a hammer). Which one you get is
an easter egg: the cabinet deals a different game on each visit (remembered in
`localStorage`, so consecutive visits rotate), and there is deliberately no menu
to pick one. Arrows steer (WASD works too), space is the action key, `p` pauses,
`r` restarts, and there is a touch pad on phones whose round button is labelled
for the game in hand — FIRE, JUMP, DROP — and hidden for Pac-Man, which binds no
action at all. `?play=<key>` opens a specific
game directly, which is how the suites and screenshots drive them. Each game keeps a hi-score in
`localStorage`, pauses itself when you scroll away, and the cabinet carries the
site's only persistent state (sound preference, reading position, hi-scores) —
no cookies, no trackers, no network calls beyond its own assets.

Donkey Kong's barrels change view with what they are doing. Rolling along a ramp
a barrel has its axis pointing at you, so you see one circular end: an amber rim
around the head boards, which turn as it goes. On a ladder it lies across the
rungs instead, so there you see it in profile. Either way the turn is driven by
distance travelled rather than by a clock — the rolling angle is spin/radius
(rolling without slipping, so it turns at the rate a real wheel would), a stopped
cabinet shows a still barrel, and a barrel that rolls further turns further.

**Nothing game-related loads until you get there.** The page ships no game code
on a normal visit: `app.js` fetches `assets/arcade.js` only when the arcade
section comes near the viewport, and the shell then fetches just the one
cartridge it is about to play. Verified by the test suite, which asserts that no
arcade asset is requested while the visitor stays at the top.

Security is deliberately not a stage of its own: it is a consideration applied
while building (input validation, hardened servers), noted in the hero
focus-area chips rather than presented as a discipline in its own right.

Scroll progress is a Pac-Man eating a line of dots across the top (waka waka
if sound is on).

Accessibility: works with JS disabled (full text visible, static fallback art),
respects `prefers-reduced-motion` (no typing, no loops, no flicker), decorative
animations are `aria-hidden`.

## Status

Verified with headless Chromium: all 6 stages plus the arcade render at 1400×900 and 390×844,
boot overlay runs and skips correctly, no console errors
(`screenshots/` holds the captures, including `arcade-games.png` with all four
cabinets side by side, and `donkeykong-barrels.png` — a driven in-play DK board,
since the cabinet sits in READY in the other captures and so shows no barrels).

## Next steps if approved

Port the stages into the existing PHP views (`application/views/`) or serve
this folder as-is; content copy is unchanged from the current site.
