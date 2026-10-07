/* Donkey Kong — plain-browser arcade cartridge for the retro CRT terminal.
 * window.__trGames.donkeykong(api) -> { w, h, state, score, lives, level,
 * message, reset(), update(dt), draw(ctx), key(name, down), debug() }.
 * The shell owns the canvas, the clock, the DOM and every READY / PAUSED /
 * GAME OVER banner, so this file has no module, no build step, no DOM, no
 * timers and no rAF: game state plus a draw pass that is safe in any state
 * (the `ready` board is a fully populated world). api.C is the palette and
 * api.blip(freq, SECONDS) fires on discrete events only, never per frame. */

(function () {
  'use strict';
  window.__trGames = window.__trGames || {};
  window.__trGames.donkeykong = function createGame(api) {
    const W = 256, H = 320;                    // fixed logical canvas, 16px grid
    /* Palette from the shell, with CRT-green fallbacks. */
    const C = (api && api.C) || {};
    const COL = { bg: C.bg || '#040704', phos: C.phos || '#45ff6b', dim: C.dim || '#2f9a4d',
      bright: C.bright || '#c8ffdb', amber: C.amber || '#ffb84d', cyan: C.cyan || '#5ad7ff',
      red: C.red || '#ff5f5f', pac: C.pac || '#ffd94a',
      brown: C.brown || '#a9662d', tan: C.tan || '#e0b184' };
    function blip(f, s) { if (api && api.blip) api.blip(f, s); }   // seconds, not ms

    /* ==================== tuning (px, px/ms, px/ms^2, ms) ================= */
    const STEP = 8;             // simulation slice: a big dt is split this fine
    const MAX_DT = 400;         // ignore stalls longer than this (shell clamps too)
    const WALK = 0.075;         // Mario walking speed
    const CLIMB = 0.05;         // Mario ladder speed
    const JUMP_VY = -0.33;      // jump impulse -> apex ~42px
    const GRAV = 0.0013;        // gravity -> ~0.5s of airtime
    const LADDER_SNAP = 5;      // |dx| that still counts as "on the ladder"
    const BARREL_SPEED = 0.045; // barrel roll speed at level 1
    const BARREL_GAIN = 0.004;  // extra barrel speed per level
    const BARREL_MAX = 12;      // most barrels allowed on the board at once
    const SPAWN_EVERY = 2200;   // ms between DK's throws at level 1
    const SPAWN_GAIN = 150;     // ms shaved off per level
    const SPAWN_MIN = 900;      // fastest throw rate
    const BARREL_DIVE = 0.2;    // chance a barrel takes a ladder it passes
    const FIRE_SPEED = 0.055;   // fireball patrol speed
    const FIRE_CLIMB = 0.04;    // fireball ladder speed
    const FIRE_GAP_MIN = 1200, FIRE_GAP_MAX = 3000; // patrol time between climbs
    const FIRE_AFTER = 8;       // barrels spawned before the fireball appears
    const HAMMER_TIME = 10000;  // how long one hammer swings
    const ANIM = 110;           // ms per animation frame (Mario's walk, fire flicker)
    const DEATH_FREEZE = 1400;  // frozen world while Mario spins out
    const BONUS_START = 5000;   // board timer at the start of a life
    const BONUS_TICK = 1100;    // ms per bonus decrement
    const BONUS_STEP = 100;     // bonus lost per tick
    const PTS_JUMP = 100, PTS_BARREL = 300, PTS_FIRE = 500;   // scoring table
    const SPAWN_X = 24;                        // Mario's start x on the floor
    const DK_X = 40, DK_Y = 74;                // DK's feet (top-left perch)
    const PAULINE_X = 232, PAULINE_Y = 86;     // Pauline's feet (top-right perch)
    const WIN_X = 12;                          // |dx| to Pauline that clears it
    const HIT_DX = 10, HIT_LOW = -8, HIT_HIGH = 14;  // contact window (dy bounds)
    const SWAT_DX = 17, SWAT_DY = 16;          // hammer reach around Mario
    const MARIO_H = 17;                        // sprite height, feet to cap

    /* ======================= board: girders and ladders =================== */
    /* Walking surfaces as sloped segments; y is the line the feet stand on.
     * Slopes alternate, so a barrel rolls downhill, drops off the end and rolls
     * back the other way below. G3 is split by the gap at x=118..138. */
    const SEGS = [
      { x0: 0, y0: 302, x1: 256, y1: 290, g: 0 },    // G0  floor
      { x0: 0, y0: 252, x1: 256, y1: 264, g: 1 },    // G1
      { x0: 0, y0: 226, x1: 256, y1: 214, g: 2 },    // G2
      { x0: 0, y0: 176, x1: 118, y1: 182, g: 3 },    // G3a left half
      { x0: 138, y0: 183, x1: 256, y1: 188, g: 3 },  // G3b right half
      { x0: 0, y0: 150, x1: 256, y1: 138, g: 4 },    // G4
      { x0: 0, y0: 100, x1: 256, y1: 112, g: 5 }     // G5  top
    ];
    const FLOOR = 0, TOP = 6;                  // SEGS indices

    /* Surface height of one girder at x (x is clamped to the segment). */
    function yAt(seg, x) {
      const t = (x - seg.x0) / (seg.x1 - seg.x0);
      return seg.y0 + (seg.y1 - seg.y0) * (t < 0 ? 0 : t > 1 ? 1 : t);
    }
    /* THE collision helper, shared by Mario, the barrels and the fireball:
     * the nearest girder surface under a foot point — the smallest surface y
     * that is at or below feetY (1px of slack for rounding). `skip` lets a
     * falling barrel ignore the girder it just rolled off. */
    function supportAt(x, feetY, skip) {
      let best = null, bestY = Infinity;
      for (let i = 0; i < SEGS.length; i++) {
        const s = SEGS[i];
        if (s === skip || x < s.x0 || x > s.x1) continue;
        const y = yAt(s, x);
        if (y >= feetY - 1 && y < bestY) { bestY = y; best = s; }
      }
      return best ? { seg: best, y: bestY } : null;
    }
    function onSeg(seg, x) { return x >= seg.x0 && x <= seg.x1; }
    /* Downhill is +1 when the girder drops to the right, else -1. */
    function downhill(seg) { return seg.y1 > seg.y0 ? 1 : -1; }
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    /* Ladders joining consecutive girders, staggered so the climb zig-zags.
     * Both end heights are read off the segments, so the rungs always meet the
     * surfaces; `up`/`down` are the girder objects they connect. */
    const LADDERS = [
      { x: 36, lo: 0, hi: 1 },     // floor -> G1
      { x: 214, lo: 1, hi: 2 },    // G1 -> G2
      { x: 44, lo: 2, hi: 3 },     // G2 -> G3a
      { x: 208, lo: 4, hi: 5 },    // G3b -> G4
      { x: 40, lo: 5, hi: 6 }      // G4 -> G5
    ].map(function (L) {
      return { x: L.x, yTop: yAt(SEGS[L.hi], L.x), yBottom: yAt(SEGS[L.lo], L.x),
               up: SEGS[L.hi], down: SEGS[L.lo] };
    });
    /* The ladder whose span covers a foot point and whose x is within reach. */
    function ladderAt(x, feetY) {
      for (let i = 0; i < LADDERS.length; i++) {
        const L = LADDERS[i];
        if (Math.abs(x - L.x) <= LADDER_SNAP && feetY >= L.yTop - 3 && feetY <= L.yBottom + 3) return L;
      }
      return null;
    }
    /* Both hammers rest on a girder; their y comes from the segment. */
    const HAMMER_SPOTS = [{ x: 96, seg: 2 }, { x: 196, seg: 5 }];   // G2 and G4

    /* ============================ game state ============================== */
    const keys = { left: false, right: false, up: false, down: false, action: false };
    let mario, barrels, fireball, hammers, hammer, bonus, frozen, deathT, animT;
    let spawnAcc, bonusAcc, spawned, throwT, climbT;

    function freshHammers() {
      return HAMMER_SPOTS.map(function (s) { return { x: s.x, y: yAt(SEGS[s.seg], s.x) }; });
    }
    function placeMario() {
      mario = { x: SPAWN_X, y: yAt(SEGS[FLOOR], SPAWN_X), girder: SEGS[FLOOR], vy: 0,
                air: false, jumpY: null, climb: null, dead: false };
    }
    function resetGame() {
      barrels = []; fireball = null; spawned = 0; throwT = 0; climbT = FIRE_GAP_MIN;
      spawnAcc = 0; bonusAcc = 0; bonus = BONUS_START; frozen = 0; deathT = 0; animT = 0;
      hammer = { active: false, t: 0 };
      hammers = freshHammers();
      placeMario();
      g.score = 0; g.lives = 3; g.level = 1; g.message = '';
    }
    function spawnEvery() {
      const v = SPAWN_EVERY - SPAWN_GAIN * (g.level - 1);
      return v < SPAWN_MIN ? SPAWN_MIN : v;
    }

    /* ============================== events ================================ */
    /* Contact threats are all routed through here so a hammer always wins. */
    function die() {
      if (frozen > 0 || mario.dead) return;
      g.lives -= 1;
      mario.dead = true; mario.climb = null; mario.air = true; mario.jumpY = null;
      mario.vy = -0.05;                        // the classic little pop before the fall
      frozen = DEATH_FREEZE; deathT = 0;
      blip(90, 0.35);                          // discrete event: Mario is hit
    }
    /* Fresh hazards, fresh hammers, the clock back to 5000, Mario on the floor. */
    function resetBoard() {
      barrels = []; fireball = null; spawned = 0; spawnAcc = 0; bonusAcc = 0;
      bonus = BONUS_START; hammer.active = false; hammer.t = 0;
      hammers = freshHammers();
      placeMario();
    }
    function respawn() {
      frozen = 0; deathT = 0;
      if (g.lives <= 0) {                      // the shell draws the banner from these
        g.state = 'over';
        g.message = 'GAME OVER \u2014 press R or START';
        return;
      }
      resetBoard();                            // a fresh life on a clean board
    }
    /* Reaching Pauline banks the rest of the bonus and starts a faster board. */
    function clearBoard() {
      g.score += bonus;
      g.level += 1;
      blip(1046, 0.18);                        // discrete event: board cleared
      resetBoard();
    }
    /* A barrel or fireball scores or kills; a swinging hammer destroys instead. */
    function threat(x, y, isFire) {
      if (mario.dead) return false;
      const dx = Math.abs(mario.x - x), dy = mario.y - y;
      /* a swinging hammer reaches further than Mario's own body does */
      const rx = hammer.active ? SWAT_DX : HIT_DX;
      const ry = hammer.active ? -SWAT_DY : HIT_LOW;
      if (dx > rx || dy < ry || dy > HIT_HIGH) return false;
      if (hammer.active) {
        g.score += isFire ? PTS_FIRE : PTS_BARREL;
        blip(isFire ? 240 : 320, isFire ? 0.12 : 0.05);   // discrete event: smash
        return true;
      }
      if (isFire || !mario.air) { die(); return false; }
      return false;                            // airborne: handled by the jump award
    }

    /* ============================== Mario ================================= */
    function stepMario(dt) {
      const m = mario;
      /* ladders first: no gravity while climbing, x snapped to the rail */
      if (m.climb) {
        const L = m.climb;
        m.x = L.x;
        if (keys.up) m.y -= CLIMB * dt;
        if (keys.down) m.y += CLIMB * dt;
        /* Stop at either end; hanging within a rung of one finishes the step
         * rather than leaving Mario stuck a fraction below it. */
        const idle = !keys.up && !keys.down;
        if (m.y <= L.yTop + (idle ? 2 : 0)) {
          m.y = L.yTop; m.girder = L.up; m.climb = null; m.air = false; m.vy = 0;
        } else if (m.y >= L.yBottom - (idle ? 2 : 0)) {
          m.y = L.yBottom; m.girder = L.down; m.climb = null; m.air = false; m.vy = 0;
        }
        return;
      }
      if ((keys.up || keys.down) && !m.dead) {
        const L = ladderAt(m.x, m.y);
        /* Only grab when the ladder still has rungs that way, so holding up at
         * the top steps Mario off onto the girder instead of gluing him on. */
        if (L && ((keys.up && m.y > L.yTop + 0.5) || (keys.down && m.y < L.yBottom - 0.5))) {
          m.climb = L; m.x = L.x; m.air = false; m.jumpY = null; m.vy = 0; return;
        }
      }
      /* walk: clamped to the board, then stick to (or leave) the girder */
      const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      if (dir !== 0 && !m.dead) m.x = clamp(m.x + dir * WALK * dt, 0, W);
      if (keys.action && !m.air && !m.dead) {
        m.air = true; m.vy = JUMP_VY; m.jumpY = yAt(m.girder, m.x);
        blip(680, 0.05);                       // discrete event: jump
      }
      if (m.air) {
        /* Land on the nearest surface at or below the feet. A jump remembers the
         * height it left from, so it never snaps onto a girder above that line
         * (jumping does not change girders) — but it can still clear the G3 gap
         * and come down on G3b, which is at the same level. */
        const low = m.jumpY === null ? m.y - 1 : Math.max(m.y - 1, m.jumpY - 5);
        const surf = supportAt(m.x, low);
        m.vy += GRAV * dt;
        m.y += m.vy * dt;
        if (surf && m.vy > 0 && m.y >= surf.y) {
          m.y = surf.y; m.girder = surf.seg; m.air = false; m.jumpY = null; m.vy = 0;
        }
      } else if (onSeg(m.girder, m.x)) {
        m.y = yAt(m.girder, m.x);              // hug the girder along its slope
      } else {
        m.air = true; m.vy = 0; m.jumpY = null;   // walked past the end: fall
      }
      /* hammer pickup */
      if (!hammer.active && !m.dead) {
        for (let i = 0; i < hammers.length; i++) {
          if (Math.abs(m.x - hammers[i].x) < 10 && Math.abs(m.y - hammers[i].y) < 8) {
            hammer.active = true; hammer.t = HAMMER_TIME;
            hammers.splice(i, 1);
            blip(520, 0.12);                   // discrete event: hammer grabbed
            break;
          }
        }
      }
    }

    /* ============================= barrels ================================ */
    function spawnBarrel() {
      const seg = SEGS[TOP];
      const x = DK_X + 10;                     // clear of the G4-G5 ladder at x=40
      barrels.push({ x: x, y: yAt(seg, x), seg: seg, dir: downhill(seg), vy: 0,
                     mode: 'roll', from: null, dive: -1, l: null, jumped: false,
                     spin: 0 });               // distance rolled, drives the stave sweep
      spawned += 1;
      throwT = 520;                            // DK's throwing frame, cosmetic
      blip(150, 0.05);                         // discrete event: new barrel
    }
    function stepBarrels(dt) {
      const spd = BARREL_SPEED + BARREL_GAIN * (g.level - 1);
      for (let i = barrels.length - 1; i >= 0; i--) {
        const b = barrels[i];
        if (b.mode === 'fall') {
          b.x = clamp(b.x + b.dir * spd * 0.5 * dt, 0, W);   // keeps its heading
          const sup = supportAt(b.x, b.y - 1, b.from);
          b.vy += GRAV * dt;
          b.y += b.vy * dt;
          if (sup && b.y >= sup.y) {             // lands on the girder below
            b.mode = 'roll'; b.seg = sup.seg; b.y = sup.y; b.vy = 0;
            b.dir = downhill(sup.seg);           // and rolls back the other way
            b.dive = -1;
          }
        } else if (b.mode === 'dive') {
          const ny = b.y + spd * 0.8 * dt;       // down the ladder it picked
          b.spin += Math.abs(ny - b.y);          // it turns on the way down too
          b.y = ny;
          if (b.y >= b.l.yBottom) {
            b.mode = 'roll'; b.seg = b.l.down; b.y = b.l.yBottom;
            b.dir = downhill(b.seg); b.dive = -1;
          }
        } else {
          const nx = clamp(b.x + b.dir * spd * dt, 0, W);
          b.spin += Math.abs(nx - b.x);          // spin follows real travel, not a clock
          b.x = nx;
          b.y = yAt(b.seg, b.x);                 // hug the girder
          /* only the end it is rolling towards counts, so a barrel that lands
           * right on an end rolls away instead of dropping through again */
          const off = b.dir > 0 ? b.x >= b.seg.x1 - 0.5 : b.x <= b.seg.x0 + 0.5;
          if (off) {
            if (b.seg === SEGS[FLOOR]) { barrels.splice(i, 1); continue; }   // off the screen
            b.mode = 'fall'; b.from = b.seg; b.vy = 0;
            b.x = clamp(b.x + b.dir * 2, 0, W);  // step clear of the girder it left
            continue;
          }
          if (b.dive === -1) {                   // one roll per girder for a ladder dive
            for (let k = 0; k < LADDERS.length; k++) {
              const L = LADDERS[k];
              if (L.up === b.seg && Math.abs(b.x - L.x) <= 6) {
                b.dive = Math.random() < BARREL_DIVE ? k : -2;
                break;
              }
            }
          }
          if (b.dive >= 0) { b.mode = 'dive'; b.l = LADDERS[b.dive]; b.x = b.l.x; }
        }
        /* the jump-over award: airborne and safely above this barrel, once each */
        const bdy = mario.y - b.y;
        if (!mario.dead && !b.jumped && !hammer.active && mario.air && bdy <= HIT_LOW &&
            Math.abs(mario.x - b.x) <= HIT_DX) {
          b.jumped = true; g.score += PTS_JUMP;
          blip(980, 0.05);                       // discrete event: barrel cleared
        }
        if (threat(b.x, b.y, false) && barrels[i] === b) { barrels.splice(i, 1); }
      }
    }

    /* ============================= fireball =============================== */
    function stepFireball(dt) {
      if (!fireball) {
        if (spawned < FIRE_AFTER) return;
        const seg = SEGS[FLOOR], x = 228;      // climbs out of the bottom right
        fireball = { x: x, y: yAt(seg, x), seg: seg, dir: -1, mode: 'roll', l: null,
                     t: FIRE_GAP_MIN + Math.random() * (FIRE_GAP_MAX - FIRE_GAP_MIN) };
        blip(120, 0.15);                       // discrete event: the fireball arrives
        return;
      }
      const f = fireball;
      if (f.mode === 'climb') {
        f.y -= FIRE_CLIMB * dt;
        if (f.y <= f.l.yTop) {
          f.y = f.l.yTop; f.seg = f.l.up; f.mode = 'roll'; f.dir = downhill(f.seg);
          const sup = supportAt(f.x, f.y - 1); // re-seat on the surface it just reached
          if (sup) { f.seg = sup.seg; f.y = sup.y; }
        }
        return;
      }
      f.x = clamp(f.x + f.dir * FIRE_SPEED * dt, 0, W);
      f.y = yAt(f.seg, f.x);
      if (f.x <= f.seg.x0 + 0.5 || f.x >= f.seg.x1 - 0.5) f.dir = -f.dir;   // bounce at an end
      f.t -= dt;
      if (f.t <= 0) {                          // now and then it takes a ladder up
        f.t = FIRE_GAP_MIN + Math.random() * (FIRE_GAP_MAX - FIRE_GAP_MIN);
        for (let i = 0; i < LADDERS.length; i++) {
          const L = LADDERS[i];
          if (L.down === f.seg && Math.abs(f.x - L.x) <= 7) {
            f.mode = 'climb'; f.l = L; f.x = L.x; f.y = yAt(L.down, L.x);
            break;
          }
        }
      }
      threat(f.x, f.y, true);
    }

    /* ======================= timers, spawner, checks ====================== */
    function stepSpawner(dt) {
      throwT = throwT > 0 ? throwT - dt : 0;
      const every = spawnEvery();
      spawnAcc += dt;
      while (spawnAcc >= every) {
        spawnAcc -= every;
        if (barrels.length < BARREL_MAX) spawnBarrel();
      }
    }
    function stepBonus(dt) {
      bonusAcc += dt;
      while (bonusAcc >= BONUS_TICK) { bonusAcc -= BONUS_TICK; bonus -= BONUS_STEP; }
      if (bonus <= 0) { bonus = 0; die(); }    // the clock running out is fatal
    }
    function stepHammer(dt) {
      if (!hammer.active) return;
      hammer.t -= dt;
      if (hammer.t <= 0) {
        hammer.active = false; hammer.t = 0;
        blip(200, 0.08);                       // discrete event: the hammer expires
      }
    }
    function checkClear() {
      if (mario.dead || mario.air) return;
      if (mario.girder !== SEGS[TOP] || Math.abs(mario.x - PAULINE_X) > WIN_X) return;
      clearBoard();
    }
    /* One simulation slice: everything moves on dt, nothing per frame. */
    function step(dt) {
      animT += dt;
      if (frozen > 0) {                        // death pause: world holds still
        frozen -= dt; deathT += dt;
        mario.vy += GRAV * 0.5 * dt;           // except Mario's spin and fall
        mario.y = Math.min(H - 2, mario.y + mario.vy * dt);
        if (frozen <= 0) respawn();
        return;
      }
      stepMario(dt);
      stepBarrels(dt);
      stepFireball(dt);
      stepHammer(dt);
      stepSpawner(dt);
      stepBonus(dt);
      checkClear();
    }

    /* ============================== drawing =============================== */
    function rect(ctx, x, y, w, h, col) { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); }
    function label(ctx, s, x, y, col, font) {
      ctx.fillStyle = col; ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(s, x, y);
    }
    /* Sloped girder: a 4px deck with a lighter top edge and rivets every 8px,
     * drawn in a rotated frame so the slope costs one transform per girder. */
    function drawGirder(ctx, s) {
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = Math.sqrt(dx * dx + dy * dy);
      ctx.save();
      ctx.translate(s.x0, s.y0);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.globalAlpha = 1;
      rect(ctx, 0, -1, len, 4, COL.dim);
      rect(ctx, 0, -1, len, 1, COL.phos);
      ctx.globalAlpha = 0.6;
      for (let x = 4; x < len - 2; x += 8) rect(ctx, x, 1, 2, 2, COL.bright);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    function drawLadder(ctx, L) {
      const top = Math.min(L.yTop, L.yBottom), bot = Math.max(L.yTop, L.yBottom);
      ctx.globalAlpha = 0.9;
      rect(ctx, L.x - 4, top, 2, bot - top, COL.amber);      // rails
      rect(ctx, L.x + 2, top, 2, bot - top, COL.amber);
      ctx.globalAlpha = 0.7;
      for (let y = top + 3; y < bot - 1; y += 6) rect(ctx, L.x - 4, y, 8, 2, COL.dim);
      ctx.globalAlpha = 1;
    }
    /* Mario: 12x17 of fillRect drawn from the feet up; `pose` picks the walk /
     * climb / jump variant, and the death spin reuses the jump pose. */
    function marioBody(ctx, px, py, frame, pose) {
      rect(ctx, px - 4, py - MARIO_H, 8, 3, COL.red);        // cap
      rect(ctx, px - 6, py - MARIO_H + 2, 3, 2, COL.red);    // peak
      rect(ctx, px - 4, py - MARIO_H + 3, 8, 5, COL.amber);  // face
      rect(ctx, px + 1, py - MARIO_H + 4, 2, 2, COL.bright); // eye
      rect(ctx, px - 4, py - 9, 8, 5, COL.red);              // shirt
      rect(ctx, px - 4, py - 5, 8, 4, COL.cyan);             // overalls
      const a = frame ? 1 : -1;
      if (pose === 'climb') {                                // hands and feet swap
        rect(ctx, px - 6, py - 10 + a * 2, 2, 4, COL.amber); rect(ctx, px + 4, py - 10 - a * 2, 2, 4, COL.amber);
        rect(ctx, px - 4, py - 2 - a, 3, 2, COL.dim);        rect(ctx, px + 1, py - 2 + a, 3, 2, COL.dim);
      } else if (pose === 'jump') {                          // arms up, legs tucked
        rect(ctx, px - 6, py - 14, 2, 5, COL.amber);         rect(ctx, px + 4, py - 14, 2, 5, COL.amber);
        rect(ctx, px - 4, py - 3, 3, 2, COL.dim);            rect(ctx, px + 1, py - 3, 3, 2, COL.dim);
      } else {                                               // stride (walk) or legs together
        const w = pose === 'walk' ? 4 : 3, sw = pose === 'walk' ? (frame ? 5 : 3) : 4;
        rect(ctx, px - 5, py - 9, 2, 4, COL.amber);          rect(ctx, px + 3, py - 9, 2, 4, COL.amber);
        rect(ctx, px - sw, py - 2, w, 2, COL.dim);           rect(ctx, px + 1, py - 2, w, 2, COL.dim);
      }
    }
    function drawSwing(ctx, px, py, frame) {                  // 2 frames: raised, struck
      const hy = frame ? py - 8 : py - 24, hx = frame ? px + 5 : px + 2;
      rect(ctx, px + 4, py - 12, 2, 7, COL.amber);            // arm
      rect(ctx, px + 5, hy, 3, 9, COL.cyan);                  // handle
      rect(ctx, hx, hy - 5, 9, 5, COL.bright);                // head
    }
    function drawMario(ctx) {
      const m = mario;
      const px = Math.round(clamp(m.x, 6, W - 6)), py = Math.round(m.y);
      const frame = Math.floor(animT / ANIM) % 2;
      if (m.dead) {                                           // death spin
        ctx.save();
        ctx.translate(px, py - 8);
        ctx.rotate(deathT * 0.013);
        marioBody(ctx, 0, 8, frame, 'jump');
        ctx.restore();
        return;
      }
      const pose = m.climb ? 'climb' : m.air ? 'jump'
        : (keys.left || keys.right) ? 'walk' : 'stand';
      marioBody(ctx, px, py, frame, pose);
      if (hammer.active) drawSwing(ctx, px, py, frame);
    }
    /* ============================ barrel sprites ==========================
     * A barrel rolling across the screen has its axis pointing at the viewer,
     * so what you see is one circular head: an amber rim around the head
     * boards. The boards turn with the roll — the angle is spin/radius, i.e.
     * rolling without slipping, so it turns at the rate a real wheel would —
     * and the phase comes from distance travelled rather than a clock, so a
     * stopped world is a still barrel. A barrel on a ladder lies across it
     * instead, so there you see the side profile.
     * ==================================================================== */
    const DISC_RIM = [0, 3, 4, 5, 5, 5, 5, 5, 4, 3, 0];   // half-widths, top row first
    const DISC_HEAD = [0, 3, 3, 4, 4, 4, 3, 3, 0];        // one pixel inside the rim
    function drawBarrelEnd(ctx, b) {                        // rolling, or mid-drop
      ctx.save();
      ctx.translate(b.x, b.y);                              // b.y is the surface it sits on
      for (let i = 0; i < DISC_RIM.length; i++) {
        const hw = DISC_RIM[i];
        rect(ctx, -hw, -11 + i, hw * 2 + 1, 1, COL.amber);  // the rim
      }
      for (let i = 0; i < DISC_HEAD.length; i++) {
        const hw = DISC_HEAD[i];
        rect(ctx, -hw, -10 + i, hw * 2 + 1, 1, COL.pac);    // the head
      }
      /* the head's boards, turning with the roll. Walked out as pixel steps
         rather than rotated rects, which would blur to a smudge at this size. */
      const a = (b.dir > 0 ? 1 : -1) * b.spin / 5;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let k = -1; k <= 1; k++) {                       // three boards
        const ox = k * 3 * -sa, oy = k * 3 * ca;            // spaced across the head
        for (let t = -4; t <= 4; t++) {
          const px = Math.round(ox + t * ca), py = Math.round(oy + t * sa);
          if (px * px + py * py > 16) continue;             // stay on the head
          rect(ctx, px, -6 + py, 1, 1, COL.dim);
        }
      }
      ctx.restore();
    }
    /* Side profile: half-width of each row, top row first. The corners are cut
     * so it reads as a cylinder rather than a box. */
    const BARREL_ROWS = [4, 6, 7, 7, 7, 7, 7, 7, 6, 4];
    function drawBarrelSide(ctx, b) {                       // lying across a ladder
      ctx.save();
      ctx.translate(b.x, b.y);
      for (let i = 0; i < BARREL_ROWS.length; i++) {
        const hw = BARREL_ROWS[i], r = -10 + i;
        rect(ctx, -hw, r, hw * 2 + 1, 1, COL.pac);          // staves
        rect(ctx, -hw, r, 2, 1, COL.amber);                 // both heads, a shade darker
        rect(ctx, hw - 1, r, 2, 1, COL.amber);
      }
      rect(ctx, -5, -8, 1, 6, COL.dim);                     // an iron hoop at each rim
      rect(ctx, 5, -8, 1, 6, COL.dim);
      const t = (b.spin / 26) % 1;                          // one turn per 26px travelled
      const row = -8 + Math.round((b.dir > 0 ? t : 1 - t) * 5);
      ctx.globalAlpha = 0.5;
      rect(ctx, -4, row, 9, 1, COL.bright);                 // stave glint, sweeping
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    function drawBarrel(ctx, b) {
      if (b.mode === 'dive') drawBarrelSide(ctx, b);
      else drawBarrelEnd(ctx, b);
    }
    function drawFire(ctx, f) {
      const x = clamp(f.x, 7, W - 7), y = Math.round(f.y);
      const frame = Math.floor(animT / ANIM) % 2;
      rect(ctx, x - 5, y - 12, 10, 10, COL.red);
      rect(ctx, x - 3, y - 14, 6, 3, COL.amber);              // flame tip
      if (frame) { rect(ctx, x - 7, y - 10, 2, 5, COL.amber); rect(ctx, x + 5, y - 9, 2, 5, COL.amber); }
      else { rect(ctx, x - 6, y - 13, 2, 4, COL.amber);       rect(ctx, x + 4, y - 13, 2, 4, COL.amber); }
      rect(ctx, x - 2, y - 9, 2, 2, COL.bright);  rect(ctx, x + 1, y - 9, 2, 2, COL.bright);
    }
    function drawHammerItem(ctx, h) {                         // resting on its girder
      rect(ctx, h.x - 1, h.y - 12, 3, 12, COL.cyan);
      rect(ctx, h.x - 5, h.y - 19, 11, 6, COL.bright);  rect(ctx, h.x - 5, h.y - 19, 11, 1, COL.phos);
    }
    /* DK, two frames: arms up, then the throw with a barrel in his hands. */
    function drawDK(ctx) {
      const x = DK_X, y = DK_Y, f = throwT > 0 ? 1 : 0;
      rect(ctx, x - 30, y - 1, 60, 4, COL.dim);              // his platform
      rect(ctx, x - 30, y - 1, 60, 1, COL.phos);             // lit top edge
      rect(ctx, x - 12, y - 10, 8, 10, COL.brown);           // legs
      rect(ctx, x + 4, y - 10, 8, 10, COL.brown);
      rect(ctx, x - 16, y - 28, 32, 20, COL.brown);          // chest
      rect(ctx, x - 10, y - 24, 20, 11, COL.tan);            // belly
      rect(ctx, x - 12, y - 44, 24, 16, COL.brown);          // head
      rect(ctx, x - 1, y - 38, 11, 8, COL.tan);              // muzzle
      rect(ctx, x - 8, y - 42, 3, 3, COL.red);  rect(ctx, x + 4, y - 42, 3, 3, COL.red);
      if (f) {                                               // the throw
        rect(ctx, x + 14, y - 30, 12, 8, COL.brown);  rect(ctx, x - 26, y - 34, 12, 8, COL.brown);
        rect(ctx, x + 22, y - 36, 10, 10, COL.pac);          // the barrel he lets go
      } else {                                               // arms raised
        rect(ctx, x + 14, y - 44, 8, 15, COL.brown);  rect(ctx, x - 22, y - 44, 8, 15, COL.brown);
      }
    }
    function drawPauline(ctx) {
      const x = PAULINE_X, y = PAULINE_Y;
      rect(ctx, x - 16, y - 1, 32, 4, COL.dim);              // her platform
      rect(ctx, x - 16, y - 1, 32, 1, COL.phos);             // lit top edge
      rect(ctx, x - 3, y - 20, 6, 5, COL.pac);               // hair
      rect(ctx, x - 4, y - 16, 8, 5, COL.amber);             // face
      rect(ctx, x - 5, y - 11, 10, 9, COL.red);              // dress
      rect(ctx, x - 4, y - 2, 3, 2, COL.amber);  rect(ctx, x + 2, y - 2, 3, 2, COL.amber);
      const bx = x - 17, by = y - 39;                        // in-world HELP! bubble
      ctx.globalAlpha = 0.3; rect(ctx, bx, by, 34, 12, COL.cyan); ctx.globalAlpha = 1;
      ctx.strokeStyle = COL.cyan; ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, 33, 11);
      rect(ctx, bx + 9, by + 12, 3, 4, COL.cyan);            // tail
      ctx.fillStyle = COL.bright; ctx.font = '9px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('HELP!', x, by + 2);
    }

    /* ============================ public object =========================== */
    const g = {
      w: W, h: H,
      state: 'ready',          // the shell sets 'playing' / 'paused'; we set 'over'
      score: 0, lives: 3, level: 1, message: '',
      /* Fresh board. The shell calls this to start or restart; state is its job. */
      reset: function () { resetGame(); },
      /* dt in ms. The shell only calls this while state === 'playing'. */
      update: function (dt) {
        if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) return;
        if (g.state === 'over') return;
        let left = dt > MAX_DT ? MAX_DT : dt;
        while (left > 0) {                     // fixed slices: frame-rate independent
          const s = left > STEP ? STEP : left;
          step(s);
          left -= s;
        }
      },
      /* Renders every state, including 'ready'; the shell owns all banners. */
      draw: function (ctx) {
        ctx.save();
        ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        rect(ctx, 0, 0, W, H, COL.bg);
        for (let i = 0; i < SEGS.length; i++) drawGirder(ctx, SEGS[i]);
        for (let i = 0; i < LADDERS.length; i++) drawLadder(ctx, LADDERS[i]);
        for (let i = 0; i < hammers.length; i++) drawHammerItem(ctx, hammers[i]);
        drawDK(ctx);
        drawPauline(ctx);
        for (let i = 0; i < barrels.length; i++) drawBarrel(ctx, barrels[i]);
        if (fireball) drawFire(ctx, fireball);
        if (mario) drawMario(ctx);
        label(ctx, 'BONUS ' + (bonus < 0 ? 0 : bonus), 6, 8, COL.amber, '11px monospace');
        ctx.restore();
      },
      /* name: 'left' | 'right' | 'up' | 'down' | 'action'; down is boolean. */
      key: function (name, down) {
        if (name === 'left' || name === 'right' || name === 'up' ||
            name === 'down' || name === 'action') keys[name] = !!down;
      },
      /* Snapshot for the test harness: positions, hazards and timers. */
      debug: function () {
        const pos = function (o) { return { x: o.x, y: o.y }; };
        return {
          mario: pos(mario),
          /* spin is the distance rolled: the rolling sprite's stave sweep is
             driven by it, so a barrel that has not moved has not turned */
          barrels: barrels.map(function (b) {
            return { x: b.x, y: b.y, mode: b.mode, spin: b.spin };
          }),
          fireballs: fireball ? [pos(fireball)] : [],
          ladders: LADDERS.map(function (L) { return { x: L.x, yTop: L.yTop, yBottom: L.yBottom }; }),
          hammers: hammers.map(pos),
          hammer: !!hammer.active, bonus: bonus, frozen: frozen > 0
        };
      }
    };
    resetGame();               // a populated board is what 'ready' draws
    return g;
  };
})();
