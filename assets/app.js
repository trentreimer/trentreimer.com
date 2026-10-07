/* ============================================================
   trentreimer.com — test-site-1
   scroll-triggered terminal animations · vanilla JS, no deps
   ============================================================ */
(() => {
'use strict';

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/* ?instant=1 — dev/verification hook: skip boot + animations, show final state */
const INSTANT = /[?&]instant/.test(location.search);
/* ?debug=1 — dev hook: log stage trigger/queue/typing order to the console */
const DEBUG = /[?&]debug/.test(location.search);

document.documentElement.classList.remove('no-js');
document.documentElement.classList.add('js');
if (INSTANT) document.documentElement.classList.add('no-anim');

/* ============================================================
   audio — synthesized retro bleeps, no files, default OFF
   ============================================================ */
let audio = null;
let sndOn = false;
try { sndOn = localStorage.getItem('tr-snd') === 'on'; } catch (e) { /* private mode */ }

let lastWaka = 0;
let wakaHi = false;

function actx() {
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  return audio;
}

function blip(freq, dur = 0.07, type = 'square', gain = 0.045, delay = 0) {
  if (!sndOn) return;
  const c = actx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}

function waka() {
  const now = performance.now();
  if (now - lastWaka < 110) return;
  lastWaka = now;
  wakaHi = !wakaHi;
  blip(wakaHi ? 540 : 340, 0.05, 'square', 0.035);
}

function chord(freqs, gap = 0.09) {
  freqs.forEach((f, i) => blip(f, 0.12, 'square', 0.04, i * gap));
}

const sndBtn = $('#sndbtn');
function paintSnd() {
  sndBtn.textContent = sndOn ? '[♪ snd: on]' : '[♪ snd: off]';
  sndBtn.classList.toggle('on', sndOn);
  sndBtn.setAttribute('aria-pressed', String(sndOn));
}
function toggleSnd() {
  sndOn = !sndOn;
  try { localStorage.setItem('tr-snd', sndOn ? 'on' : 'off'); } catch (e) { /* ignore */ }
  paintSnd();
  if (sndOn) { actx(); chord([660, 880]); }
}
sndBtn.addEventListener('click', toggleSnd);
paintSnd();

/* unlock the audio context on first gesture */
const unlock = () => { if (sndOn) actx(); };
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

/* The arcade cabinet (assets/arcade.js, fetched only when the visitor reaches
   the bottom of the page) borrows this so it shares one audio context and
   honours the same sound toggle. */
window.__trSfx = {
  enabled: () => sndOn,
  blip: (freq, dur, type, gain) => blip(freq, dur, type, gain)
};

/* ============================================================
   typing
   ============================================================ */
function typeText(el, text, speed = 24, done, abort) {
  /* If a ghost reserved this element's final box, type into a .type-live span
     that overlays the ghost — the element's height stays the ghost's height for
     the whole type-in, so surrounding cards never grow. */
  const ghost = el.querySelector(':scope > .type-ghost');
  let live = null;
  if (ghost) {
    live = document.createElement('span');
    live.className = 'type-live';
    ghost.after(live);
  }
  const set = t => { if (live) live.textContent = t; else el.textContent = t; };
  const finish = () => {
    if (ghost) {
      ghost.remove();
      el.classList.remove('has-ghost');
      if (live) { el.textContent = live.textContent; live.remove(); }
    }
    el.classList.remove('typing');
    if (done) done();
  };

  set('');
  el.classList.add('typing');
  /* the caret rides the live overlay, not the reserved ghost text */
  if (live) live.classList.add('typing');
  const pauseChars = ',.:;!?'.split('');
  let i = 0;
  (function step() {
    if (abort && abort()) { set(text); finish(); return; }
    if (i >= text.length) { finish(); return; }
    const c = text[i++];
    set(text.substring(0, i));
    let pause = speed + Math.random() * speed * 0.8;
    if (pauseChars.includes(c)) pause = 240;
    else if (c === ' ') pause = speed * 0.5;
    setTimeout(step, pause);
  })();
}

/* capture final text, then reserve its box and clear the visible text.
   The cleared element would collapse to zero height and the card would grow
   line-by-line as the type-in runs; instead a hidden ghost holds the exact
   final box (same text, font and width), so every card is its true size from
   the first frame. */
$$('[data-type]').forEach(el => {
  el.dataset.trText = el.textContent;
  if (REDUCED || INSTANT) return;

  const ghost = document.createElement('span');
  ghost.className = 'type-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.textContent = el.dataset.trText;
  el.textContent = '';
  el.appendChild(ghost);
  el.classList.add('has-ghost');   /* live text overlays the reserved box */
  /* An INLINE .t that wraps gives the absolutely positioned overlay a containing
     block the width of a single line fragment, so the typed text breaks one
     character per line — this is the boot command line on a phone, while the
     webfont is still loading and the line wraps. An inline-block containing
     block is the whole wrapped box. Block-level .t elements already are one. */
  if (getComputedStyle(el).display === 'inline') el.classList.add('t-inline');
});

let ffSec = null;      /* section whose running sequence must fast-forward */
let runningSec = null; /* section currently typing (queue head) */
let focusSec = null;   /* section the visitor last entered — it types next */

function runSeq(sec, done) {
  const finish = () => {
    if (ffSec === sec) ffSec = null;
    sec.classList.add('typed-done');
    if (done) done();
  };
  if (ffSec === sec) {
    $$('[data-type]', sec).forEach(el => {
      el.textContent = el.dataset.trText;
      el.classList.remove('typing', 'has-ghost', 't-inline');
    });
    finish();
    return;
  }
  /* instant hook / reduced motion / already revealed: show final state, never retype */
  if (sec.classList.contains('typed-done') || REDUCED || INSTANT) { finish(); return; }

  const els = $$('[data-type]', sec);
  if (!els.length) { finish(); return; }

  let i = 0;
  (function next() {
    if (ffSec === sec) {
      els.slice(i).forEach(el => {
        el.textContent = el.dataset.trText;
        el.classList.remove('typing', 'has-ghost', 't-inline');
      });
      finish();
      return;
    }
    if (i >= els.length) { finish(); return; }
    const el = els[i++];
    const text = el.dataset.trText;
    const speed = parseFloat(el.dataset.speed || '24');
    const gap = parseFloat(el.dataset.gap || '240');
    typeText(el, text, speed, () => setTimeout(next, gap), () => ffSec === sec);
  })();
}

/* show a stage complete right away — used when the visitor arrives mid-page,
   reloads below the top, or scrolls UP into a stage (it is already behind
   them; no animation, no queue wait) */
function finishInstant(sec) {
  const first = !sec.classList.contains('typed-done');
  if (runningSec === sec) ffSec = sec;
  $$('[data-type]', sec).forEach(el => {
    el.textContent = el.dataset.trText;
    el.classList.remove('typing', 'has-ghost', 't-inline');
  });
  sec.classList.add('played', 'typed-done');
  sec.dataset.sfxDone = '1';
  sec.dataset.seqQueued = '1';
  if (DEBUG && first) console.log('[stage] instant ' + sec.id);
}

/* typing queue — only one stage's sequence runs at a time, so short stages
   that share a viewport never animate simultaneously */
const seqQueue = [];
let seqRunning = false;

function queueSeq(sec) {
  if (sec.dataset.seqQueued) return;
  sec.dataset.seqQueued = '1';
  seqQueue.push(sec);
  if (DEBUG) console.log('[stage] queued  ' + sec.id + '  (queue: ' + seqQueue.map(s => s.id).join(', ') + ')');
  pumpSeq(true);
}

function pumpSeq(draining) {
  if (seqRunning || !seqQueue.length) return;
  let sec = seqQueue.shift();
  if (draining) {
    while (sec && sec !== focusSec) {
      /* superseded while waiting — show it complete */
      if (DEBUG) console.log('[stage] drain  ' + sec.id);
      finishInstant(sec);
      sec = seqQueue.shift();
    }
  }
  if (!sec) return;
  seqRunning = true;
  runningSec = sec;
  if (DEBUG) console.log('[stage] START  ' + sec.id);
  runSeq(sec, () => {
    if (DEBUG) console.log('[stage] end    ' + sec.id);
    seqRunning = false;
    runningSec = null;
    pumpSeq(true);
  });
}

/* the stage the visitor just entered — by scrolling into it, clicking its
   nav link or pressing its number — takes the focus unconditionally:
   everything still typing or queued completes on the spot so the entered
   stage starts immediately and never waits behind earlier stages */
function enterSection(sec) {
  focusSec = sec;
  if (runningSec && runningSec !== sec) {
    if (DEBUG) console.log('[stage] ff     ' + runningSec.id + ' (for ' + sec.id + ')');
    ffSec = runningSec;
  }
  for (let i = seqQueue.length - 1; i >= 0; i--) {
    if (seqQueue[i] !== sec) {
      if (DEBUG) console.log('[stage] drop   ' + seqQueue[i].id + ' (for ' + sec.id + ')');
      finishInstant(seqQueue[i]);
      seqQueue.splice(i, 1);
    }
  }
  queueSeq(sec);
}

/* per-stage arcade blip, fired once when a stage first activates */
const STAGE_SFX = {
  network: [440, 660],
  ai:      [523, 659, 784],
  skills:  [988, 1319],          // coin!
  contact: [659, 784, 988]
};

/* ============================================================
   bonus arcade — loaded on demand
   The cabinet script (and, through it, the chosen game) is fetched only once
   the visitor actually scrolls down to the arcade: nothing game-related is
   requested on a normal visit.
   ============================================================ */
(function lazyArcade() {
  const slot = $('#arcade-cab');
  if (!slot) return;
  let requested = false;
  const load = () => {
    if (requested) return;
    requested = true;
    const s = document.createElement('script');
    s.src = 'assets/arcade.js';
    s.async = true;
    s.dataset.arcade = '1';
    document.head.appendChild(s);
  };
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      obs.disconnect();
      load();
    });
  }, { rootMargin: '160px 0px' });   /* start a moment before it scrolls in */
  io.observe(slot);

  /* Belt and braces: a proximity check on scroll. IntersectionObserver is the
     primary trigger, but it can be slow to deliver (and is skipped entirely in
     some headless/renderless contexts), so the cabinet must not depend on it
     alone to appear when the visitor is clearly at the bottom. */
  const near = () => {
    const r = slot.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top < vh * 2 && r.bottom > -vh;
  };
  const check = () => { if (!requested && near()) load(); };
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  check();   /* covers arriving mid-page, already near the bottom */
})();

