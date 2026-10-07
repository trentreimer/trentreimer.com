/* Pole Position — plain-browser arcade cartridge for the CRT terminal shell.
 * window.__trGames.poleposition(api) -> { w, h, state, score, lives, level,
 * message, reset(), update(dt), draw(ctx), key(name, down), debug() }.
 * The shell owns the canvas, the clock, the DOM and every READY / PAUSED /
 * GAME OVER banner, so this file has no module, no build step, no DOM, no
 * timers and no rAF: game state plus a draw pass that is safe in any state
 * (the `ready` board is a fully populated world). api.C is the palette and
 * api.blip(freq, SECONDS) fires on discrete events only, never per frame.
 *
 * The road is drawn the way the 1982 arcade machine faked it: the track is a
 * list of segments, each carrying a curve and a height, and each frame they are
 * projected from a camera above and behind the car and painted back to front as
 * trapezoids. Everything you see is a polygon or a rect in shell colours —
 * there is no bitmap art, and no image ever loads. */

(function () {
  'use strict';
  window.__trGames = window.__trGames || {};
  window.__trGames.poleposition = function createGame(api) {
    const W = 480, H = 360;                 // fixed logical canvas (shell scales it)
    /* Palette from the shell, with CRT-green fallbacks. */
    const C = (api && api.C) || {};
    const COL = { bg: C.bg || '#040704', phos: C.phos || '#45ff6b', dim: C.dim || '#2f9a4d',
      bright: C.bright || '#c8ffdb', amber: C.amber || '#ffb84d', cyan: C.cyan || '#5ad7ff',
      red: C.red || '#ff5f5f', pac: C.pac || '#ffd94a',
      brown: C.brown || '#a9662d', tan: C.tan || '#e0b184' };
    function blip(f, s) { if (api && api.blip) api.blip(f, s); }   // seconds, not ms

    /* ============================ tuning ============================== */
    const STEP = 8;               // simulation slice: a big dt is split this fine
    const MAX_DT = 400;           // ignore stalls longer than this (shell clamps too)
    const SEG_LEN = 200;          // world units per road segment
    const RUMBLE = 3;             // segments per rumble / stripe band
    const ROAD_W = 1100;          // half-width of the road in world units
    const LANES = 3;
    const DRAW_DIST = 170;        // segments drawn ahead of the car
    const CAM_H = 1000;           // camera height above the road
    const CAM_D = 1 / Math.tan((100 / 2) * Math.PI / 180);   // 100 degree field of view
    const MAX_SPEED = SEG_LEN / 30;      // world units per ms at full throttle
    const ACCEL = MAX_SPEED / 4200;      // throttle
    const BRAKE = MAX_SPEED / 900;       // deliberate braking
    const COAST = MAX_SPEED / 14000;     // engine braking when you let go
    const OFF_DECEL = MAX_SPEED / 1800;  // dragging along the verge
    const OFF_CAP = MAX_SPEED * 0.34;    // and the speed it drags you down to
    /* Steering pulls, the corner pushes, and both scale with how fast you are
     * going — the corner with the square of it, which is what forces you to
     * slow down for a bend. Balanced so a gentle curve is flat-out, a 3 is
     * nearly flat-out, and a 6 has to be taken at about 70%. */
    const CENTRIFUGAL = 0.00068;         // road-offsets per ms, per unit of curve
    const STEER = 0.0020;                // road-offsets per ms at full speed
    const CAR_HALF_W = 0.15;             // half a car's width, in road offsets
    const CAR_HALF_L = SEG_LEN * 0.55;   // half a car's length, in world units
    /* The player's car is drawn glued to a fixed row near the bottom of the
     * frame rather than projected from its world z, so the contact test works
     * in that same screen space: these are the rows its sprite box spans. */
    const PLAYER_SCREEN_Y = H - 26;      // row the wheels sit on (drawPlayer)
    const PLAYER_SCREEN_HH = 26;         // body half-height
    const TRAFFIC = 26;                  // cars out on the track
    const CAR_MIN = MAX_SPEED * 0.34;
    const CAR_MAX = MAX_SPEED * 0.70;
    /* A clean lap is ~47s flat out and ~62s for a driver who lifts for the big
     * corners, so 75s leaves room to be quick without being perfect — and the
     * time bonus on the line rewards the difference. */
    const LAP_TIME = 75000;              // ms to get round before you lose a life
    const PTS_OVERTAKE = 200;
    const PTS_LAP = 1500;
    /* Contact comes in two kinds. A graze — you were barely faster than the car
     * you clipped — shoves it aside and scrubs a little speed off you. Anything
     * harder stops your car dead and puts it in the barrier. The closing speed
     * is what separates them, so side-swiping at speed still counts as a hit. */
    const BUMP_SLOW = 0.86;              // fraction of speed kept after a graze
    const CRASH_CLOSING = MAX_SPEED * 0.30;   // closing speed that makes it a crash
    const CRASH_STOP = 900;              // ms stopped, and the crash sprite shows
    const SHAKE = 420;                   // ms of screen shake after a knock
    const BUMP_SHAKE = 160;              // ... and the smaller one for a graze
    const START_LIVES = 3;

    /* ============================= track ============================== */
    /* Segments carry the road's shape, not its screen position: the projection
     * works that out every frame, which is what lets the hills occlude. */
    const segments = [];
    let trackLength = 0;
    function lastY() { return segments.length ? segments[segments.length - 1].p2.world.y : 0; }
    function addSegment(curve, y) {
      const n = segments.length;
      segments.push({
        index: n,
        p1: { world: { x: 0, y: lastY(), z: n * SEG_LEN }, camera: {}, screen: {} },
        p2: { world: { x: 0, y: y, z: (n + 1) * SEG_LEN }, camera: {}, screen: {} },
        curve: curve,
        sprites: [],                       // roadside poles, drawn far to near
        cars: [],
        dark: Math.floor(n / RUMBLE) % 2 === 0
      });
    }
    function easeIn(a, b, p) { return a + (b - a) * p * p; }
    function easeInOut(a, b, p) { return a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5); }
    /* Enter / hold / leave: the standard way to ease into a curve or a hill so
     * the road has no corners in it that the eye can catch. */
    function addRoad(enter, hold, leave, curve, y) {
      const startY = lastY(), endY = startY + y * SEG_LEN, total = enter + hold + leave;
      let i;
      for (i = 0; i < enter; i++) addSegment(easeIn(0, curve, i / enter), easeInOut(startY, endY, i / total));
      for (i = 0; i < hold; i++) addSegment(curve, easeInOut(startY, endY, (enter + i) / total));
      for (i = 0; i < leave; i++) addSegment(easeInOut(curve, 0, i / leave), easeInOut(startY, endY, (enter + hold + i) / total));
    }
    function straight(n, y) { addRoad(n, n, n, 0, y || 0); }
    function curve(n, c, y) { addRoad(n, n, n, c, y || 0); }
    function hillRoad(n, y) { addRoad(n, n, n, 0, y); }
    /* One lap: a fast opening straight, a long right, a hill to crest, an
     * S-bend, a drop, then a tightening left back onto the line. */
    function buildTrack() {
      segments.length = 0;
      straight(30);
      curve(40, 3, 20);
      straight(20, -10);
      curve(50, -4, -30);
      hillRoad(40, 40);
      straight(30);
      curve(50, 5, 10);
      curve(50, -5, 10);
      hillRoad(40, -50);
      straight(30);
      curve(30, 6, 30);
      straight(40, -20);
      curve(40, -3, 0);
      straight(30);
      /* a pole every few segments down both verges: the thing the game is named
       * for, and the only reliable cue for how fast you are actually going */
      for (let i = 0; i < segments.length; i += 4) {
        segments[i].sprites.push({ offset: -1.35, h: 300, colour: COL.amber });
        if (i % 8 === 0) segments[i].sprites.push({ offset: 1.35, h: 300, colour: COL.amber });
      }
      trackLength = segments.length * SEG_LEN;
    }

    /* ============================ game state =========================== */
    let position, speed, playerX, steerDir, throttle, braking;
    let cars, lap, timeLeft, crashT, shakeT, offT, bounceT, lastZ, bumps, crashes;
    let pendingOver;                           // set when the last life goes
    function segmentAt(z) {
      const i = Math.floor(z / SEG_LEN) % segments.length;
      return segments[i < 0 ? i + segments.length : i];
    }
    /* signed distance from b to a, the short way round the lap */
    function zdiff(a, b) {
      let d = a - b;
      if (d > trackLength / 2) d -= trackLength;
      if (d < -trackLength / 2) d += trackLength;
      return d;
    }
    function resetGame() {
      buildTrack();
      cars = [];
      for (let i = 0; i < TRAFFIC; i++) {
        const z = (i + 0.5) * (trackLength / TRAFFIC);
        const car = {
          z: z,
          offset: (Math.random() * 1.5) - 0.75,      // never right on the verge
          speed: CAR_MIN + Math.random() * (CAR_MAX - CAR_MIN),
          colour: [COL.amber, COL.pac, COL.phos, COL.cyan][i % 4],
          ahead: true
        };
        cars.push(car);
        segmentAt(z).cars.push(car);
      }
      position = 0; speed = 0; playerX = 0; steerDir = 0; throttle = false; braking = false;
      lap = 1; timeLeft = LAP_TIME; crashT = 0; shakeT = 0; offT = 0; bounceT = 0; lastZ = 0;
      bumps = 0; crashes = 0; pendingOver = null;
      g.score = 0; g.lives = START_LIVES; g.level = 1;
      g.message = '';
    }
    /* Losing a life is the same event whether it was traffic or the clock. The
     * caller decides what it does to the car — a hit stops it dead and raises
     * the crash sprite; the clock just resets the lap — so this only counts the
     * life down, shakes the screen and ends the run at zero. */
    function loseLife(reason) {
      g.lives -= 1;
      shakeT = SHAKE;
      blip(90, 0.3);                            // discrete event: a knock
      if (g.lives <= 0) {
        g.lives = 0;
        /* not over yet: the wreck is still playing out, and the last thing the
         * visitor should see is the crash, not a banner over the top of it */
        pendingOver = reason + ' \u2014 press R or START';
      }
    }

    /* ============================== physics ============================ */
    /* Traffic, where the draw pass will put it: the same interpolation between
     * the two projected ends of the car's segment, so the contact test and the
     * animation can never disagree about where a sprite is. `s1`/`s2` are the
     * projected segment ends, `pct` the car's place between them. */
    function carScreen(s1, s2, pct, offset) {
      const x = s1.x + (s2.x - s1.x) * pct + offset * (s1.w + (s2.w - s1.w) * pct);
      const y = s1.y + (s2.y - s1.y) * pct;
      const w = s1.w + (s2.w - s1.w) * pct;
      return { x: x, y: y, w: w, hh: CAR_HALF_W * w * 0.8 };
    }
    /* The same box for a traffic car at a signed distance ahead of us. The road
     * ends are projected from the camera the draw pass uses and carry the road's
     * real height, so a crest or a dip moves the sprite exactly as it is drawn. */
    function carSpriteBox(car, dz) {
      const base = segmentAt(position);
      const basePct = (position % SEG_LEN) / SEG_LEN;
      const camY = base.p1.world.y + (base.p2.world.y - base.p1.world.y) * basePct + CAM_H;
      const seg = segmentAt(car.z);
      const pct = (car.z % SEG_LEN) / SEG_LEN;
      const p1z = Math.max(1, dz - pct * SEG_LEN), p2z = Math.max(1, dz + (1 - pct) * SEG_LEN);
      const s1 = { x: 0, y: H / 2 - (CAM_D / p1z) * (seg.p1.world.y - camY) * H / 2,
        w: (CAM_D / p1z) * ROAD_W * W / 2 };
      const s2 = { x: 0, y: H / 2 - (CAM_D / p2z) * (seg.p2.world.y - camY) * H / 2,
        w: (CAM_D / p2z) * ROAD_W * W / 2 };
      return carScreen(s1, s2, pct, 0);
    }
    /* True when the traffic sprite box has reached ours: the moment the edges
     * meet is the moment contact is called, whatever the hill is doing. */
    function carTouchesPlayer(car, dz) {
      if (dz <= CAM_D) return false;                 // behind the camera, not drawn
      const box = carSpriteBox(car, dz);
      return box.y > PLAYER_SCREEN_Y - PLAYER_SCREEN_HH && box.y - box.hh < PLAYER_SCREEN_Y;
    }
    /* Traffic: drive it, score the passes, and watch for contact. Its own
     * function because the wreck path needs it too — a stopped player must not
     * freeze the rest of the field. */
    function stepCars(dt) {
      const speedPct = speed / MAX_SPEED;
      /* backwards, because a car that is written off is removed from the field */
      for (let i = cars.length - 1; i >= 0; i--) {
        const car = cars[i];
        const before = zdiff(car.z, position);
        const oldSeg = segmentAt(car.z);
        car.z += car.speed * dt;
        if (car.z >= trackLength) car.z -= trackLength;
        const newSeg = segmentAt(car.z);
        if (oldSeg !== newSeg) {                   // re-file it for the draw pass
          const k = oldSeg.cars.indexOf(car);
          if (k !== -1) oldSeg.cars.splice(k, 1);
          newSeg.cars.push(car);
        }
        const after = zdiff(car.z, position);
        if (before > 0 && after <= 0) {            // we just went past it
          g.score += PTS_OVERTAKE + Math.round(speedPct * PTS_OVERTAKE);
          blip(660, 0.05);                         // discrete event: overtake
        }
        /* --- contact ---------------------------------------------------- *
         * Two cars never share the same patch of screen. The player's sprite
         * is glued near the bottom of the frame rather than projected from its
         * world z, and the closer traffic gets to the camera the lower it is
         * drawn, so a world-z gap would let a car drive right through the
         * player before contact came. The test is therefore in the draw pass's
         * own screen space: when the traffic sprite reaches the player's box
         * they are pushed apart — the other car first, then us for whatever
         * the verge would not let it take, and if we are against the verge as
         * well we drop back along the road instead. The closing speed decides
         * whether it is a shove or a crash. */
        const gapX = car.offset - playerX;
        const overlapX = CAR_HALF_W * 2 - Math.abs(gapX);
        if (overlapX <= 0 || !carTouchesPlayer(car, after)) continue;
        const away = gapX >= 0 ? 1 : -1;           // which side the car is on
        if (crashT > 0) {
          /* We are stopped in the wreck and the controls are dead, but the rest
           * of the field is still racing: it goes round us rather than through
           * us. Nobody loses a life for this — it is only separation. */
          car.offset = Math.max(-0.98, Math.min(0.98, car.offset + away * (overlapX + 0.02)));
          car.speed *= 0.94;
          continue;
        }
        const hard = speed - car.speed >= CRASH_CLOSING;
        const want = overlapX + (hard ? 0.05 : 0.02);
        const wasAt = car.offset;
        car.offset = Math.max(-0.98, Math.min(0.98, car.offset + away * want));
        let rest = want - Math.abs(car.offset - wasAt);
        const weWereAt = playerX;
        playerX = Math.max(-1.6, Math.min(1.6, playerX - away * (rest + overlapX * 0.3)));
        rest = Math.max(0, rest - Math.abs(playerX - weWereAt));
        if (rest > 0.005) {                        // boxed in sideways: back off
          position -= Math.min(rest * ROAD_W, CAR_HALF_L * 2);
          if (position < 0) position += trackLength;
        }
        if (hard) {
          speed = 0;                               // stopped dead
          crashT = CRASH_STOP;
          /* the car we hit is knocked out of the race: off the field, and off
           * the segment it was filed under for the draw pass */
          const k = oldSeg.cars.indexOf(car);
          if (k !== -1) oldSeg.cars.splice(k, 1);
          newSeg.cars.splice(newSeg.cars.indexOf(car), 1);
          cars.splice(i, 1);
          crashes += 1;
          loseLife('you hit the traffic');
        } else {
          speed *= BUMP_SLOW;
          /* if we could not get out of its way sideways, match its pace rather
           * than driving through it */
          if (rest > 0.005 || after > 0) speed = Math.min(speed, car.speed * 0.98);
          shakeT = Math.max(shakeT, BUMP_SHAKE);
          bumps += 1;
          blip(200, 0.06);                         // discrete event: a shove
        }
      }
    }

    function step(dt) {
      const seg = segmentAt(position);

      /* while the crash sprite is up the car is stopped and the controls are
       * dead: the wreck has to play out before you drive on */
      if (crashT > 0) {
        /* stopped, controls dead — but the world keeps moving around the wreck,
         * which is also what lets the car we hit drive out of the way */
        speed = 0;
        crashT -= dt;
        if (shakeT > 0) shakeT -= dt;
        timeLeft -= dt;
        bounceT += dt;
        stepCars(dt);
        if (crashT <= 0 && pendingOver) {          // the explosion has finished
          g.state = 'over';
          g.message = pendingOver;
          pendingOver = null;
        }
        return;
      }

      /* throttle, brake, coast — one speed number, as the arcade did it */
      if (throttle) speed += (braking ? BRAKE : ACCEL) * dt;
      else if (braking) speed -= BRAKE * dt;
      else speed -= COAST * dt;

      /* off the road: drag, a cap, and a shake you can feel */
      const off = Math.abs(playerX) > 1;
      if (off) {
        offT += dt;
        if (speed > OFF_CAP) speed -= OFF_DECEL * dt;
        if (offT > 220) { offT = 0; blip(70, 0.025); }   // discrete: verge rumble
      } else {
        offT = 0;
      }
      if (speed > MAX_SPEED) speed = MAX_SPEED;
      if (speed < 0) speed = 0;

      /* steering: heavier when slow, twitchier near top speed */
      const speedPct = speed / MAX_SPEED;
      if (steerDir !== 0) {                          // heavy when slow, sharp when fast
        playerX += steerDir * STEER * (0.15 + 0.85 * speedPct) * dt;
      }
      /* and the corner throws you outward, harder the faster you take it */
      playerX -= CENTRIFUGAL * seg.curve * speedPct * speedPct * dt;
      if (playerX < -1.6) playerX = -1.6;
      if (playerX > 1.6) playerX = 1.6;

      /* the world moves under the car */
      lastZ = position;
      position += speed * dt;
      if (position >= trackLength) {                 // crossed the line
        position -= trackLength;
        lap += 1;
        g.level = lap;
        g.score += PTS_LAP + Math.round(timeLeft / 100);
        timeLeft = LAP_TIME;
        blip(880, 0.16);                             // discrete event: a lap done
      }

      stepCars(dt);

      /* the clock is the other way to lose one */
      if (shakeT > 0) shakeT -= dt;
      timeLeft -= dt;
      if (timeLeft <= 0 && g.state === 'playing') {
        timeLeft = LAP_TIME;
        position = 0;
        playerX = 0;
        speed = 0;
        crashT = CRASH_STOP;
        blip(120, 0.34);                             // discrete event: out of time
        loseLife('out of time');
      }

      bounceT += dt;                             // drives the off-road shake
    }

    /* ============================== drawing ============================ */
    function project(p, camX, camY, camZ) {
      p.camera.x = p.world.x - camX;
      p.camera.y = p.world.y - camY;
      p.camera.z = p.world.z - camZ;
      if (p.camera.z < 1) p.camera.z = 1;            // never divide by nothing
      p.screen.scale = CAM_D / p.camera.z;
      p.screen.x = W / 2 + p.screen.scale * p.camera.x * W / 2;
      p.screen.y = H / 2 - p.screen.scale * p.camera.y * H / 2;
      p.screen.w = p.screen.scale * ROAD_W * W / 2;
    }
    function poly(ctx, x1, y1, x2, y2, x3, y3, x4, y4) {
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
      ctx.closePath(); ctx.fill();
    }
    /* Sky above the horizon: a few flat bands rather than a gradient, to keep
     * the pixel feel. */
    /* `horizon` is where the terrain stops, not a fixed line: the projection's
     * vanishing point is the middle of the canvas, but the road can drop away
     * below it or climb above it, and sky painted past the ground showed through
     * the translucent terrain as bands. It stays fractional so the last band
     * tracks the terrain's top without stepping a whole pixel at a time; the
     * sub-pixel blend that leaves on the seam is faint enough to live with. */
    function drawSky(ctx, horizon) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, W, H);
      if (horizon <= 0) return;
      const bands = 9;
      for (let i = 0; i < bands; i++) {              // sky, darkest at the top
        const y = i * (horizon / bands);
        if (y >= horizon) break;
        ctx.globalAlpha = 0.015 + i * 0.011;
        ctx.fillStyle = COL.phos;
        ctx.fillRect(0, y, W, Math.min(horizon - y, horizon / bands + 1));
      }
      ctx.globalAlpha = 1;
    }
    /* `fillTo` is where the last drawn segment ended. A crest hides the segments
     * behind it and the loop skips them, which would leave a gap between the last
     * one drawn and the next — and the sky shows through it as green streaks
     * across the hill. Carrying the verge down to that point fills the gap with
     * ground, which is what is really there. */
    function drawSegment(ctx, seg, n, fillTo) {
      const p1 = seg.p1.screen, p2 = seg.p2.screen;
      const fog = 1 - Math.pow(n / DRAW_DIST, 1.7) * 0.92;
      const x1 = p1.x, y1 = p1.y, w1 = p1.w, x2 = p2.x, y2 = p2.y, w2 = p2.w;
      /* the verge fills the band, then the road is laid over it */
      ctx.globalAlpha = (seg.dark ? 0.09 : 0.14) * fog;
      ctx.fillStyle = COL.phos;
      ctx.fillRect(0, y2, W, Math.max(y1, fillTo) - y2 + 1);
      /* road */
      ctx.globalAlpha = (seg.dark ? 0.20 : 0.27) * fog;
      ctx.fillStyle = COL.dim;
      poly(ctx, x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2);
      /* rumble strips, alternating with the road bands */
      const r1 = w1 / 11, r2 = w2 / 11;
      ctx.globalAlpha = fog;
      ctx.fillStyle = seg.dark ? COL.phos : COL.dim;
      poly(ctx, x1 - w1 - r1, y1, x1 - w1, y1, x2 - w2, y2, x2 - w2 - r2, y2);
      poly(ctx, x1 + w1, y1, x1 + w1 + r1, y1, x2 + w2 + r2, y2, x2 + w2, y2);
      /* lane markers: dashed, because only the light bands get them */
      if (!seg.dark) {
        const l1 = w1 * 2 / LANES, l2 = w2 * 2 / LANES, m1 = w1 / 40, m2 = w2 / 40;
        ctx.globalAlpha = 0.5 * fog;
        ctx.fillStyle = COL.bright;
        for (let lane = 1; lane < LANES; lane++) {
          const lx1 = x1 - w1 + lane * l1, lx2 = x2 - w2 + lane * l2;
          poly(ctx, lx1 - m1, y1, lx1 + m1, y1, lx2 + m2, y2, lx2 - m2, y2);
        }
      }
      ctx.globalAlpha = 1;
    }
    /* A car seen from behind, sized from the projected road width so the
     * perspective takes care of itself. */
    function drawCar(ctx, x, y, roadW, colour) {
      const hw = CAR_HALF_W * roadW, hh = hw * 0.8;   // wider than it is tall
      if (hw < 1.2) return;                            // too far away to bother
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour;
      poly(ctx, x - hw * 0.72, y - hh, x + hw * 0.72, y - hh, x + hw, y, x - hw, y);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = COL.bg;                          // rear window
      ctx.fillRect(x - hw * 0.45, y - hh * 0.82, hw * 0.9, hh * 0.34);
      ctx.globalAlpha = 1;
      ctx.fillStyle = COL.bright;                      // wheels
      ctx.fillRect(x - hw - 1, y - hh * 0.42, 2, hh * 0.42);
      ctx.fillRect(x + hw - 1, y - hh * 0.42, 2, hh * 0.42);
      ctx.fillStyle = COL.red;                        // tail lights, so you can read it
      ctx.fillRect(x - hw * 0.78, y - hh * 0.32, Math.max(1, hw * 0.3), Math.max(1, hh * 0.14));
      ctx.fillRect(x + hw * 0.48, y - hh * 0.32, Math.max(1, hw * 0.3), Math.max(1, hh * 0.14));
      ctx.restore();
    }
    /* Projects the stretch of road in view and walks it near to far, calling
     * `onSegment(seg, n, fillTo)` for each segment that survives the cull, and
     * returning the highest point the terrain reaches. One walk, so the sky's
     * horizon and the road that is drawn can never disagree. */
    function eachRoadSegment(onSegment) {
      const base = segmentAt(position);
      const basePct = (position % SEG_LEN) / SEG_LEN;
      const playerY = base.p1.world.y + (base.p2.world.y - base.p1.world.y) * basePct;
      const camY = playerY + CAM_H;
      let maxy = H, top = H, x = 0, dx = -(base.curve * basePct), n;

      for (n = 0; n < DRAW_DIST; n++) {
        const seg = segments[(base.index + n) % segments.length];
        const camZ = position - (seg.index < base.index ? trackLength : 0);
        seg.clip = maxy;
        seg.fog = 1 - Math.pow(n / DRAW_DIST, 1.7) * 0.92;
        project(seg.p1, (playerX * ROAD_W) - x, camY, camZ);
        project(seg.p2, (playerX * ROAD_W) - x - dx, camY, camZ);
        x += dx;
        dx += seg.curve;
        /* behind the camera, back-facing, or hidden by a hill in front of it */
        if (seg.p1.camera.z <= CAM_D || seg.p2.screen.y >= seg.p1.screen.y ||
            seg.p2.screen.y >= maxy) continue;
        if (onSegment) onSegment(seg, n, maxy);
        if (seg.p2.screen.y < top) top = seg.p2.screen.y;
        maxy = seg.p2.screen.y;
      }
      return top;
    }
    function drawRoad(ctx) {
      const base = segmentAt(position);
      let n;
      eachRoadSegment(function (seg, idx, fillTo) { drawSegment(ctx, seg, idx, fillTo); });
      /* everything standing on the road, far to near, clipped by the hill */
      for (n = DRAW_DIST - 1; n >= 0; n--) {
        const seg = segments[(base.index + n) % segments.length];
        if (seg.clip === undefined || seg.p1.camera.z <= CAM_D) continue;
        const s1 = seg.p1.screen, s2 = seg.p2.screen;
        /* same test the road pass used to cull: a segment whose far end is below
         * the skyline drawn in front of it is hidden, sprites and all */
        if (s2.y >= seg.clip) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, Math.max(0, seg.clip));
        ctx.clip();
        ctx.globalAlpha = seg.fog;
        for (let i = 0; i < seg.sprites.length; i++) {         // roadside poles
          const sp = seg.sprites[i];
          const px = s1.x + sp.offset * s1.w;
          const ph = sp.h * s1.scale * H / 2;
          if (ph < 1.5) continue;
          ctx.fillStyle = sp.colour;
          ctx.fillRect(px - Math.max(0.5, s1.w / 90), s1.y - ph, Math.max(1, s1.w / 45), ph);
        }
        for (let i = 0; i < seg.cars.length; i++) {            // traffic
          const car = seg.cars[i];
          const box = carScreen(s1, s2, (car.z % SEG_LEN) / SEG_LEN, car.offset);
          drawCar(ctx, box.x, box.y, box.w, car.colour);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
    /* The player's car, drawn from behind and glued to the middle of the
     * screen — the road moves under it, which is what sells the speed. */
    /* The player's car, from behind, drawn to the proportions of the arcade
     * sprite: the body is 76% of the full width (the slicks stick out past it),
     * the wheels stand the lower 53% of the height, the red band crosses the
     * back, and a roll hoop with the driver's helmet rises above the shoulders.
     * Sized from the road at the row its wheels sit on — at the bottom of the
     * frame a road half-width is 226px and this car is CAR_HALF_W of one, so
     * 68px across, the same size a traffic car of that distance would be. */
    function drawPlayer(ctx) {
      const offRoad = Math.abs(playerX) > 1;
      const bounce = offRoad ? Math.sin(bounceT / 26) * 2.2 : 0;
      const jolt = shakeT > 0 ? (Math.sin(shakeT * 1.7) * 3 * (shakeT / SHAKE)) : 0;
      const x = W / 2 + jolt, y = PLAYER_SCREEN_Y + bounce;
      const hw = 34, hh = PLAYER_SCREEN_HH, hoop = 7;
      const bw = hw * 0.76;                       // body half-width
      const tyreW = hw - bw, tyreH = (hh + hoop) * 0.53;
      ctx.save();
      ctx.globalAlpha = 1;

      /* --- slicks, out past the body, with a lit tread --- */
      ctx.fillStyle = COL.bg;
      ctx.fillRect(x - hw, y - tyreH, tyreW, tyreH);
      ctx.fillRect(x + bw, y - tyreH, tyreW, tyreH);
      ctx.fillStyle = COL.dim;
      ctx.fillRect(x - hw, y - tyreH, tyreW, 2);
      ctx.fillRect(x + bw, y - tyreH, tyreW, 2);
      ctx.fillRect(x - hw, y - 3, tyreW, 3);
      ctx.fillRect(x + bw, y - 3, tyreW, 3);
      ctx.fillStyle = COL.bright;                 // a mark on each sidewall
      ctx.fillRect(x - hw + 1, y - tyreH * 0.62, 2, 3);
      ctx.fillRect(x + hw - 3, y - tyreH * 0.62, 2, 3);

      /* --- body, bottom to top --- */
      ctx.fillStyle = COL.dim;                    // diffuser
      ctx.fillRect(x - bw, y - 6, bw * 2, 6);
      ctx.fillStyle = COL.cyan;                   // teal midriff
      ctx.fillRect(x - bw, y - 10, bw * 2, 4);
      ctx.fillStyle = COL.dim;                    // gearbox either side
      ctx.fillRect(x - bw, y - 17, bw * 2, 7);
      ctx.fillStyle = COL.red;                    // engine block down the middle
      ctx.fillRect(x - bw * 0.42, y - 17, bw * 0.84, 7);
      ctx.fillStyle = braking || !throttle ? COL.red : COL.amber;   // brake lights
      ctx.fillRect(x - bw * 0.86, y - 16, 3, 3);
      ctx.fillRect(x + bw * 0.86 - 3, y - 16, 3, 3);
      ctx.fillStyle = COL.red;                    // the band across the back
      ctx.fillRect(x - bw, y - 20, bw * 2, 3);
      ctx.fillStyle = COL.amber;                  // shoulders, tapering in
      poly(ctx, x - bw, y - 20, x + bw, y - 20, x + bw * 0.84, y - hh, x - bw * 0.84, y - hh);

      /* --- roll hoop, and the helmet inside it --- */
      ctx.fillStyle = COL.dim;
      poly(ctx, x - bw * 0.38, y - hh + 1, x + bw * 0.38, y - hh + 1,
        x + bw * 0.13, y - hh - hoop, x - bw * 0.13, y - hh - hoop);
      ctx.fillStyle = COL.cyan;
      ctx.fillRect(x - bw * 0.22, y - hh - 3, bw * 0.44, 3);
      ctx.fillStyle = COL.pac;                    // the driver
      ctx.fillRect(x - bw * 0.17, y - hh - 5, bw * 0.34, 5);
      ctx.restore();
    }
    /* The crash: a white cloud with a yellow flash in it, growing and fading
     * over the stop. Drawn over the car, which is stationary beneath it. */
    function drawCrash(ctx) {
      if (crashT <= 0) return;
      const t = 1 - crashT / CRASH_STOP;                 // 0 as it starts, 1 as it ends
      const grow = 0.5 + t * 0.8, fade = 1 - t * t;
      const x = W / 2, y = H - 40;
      const puffs = [[0, 0, 24], [-24, -7, 16], [24, -7, 16], [0, -20, 17],
        [-16, 11, 13], [16, 11, 13]];
      ctx.save();
      ctx.fillStyle = COL.bright;                        // the cloud
      ctx.globalAlpha = fade * 0.9;
      for (let i = 0; i < puffs.length; i++) {
        ctx.beginPath();
        ctx.arc(x + puffs[i][0] * grow, y + puffs[i][1] * grow, puffs[i][2] * grow, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = COL.pac;                           // the flash, with spikes
      ctx.globalAlpha = Math.min(1, fade * 1.4);
      const r = 15 * grow;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + t * 1.6;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6);
        ctx.lineTo(x + Math.cos(a + 0.28) * r * 1.6, y + Math.sin(a + 0.28) * r * 1.6);
        ctx.lineTo(x + Math.cos(a + 0.56) * r * 0.6, y + Math.sin(a + 0.56) * r * 0.6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    function drawHud(ctx) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = '13px "Share Tech Mono", monospace';
      ctx.fillStyle = COL.dim;
      ctx.fillText('SPEED', 10, 8);
      ctx.fillText('TIME', W - 96, 8);
      ctx.font = '22px VT323, "Share Tech Mono", monospace';
      ctx.fillStyle = COL.phos;
      ctx.fillText(String(Math.round((speed / MAX_SPEED) * 300)), 10, 22);
      const secs = Math.max(0, timeLeft / 1000);
      ctx.fillStyle = secs < 8 ? COL.red : COL.phos;   // it goes red when it matters
      ctx.fillText(secs.toFixed(1), W - 96, 22);
      ctx.font = '13px "Share Tech Mono", monospace';
      ctx.fillStyle = COL.dim;
      ctx.fillText('LAP ' + lap, W / 2 - 24, 8);
      ctx.fillStyle = COL.bright;
      ctx.fillText(Math.round(position / 100) + 'm', W / 2 - 24, 22);
      if (Math.abs(playerX) > 1) {                     // a word for the verge
        ctx.fillStyle = COL.amber;
        ctx.fillText('OFF ROAD', W / 2 - 30, H - 46);
      }
      ctx.restore();
    }
    /* ============================ public object ========================= */
    const g = {
      w: W, h: H,
      state: 'ready',        // the shell sets 'playing' / 'paused'; we set 'over'
      score: 0, lives: START_LIVES, level: 1, message: '',
      reset: function () { resetGame(); },
      /* dt in ms. The shell only calls this while state === 'playing'. */
      update: function (dt) {
        if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) return;
        if (g.state === 'over') return;
        let left = dt > MAX_DT ? MAX_DT : dt;
        while (left > 0) {                           // fixed slices: frame-rate independent
          const s = left > STEP ? STEP : left;
          step(s);
          left -= s;
        }
      },
      /* Renders every state, including 'ready'; the shell owns all banners. */
      draw: function (ctx) {
        ctx.save();
        ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        /* where the terrain reaches decides where the sky stops */
        drawSky(ctx, Math.min(H / 2, eachRoadSegment(null)));
        drawRoad(ctx);            /* road, poles and traffic, hills clipping all of it */
        drawPlayer(ctx);
        drawCrash(ctx);           /* over the car: it is stopped under the cloud */
        drawHud(ctx);
        ctx.restore();
      },
      /* name: 'left' | 'right' | 'up' | 'down' | 'action'; down is boolean.
       * The touch pad shows only LEFT / RIGHT / GO, but the up and down keys
       * still work so a keyboard player is not left pressing dead arrows:
       * up is throttle, down is brake, exactly like the action button. */
      key: function (name, down) {
        if (name === 'left') steerDir = down ? -1 : (steerDir === -1 ? 0 : steerDir);
        else if (name === 'right') steerDir = down ? 1 : (steerDir === 1 ? 0 : steerDir);
        else if (name === 'action' || name === 'up') throttle = down;
        else if (name === 'down') braking = down;
      },
      /* Snapshot for the test harness: where everything is and how fast. */
      debug: function () {
        return {
          position: position, speed: speed, playerX: playerX, lap: lap,
          timeLeft: timeLeft, offRoad: Math.abs(playerX) > 1,
          /* contacts, split by kind: a shove costs no life, a crash costs one */
          bumps: bumps, crashes: crashes, crashing: crashT > 0,
          trackLength: trackLength, segments: segments.length,
          /* each car carries the sprite box the contact test uses, so the
           * harness can prove no two sprites are left sharing screen space */
          cars: cars.map(function (c) {
            const dz = zdiff(c.z, position);
            const box = dz > CAM_D ? carSpriteBox(c, dz) : null;
            return { z: c.z, offset: c.offset, speed: c.speed,
              sy: box ? box.y : null, hh: box ? box.hh : null };
          }),
          playerTop: PLAYER_SCREEN_Y - PLAYER_SCREEN_HH, playerBottom: PLAYER_SCREEN_Y,
          curve: segmentAt(position).curve
        };
      }
    };
    resetGame();               // a populated board is what 'ready' draws
    return g;
  };
})();
