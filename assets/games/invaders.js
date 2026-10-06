/* ============================================================================
   invaders.js — Space Invaders for the CRT-terminal arcade.

   Plain browser script: no modules, no build step, no DOM access, no timers,
   no requestAnimationFrame. The shell owns the canvas, the clock and every
   overlay (READY / PAUSED / GAME OVER); this file advances and paints the world
   and reports state through the object it returns.
   ========================================================================== */
(function () {
  'use strict';
  window.__trGames = window.__trGames || {};

  window.__trGames.invaders = function createGame(api) {
    /* Shell palette + sound. The fallback palette only keeps this file drawable
       standalone; blip() fires on discrete events only — shot fired, invader
       hit, player hit, wave clear — never once per frame. */
    const C = Object.assign({ bg: '#04140c', phos: '#3ddc84', dim: '#1c6b46',
      bright: '#c8ffdb', amber: '#ffc857', cyan: '#5ce1e6', red: '#ff5d5d',
      pac: '#ffd23f' }, api.C || {});
    const blip = typeof api.blip === 'function' ? api.blip : function () {};

    /* Geometry: a fixed 480x360 logical canvas (the shell scales it with CSS).
       Every speed is per millisecond, so dt drives all motion. */
    const W = 480, H = 360, GROUND_Y = H - 14;    // classic ground line
    const ROWS = 4, COLS = 9;                     // 36 invaders per wave
    const INV_W = 22, INV_H = 16;                 // 11x8 art at 2px per dot
    const PITCH_X = 36, PITCH_Y = 28;             // formation spacing
    const EDGE = 10, STEP_PX = 8, DROP = 14;      // wall inset / step / down-step
    const SHIP_W = 26, SHIP_H = 12, SHIP_Y = GROUND_Y - 16, SHIP_SPEED = 0.17;
    const SHOT_VY = -0.34, MAX_SHOTS = 2, MAX_BOMBS = 4;  // two shots; cap on fire
    const DEATH_MS = 900, WAVE_MS = 900;          // dt-based pauses
    const CELL = 3, BC = 8, BR = 6;               // bunker cells: 8x6 of 3px
    const BUNKER_Y = GROUND_Y - 78, BUNKER_X = [68, 228, 388];
    const POINTS = [30, 20, 20, 10];              // points by formation row
    const TYPES = ['squid', 'crab', 'octopus'];

    /* Pixel art: two animation frames per invader type. The fleet toggles
       frames on every step, so the formation shimmers as it marches. */
    const ART = {
      squid: [['...#####...', '..#######..', '.##.###.##.', '###.###.###', '###########', '..#.....#..', '.#.#...#.#.', '#...#.#...#'],
              ['...#####...', '..#######..', '.##.###.##.', '###.###.###', '###########', '.#.......#.', '#..#...#..#', '.#.#...#.#.']],
      crab: [['..#.....#..', '...#...#...', '..#######..', '.##.###.##.', '###########', '#.#######.#', '#.#.....#.#', '...#...#...'],
             ['..#.....#..', '#..#...#..#', '#.#######.#', '###.###.###', '###########', '.#########.', '..#.....#..', '.#.......#.']],
      octopus: [['...#####...', '..#######..', '.##.###.##.', '###.###.###', '###########', '...##.##...', '..##.#.##..', '.#..#.#..#.'],
                ['...#####...', '..#######..', '.##.###.##.', '###.###.###', '###########', '..#.#.#.#..', '.##.###.##.', '..#.....#..']]
    };
    const SHIP = ['......#......', '.....###.....', '.....###.....', '.###########.', '#############', '#############'];

    /* Live state. score/lives/level/state/message sit on `g` because the shell
       reads and writes exactly those properties. */
    let player = null, form = null, fireTimer = 0, waveTimer = 0;
    let invaders = [], shots = [], bombs = [], bunkers = [];
    const keys = { left: false, right: false, action: false };

    const g = {
      w: W, h: H, state: 'ready', score: 0, lives: 3, level: 1, message: '',
      /* Fresh game; the shell calls this to start and to restart. It finishes
         in 'ready' so the shell can show its own banner first. */
      reset() {
        g.score = 0; g.lives = 3; g.level = 1; g.message = ''; g.state = 'ready';
        shots = []; bombs = []; waveTimer = 0;
        keys.left = false; keys.right = false; keys.action = false;
        fireTimer = fireDelay();      // the first enemy shot is a beat away
        player = { x: (W - SHIP_W) / 2, y: SHIP_Y, w: SHIP_W, h: SHIP_H, dead: 0 };
        buildWorld();
      },
      /* dt is milliseconds. The shell calls this only while 'playing'. */
      update(dt) {
        if (!(dt > 0)) return;        // ignore nonsense frames
        if (dt > 250) dt = 250;       // clamp tab-restore spikes
        if (g.lives <= 0) { g.state = 'over'; return; }   // resumed with none left
        if (player.dead > 0) {        // brief dt-based pause after losing a life
          player.dead -= dt;
          if (player.dead <= 0 && g.lives > 0) {          // reset the ship
            player.x = (W - SHIP_W) / 2; shots = []; bombs = [];
          }
          return;                     // the world holds still
        }
        if (waveTimer > 0) { waveTimer -= dt; moveShip(dt); return; }  // breather
        moveShip(dt);
        stepFormation(dt);
        advance(shots, dt, shotHit);
        advance(bombs, dt, bombHit);
        if (player.dead > 0 || waveTimer > 0) return;     // died / cleared just now
        fireTimer -= dt;              // probabilistic, dt-based return fire
        if (fireTimer <= 0) { invaderFire(); fireTimer = fireDelay(); }
        const f = fleet();            // the fleet reaching the ship ends it
        if (f.maxR >= 0 && form.y + f.maxR * PITCH_Y + INV_H >= player.y) {
          g.lives = 0; g.state = 'over'; g.message = 'THE FLEET LANDED';
          blip(90, 0.4);              // discrete event: invasion complete
        }
      },
      /* Renders in EVERY state — including 'ready', which shows the full
         formation and the ship. No overlay text: the shell draws banners from
         state/message. */
      draw(ctx) {
        ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = C.phos;       // bunkers: solid 3px cells
        for (let i = 0; i < bunkers.length; i++) {
          const k = bunkers[i];
          for (let r = 0; r < BR; r++) for (let c = 0; c < BC; c++)
            if (k.cells[r * BC + c]) ctx.fillRect(k.x + c * CELL, k.y + r * CELL, CELL, CELL);
        }
        const colors = [C.cyan, C.phos, C.bright];   // squid / crab / octopus
        for (let i = 0; i < invaders.length; i++) {
          const v = invaders[i];
          if (!v.alive) continue;
          art(ctx, ART[TYPES[v.t]][form.frame], form.x + v.c * PITCH_X,
              form.y + v.r * PITCH_Y, 2, colors[v.t]);
        }
        ctx.fillStyle = C.bright;     // player shots
        for (let i = 0; i < shots.length; i++)
          ctx.fillRect(shots[i].x, shots[i].y, shots[i].w, shots[i].h);
        ctx.fillStyle = C.red;        // invader bombs
        for (let i = 0; i < bombs.length; i++)
          ctx.fillRect(bombs[i].x, bombs[i].y, bombs[i].w, bombs[i].h);
        if (player.dead <= 0) art(ctx, SHIP, player.x, player.y, 2, C.bright);
        ctx.fillStyle = C.phos;       // the classic ground line
        ctx.fillRect(0, GROUND_Y, W, 2);
      },
      /* The shell consumes pause/restart; this only ever sees the play keys. */
      key(name, down) {
        down = !!down;
        if (name === 'left' || name === 'right') keys[name] = down;
        else if (name === 'action') {
          if (down && !keys.action) fire();   // edge-triggered: one per press
          keys.action = down;
        }
        // 'up' / 'down' are not used by this game.
      }
    };

    /* ---- helpers ---------------------------------------------------------- */
    // Paint a sprite grid of '#'/'.' as dot-sized blocks.
    function art(ctx, sprite, x, y, dot, color) {
      ctx.fillStyle = color;
      for (let r = 0; r < sprite.length; r++) for (let c = 0; c < sprite[r].length; c++)
        if (sprite[r].charAt(c) === '#') ctx.fillRect(x + c * dot, y + r * dot, dot, dot);
    }
    // Half-open AABB test: touching edges are not a hit.
    function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
      return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    }
    /* The living fleet in one pass: how many are left, the outer columns and the
       lowest row. The fleet bounces off the edges of what is left, so wiping a
       column buys extra travel room. */
    function fleet() {
      const f = { n: 0, minC: COLS, maxC: -1, maxR: -1 };
      for (let i = 0; i < invaders.length; i++) {
        const v = invaders[i];
        if (!v.alive) continue;
        f.n++;
        f.minC = Math.min(f.minC, v.c); f.maxC = Math.max(f.maxC, v.c);
        f.maxR = Math.max(f.maxR, v.r);
      }
      return f;                       // maxC < 0 means "no invaders left"
    }

    /* ---- world ------------------------------------------------------------ */
    /* 36 invaders in a 4x9 grid (types by row: 30 / 20 / 20 / 10 points) plus
       three bunkers, 8x6 cells each with the classic arch bitten out. */
    function buildWorld() {
      const top = Math.min(62 + (g.level - 1) * 10, 170);  // each wave sits lower
      form = { x: (W - ((COLS - 1) * PITCH_X + INV_W)) / 2, y: top, dir: 1,
               timer: 0, frame: 0 };
      invaders = []; bunkers = [];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++)
        invaders.push({ c: c, r: r, t: r === 0 ? 0 : (r === ROWS - 1 ? 2 : 1), alive: true });
      for (let i = 0; i < BUNKER_X.length; i++) {
        const cells = [];
        for (let r = 0; r < BR; r++) for (let c = 0; c < BC; c++) {
          const arch = (r === BR - 2 && (c === 3 || c === 4)) ||   // the arch
                       (r === BR - 1 && c >= 2 && c <= 5);
          cells.push(arch ? 0 : 1);
        }
        bunkers.push({ x: BUNKER_X[i], y: BUNKER_Y, cells: cells });
      }
    }

    /* ---- ship ------------------------------------------------------------- */
    function moveShip(dt) {
      player.x += ((keys.left ? -1 : 0) + (keys.right ? 1 : 0)) * SHIP_SPEED * dt;
      if (player.x < 6) player.x = 6;                             // never leave
      if (player.x > W - 6 - SHIP_W) player.x = W - 6 - SHIP_W;   // the screen
    }
    function fire() {                 // at most two shots alive at once
      if (g.state !== 'playing' || g.lives <= 0 || player.dead > 0 || waveTimer > 0) return;
      if (shots.length >= MAX_SHOTS) return;
      shots.push({ x: player.x + SHIP_W / 2 - 1, y: player.y - 6, w: 2, h: 6, vy: SHOT_VY });
      blip(880, 0.05);                // discrete event: shot fired
    }

    /* ---- formation -------------------------------------------------------- */
    /* One step slides the fleet sideways, or reverses it and drops a row when
       the next step would push a living invader through a wall. The step
       interval shrinks as the fleet thins and as the level climbs. */
    function stepFormation(dt) {
      const interval = function () {
        const base = 90 + 560 * (Math.max(1, fleet().n) / (ROWS * COLS));
        return Math.max(70, base / (1 + 0.12 * (g.level - 1)));   // 650ms -> 70ms
      };
      form.timer += dt;
      let iv = interval(), guard = 0;
      while (form.timer >= iv && guard++ < 6) {
        form.timer -= iv;
        form.frame ^= 1;              // animation toggles once per step
        const f = fleet();
        if (f.maxC >= 0) {
          const dx = form.dir * STEP_PX;
          if (form.x + f.minC * PITCH_X + dx < EDGE ||
              form.x + f.maxC * PITCH_X + INV_W + dx > W - EDGE) {
            form.dir = -form.dir; form.y += DROP;     // bounce: drop a row
          } else form.x += dx;
        }
        iv = interval();              // the fleet may have just thinned
      }
      if (form.timer > iv) form.timer = iv;   // drop backlog we did not use
    }

    /* ---- bullets ----------------------------------------------------------
       Bullets advance in <=2px sub-steps, so a 3px bunker cell can never be
       tunnelled through, whatever dt arrives. hit() consumes the bullet. */
    function advance(list, dt, hit) {
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i], total = b.vy * dt;
        const steps = Math.max(1, Math.ceil(Math.abs(total) / 2));
        let dead = false;
        for (let s = 0; s < steps && !dead; s++) { b.y += total / steps; dead = hit(b); }
        if (waveTimer > 0 || player.dead > 0) return;   // a freeze just started
        if (dead || b.y + b.h < 0 || b.y > H) list.splice(i, 1);
      }
    }
    // Player shot: invader first, then bunker. Invader kill: first hit wins.
    function shotHit(b) { return hitInvader(b) || hitBunkers(b.x + b.w / 2, b.y, true); }
    function hitInvader(b) {
      for (let i = 0; i < invaders.length; i++) {
        const v = invaders[i];
        if (!v.alive) continue;
        const x = form.x + v.c * PITCH_X, y = form.y + v.r * PITCH_Y;
        if (!overlap(b.x, b.y, b.w, b.h, x, y, INV_W, INV_H)) continue;
        v.alive = false;
        g.score += POINTS[v.r];
        blip(660 - v.r * 60, 0.06);   // discrete event: invader hit
        if (fleet().n === 0) waveClear();
        return true;
      }
      return false;
    }
    // Invader bomb: bunker first, then the ship.
    function bombHit(b) {
      if (hitBunkers(b.x + b.w / 2, b.y + b.h, false)) return true;
      if (!overlap(b.x, b.y, b.w, b.h, player.x, player.y, player.w, player.h)) return false;
      bombs.length = 0;               // clear the screen of fire
      killPlayer();
      return true;
    }
    /* A bullet's tip is sampled against each bunker; the first solid cell stops
       the bullet and blows a few cells out — the impact cell, its neighbours
       across, and the cell the bullet came through (up bullets came from below). */
    function hitBunkers(x, tipY, up) {
      for (let i = 0; i < bunkers.length; i++) {
        const k = bunkers[i];
        const c = Math.floor((x - k.x) / CELL), r = Math.floor((tipY - k.y) / CELL);
        if (c < 0 || c >= BC || r < 0 || r >= BR) continue;   // outside this block
        if (!k.cells[r * BC + c]) continue;                   // already blown away
        const bite = [[c, r], [c - 1, r], [c + 1, r], [c, up ? r + 1 : r - 1]];
        for (let j = 0; j < bite.length; j++) {
          const cc = bite[j][0], rr = bite[j][1];
          if (cc >= 0 && cc < BC && rr >= 0 && rr < BR) k.cells[rr * BC + cc] = 0;
        }
        return true;                  // the bunker consumes the bullet
      }
      return false;
    }

    /* ---- invader fire ----------------------------------------------------- */
    // Longer between shots while the fleet is thick, quicker as it thins.
    function fireDelay() {
      const base = 300 + 900 * (Math.max(1, fleet().n) / (ROWS * COLS));
      return (base / (1 + 0.12 * (g.level - 1))) * (0.6 + Math.random() * 0.9);
    }
    // The lowest living invader of a random occupied column fires — classic.
    function invaderFire() {
      if (bombs.length >= MAX_BOMBS) return;
      const low = [];
      for (let i = 0; i < invaders.length; i++) {
        const v = invaders[i];
        if (v.alive && (!low[v.c] || v.r > low[v.c].r)) low[v.c] = v;
      }
      const shooters = [];
      for (let c = 0; c < COLS; c++) if (low[c]) shooters.push(low[c]);
      if (!shooters.length) return;
      const s = shooters[(Math.random() * shooters.length) | 0];
      const speed = (0.11 + 0.006 * g.level) * (1 + (ROWS * COLS - fleet().n) / 60);
      bombs.push({ x: form.x + s.c * PITCH_X + INV_W / 2 - 1,
                   y: form.y + s.r * PITCH_Y + INV_H, w: 2, h: 6, vy: speed });
      blip(200, 0.05);                // discrete event: invader shot
    }

    /* ---- outcomes --------------------------------------------------------- */
    function killPlayer() {
      g.lives -= 1;
      player.dead = DEATH_MS;         // brief dt-based pause, see update()
      blip(120, 0.35);                // discrete event: player hit
      if (g.lives <= 0) { g.state = 'over'; g.message = 'THE FLEET BROKE THROUGH'; }
    }
    /* All invaders gone: next wave, faster, starting a little lower. The game
       stays 'playing' through a short dt-based breather — the shell only calls
       update() while playing, so parking in 'win' would stall the next wave. */
    function waveClear() {
      g.level += 1;
      waveTimer = WAVE_MS;
      shots.length = 0; bombs.length = 0;
      buildWorld();
      fireTimer = fireDelay();
      blip(1000, 0.07); blip(1500, 0.12);   // discrete event: wave clear
    }

    g.reset();      // always hand the shell a fully built, ready world
    return g;
  };
})();