/* ============================================================
   boot sequence
   ============================================================ */
const boot = $('#boot');
let bootDone = false;

/* jump to a stage by nav link or number key — the stage's animation starts
   immediately (not when the scroll eventually crosses the trigger line) */
let pendingJump = null;
function jumpTo(sec) {
  if (!sec) return;
  if (!bootDone) { pendingJump = sec; return; }  /* boot overlay still up */
  sec.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  if (!sec.classList.contains('played')) {
    sec.classList.add('played', 'on');
    if (!sec.dataset.sfxDone) {
      sec.dataset.sfxDone = '1';
      const f = STAGE_SFX[sec.id];
      if (f && sndOn && !REDUCED) chord(f);
    }
  }
  enterSection(sec);
}

/* flashed: true only when a real boot sequence just played out — the CRT
   power-on flash is the payoff for watching it, so a skipped boot (mid-page
   landing, small screen, ?instant, reduced motion) does not flash. */
function finishBoot(flashed) {
  if (bootDone) return;
  bootDone = true;
  document.body.classList.add('crt-off');
  if (flashed && !REDUCED && !INSTANT) document.body.classList.add('crt-on');
  setTimeout(() => {
    boot.remove();
    document.body.classList.remove('booting');
  }, (REDUCED || INSTANT) ? 0 : 350);
  if (INSTANT) {
    $$('.sec').forEach(s => s.classList.add('played', 'on', 'typed-done'));
  }
  startObservers();

  /* ?goto=<id> — dev hook: jump to a section without fragment navigation */
  const goto_ = location.search.match(/[?&]goto=([\w-]+)/);
  if (goto_) {
    const target = document.getElementById(goto_[1]);
    if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'auto', block: 'start' }));
  }

  /* ?only=<id> — dev hook: render a single section at the top (screenshots, debugging) */
  const only = location.search.match(/[?&]only=([\w-]+)/);
  if (only) {
    const target = document.getElementById(only[1]);
    if (target) {
      document.body.classList.add('only');
      document.body.classList.add('only-' + only[1]);
      target.classList.add('target');
    }
  }

  /* a nav-link or number-key jump pressed during boot applies now */
  if (pendingJump) { const j = pendingJump; pendingJump = null; jumpTo(j); }
}

