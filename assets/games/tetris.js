/* Tetris — plain-browser arcade cartridge for the CRT terminal shell.
 * window.__trGames.tetris(api) -> { w, h, state, score, lives, level, message,
 * reset(), update(dt), draw(ctx), key(name, down) }. The shell owns the frame
 * loop, the pause/restart keys and all overlay banners, so this file has no DOM,
 * timers or frames of its own: pure game state plus a draw pass that is safe in
 * any state. Colours come from api.C and beeps from api.blip. */

(function () {
  'use strict';
  window.__trGames = window.__trGames || {};
  window.__trGames.tetris = function createGame(api) {
    var W = 340, H = 480;                    // fixed logical canvas (shell scales it)
    /* ---- palette from the shell, with CRT-green fallbacks ---- */
    var C = api && api.C ? api.C : {};
    var COL = { bg: C.bg || '#040704', phos: C.phos || '#45ff6b', dim: C.dim || '#2f9a4d',
      bright: C.bright || '#c8ffdb', amber: C.amber || '#ffb84d', cyan: C.cyan || '#5ad7ff',
      red: C.red || '#ff5f5f', pac: C.pac || '#ffd94a' };
    /* api.blip takes SECONDS (the shell's own blip defaults to 0.07s), so keep
     * every duration short and fire it only on discrete events, never per frame. */
    function blip(f, d) { if (api && api.blip) api.blip(f, d); }
    /* ---- the seven tetrominoes, each with four rotation states as cell lists in
     * a 4x4 box. State n+1 is state n turned once counter-clockwise by the rule
     * (x,y) -> (3-y,x) that rotate() applies, so four turns restore the spawn
     * shape and the wall kicks below always see a matching matrix. O never
     * changes when turned, so all four of its states are the same. ---- */
    var SHAPES = {
      I: { c: [[[0,1],[1,1],[2,1],[3,1]], [[2,0],[2,1],[2,2],[2,3]],
               [[0,2],[1,2],[2,2],[3,2]], [[1,0],[1,1],[1,2],[1,3]]], col: COL.cyan },
      J: { c: [[[0,0],[0,1],[1,1],[2,1]], [[2,0],[3,0],[2,1],[2,2]],
               [[1,2],[2,2],[3,2],[3,3]], [[1,1],[1,2],[0,3],[1,3]]], col: COL.phos },
      L: { c: [[[2,0],[0,1],[1,1],[2,1]], [[2,0],[2,1],[2,2],[3,2]],
               [[1,2],[2,2],[3,2],[1,3]], [[0,1],[1,1],[1,2],[1,3]]], col: COL.amber },
      O: { c: [[[1,0],[2,0],[1,1],[2,1]], [[1,0],[2,0],[1,1],[2,1]],
               [[1,0],[2,0],[1,1],[2,1]], [[1,0],[2,0],[1,1],[2,1]]], col: COL.pac },
      S: { c: [[[1,0],[2,0],[0,1],[1,1]], [[2,0],[2,1],[3,1],[3,2]],
               [[2,2],[3,2],[1,3],[2,3]], [[0,1],[0,2],[1,2],[1,3]]], col: COL.bright },
      T: { c: [[[1,0],[0,1],[1,1],[2,1]], [[2,0],[2,1],[3,1],[2,2]],
               [[1,2],[2,2],[3,2],[2,3]], [[1,1],[0,2],[1,2],[1,3]]], col: COL.red },
      Z: { c: [[[0,0],[1,0],[1,1],[2,1]], [[3,0],[2,1],[3,1],[2,2]],
               [[1,2],[2,2],[2,3],[3,3]], [[1,1],[0,2],[1,2],[0,3]]], col: COL.pac }
    };
    var TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
    /* Per-type bounding box of the spawn state, used to centre the NEXT preview. */
    var BOX = {};
    (function () {
      for (var t = 0; t < TYPES.length; t++) {
        var cs = SHAPES[TYPES[t]].c[0], x0 = 9, x1 = -1, y0 = 9, y1 = -1, i;
        for (i = 0; i < cs.length; i++) {
          x0 = Math.min(x0, cs[i][0]); x1 = Math.max(x1, cs[i][0]);
          y0 = Math.min(y0, cs[i][1]); y1 = Math.max(y1, cs[i][1]);
        }
        BOX[TYPES[t]] = { x0: x0, y0: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      }
    })();
    /* ---- geometry: 10x20 well left, ~100px side panel right ---- */
    var COLS = 10, ROWS = 20, CELL = 22, PAD = 10, I8 = 12;   // I8 = highlight inset
    var WELL_X = 10, WELL_Y = 20, WELL_W = COLS * CELL, WELL_H = ROWS * CELL;
    var PANEL_X = WELL_X + WELL_W + PAD;     // 240; 220 + 10 + 100 = 340 wide
    /* ---- timings, all in ms and all applied through dt ---- */
    var LOCK_DELAY = 450, SOFT_REPEAT = 45;  // lock grace; soft-drop step
    var MOVE_DELAY = 180, MOVE_REPEAT = 95;  // DAS / ARR for left and right
    var SCORE_LINES = [0, 100, 300, 500, 800];   // rows cleared at once -> points
    /* ---- mutable game data ---- */
    var board, piece, next, bag = [], lines = 0, dropAcc = 0, lockAcc = 0;
    var softAcc = 0, moveAcc = 0, softHeld = false, moveDir = 0, started = false;
    function makeBoard() {                     // 20 rows of 10 empty cells
      var b = [], y, x;
      for (y = 0; y < ROWS; y++) { b.push([]); for (x = 0; x < COLS; x++) b[y].push(null); }
      return b; }
    /* Next type from a shuffled 7-bag: fair, with no long droughts. */
    function nextType() {
      if (!bag.length) {
        bag = TYPES.slice();
        for (var i = bag.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1)), tmp = bag[i];
          bag[i] = bag[j]; bag[j] = tmp;
        }
      }
      return bag.pop(); }
    /* Gravity interval: 700ms at level 1, 60ms faster per level, floor 110ms. */
    function dropInterval() { var v = 700 - (g.level - 1) * 60; return v < 110 ? 110 : v; }
    function makePiece(type, px) {
      return { type: type, rot: 0, x: px, y: 0, cells: SHAPES[type].c[0], col: SHAPES[type].col };
    }
    /* Collision against the walls, the floor and settled blocks. Pieces always
     * spawn at y = 0, so negative rows cannot occur and are simply skipped. */
    function collides(cells, px, py) {
      for (var i = 0; i < cells.length; i++) {
        var x = px + cells[i][0], y = py + cells[i][1];
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y >= 0 && board[y][x]) return true;
      }
      return false;
    }
    /* Spawn the previewed piece. If it does not fit, the game is over. */
    function spawn() {
      piece = makePiece(next, 3);            // cell 0 of every spawn state is on row 0
      next = nextType(); lockAcc = 0; dropAcc = 0;
      if (collides(piece.cells, piece.x, piece.y)) {
        g.state = 'over';
        g.message = 'GAME OVER \u2014 press R or START';
        blip(110, 0.26);                     // discrete event: death
      }
    }
    function move(dx, dy) {                  // returns true when the move was legal
      if (!piece || collides(piece.cells, piece.x + dx, piece.y + dy)) return false;
      piece.x += dx; piece.y += dy;
      return true;
    }
    /* Clockwise rotation with a simple wall kick: try in place, then 1 and 2
     * cells to either side. Floor kicks are unnecessary in a 20-row well. */
    function rotate() {
      if (!piece) return false;
      var cells = SHAPES[piece.type].c[(piece.rot + 1) % 4];
      var kicks = [0, -1, 1, -2, 2];
      for (var k = 0; k < kicks.length; k++) {
        if (!collides(cells, piece.x + kicks[k], piece.y)) {
          piece.cells = cells; piece.rot = (piece.rot + 1) % 4; piece.x += kicks[k];
          return true;
        }
      }
      return false;                          // fully blocked: rotation is refused
    }
    /* Merge the active piece into the board, then score any rows it completed. */
    function lockPiece() {
      for (var i = 0; i < piece.cells.length; i++) {
        var x = piece.x + piece.cells[i][0], y = piece.y + piece.cells[i][1];
        if (y >= 0 && y < ROWS && x >= 0 && x < COLS) board[y][x] = piece.col;
      }
      blip(220, 0.055);                      // discrete event: piece locked
      clearRows();
    }
    /* Delete full rows, splice fresh empty rows on top, then score and level up.
     * Each removal is followed by an unshift, so the saved indices stay valid. */
    function clearRows() {
      var full = [], n = 0, i, j, y, x;
      for (y = 0; y < ROWS; y++) {
        for (n = 0, x = 0; x < COLS; x++) if (board[y][x]) n++;
        if (n === COLS) full.push(y);
      }
      for (i = 0; i < full.length; i++) {      // each splice is paired with an unshift
        board.splice(full[i], 1); board.unshift([]);
        for (j = 0; j < COLS; j++) board[0].push(null);
      }
      n = full.length;
      if (n > 0) {
        lines += n;
        g.score += SCORE_LINES[n] * g.level; // 100 / 300 / 500 / 800, times level
        g.level = 1 + Math.floor(lines / 10);
        blip(n === 4 ? 880 : 440, n === 4 ? 0.15 : 0.09);   // discrete event: line clear
      }
    }
    /* Gravity plus grounded lock delay, both scaled by dt. */
    function step(dt) {
      if (!piece) return;
      if (!collides(piece.cells, piece.x, piece.y + 1)) {
        dropAcc += dt; lockAcc = 0;             // falling: accumulate gravity
        var iv = dropInterval();
        while (dropAcc >= iv && !collides(piece.cells, piece.x, piece.y + 1)) { piece.y++; dropAcc -= iv; }
      } else if ((lockAcc += dt) >= LOCK_DELAY) {   // grounded: run the lock timer
        dropAcc = 0; lockPiece(); spawn();
      }
    }
    /* ---- drawing: one block, then the well, ghost, piece and HUD ---- */
    /* A block is a dim body, a translucent colour wash, a bright outline and a
     * small highlight on the top-left corner. */
    function block(ctx, px, py, s, colour) {
      ctx.globalAlpha = 1; ctx.fillStyle = COL.dim;            // dim body
      ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
      ctx.globalAlpha = 0.22; ctx.fillStyle = colour;          // colour wash
      ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
      ctx.globalAlpha = 0.9; ctx.strokeStyle = colour; ctx.lineWidth = 1;
      ctx.strokeRect(px + 1.5, py + 1.5, s - 3, s - 3);        // bright edge
      ctx.globalAlpha = 0.55;                // top-left highlight
      ctx.fillRect(px + 4, py + 4, Math.max(2, s - I8), 2);
      ctx.fillRect(px + 4, py + 4, 2, Math.max(2, s - I8));
      ctx.globalAlpha = 1; }
    /* The well renders in every state; it is the empty board plus the stack. */
    function drawWell(ctx) {
      var x, y;
      ctx.globalAlpha = 1; ctx.fillStyle = COL.bg;
      ctx.fillRect(WELL_X, WELL_Y, WELL_W, WELL_H);
      ctx.globalAlpha = 0.16; ctx.strokeStyle = COL.dim; ctx.lineWidth = 1;
      ctx.beginPath();                       // half-pixel offsets keep lines crisp
      for (x = 1; x < COLS; x++) {           // vertical grid lines
        ctx.moveTo(WELL_X + x * CELL + 0.5, WELL_Y + 0.5);
        ctx.lineTo(WELL_X + x * CELL + 0.5, WELL_Y + WELL_H - 0.5); }
      for (y = 1; y < ROWS; y++) {           // horizontal grid lines
        ctx.moveTo(WELL_X + 0.5, WELL_Y + y * CELL + 0.5);
        ctx.lineTo(WELL_X + WELL_W - 0.5, WELL_Y + y * CELL + 0.5); }
      ctx.stroke();
      ctx.globalAlpha = 1; ctx.strokeStyle = COL.phos;
      ctx.strokeRect(WELL_X + 0.5, WELL_Y + 0.5, WELL_W - 1, WELL_H - 1);
      for (y = 0; y < ROWS; y++) for (x = 0; x < COLS; x++) {
        if (board[y][x]) block(ctx, WELL_X + x * CELL, WELL_Y + y * CELL, CELL, board[y][x]);
      }
    }
    /* Faint marker showing where the active piece would land. */
    function drawGhost(ctx) {
      if (!piece) return;
      var gy = piece.y, i, x, y;
      while (!collides(piece.cells, piece.x, gy + 1)) gy++;
      if (gy === piece.y) return;            // already grounded: marker adds nothing
      ctx.globalAlpha = 0.18; ctx.fillStyle = piece.col;
      for (i = 0; i < 4; i++) {
        x = WELL_X + (piece.x + piece.cells[i][0]) * CELL;
        y = WELL_Y + (gy + piece.cells[i][1]) * CELL;
        ctx.fillRect(x + 3, y + 3, CELL - 6, CELL - 6); }

      ctx.globalAlpha = 1; }
    /* Active piece, the NEXT preview inside the panel, and LINES / LEVEL text.
     * Draws with no piece at all too, which is what the 'ready' state shows. */
    function drawHud(ctx) {
      var i, c, box, x, y, s, ox, oy, v, pd;
      if (piece) for (i = 0; i < 4; i++) {
        x = WELL_X + (piece.x + piece.cells[i][0]) * CELL;
        y = WELL_Y + (piece.y + piece.cells[i][1]) * CELL;
        block(ctx, x, y, CELL, piece.col); }
      ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      var PANEL = [['LINES', lines, 28], ['LEVEL', g.level, 88]];
      for (i = 0; i < PANEL.length; i++) {   // quiet label above a phosphor value
        pd = PANEL[i]; v = String(pd[1]);
        ctx.fillStyle = COL.dim; ctx.font = '13px "Share Tech Mono", monospace';
        ctx.fillText(pd[0], PANEL_X, pd[2]);
        ctx.fillStyle = COL.phos; ctx.font = '20px VT323, "Share Tech Mono", monospace';
        ctx.fillText(v, PANEL_X, pd[2] + 18);
      }
      ctx.fillStyle = COL.bright; ctx.font = '13px "Share Tech Mono", monospace';
      ctx.fillText('NEXT', PANEL_X + 26, 160);
      ctx.globalAlpha = 0.6; ctx.strokeStyle = COL.dim; ctx.lineWidth = 1;
      ctx.strokeRect(PANEL_X + 4.5, 180.5, 74, 74);      // preview frame, drawn always
      ctx.globalAlpha = 1;
      if (!next) return;
      s = 14; box = BOX[next];               // 4 cells * 14 = 56, inside the 74px frame
      ox = PANEL_X + 5 + ((4 - box.w) * s) / 2 - box.x0 * s;
      oy = 186 + ((4 - box.h) * s) / 2 - box.y0 * s;
      for (i = 0; i < 4; i++) {
        c = SHAPES[next].c[0][i];
        block(ctx, ox + c[0] * s, oy + c[1] * s, s, SHAPES[next].col); }
    }
    /* ---- the public game object ---- */
    var g = {
      w: W, h: H,
      state: 'ready',        // the shell sets 'playing' / 'paused'; we set 'over'
      score: 0,
      lives: 0,              // Tetris has no lives, so the shell hides that stat
      level: 1,
      message: '',
      reset: function () {                     // fresh game; shell calls on start/restart
        board = makeBoard(); piece = null; bag = []; started = false;
        lines = dropAcc = lockAcc = softAcc = moveAcc = 0;
        softHeld = false; moveDir = 0;
        next = nextType();                     // preview is filled before play begins
        g.score = 0; g.level = 1; g.message = '';
      },
      /* dt in ms. The shell only calls this while state === 'playing'. */
      update: function (dt) {
        if (typeof dt !== 'number' || dt <= 0) return;
        if (dt > 100) dt = 100;                // clamp stalls; the shell pauses us anyway
        if (!started) { started = true; spawn(); return; }   // first tick of a new game
        if (g.state !== 'playing' || !piece) return;
        if (softHeld) {                        // soft drop: +1 point per cell, dt-timed
          softAcc += dt;
          var guard = 0;
          while (softAcc >= SOFT_REPEAT && guard++ < ROWS) {
            softAcc -= SOFT_REPEAT;
            if (move(0, 1)) { g.score += 1; lockAcc = 0; }
            else { lockAcc = LOCK_DELAY; break; }    // grounded early: settle now
          }
        }
        if (moveDir !== 0) {                   // left/right auto-repeat, dt-timed
          moveAcc += dt;                       // DAS for the first step, then ARR
          if (moveAcc >= MOVE_DELAY) {
            moveAcc = MOVE_DELAY + (moveAcc - MOVE_DELAY) % MOVE_REPEAT;
            if (!move(moveDir, 0)) moveAcc = MOVE_DELAY;   // blocked: wait a full ARR
          }
        }
        step(dt);
      },
      /* Renders every state; overlay banners are the shell's job. */
      draw: function (ctx) {
        ctx.save();
        ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
        drawWell(ctx);
        // on game over the shell covers the well, so the live piece is skipped
        if (g.state !== 'over') { drawGhost(ctx); drawHud(ctx); }
        ctx.restore();
      },
      /* name: 'left' | 'right' | 'up' | 'down' | 'action'; down: boolean. */
      key: function (name, down) {
        if (g.state !== 'playing' || !piece) return;    // shell owns pause/restart keys
        var dir = name === 'left' ? -1 : name === 'right' ? 1 : 0;
        if (dir) {                             // act at once, then auto-repeat via dt
          if (down) { moveDir = dir; moveAcc = 0; move(dir, 0); }
          else if (moveDir === dir) { moveDir = 0; moveAcc = 0; }
        } else if (name === 'down') {
          if (down) { softHeld = true; softAcc = SOFT_REPEAT; }     // fire on the next tick
          else { softHeld = false; softAcc = 0; }
        } else if (down && name === 'up') {
          rotate();                            // rotation is edge-triggered, never repeats
        } else if (down && name === 'action') {
          var dist = 0;                        // hard drop: +2 points per cell
          while (move(0, 1)) dist++;
          if (dist > 0) g.score += dist * 2;
          lockPiece(); spawn();                // land it now: no lock delay
        }
      }
    };
    g.reset();                                 // ready to draw the empty well at once
    return g;
  };
})();