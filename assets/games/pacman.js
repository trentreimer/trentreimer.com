/* ===========================================================================
 * pacman.js — Pac-Man for the retro CRT arcade.
 *
 * Plain browser script: no modules, no build step, no libraries, no DOM, no
 * timers.  The shell owns the frame loop and the pause / restart keys; this
 * file owns the world and never draws text — READY / PAUSED / GAME OVER
 * banners belong to the shell and are driven by `state` and `message`.
 *
 *   window.__trGames.pacman = function createGame(api) { ... return game ... }
 *     api.C                palette { bg, phos, dim, bright, amber, cyan, red, pac }
 *     api.blip(freq, dur)  short square-wave beep, only on discrete events
 *     game.state    the shell sets 'playing' / 'paused'; we set 'over' / 'win'
 *     game.message  short line set when we move to 'over' / 'win'
 *     game.reset()  fresh game — call it, then set state 'playing'
 *     game.update(dt)  dt in ms; the shell calls this only while 'playing'
 *     game.draw(ctx)   renders the world in every state, including 'ready'
 *     game.key(name, down)  'left' | 'right' | 'up' | 'down' | 'action'
 * ==========================================================================*/
(function () {
  'use strict';
  window.__trGames = window.__trGames || {};

  /* ---------------------------------------------------------------- maze --
   * 19 columns x 16 rows of 16px tiles => the fixed 304x256 logical canvas.
   * Mirrored about column 9, closed wall border, no dead ends, and every
   * walkable tile is reachable from the player start.
   *   '#' wall   '.' dot   'o' power pellet   ' ' empty walkable
   *   'P' player start      '-' ghost start (the ghost house, 2 rows x 5)
   */
  const MAZE = [
    '###################',
    '#.................#',
    '#o##.###.#.###.##o#',
    '#.................#',
    '#.##.###.#.###.##.#',
    '#....###...###....#',
    '#.##.#### ####.##.#',
    '#.##.##-- --##.##.#',
    '#.##.##     ##.##.#',
    '#.##.#########.##.#',
    '#....###...###....#',
    '#.##.###.#.###.##.#',
    '#.................#',
    '#o##.###.#.###.##o#',
    '#........P........#',
    '###################'
  ];
  const COLS = MAZE[0].length, ROWS = MAZE.length, TILE = 16;
  const W = COLS * TILE, H = ROWS * TILE;              // 304 x 256

  // Directions, in the classic up / left / down / right tie-break order.
  const UP = { x: 0, y: -1 }, DOWN = { x: 0, y: 1 };
  const LEFT = { x: -1, y: 0 }, RIGHT = { x: 1, y: 0 };
  const DIRS = [UP, LEFT, DOWN, RIGHT];
  const idx = (c, r) => r * COLS + c;
  const legend = (c, r) => MAZE[r].charAt(c);
  const isWall = (c, r) =>
    c < 0 || r < 0 || c >= COLS || r >= ROWS || MAZE[r].charAt(c) === '#';

  /* ---- static analysis of the maze, done once at load -------------------- */
  // The ghost house is the dotless '-'/' ' region: the player may never step
  // inside it, and PEN_EXIT is the corridor tile just outside its gate — where
  // a ghost that is leaving (or one that was eaten) heads for.
  const isPen = (c, r) => !isWall(c, r) && (legend(c, r) === '-' || legend(c, r) === ' ');
  const GHOST_STARTS = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++)
    if (legend(c, r) === '-') GHOST_STARTS.push({ c: c, r: r });
  const PLAYER_START = { c: 1, r: 1 };
  let PEN_EXIT = null;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (legend(c, r) === 'P') { PLAYER_START.c = c; PLAYER_START.r = r; }
    if (!isPen(c, r) || PEN_EXIT) continue;
    for (const d of DIRS) {
      const nc = c + d.x, nr = r + d.y;
      if (!isWall(nc, nr) && !isPen(nc, nr)) PEN_EXIT = { c: nc, r: nr };
    }
  }
  // Wall shapes: a corner is rounded only where both of its sides are open, so
  // a run of wall tiles merges into one solid mass with soft outside corners
  // (filled without a stroke, so the seams between tiles never show).
  const WALLS = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!isWall(c, r)) continue;
    WALLS.push({ x: c * TILE, y: r * TILE,
      tl: !isWall(c - 1, r) && !isWall(c, r - 1), tr: !isWall(c + 1, r) && !isWall(c, r - 1),
      br: !isWall(c + 1, r) && !isWall(c, r + 1), bl: !isWall(c - 1, r) && !isWall(c, r + 1) });
  }
  // BFS distance fields, cached per target tile (the layout never changes).
  // Used only where greedy steering could loop for ever: leaving the house and
  // floating home after being eaten — the only traffic in there is ghosts.
  const FIELDS = {};
  function distField(tc, tr) {
    const key = tc + ',' + tr;
    if (FIELDS[key]) return FIELDS[key];
    const dist = new Int16Array(COLS * ROWS).fill(-1), queue = [idx(tc, tr)];
    dist[idx(tc, tr)] = 0;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], c = i % COLS, r = (i - c) / COLS;
      for (const d of DIRS) {
        const nc = c + d.x, nr = r + d.y;
        if (isWall(nc, nr) || dist[idx(nc, nr)] >= 0) continue;
        dist[idx(nc, nr)] = dist[i] + 1;
        queue.push(idx(nc, nr));
      }
    }
    return (FIELDS[key] = dist);
  }

  /* ---- tuning ------------------------------------------------------------ */
  const SPEED = { player: 84, ghost: 74, fright: 46, home: 130 };   // px/s
  const FRIGHT_MS = 6000, DEATH_MS = 1400, CLEAR_MS = 1100;        // pauses
  const SCATTER_MS = 7000, CHASE_MS = 18000, RELEASE_MS = 900;     // AI timing
  const BONUS_PER_LEVEL = 4, COLLIDE = 10, MAX_LEVEL = 5, TAU = Math.PI * 2;
  const STEP = 4;                                                  // ms per tick
  const EAT_POINTS = [200, 400, 800, 1600];                        // per pellet
  const CORNERS = [{ c: COLS - 2, r: 1 }, { c: 1, r: 1 },          // scatter spots
                   { c: COLS - 2, r: ROWS - 2 }, { c: 1, r: ROWS - 2 }];

  window.__trGames.pacman = function createGame(api) {
    // Palette: whatever the shell supplies, with amber-terminal fallbacks.
    const C = Object.assign({
      bg: '#080b09', phos: '#39ff88', dim: '#1a5c33', bright: '#dcffe6',
      amber: '#ffb300', cyan: '#4fd8ff', red: '#ff4d4d', pac: '#ffd94a'
    }, api && api.C);
    const beep = (f, d) => { if (api && api.blip) api.blip(f, d); };
    const g = {
      w: W, h: H,
      state: 'ready',            // the shell drives 'playing' / 'paused'
      score: 0, lives: 3, level: 1, message: '',
      reset: reset, update: update, draw: draw, key: key
    };

    /* ---- world state ----------------------------------------------------- */
    let grid = [], dotsLeft = 0;      // mutable copy of MAZE; dots are eaten away
    let clock = 0, chomp = 0;         // ms: pellet pulse / skirt wobble / mouth
    let acc = 0;                      // unspent ms carried into the next frame
    let phase = 'play', phaseT = 0;   // 'play' | 'dying' | 'clear' | 'done'
    let frightT = 0, chain = 0;       // power-pellet time left; ghosts eaten
    let scatter = true, scatterT = SCATTER_MS, started = false;
    const tileOf = e => ({ c: Math.floor(e.px / TILE), r: Math.floor(e.py / TILE) });
    const putAt = (e, c, r) => { e.px = c * TILE + TILE / 2; e.py = r * TILE + TILE / 2; };
    const isDot = (c, r) => grid[r][c] === '.' || grid[r][c] === 'o';
    const player = { px: 0, py: 0, dir: null, want: null, face: LEFT, speed: SPEED.player };
    const ghosts = [];
    for (let i = 0; i < 4; i++) ghosts.push({
      px: 0, py: 0, dir: UP, home: GHOST_STARTS[i % GHOST_STARTS.length],
      mode: 'chase', wait: i * RELEASE_MS, speed: SPEED.ghost,
      colour: [C.red, C.amber, C.cyan, C.phos][i]
    });

    /* ---- lifecycle ------------------------------------------------------- */
    // Put every actor back on its start tile without touching the dots.  The
    // house stays shut until the player moves, so spawns are always survivable.
    function placeActors() {
      putAt(player, PLAYER_START.c, PLAYER_START.r);
      player.dir = null; player.want = null; player.face = LEFT;
      ghosts.forEach((gh, i) => {
        putAt(gh, gh.home.c, gh.home.r);
        gh.dir = UP; gh.mode = 'chase'; gh.wait = i * RELEASE_MS;
      });
      frightT = 0; chain = 0; started = false;
      scatter = true; scatterT = SCATTER_MS;
      phase = 'play'; phaseT = 0;
    }

    // Fresh dots and fresh actors: the start of a game and of every level.
    function startLevel() {
      grid = MAZE.map(row => row.split(''));
      dotsLeft = 0;
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (isDot(c, r)) dotsLeft++;
      placeActors();
    }

    function reset() { g.score = 0; g.lives = 3; g.level = 1; g.message = ''; startLevel(); }

    /* ---- movement -------------------------------------------------------- */
    // Walkability.  The house gate is ghost-only: the player may never step
    // inside, and a ghost may be in there only while leaving or homing.
    function canEnter(e, c, r) {
      if (isWall(c, r)) return false;
      if (!isPen(c, r)) return true;
      if (e === player) return false;
      if (e.mode === 'home') return true;
      const here = tileOf(e);
      return isPen(here.c, here.r);
    }

    // Centre of the next tile this entity will reach.  Entities always travel
    // along a corridor centre line, so only one axis ever changes.
    function nextCentre(e) {
      const c = Math.floor(e.px / TILE), r = Math.floor(e.py / TILE);
      const cx = c * TILE + TILE / 2, cy = r * TILE + TILE / 2;
      if (e.dir.x > 0) return { x: e.px < cx - 0.01 ? cx : cx + TILE, y: cy };
      if (e.dir.x < 0) return { x: e.px > cx + 0.01 ? cx : cx - TILE, y: cy };
      if (e.dir.y > 0) return { x: cx, y: e.py < cy - 0.01 ? cy : cy + TILE };
      return { x: cx, y: e.py > cy + 0.01 ? cy : cy - TILE };
    }

    // Grid-locked movement with smooth interpolation: travel speed*dt pixels,
    // stopping at every tile centre so `decide` can turn.  Directions only ever
    // change at a centre, and only onto a walkable tile.
    function moveEntity(e, dt, decide) {
      let budget = e.speed * dt / 1000, guard = 0;
      while (budget > 1e-6 && guard++ < 64) {
        const c = Math.floor(e.px / TILE), r = Math.floor(e.py / TILE);
        const cx = c * TILE + TILE / 2, cy = r * TILE + TILE / 2;
        if (Math.abs(e.px - cx) < 0.01 && Math.abs(e.py - cy) < 0.01) {
          e.px = cx; e.py = cy;                                  // snap: no drift
          decide(e, c, r);
          if (!e.dir || !canEnter(e, c + e.dir.x, r + e.dir.y)) return;   // idle / wall
        } else if (!e.dir) return;
        const n = nextCentre(e);
        const step = Math.abs(n.x - e.px) + Math.abs(n.y - e.py);
        if (step <= budget) { e.px = n.x; e.py = n.y; budget -= step; }
        else { e.px += e.dir.x * budget; e.py += e.dir.y * budget; budget = 0; }
      }
    }

    // The queued key is honoured only at a tile centre, and only if the tile it
    // points at is open; otherwise Pac waits where he is.
    function playerDecide(e, c, r) {
      if (e.want && canEnter(e, c + e.want.x, r + e.want.y)) { e.dir = e.want; e.face = e.want; }
    }

    /* ---- ghost brains ---------------------------------------------------- */
    // The open exits from a tile, optionally excluding a reversal.
    function openDirs(e, c, r, noReverse) {
      const out = [];
      for (const d of DIRS) {
        if (canEnter(e, c + d.x, r + d.y) &&
            !(noReverse && e.dir && d.x === -e.dir.x && d.y === -e.dir.y)) out.push(d);
      }
      return out;
    }

    // Classic rule: at a tile centre take the non-reversing exit whose tile is
    // nearest (squared Euclidean) to the target; reverse only when boxed in.
    function greedyDir(e, c, r, tc, tr) {
      let opts = openDirs(e, c, r, true);
      if (!opts.length) opts = openDirs(e, c, r, false);
      let best = null, bestD = Infinity;
      for (const d of opts) {
        const dx = c + d.x - tc, dy = r + d.y - tr, dd = dx * dx + dy * dy;
        if (dd < bestD) { bestD = dd; best = d; }
      }
      return best;
    }

    // Shortest way to a tile, via the cached BFS field: this never loops.
    function shortestDir(e, c, r, tc, tr) {
      const dist = distField(tc, tr);
      let best = null, bestD = Infinity;
      for (const d of DIRS) {
        const nc = c + d.x, nr = r + d.y, dd = dist[idx(nc, nr)];
        if (canEnter(e, nc, nr) && dd >= 0 && dd < bestD) { bestD = dd; best = d; }
      }
      return best;
    }

    // One personality each: straight at the player; four tiles ahead of him;
    // the player mirrored through the red ghost; and a shy one that backs off
    // to its corner when it gets close.  Scatter sends them all to a corner.
    function chaseTarget(gh, c, r) {
      const i = ghosts.indexOf(gh), p = tileOf(player), pd = player.dir || player.face;
      if (scatter) return CORNERS[i];
      if (i === 0) return p;
      if (i === 1) return { c: p.c + pd.x * 4, r: p.r + pd.y * 4 };
      const red = tileOf(ghosts[0]);
      if (i === 2) return { c: 2 * red.c - p.c, r: 2 * red.r - p.r };
      return Math.abs(p.c - c) + Math.abs(p.r - r) > 8 ? p : CORNERS[i];
    }

    function ghostDecide(gh, c, r) {
      const home = gh.mode === 'home';
      let t;                                       // where this ghost is heading
      if (isPen(c, r) && PEN_EXIT) t = PEN_EXIT;   // still in the house: out
      else if (home) {
        if (c === gh.home.c && r === gh.home.r) { gh.mode = 'chase'; gh.wait = 0; return; }
        t = gh.home;                               // eaten: the eyes float home
      } else if (frightT > 0) {                    // frightened: wander at random
        const opts = openDirs(gh, c, r, true);
        if (opts.length) gh.dir = opts[Math.floor(Math.random() * opts.length)];
        return;
      } else t = chaseTarget(gh, c, r);            // chase or scatter
      const path = home || isPen(c, r);            // eyes and house exits path-find
      gh.dir = (path ? shortestDir(gh, c, r, t.c, t.r) : greedyDir(gh, c, r, t.c, t.r)) || gh.dir;
    }

    function ghostSpeed(gh) {
      if (gh.mode === 'home') return SPEED.home;
      if (frightT > 0) return SPEED.fright;
      return SPEED.ghost + Math.min(20, (g.level - 1) * BONUS_PER_LEVEL);
    }

    /* ---- rules ----------------------------------------------------------- */
    function eatDots() {
      const t = tileOf(player);
      if (!isDot(t.c, t.r)) return;
      const pellet = grid[t.r][t.c] === 'o';
      grid[t.r][t.c] = ' ';
      dotsLeft--;
      if (pellet) { g.score += 50; frightT = FRIGHT_MS; chain = 0; beep(220, 0.14); }
      else { g.score += 10; beep(660, 0.035); }
      if (dotsLeft <= 0) { phase = 'clear'; phaseT = CLEAR_MS; }
    }

    function caught() {
      for (const gh of ghosts) {
        if (gh.mode === 'home') continue;                     // just floating eyes
        const dx = gh.px - player.px, dy = gh.py - player.py;
        if (dx * dx + dy * dy > COLLIDE * COLLIDE) continue;
        if (frightT > 0) {                                    // edible: 200/400/…
          g.score += EAT_POINTS[Math.min(chain, 3)];
          chain++;
          gh.mode = 'home';
          beep(1200, 0.12);
        } else {                                              // caught: lose a life
          g.lives--; frightT = 0;
          phase = 'dying'; phaseT = DEATH_MS;
          beep(120, 0.5);
          return;
        }
      }
    }

    /* ---- frame ----------------------------------------------------------- */
    // The world advances in fixed 4ms steps no matter what dt the shell passes,
    // so a 60Hz, 120Hz or stuttering display all produce exactly the same game.
    function update(dt) {
      if (!(dt > 0)) return;
      if (dt > 100) dt = 100;                      // clamp stalls: no tunnelling
      acc += dt;
      while (acc >= STEP) { acc -= STEP; step(STEP); }
    }

    function step(dt) {
      if (phase === 'done') return;                // over or won: the world freezes
      clock += dt;

      if (phase === 'dying') {
        phaseT -= dt;
        if (phaseT > 0) return;
        if (g.lives <= 0) {
          g.state = 'over';
          g.message = 'Level ' + g.level + ' — ' + g.score + ' pts';
          phase = 'done';
        } else placeActors();                      // dots stay eaten
        return;
      }
      if (phase === 'clear') {
        phaseT -= dt;
        if (phaseT > 0) return;
        g.level++;
        if (g.level > MAX_LEVEL) {
          g.state = 'win';
          g.message = 'All ' + MAX_LEVEL + ' mazes cleared — ' + g.score + ' pts';
          phase = 'done';
        } else startLevel();                       // keep the score, reset dots
        return;
      }

      // Power-pellet clock, and the scatter / chase alternation.
      if (frightT > 0) frightT = Math.max(0, frightT - dt);
      if ((scatterT -= dt) <= 0) { scatter = !scatter; scatterT = scatter ? SCATTER_MS : CHASE_MS; }

      // Ghosts queue in the house until the player gets going (shell READY).
      if (!started && player.dir) started = true;
      if (started) for (const gh of ghosts) if (gh.wait > 0) gh.wait -= dt;

      const wasX = player.px, wasY = player.py;
      moveEntity(player, dt, playerDecide);
      if (player.px !== wasX || player.py !== wasY) chomp += dt;
      eatDots();
      if (phase !== 'play') return;                // that was the last dot

      for (const gh of ghosts) {
        if (!started || gh.wait > 0) continue;     // the house holds them back
        gh.speed = ghostSpeed(gh);
        moveEntity(gh, dt, ghostDecide);
      }
      caught();
    }

    /* ---- drawing --------------------------------------------------------- */
    // Walls: rounded blocks (see WALLS).  They blink bright on a level clear.
    function drawWalls(ctx) {
      const R = 6, e = TILE;
      ctx.fillStyle = (phase === 'clear' && Math.floor(clock / 140) % 2) ? C.bright : C.dim;
      for (const s of WALLS) {
        const x = s.x, y = s.y;
        ctx.beginPath();
        ctx.moveTo(x + (s.tl ? R : 0), y);
        ctx.lineTo(x + e - (s.tr ? R : 0), y);
        if (s.tr) ctx.quadraticCurveTo(x + e, y, x + e, y + R);
        ctx.lineTo(x + e, y + e - (s.br ? R : 0));
        if (s.br) ctx.quadraticCurveTo(x + e, y + e, x + e - R, y + e);
        ctx.lineTo(x + (s.bl ? R : 0), y + e);
        if (s.bl) ctx.quadraticCurveTo(x, y + e, x, y + e - R);
        ctx.lineTo(x, y + (s.tl ? R : 0));
        if (s.tl) ctx.quadraticCurveTo(x, y, x + R, y);
        ctx.closePath();
        ctx.fill();
      }
    }

    function drawDots(ctx) {
      const pulse = 1 + Math.sin(clock / 180) * 0.25;        // pellets breathe
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const ch = grid[r][c];
        if (ch !== '.' && ch !== 'o') continue;
        const s = ch === 'o' ? 6 * pulse : 3;                // pellet vs dot
        ctx.fillStyle = ch === 'o' ? C.bright : C.phos;
        ctx.fillRect(c * TILE + 8 - s / 2, r * TILE + 8 - s / 2, s, s);
      }
    }

    function drawPac(ctx) {
      // The wedge follows the distance actually travelled, so the mouth stops
      // with Pac; on a death it opens all the way until he vanishes for good.
      const dead = phase === 'dying' || (phase === 'done' && g.state === 'over');
      const m = dead
        ? Math.min(1, 1 - phaseT / DEATH_MS) * Math.PI
        : 0.06 * Math.PI + (Math.sin(chomp / 55) * 0.5 + 0.5) * 0.30 * Math.PI;
      const a = Math.atan2(player.face.y, player.face.x), r = TILE * 0.46;
      ctx.beginPath();
      ctx.moveTo(player.px, player.py);
      ctx.arc(player.px, player.py, r, a + m, a - m + TAU);
      ctx.closePath();
      ctx.fillStyle = C.pac;
      ctx.fill();
    }

    function drawGhosts(ctx) {
      const wobble = Math.floor(clock / 150) % 2;            // two-frame skirt
      for (const gh of ghosts) {
        const eaten = gh.mode === 'home', scared = !eaten && frightT > 0;
        const x = gh.px, y = gh.py, r = TILE * 0.42;
        if (!eaten) {                                        // dome + skirt
          ctx.fillStyle = scared
            ? ((frightT < 1500 && Math.floor(frightT / 150) % 2) ? C.dim : C.bright)
            : gh.colour;
          ctx.beginPath();
          ctx.arc(x, y - 1, r, Math.PI, 0);
          ctx.lineTo(x + r, y + 6);
          const step = (r * 2) / 3, notch = y + 6 - (wobble ? 4.5 : 2);
          for (let i = 0; i < 3; i++) {
            const x0 = x + r - i * step;
            ctx.lineTo(x0 - step / 2, notch);
            ctx.lineTo(x0 - step, y + 6);
          }
          ctx.closePath();
          ctx.fill();
        }
        if (scared) {                                        // blank scared eyes
          ctx.fillStyle = C.bg;
          ctx.fillRect(x - 3.5, y - 3.5, 2.4, 2.4);
          ctx.fillRect(x + 1.1, y - 3.5, 2.4, 2.4);
        } else {                                             // eyes look ahead
          const dx = gh.dir.x * 0.9, dy = gh.dir.y * 0.9;
          ctx.fillStyle = C.bright;
          ctx.beginPath();
          ctx.arc(x - 2.4, y - 2, 2.1, 0, TAU);
          ctx.arc(x + 2.4, y - 2, 2.1, 0, TAU);
          ctx.fill();
          ctx.fillStyle = C.bg;
          ctx.beginPath();
          ctx.arc(x - 2.4 + dx, y - 2 + dy, 1, 0, TAU);
          ctx.arc(x + 2.4 + dx, y - 2 + dy, 1, 0, TAU);
          ctx.fill();
        }
      }
    }

    // The whole world, in every state: the shell paints its banners over this.
    function draw(ctx) {
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, W, H);
      drawWalls(ctx);
      drawDots(ctx);
      // Ghosts vanish while Pac is dying, then return for the shell's banner.
      if (phase !== 'dying' || phaseT <= 0) drawGhosts(ctx);
      drawPac(ctx);
    }

    /* ---- input ----------------------------------------------------------- */
    function key(name, down) {
      if (!down) return;                      // presses only; 'action' is unused
      if (name === 'left') player.want = LEFT;
      else if (name === 'right') player.want = RIGHT;
      else if (name === 'up') player.want = UP;
      else if (name === 'down') player.want = DOWN;
    }

    startLevel();                             // a sensible 'ready' world to draw
    return g;
  };
})();