/* remember where the visitor was, so a return to the page can tell
   "starting fresh at the top" (boot screen) from "coming back mid-page"
   (no boot — they are already looking at content) */
let savedY = 0;
try { savedY = parseInt(sessionStorage.getItem('tr-scroll') || '0', 10) || 0; } catch (e) { /* private mode */ }

let savePending = false;
function saveScrollNow() {
  try { sessionStorage.setItem('tr-scroll', String(window.scrollY | 0)); } catch (e) { /* ignore */ }
}
window.addEventListener('scroll', () => {
  if (savePending) return;
  savePending = true;
  requestAnimationFrame(() => { savePending = false; saveScrollNow(); });
}, { passive: true });
window.addEventListener('pagehide', saveScrollNow);

/* The boot overlay covers the whole viewport, and on a phone it is mostly a
   delay in front of the content, so small screens skip it — the hero still
   types in as you land on it. ?boot=1 forces it back: a dev hook, and how the
   suites check the boot at phone widths. */
const SMALL_SCREEN = window.matchMedia('(max-width: 780px)').matches;
const FORCE_BOOT = /[?&]boot=1/.test(location.search);

function runBoot() {
  /* boot plays only when the visitor starts at the top: fresh visit or a
     reload made while scrolled to the top. Skipped when landing mid-page —
     scroll restoration, a #fragment deep link, or the ?goto/?only/?play hooks —
     for reduced motion / ?instant, and on small screens unless ?boot=1.
     The CRT power-on flash belongs to the END of the boot sequence, so every
     skipped path passes flashed=false: no boot, no flash. */
  const deepLink = !!location.hash || /[?&](goto|only|play)=/.test(location.search);
  const startAtTop = !REDUCED && !INSTANT && !deepLink && savedY < 50 &&
                     (FORCE_BOOT || !SMALL_SCREEN);
  if (!startAtTop) { finishBoot(false); return; }

  const skip = () => finishBoot(true);
  window.addEventListener('keydown', skip, { once: true });
  window.addEventListener('pointerdown', skip, { once: true });
  window.addEventListener('scroll', skip, { once: true, passive: true });

  const lines = $$('.bline', boot);
  lines.forEach((l, i) => setTimeout(() => l.classList.add('show'), 180 + i * 300));

  const lastLine = $('#boot [data-type]');
  const lastDelay = 180 + (lines.length - 1) * 300 + 250;
  setTimeout(() => {
    typeText(lastLine, lastLine.dataset.trText, 16, () => setTimeout(() => finishBoot(true), 480));
  }, lastDelay);

  /* hard cap so a stuck timer can never trap the visitor */
  setTimeout(() => finishBoot(true), lastDelay + 4200);
}
runBoot();

