/* ============================================================
   trentreimer.com — bonus arcade cabinet  (assets/arcade.js)

   Fetched by app.js only when the visitor scrolls down to the arcade, and it in
   turn fetches just the one game it is about to play (assets/games/<key>.js).
   Nothing game-related is requested on an ordinary visit.

   The cabinet owns the canvas, the loop, the HUD, input, pause handling and the
   per-game hi-scores. Each game supplies only its own world:
       { w, h, state, score, lives, level, message,
         reset(), update(dt), draw(ctx), key(name, down),
         debug()?  }   // optional: a snapshot for the tests (see __arcade.debug)
   and the cabinet draws the READY / PAUSED / GAME OVER banners itself.
   ============================================================ */
(() => {
'use strict';

const CAB = document.getElementById('arcade-cab');
if (!CAB) return;

/* ---------- the four cabinets, and the colours they share ----------
 * `action` is the label for the touch pad's round button. It is what that
 * button does in THIS game, or null where the game has no action at all
 * (Pac-Man) — a dead button is worse than no button, so it is hidden. */
const GAMES = [
  { key: 'tetris',   name: 'TETRIS',         action: 'DROP',
    keys: '\u2190 \u2192 move \u00b7 \u2191 rotate \u00b7 \u2193 soft drop \u00b7 space hard drop' },
  { key: 'pacman',   name: 'PAC-MAN',        action: null,
    keys: '\u2190 \u2192 \u2191 \u2193 steer \u00b7 clear the maze, dodge the ghosts' },
  { key: 'invaders', name: 'SPACE INVADERS', action: 'FIRE',
    keys: '\u2190 \u2192 move \u00b7 space fire' },
  { key: 'donkeykong', name: 'DONKEY KONG', action: 'JUMP',
    keys: '\u2190 \u2192 walk \u00b7 \u2191 \u2193 climb \u00b7 space jump' },
  /* Pole Position steers and accelerates, so its pad shows two arrows and GO
   * rather than a full cross with a dead pair on it. */
  { key: 'poleposition', name: 'POLE POSITION', action: 'GO', dpad: ['left', 'right'],
    keys: '\u2190 \u2192 steer \u00b7 space accelerate' }
];
const PALETTE = {
  bg: '#040704', phos: '#45ff6b', dim: '#2f9a4d', bright: '#c8ffdb',
  amber: '#ffb84d', cyan: '#5ad7ff', red: '#ff5f5f', pac: '#ffd94a',
  brown: '#a9662d', tan: '#e0b184'
};
const sfx = window.__trSfx || { enabled: () => false, blip: () => {} };
const api = { C: PALETTE, blip: (f, d, t, g) => sfx.blip(f, d, t, g) };

/* ---------- rotation: a different game each visit ---------- */
function pickIndex() {
  let last = NaN;
  try { last = parseInt(localStorage.getItem('tr-arcade-last'), 10); } catch (e) { /* private mode */ }
  const start = (isNaN(last) || last < 0 || last >= GAMES.length)
    ? Math.floor(Math.random() * GAMES.length)   /* first visit: anywhere */
    : (last + 1) % GAMES.length;                 /* then rotate on from there */
  try { localStorage.setItem('tr-arcade-last', String(start)); } catch (e) { /* ignore */ }
  return start;
}

/* ---------- markup ---------- */
CAB.classList.remove('cab-waiting');
CAB.innerHTML =
  '<div class="cab-top">' +
    '<span class="cab-title" id="cab-title">\u2026</span>' +
    '<span class="cab-stat">SCORE <b id="cab-score">0</b></span>' +
    '<span class="cab-stat">HI <b id="cab-hi">0</b></span>' +
    '<span class="cab-stat cab-lives" id="cab-lives-wrap">LIVES <b id="cab-lives">3</b></span>' +
    '<span class="cab-stat" id="cab-level-wrap">LVL <b id="cab-level">1</b></span>' +
    '<label class="cab-pick-wrap"><span class="cab-pick-label">GAME</span>' +
      '<select class="cab-pick" id="cab-pick" aria-label="Choose a game"></select></label>' +
  '</div>' +
  '<div class="cab-screen"><canvas id="cab-canvas" width="300" height="300" tabindex="0" ' +
    'aria-label="Arcade screen"></canvas></div>' +
  '<div class="cab-controls">' +
    '<button class="cab-btn" id="cab-start" type="button">[ start ]</button>' +
    '<button class="cab-btn" id="cab-pause" type="button" aria-pressed="false">[ pause ]</button>' +
    '<span class="cab-keys" id="cab-keys"></span>' +
  '</div>' +
  '<div class="cab-touch">' +
    '<div class="cab-dpad">' +
      '<button class="d-up"    data-dir="up"    type="button" aria-label="up">\u25b2</button>' +
      '<button class="d-left"  data-dir="left"  type="button" aria-label="left">\u25c0</button>' +
      '<button class="d-down"  data-dir="down"  type="button" aria-label="down">\u25bc</button>' +
      '<button class="d-right" data-dir="right" type="button" aria-label="right">\u25b6</button>' +
    '</div>' +
    '<button class="cab-fire" id="cab-fire" data-dir="action" type="button" aria-label="action">FIRE</button>' +
  '</div>';

const canvas = document.getElementById('cab-canvas');
const ctx = canvas.getContext('2d');
const el = {
  title: document.getElementById('cab-title'),
  score: document.getElementById('cab-score'),
  hi: document.getElementById('cab-hi'),
  lives: document.getElementById('cab-lives'),
  livesWrap: document.getElementById('cab-lives-wrap'),
  level: document.getElementById('cab-level'),
  keys: document.getElementById('cab-keys'),
  start: document.getElementById('cab-start'),
  pause: document.getElementById('cab-pause'),
  fire: document.getElementById('cab-fire'),
  pick: document.getElementById('cab-pick'),
  dpad: CAB.querySelector('.cab-dpad')
};
/* The selector lists every cabinet by name, so the choice is deliberate rather
 * than a surprise. It shows the game in hand and swaps to another on change. */
el.pick.innerHTML = GAMES.map((g, i) =>
  '<option value="' + i + '">' + g.name + '</option>').join('');
el.pick.addEventListener('change', () => { select(parseInt(el.pick.value, 10), true); });

/* ---------- state ---------- */
let index = pickIndex();
let game = null;
let hi = 0;
let raf = 0;
let lastTs = 0;
let autoPaused = false;
const pressed = new Set();
const loaded = new Set();

/* ---------- hi-scores ---------- */
const hiKey = () => 'tr-hiscore-' + GAMES[index].key;
function readHi() {
  try { hi = parseInt(localStorage.getItem(hiKey()), 10) || 0; } catch (e) { hi = 0; }
}
function writeHi() { try { localStorage.setItem(hiKey(), String(hi)); } catch (e) { /* ignore */ } }

/* ---------- script loading ---------- */
function loadScript(src) {
  if (loaded.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.game = src.split('/').pop().replace('.js', '');
    s.onload = () => { loaded.add(src); resolve(); };
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

/* The canvas is scaled to fill the cabinet's screen area, so every cartridge
   reads at a comfortable size whatever its native resolution — Pac-Man's maze
   is only 304x256 natively and would otherwise sit small beside the others.
   `image-rendering: pixelated` keeps the upscaled pixels crisp.
 *
 * The height allowance is the viewport MINUS the cabinet's own chrome — the
 * HUD, the controls row, its padding and its borders — because a canvas sized
 * to a flat share of the window pushes that chrome off the edges: the frame
 * gets cut off at the bottom. The chrome is measured rather than assumed, since
 * it grows when the HUD wraps on a narrow screen. The width is whatever the
 * cabinet has, which for this section is a wider measure than the rest of the
 * page. Whichever runs out first wins, so nothing overflows. */
function fitScreen() {
  if (!game) return;
  const screen = canvas.parentElement;
  const avail = (screen && screen.clientWidth) || CAB.clientWidth || game.w;
  /* measured from the CARD, not the cabinet: the frame the visitor sees is the
     card, and its padding and border sit outside the cabinet's own chrome */
  const frame = CAB.closest('.card') || CAB;
  const chrome = Math.max(0,
    frame.getBoundingClientRect().height - canvas.getBoundingClientRect().height);
  const room = (window.innerHeight || 800) - chrome - 12;   // 12px of breathing space
  const maxH = Math.max(200, Math.round(room));
  const scale = Math.min(avail / game.w, maxH / game.h);
  canvas.style.width = Math.max(1, Math.round(game.w * scale)) + 'px';
  canvas.style.height = Math.max(1, Math.round(game.h * scale)) + 'px';
}

/* ---------- HUD + banners ---------- */
function refreshHud() {
  if (!game) return;
  el.title.textContent = GAMES[index].name;
  el.score.textContent = String(game.score || 0);
  el.hi.textContent = String(Math.max(hi, game.score || 0));
  el.lives.textContent = '\u2665'.repeat(Math.max(0, game.lives || 0));
  el.livesWrap.hidden = !game.lives;
  el.level.textContent = String(game.level || 1);
  el.keys.textContent = GAMES[index].keys;
  el.pause.setAttribute('aria-pressed', String(game.state === 'paused'));
}

function banner(lines) {
  const w = canvas.width, h = canvas.height;
  ctx.save();
  ctx.fillStyle = 'rgba(4, 7, 4, .78)';
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PALETTE.bright;
  ctx.font = 'bold ' + Math.max(14, Math.round(w / 22)) + 'px "Share Tech Mono", monospace';
  lines.forEach((line, i) => {
    if (i === 1) { ctx.fillStyle = PALETTE.dim; ctx.font = Math.round(w / 30) + 'px "Share Tech Mono", monospace'; }
    ctx.fillText(line, w / 2, h / 2 + (i - (lines.length - 1) / 2) * Math.round(w / 16));
  });
  ctx.restore();
}

function render() {
  if (!game) return;
  if ((game.score || 0) > hi) { hi = game.score; writeHi(); }
  game.draw(ctx);
  const st = game.state;
  if (st === 'ready') banner(['INSERT COIN', 'press START \u2014 or pick a game above']);
  else if (st === 'paused') banner(['PAUSED', 'press P or PAUSE to resume']);
  else if (st === 'over') banner(['GAME OVER', game.message || 'press R or START to play again']);
  else if (st === 'win') banner(['YOU WIN', game.message || 'press R or START for another run']);
  refreshHud();
  document.body.classList.toggle('arcade-playing', st === 'playing');
}

/* ---------- the loop: runs only while a game is actually being played ---------- */
function tick(ts) {
  raf = 0;
  if (!game || game.state !== 'playing') return;
  const dt = Math.min(50, ts - lastTs);       /* clamp so tab switches don't jump */
  lastTs = ts;
  game.update(dt);
  render();
  if (game.state === 'playing') raf = requestAnimationFrame(tick);
  else releaseKeys();
}
function play() {
  if (!game || game.state !== 'playing') return;
  lastTs = performance.now();
  if (!raf) raf = requestAnimationFrame(tick);
}

/* ---------- lifecycle ---------- */
function releaseKeys() {
  pressed.forEach(name => { if (game && game.state === 'playing') game.key(name, false); });
  pressed.clear();
}

function start() {
  if (!game) return;
  releaseKeys();
  game.reset();
  game.state = 'playing';
  autoPaused = false;
  render();
  play();
  try { canvas.focus({ preventScroll: true }); } catch (e) { canvas.focus(); }
}

function pauseToggle() {
  if (!game) return;
  if (game.state === 'playing') {
    releaseKeys();
    game.state = 'paused';
    render();
  } else if (game.state === 'paused') {
    game.state = 'playing';
    render();
    play();
  }
}

/* Loading a cartridge is asynchronous, so two selections can overlap — the
 * rotation picks one as the visitor arrives, and they may pick another before
 * it lands (the selector makes that easy). Each call takes a token and the
 * overtaken one bails after its await, otherwise it would build its game on top
 * of the newer selection and read the wrong entry out of GAMES. */
let selectSeq = 0;

async function select(i, autostart) {
  const token = ++selectSeq;
  index = ((i % GAMES.length) + GAMES.length) % GAMES.length;
  const picked = GAMES[index];               // what THIS call is loading
  releaseKeys();
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  game = null;
  readHi();
  el.title.textContent = picked.name;
  el.score.textContent = '0';
  el.hi.textContent = String(hi);
  el.keys.textContent = picked.keys;
  /* The pad is cut to the game: the round button says what it does here
     (FIRE / JUMP / DROP / GO), Pac-Man has no action to bind so it goes away
     rather than sitting there dead, and a game that only steers and accelerates
     shows two arrows instead of a cross with a dead pair on it. The handlers
     were bound by direction name when the shell was built, so hiding a button
     cannot leave a half-wired control behind. */
  const action = picked.action;
  el.fire.textContent = action || '';
  el.fire.hidden = !action;
  el.fire.setAttribute('aria-label', action ? action.toLowerCase() : 'action');
  const dirs = picked.dpad || ['up', 'left', 'down', 'right'];
  Array.prototype.forEach.call(el.dpad.querySelectorAll('button'), b => {
    b.hidden = dirs.indexOf(b.dataset.dir) === -1;
  });
  /* with the cross cut down to a pair, pull them together so the pad reads as
     one control instead of two buttons with a hole between them */
  el.dpad.classList.toggle('pair', dirs.length === 2);
  el.pick.value = String(index);          // the selector always shows the game in hand
  try {
    await loadScript('assets/games/' + picked.key + '.js');
  } catch (err) {
    if (token !== selectSeq) return;         // someone else owns the cabinet now
    banner(['CABINET OUT OF ORDER', 'could not load the game — check the console']);
    return;
  }
  if (token !== selectSeq) return;           // overtaken while loading: stand down
  const factory = window.__trGames && window.__trGames[picked.key];
  if (typeof factory !== 'function') {
    banner(['CABINET OUT OF ORDER', 'no game registered under ' + picked.key]);
    return;
  }
  game = factory(api);
  canvas.width = game.w;
  canvas.height = game.h;
  canvas.setAttribute('aria-label', picked.name + ' screen');
  fitScreen();
  game.state = 'ready';
  render();
  if (autostart) start();
}

/* ---------- controls ---------- */
el.start.addEventListener('click', start);
el.pause.addEventListener('click', pauseToggle);

/* keyboard: the game keys are captured before the page's own shortcuts see them */
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  Space: 'action', Enter: 'action', KeyZ: 'action'
};

function press(name) {
  if (!game || game.state !== 'playing' || pressed.has(name)) return;
  pressed.add(name);
  game.key(name, true);
}
function release(name) {
  if (!pressed.has(name)) return;
  pressed.delete(name);
  if (game && game.state === 'playing') game.key(name, false);
}

window.addEventListener('keydown', e => {
  if (!game || e.metaKey || e.ctrlKey || e.altKey) return;
  const name = KEYMAP[e.code];

  if (name) {
    if (game.state === 'playing') {
      e.preventDefault(); e.stopPropagation();        /* the page must not scroll */
      if (!e.repeat) press(name);
    } else if (game.state === 'ready' && document.activeElement === canvas) {
      e.preventDefault(); e.stopPropagation();
      start();
    } else if (game.state === 'over' || game.state === 'win') {
      if (document.activeElement === canvas) { e.preventDefault(); e.stopPropagation(); start(); }
    }
    return;
  }
  if (e.code === 'KeyP') { e.preventDefault(); e.stopPropagation(); pauseToggle(); }
  if (e.code === 'KeyR') { e.preventDefault(); e.stopPropagation(); start(); }
}, true);

window.addEventListener('keyup', e => {
  if (KEYMAP[e.code]) release(KEYMAP[e.code]);
}, true);

/* touch pad */
CAB.querySelectorAll('[data-dir]').forEach(b => {
  const name = b.dataset.dir;
  b.addEventListener('pointerdown', e => { e.preventDefault(); press(name); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
    b.addEventListener(ev, () => release(name)));
});

window.addEventListener('blur', releaseKeys);
window.addEventListener('resize', () => { fitScreen(); });

/* ---------- pause when the cabinet is off screen or the tab is hidden ---------- */
const cabIO = new IntersectionObserver(entries => {
  entries.forEach(en => {
    if (!game) return;
    if (!en.isIntersecting && game.state === 'playing') {
      autoPaused = true;
      pauseToggle();
    } else if (en.isIntersecting && autoPaused) {
      autoPaused = false;
      pauseToggle();
    }
  });
}, { threshold: 0.2 });
cabIO.observe(CAB);

document.addEventListener('visibilitychange', () => {
  if (!game) return;
  if (document.hidden && game.state === 'playing') { autoPaused = true; pauseToggle(); }
  else if (!document.hidden && autoPaused) { autoPaused = false; pauseToggle(); }
});

/* ---------- test / debug hook ---------- */
window.__arcade = {
  games: GAMES.map(g => g.key),
  current: () => GAMES[index].key,
  state: () => (game ? game.state : 'loading'),
  score: () => (game ? game.score : 0),
  lives: () => (game ? game.lives : 0),
  hi: () => hi,
  start,
  pause: pauseToggle,
  select,
  /** advance n frames of dt ms without waiting for the browser */
  step: (n, dt) => {
    if (!game || game.state !== 'playing') return;
    for (let i = 0; i < (n || 1); i++) { game.update(dt || 16); }
    render();
  },
  press,
  release,
  fitScreen,
  debug: () => (game && typeof game.debug === 'function' ? game.debug() : null),
  canvasSize: () => ({ w: canvas.width, h: canvas.height,
                       displayW: canvas.clientWidth, displayH: canvas.clientHeight })
};

/* ---------- go ---------- */
/* ?play=<key> — dev hook: open straight into a chosen game (also used for
   screenshots of each cabinet) */
const wanted = (location.search.match(/[?&]play=([\w-]+)/) || [])[1];
if (wanted) {
  const i = GAMES.findIndex(g => g.key === wanted);
  select(i === -1 ? index : i, true);
} else {
  select(index, false);
}
})();