/* ============================================================
   scroll observers — fire the stage animations
   ============================================================ */
function startObservers() {
  /* the visitor may have landed mid-page (reload scroll restoration, #fragment):
     everything already above the viewport is behind them — show it complete */
  if (window.scrollY > 0) {
    $$('.sec').forEach(sec => {
      if (sec.getBoundingClientRect().bottom <= 0) finishInstant(sec);
    });
  }

  /* once-per-load trigger: fires when a stage's TOP crosses ~58% of the
      viewport height — its neighbour below is still held back at that point */
  const playIO = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const sec = en.target;
      const rect = en.boundingClientRect || sec.getBoundingClientRect();

      /* arriving from below — scrolled up into it, or landed inside/past it:
         the stage is behind the visitor, show it complete instead of queueing */
      if (rect.top < 0) { finishInstant(sec); return; }

      sec.classList.add('played');
      sec.classList.add('on');
      if (DEBUG) console.log('[stage] fired  ' + sec.id);
      if (!sec.dataset.sfxDone) {
        sec.dataset.sfxDone = '1';
        const f = STAGE_SFX[sec.id];
        if (f && sndOn && !REDUCED) chord(f);
      }

      /* the entered stage takes the focus: text above completes on the spot,
         this stage starts immediately */
      enterSection(sec);
    });
  }, { rootMargin: '0px 0px -42% 0px', threshold: 0 });

  /* continuous trigger: keeps looping animations running only while visible */
  const loopIO = new IntersectionObserver(entries => {
    entries.forEach(en => en.target.classList.toggle('on', en.isIntersecting));
  }, { threshold: 0.05 });

  $$('.sec').forEach(sec => { playIO.observe(sec); loopIO.observe(sec); });

  /* nav highlight: whichever section crosses the viewport centre */
  const navIO = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const id = en.target.id;
      $$('#proc a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
    });
  }, { rootMargin: '-42% 0px -52% 0px', threshold: 0 });
  $$('.sec').forEach(sec => navIO.observe(sec));
}

/* ============================================================
   pac-man scroll progress
   ============================================================ */
const pacbar = $('#pacbar');
const pac = $('#pac');
const dotsWrap = $('#pacdots');
const NDOTS = 26;
const dots = [];
for (let i = 0; i < NDOTS; i++) {
  const d = document.createElement('i');
  dotsWrap.appendChild(d);
  dots.push(d);
}

/* the sprite is 34px wide: its leading arc reaches ~0.88 of its width from the
   left edge (centre x+17, r≈16). A dot is eaten once that arc is over it, so a
   dot can never sit half-covered behind the pack. */
const PAC_START = 28;   /* sprite rest inset — aligns with the dot track */
const DOT_R = 3;        /* dot radius, for the no-layout fallback only */

let dotX = [];          /* dot centres, measured in pacbar space */
let pacLead = 30;       /* how far the leading arc reaches from the sprite's left */
let travel = 0;         /* sprite travel over the full scroll range */

/* Measure the rendered bar instead of re-deriving the CSS: #pacdots lays dots
   out with space-between, so the first and last sit flush against the track
   ends. Re-derived geometry is what previously left a 1px sliver of the first
   dot poking out behind the sprite. */
function measurePac() {
  const barBox = pacbar.getBoundingClientRect();
  const barW = barBox.width || pacbar.clientWidth;
  const spriteW = pac.getBoundingClientRect().width;
  if (spriteW) pacLead = spriteW * 0.88;

  const rects = dots.map(d => d.getBoundingClientRect());
  if (rects[0] && rects[0].width) {
    dotX = rects.map(r => r.left + r.width / 2 - barBox.left);
  } else if (barW) {
    /* no layout available (headless/jsdom): mirror the real space-between track */
    const track = barW - 56;
    dotX = dots.map((d, i) => 28 + DOT_R + (track - DOT_R * 2) * i / (NDOTS - 1));
  } else {
    dotX = [];
  }

  travel = dotX.length
    ? Math.max(0, dotX[dotX.length - 1] - pacLead - PAC_START)
    : 0;
}

const hint = $('.scrollhint');
let levelDone = false;

function pacFrame() {
  if (!dotX.length) measurePac();   /* bar may have been hidden at load */

  const docH = document.documentElement.scrollHeight - window.innerHeight;
  const p = docH > 0 ? Math.min(1, Math.max(0, window.scrollY / docH)) : 0;

  const x = PAC_START + p * travel;
  pac.style.transform = 'translateX(' + x.toFixed(1) + 'px)';

  /* purely geometric: whatever the mouth already covers is eaten — including
     the dot under the sprite at page load */
  const mouth = x + pacLead;
  let newlyEaten = false;
  dots.forEach((d, i) => {
    if (d.classList.contains('eaten') || dotX[i] === undefined) return;
    if (mouth >= dotX[i]) { d.classList.add('eaten'); newlyEaten = true; }
  });
  if (newlyEaten) waka();

  if (!levelDone && p >= 1) {
    levelDone = true;
    if (sndOn) chord([660, 880, 1320], 0.1);
  }

  if (hint && window.scrollY > 90) hint.classList.add('off');
}
window.addEventListener('scroll', () => requestAnimationFrame(pacFrame), { passive: true });
window.addEventListener('resize', () => { measurePac(); pacFrame(); });
window.addEventListener('load', () => { measurePac(); pacFrame(); });
measurePac();
pacFrame();

/* ============================================================
   ai — build the ascii neural net (compact 33-col, trails wave)
   ============================================================ */
(function buildNet() {
  const host = $('#net');
  if (!host) return;
  const layers = [3, 4, 4, 2];
  const ROWS = 5, COL = 6, GAP = 3;
  const width = layers.length * COL + (layers.length - 1) * GAP; /* 33 */

  const grid = Array.from({ length: ROWS }, () => Array(width).fill(' '));
  const nodes = [];   /* {r,c,layer,k} */
  const trails = [];  /* {r,c,col} */

  const rowsOf = n => {
    const out = [];
    for (let k = 0; k < n; k++) out.push(Math.round(k * (ROWS - 1) / (n - 1)));
    return out;
  };

  layers.forEach((n, L) => {
    rowsOf(n).forEach((r, k) => {
      const c = L * (COL + GAP) + 2;
      grid[r][c] = '@';
      nodes.push({ r, c, layer: L, k });
    });
  });

  /* each node connects to every node within 2 rows of the next layer */
  nodes.forEach(a => {
    if (a.layer >= layers.length - 1) return;
    nodes
      .filter(p => p.layer === a.layer + 1 && Math.abs(p.r - a.r) <= 2)
      .forEach(b => {
        const steps = b.c - a.c;
        for (let i = 1; i < steps; i++) {
          const c = a.c + i;
          const r = Math.round(a.r + (b.r - a.r) * i / steps);
          if (grid[r][c] === ' ') {
            grid[r][c] = '·';
            trails.push({ r, c });
          }
        }
      });
  });

  /* labels under each layer */
  const labels = ['input', 'hidden', 'hidden', 'output'];
  const labelRow = Array(width).fill(' ');
  labels.forEach((t, L) => {
    const base = L * (COL + GAP);
    const pad = Math.floor((COL - t.length) / 2);
    for (let i = 0; i < t.length; i++) labelRow[base + pad + i] = t[i];
  });

  host.textContent = '';
  let buf = '';
  const flush = () => {
    if (buf) { host.appendChild(document.createTextNode(buf)); buf = ''; }
  };

  const rows = grid.map(row => row.join(''));
  rows.forEach((line, r) => {
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch !== '@' && ch !== '·') { buf += ch; continue; }
      flush();
      const s = document.createElement('span');
      s.className = 'nd' + (ch === '·' ? ' dot' : '');
      s.textContent = ch;
      /* left-to-right signal sweep, nodes pop layer by layer */
      const dl = ch === '@'
        ? (0.15 + nodes.find(n => n.r === r && n.c === c).layer * 0.28).toFixed(2)
        : (c / width * 1.35).toFixed(2);
      s.style.setProperty('--dl', dl + 's');
      host.appendChild(s);
    }
    flush();
    if (r < rows.length - 1) host.appendChild(document.createTextNode('\n'));
  });
  host.appendChild(document.createTextNode('\n' + labelRow.join('').replace(/\s+$/, '')));
})();

/* ============================================================
   contact — email links, copy, ping demo
   ============================================================ */
const EMAIL = ['trentreimer', 'gmail.com'].join('@');
const mailLink = $('#mail');
if (mailLink) {
  mailLink.textContent = EMAIL;
  mailLink.href = 'mailto:' + EMAIL;
}
const writeBtn = $('#writebtn');
if (writeBtn) writeBtn.href = 'mailto:' + EMAIL;

const copyBtn = $('#copybtn');
const copied = $('#copied');
if (copyBtn) {
  copyBtn.addEventListener('click', () => {
    const show = () => {
      copied.hidden = false;
      blip(880, 0.09, 'square', 0.05);
      setTimeout(() => { copied.hidden = true; }, 2200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(EMAIL).then(show, show);
    } else {
      const ta = document.createElement('textarea');
      ta.value = EMAIL;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      ta.remove();
      show();
    }
  });
}

const pingBtn = $('#pingbtn');
const pingBox = $('#pingbox');
const PING_LINES = [
  'PING trentreimer.com (127.0.0.1): 56 data bytes',
  '64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.021 ms',
  '64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.017 ms',
  '64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.026 ms',
  '',
  '--- ping statistics ---',
  '3 packets transmitted, 3 received, 0% packet loss',
  'round-trip min/avg/max = 0.017/0.021/0.026 ms'
];
let pinging = false;

if (pingBtn && pingBox) {
  pingBtn.addEventListener('click', () => {
    if (pinging) return;
    pinging = true;
    pingBtn.textContent = '[ pinging… ]';
    $$('.pline', pingBox).forEach(n => n.parentElement.remove());
    if (REDUCED) {
      PING_LINES.forEach(t => appendPing(t));
      donePing();
      return;
    }
    PING_LINES.forEach((t, i) => {
      setTimeout(() => {
        appendPing(t);
        if (t) blip(820, 0.03, 'square', 0.02);
        if (i === PING_LINES.length - 1) donePing();
      }, 300 + i * 340);
    });
  });
}

function appendPing(text) {
  const row = document.createElement('div');
  row.className = 'trow out';
  const ps = document.createElement('span');
  ps.className = 'ps1';
  const p = document.createElement('p');
  p.className = 't pline';
  p.textContent = text;
  if (/0% packet loss/.test(text)) p.classList.add('ok');
  row.appendChild(ps);
  row.appendChild(p);
  pingBox.appendChild(row);
}

function donePing() {
  pinging = false;
  pingBtn.textContent = '[ ping again ]';
  const row = document.createElement('div');
  row.className = 'trow out';
  const ps = document.createElement('span');
  ps.className = 'ps1';
  const p = document.createElement('p');
  p.className = 't pline ok';
  p.textContent = 'status: online — email me, I answer fast ✓';
  row.appendChild(ps);
  row.appendChild(p);
  pingBox.appendChild(row);
  if (sndOn) chord([784, 988], 0.1);
}

/* ============================================================
   keyboard — 1-7 jump, m mute
   ============================================================ */
const SECTIONS = () => $$('.sec');
/* nav links: jump AND animate immediately */
$$('#proc a').forEach(a => {
  a.addEventListener('click', () => {
    jumpTo(document.getElementById((a.getAttribute('href') || '').slice(1)));
  });
});

window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  /* while a cabinet game is running the arrows and number keys belong to the
     game — only the sound toggle still answers to the page */
  if (document.body.classList.contains('arcade-playing') && e.key !== 'm' && e.key !== 'M') return;

  /* number jump */
  if (e.key >= '1' && e.key <= '7') {
    const secs = SECTIONS();
    jumpTo(secs[parseInt(e.key, 10) - 1]);
    return;
  }

  /* mute */
  if (e.key === 'm' || e.key === 'M') { toggleSnd(); return; }
});

/* ============================================================
   misc
   ============================================================ */
const year = $('#year');
if (year) year.textContent = String(new Date().getFullYear());

console.log('%c You have come to the right place. ',
  'background:#45ff6b;color:#040704;font-family:monospace;font-size:14px');

})();
