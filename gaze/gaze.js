// GazeTracker: webcam → where on the screen you are looking.
//
// Plain script (no build step). Loads MediaPipe's Face Landmarker from a CDN, reads the iris and
// eye-corner landmarks plus the head pose every frame, and maps them to viewport pixels with a
// ridge regression fitted during a short calibration (look at a dot, click it, nine times).
//
//   const gaze = new GazeTracker({ video, onGaze: s => ..., onStatus: msg => ... });
//   await gaze.init();                 // camera + model
//   gaze.collect(x, y) / gaze.stopCollecting()   // during calibration, per dot
//   gaze.fit()                         // → { error, lambda, points }
//   gaze.validate(x, y, samples)       // → mean error in px at a check dot
//   samples arrive in onGaze as { t, x, y, fix, blink, face, drift }
//
// Coordinates are CSS pixels of the viewport, so a calibration only holds while the window stays
// where it was: go fullscreen, or recalibrate after moving or resizing it.

(() => {
  const MP_VERSION = '0.10.21';
  const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  // Face mesh indices. Right/left are the subject's own.
  const EYES = {
    right: { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468 },
    left: { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473 },
  };

  // feature-row indices that describe the eyes alone (not the head), for the local correction
  const RBF_FEATURES = [1, 2, 3, 4, 5, 6, 10, 11, 12];
  const REGION_R = 110;   // px: a look that wanders less than this is one dwell

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const median = arr => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Solve (XᵀX + λI) w = Xᵀy by Gaussian elimination; X is an array of rows.
  function ridge(X, y, lambda) {
    const d = X[0].length;
    const A = Array.from({ length: d }, () => new Float64Array(d + 1));
    for (const row of X) for (let i = 0; i < d; i++) { const xi = row[i]; if (!xi) continue; const Ai = A[i]; for (let j = 0; j < d; j++) Ai[j] += xi * row[j]; }
    for (let r = 0; r < X.length; r++) { const row = X[r], yr = y[r]; for (let i = 0; i < d; i++) A[i][d] += row[i] * yr; }
    for (let i = 1; i < d; i++) A[i][i] += lambda;  // leave the bias (column 0) unpenalised
    for (let c = 0; c < d; c++) {
      let p = c;
      for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      const piv = A[c][c] || 1e-12;
      for (let r = 0; r < d; r++) {
        if (r === c) continue;
        const f = A[r][c] / piv;
        if (!f) continue;
        for (let j = c; j <= d; j++) A[r][j] -= f * A[c][j];
      }
    }
    return Float64Array.from(A, (row, i) => row[d] / (row[i] || 1e-12));
  }

  class GazeTracker {
    // The cameras available, for a picker: [{ deviceId, label }] (labels appear once the camera has been allowed)
    static async cameras() {
      try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map(d => ({ deviceId: d.deviceId, label: d.label })); }
      catch (e) { return []; }
    }

    constructor({ video, onGaze, onStatus, onFrame, deviceId = null } = {}) {
      this.video = video;
      this.deviceId = deviceId;
      this.onGaze = onGaze || (() => {});
      this.onStatus = onStatus || (() => {});
      this.onFrame = onFrame || null;   // (landmarks, result) for drawing a preview
      this.landmarker = null;
      this.stream = null;
      this.running = false;
      this.model = null;        // { mean, std, wx, wy, head, error }
      this.points = [];         // calibration: [{ x, y, rows: [features] }]
      this.collecting = null;   // { x, y, rows } while a dot is being looked at
      this.history = [];        // recent raw predictions for the median filter
      this.smooth = null;       // EMA of the prediction
      this.fixWin = [];         // samples inside the current fixation candidate
      this.fix = null;
      this.lastFeatures = null;
      this.fps = 0;
      this._frames = 0;
      this._fpsAt = performance.now();
    }

    async init() {
      this.onStatus('Loading the face model…');
      const vision = await import(`${MP_URL}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
      const make = delegate => vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      });
      try { this.landmarker = await make('GPU'); }
      catch (e) { console.warn('GPU delegate failed, using CPU', e); this.landmarker = await make('CPU'); }

      this.onStatus('Starting the camera…');
      const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
      if (this.deviceId) video.deviceId = { exact: this.deviceId }; else video.facingMode = 'user';
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await new Promise(res => { this.video.onloadedmetadata = () => { this.video.play().then(res, res); }; });
      this.running = true;
      this.onStatus('Camera running');
      this._loop();
    }

    stop() {
      this.running = false;
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      if (this.landmarker) { this.landmarker.close(); this.landmarker = null; }
    }

    // rAF rather than requestVideoFrameCallback, which can stall while the video element is hidden
    _loop() {
      let lastTime = -1;
      const step = () => {
        if (!this.running) return;
        requestAnimationFrame(step);
        if (this.video.currentTime === lastTime) return;   // no new camera frame yet
        lastTime = this.video.currentTime;
        this._tick();
      };
      step();
    }

    _tick() {
      const v = this.video;
      if (!v.videoWidth || !this.landmarker) return;
      const t = performance.now();
      let result;
      try { result = this.landmarker.detectForVideo(v, t); } catch (e) { return; }
      this._frames++;
      if (t - this._fpsAt > 1000) { this.fps = this._frames * 1000 / (t - this._fpsAt); this._frames = 0; this._fpsAt = t; }
      const lm = result.faceLandmarks && result.faceLandmarks[0];
      if (this.onFrame) this.onFrame(lm || null, result);
      if (!lm) { this.lastFeatures = null; this.onGaze({ t, x: null, y: null, fix: null, blink: false, face: false, drift: 0 }); return; }
      const f = this._features(lm, result.facialTransformationMatrixes && result.facialTransformationMatrixes[0], v.videoWidth, v.videoHeight);
      this.lastFeatures = f;
      // A blink, and the few frames after it while the lid settles and the iris landmark wanders
      if (f.blink) this.blinkCool = 4;
      else if (this.blinkCool > 0) this.blinkCool--;
      if (f.blink || this.blinkCool > 0) { this.onGaze({ t, x: null, y: null, fix: this.fix, region: this.region, blink: true, face: true, drift: this._drift(f) }); return; }
      if (this.collecting) { this.collecting.rows.push(f.row); this.collecting.ears.push(f.ear); }
      if (!this.model) { this.onGaze({ t, x: null, y: null, fix: null, blink: false, face: true, drift: 0 }); return; }
      const p = this._predict(f.row);
      this._emit(t, p.x, p.y, f);
    }

    // Eye features that depend on where the eyes point, plus head pose so slight shifts can be absorbed.
    _features(lm, matrix, W, H) {
      const P = i => ({ x: lm[i].x * W, y: lm[i].y * H });
      const eye = e => {
        const o = P(e.outer), i = P(e.inner), top = P(e.top), bot = P(e.bottom), ir = P(e.iris);
        const w = dist(o, i) || 1;
        const ux = (i.x - o.x) / w, uy = (i.y - o.y) / w;        // along the eye
        const cx = (o.x + i.x) / 2, cy = (o.y + i.y) / 2;
        const dx = ir.x - cx, dy = ir.y - cy;
        const along = (q, ox, oy) => -(q.x - ox) * uy + (q.y - oy) * ux;   // distance from the eye axis, positive downwards
        const lidTop = along(top, cx, cy), lidBot = along(bot, cx, cy), irisV = along(ir, cx, cy);
        // where the iris sits between the lids: the lids follow the eye up and down, so this is a
        // steadier vertical cue than the corner-relative offset alone
        const lid = (irisV - lidTop) / ((lidBot - lidTop) || 1);
        // iris width over eye width: the distance to the camera
        const size = (dist(P(e.iris + 1), P(e.iris + 3)) + dist(P(e.iris + 2), P(e.iris + 4))) / 2 / w;
        return { h: (dx * ux + dy * uy) / w, v: (-dx * uy + dy * ux) / w, lid, size, ear: dist(top, bot) / w, w };
      };
      const R = eye(EYES.right), L = eye(EYES.left);
      // the two eyes are mirror images along the eye axis, so flip one horizontal reading
      const hR = -R.h, hL = L.h;
      const h = (hR + hL) / 2, v = (R.v + L.v) / 2, lid = (R.lid + L.lid) / 2, size = (R.size + L.size) / 2;
      const blink = (R.ear + L.ear) / 2 < 0.16;

      let yaw = 0, pitch = 0, roll = 0, tx = 0, ty = 0, tz = 0;
      if (matrix && matrix.data && matrix.data.length === 16) {
        const d = matrix.data;      // row-major 4×4
        const r00 = d[0], r01 = d[1], r02 = d[2], r10 = d[4], r11 = d[5], r12 = d[6], r20 = d[8], r21 = d[9], r22 = d[10];
        tx = d[3]; ty = d[7]; tz = d[11];
        yaw = Math.atan2(-r20, Math.hypot(r00, r10));
        pitch = Math.atan2(r21, r22);
        roll = Math.atan2(r10, r00);
        void r01; void r02; void r11; void r12;
      } else {
        // no matrix: the nose position and eye spacing stand in for head pose
        const nose = P(1), eo = P(EYES.right.outer), eo2 = P(EYES.left.outer);
        tx = nose.x / W; ty = nose.y / H; tz = dist(eo, eo2) / W;
        roll = Math.atan2(eo2.y - eo.y, eo2.x - eo.x);
      }
      // indices 5 and 6 (h, v) are what stopCollecting trims on; the head pose is always the last six.
      // The eye×head cross terms let the fit learn that the same eye angle means a different screen
      // point once the head has turned or moved, which the head-movement calibration dots exercise.
      const row = [1, hR, R.v, hL, L.v, h, v, h * h, v * v, h * v, R.lid, L.lid, lid, lid * lid, h * lid, size,
        h * yaw, v * pitch, h * tx, v * ty, lid * pitch, lid * ty,
        yaw, pitch, roll, tx, ty, tz];
      return { row, blink, ear: (R.ear + L.ear) / 2, head: [yaw, pitch, roll, tx, ty, tz], h, v };
    }

    _predict(row) {
      const m = this.model;
      let x = m.bias ? m.bias.x : 0, y = m.bias ? m.bias.y : 0;
      const zs = new Array(row.length);
      for (let i = 0; i < row.length; i++) {
        const z = i === 0 ? 1 : (row[i] - m.mean[i]) / m.std[i];
        zs[i] = z;
        x += z * m.wx[i];
        y += z * m.wy[i];
      }
      const R = m.rbf;
      if (R) {
        // local correction: how wrong the global fit was at the nearest calibration dots
        x += R.wx[0]; y += R.wy[0];
        for (let k = 0; k < R.centres.length; k++) {
          const c = R.centres[k];
          let d2 = 0;
          for (let j = 0; j < RBF_FEATURES.length; j++) { const e = zs[RBF_FEATURES[j]] - c[j]; d2 += e * e; }
          const phi = Math.exp(-d2 / (2 * R.bw * R.bw));
          x += phi * R.wx[k + 1]; y += phi * R.wy[k + 1];
        }
      }
      return { x, y };
    }

    // A quadratic in the eye features cannot bend enough at the top and bottom rows, where the
    // lids and iris behave differently. Radial basis functions centred on each still dot soak up
    // what the global fit gets wrong there, and fade back to the global fit between dots.
    _fitResidualRbf(still, z, w, predictWith) {
      if (still.length < 6) return null;
      const centres = [], rx = [], ry = [];
      for (const p of still) {
        const Zs = p.rows.map(z);
        const c = RBF_FEATURES.map(i => Zs.reduce((s, r) => s + r[i], 0) / Zs.length);
        const pr = Zs.map(r => predictWith(w, r));
        centres.push(c);
        rx.push(p.x - median(pr.map(q => q.x)));
        ry.push(p.y - median(pr.map(q => q.y)));
      }
      const dists = [];
      for (let a = 0; a < centres.length; a++) for (let b = a + 1; b < centres.length; b++) dists.push(Math.hypot(...centres[a].map((v, j) => v - centres[b][j])));
      const bw = (median(dists) || 1) * 0.7;
      const Phi = centres.map(ca => [1, ...centres.map(cb => Math.exp(-centres[0].reduce((s, _, j) => s + (ca[j] - cb[j]) ** 2, 0) / (2 * bw * bw)))]);
      return { centres, bw, wx: [...ridge(Phi, rx, 0.5)], wy: [...ridge(Phi, ry, 0.5)] };
    }

    // One-dot drift correction: shift the model so its prediction for the samples just collected
    // lands on the dot. Quick to do mid-session after shifting in the chair.
    rebias() {
      const c = this.collecting;
      this.collecting = null;
      if (!c || !this.model || c.rows.length < 3) return null;
      const m = this.model;
      const ps = c.rows.map(r => this._predict(r));
      const mx = median(ps.map(p => p.x)), my = median(ps.map(p => p.y));
      m.bias = { x: (m.bias ? m.bias.x : 0) + (c.x - mx), y: (m.bias ? m.bias.y : 0) + (c.y - my) };
      this.history = []; this.smooth = null; this.fix = null; this.fixWin = [];
      return { dx: Math.round(c.x - mx), dy: Math.round(c.y - my) };
    }

    // Median over the last few frames, then an exponential average, then a dispersion-based fixation test.
    _emit(t, rx, ry, f) {
      const W = innerWidth, H = innerHeight;
      // Looking away from the screen (down at the paper, at the keyboard, out the window): the
      // raw prediction lands well outside the viewport, the lids droop over the iris, or the head
      // has tipped well away from where it was calibrated. Hysteresis keeps it from flapping.
      this.history.push({ x: rx, y: ry });
      if (this.history.length > 9) this.history.shift();
      const rawX = median(this.history.map(p => p.x)), rawY = median(this.history.map(p => p.y));
      // Position is tested on the median (single frames at the bottom row stray far enough to look
      // like the desk); the lid test is relative to how closed the lids were on the lowest
      // calibration dots, so reading the last lines never counts as looking down.
      const mx = 0.2 * W, my = 0.2 * H;
      const dPitch = this.model.head ? Math.abs(f.head[1] - this.model.head[1]) : 0;
      const droop = this.model.earMin ? Math.min(0.2, this.model.earMin * 0.9) : 0.17;
      const recent = this.history.slice(-5);
      const qx = median(recent.map(p => p.x)), qy = median(recent.map(p => p.y));   // a shorter median: reacts in ~200 ms
      const awayNow = qx < -mx || qx > W + mx || qy < -my || qy > H + my || f.ear < droop || dPitch > 0.2;
      this.awayFrames = awayNow ? (this.awayFrames || 0) + 1 : 0;
      this.hereFrames = awayNow ? 0 : (this.hereFrames || 0) + 1;
      if (!this.away && this.awayFrames >= 3) this.away = true;
      if (this.away && this.hereFrames >= 4) { this.away = false; this.history = this.history.slice(-3); this.smooth = null; this.fix = null; this.fixWin = []; }
      if (this.away) {
        this.fix = null; this.fixWin = []; this.region = null;
        this.onGaze({ t, x: null, y: null, fix: null, region: null, blink: false, face: true, away: true, drift: this._drift(f) });
        return;
      }
      // Per-frame predictions are noisy (a couple of hundred px); a longer median and a slower
      // average trade a little lag for a much steadier point, which is fine for reading lines.
      let x = rawX, y = rawY;
      if (!this.smooth) this.smooth = { x, y };
      else {
        const jump = Math.hypot(x - this.smooth.x, y - this.smooth.y);
        const a = jump > 200 ? 0.7 : 0.22;     // follow real saccades, settle slowly otherwise
        this.smooth = { x: this.smooth.x + a * (x - this.smooth.x), y: this.smooth.y + a * (y - this.smooth.y) };
      }
      x = Math.max(0, Math.min(W, this.smooth.x));
      y = Math.max(0, Math.min(H, this.smooth.y));

      this.fixWin.push({ x, y, t });
      while (this.fixWin.length && t - this.fixWin[0].t > 2000) this.fixWin.shift();
      const xs = this.fixWin.map(p => p.x), ys = this.fixWin.map(p => p.y);
      const disp = (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));
      const span = t - this.fixWin[0].t;
      const DISP = 120;
      if (disp < DISP && span >= 100) {
        const cx = xs.reduce((a, b) => a + b) / xs.length, cy = ys.reduce((a, b) => a + b) / ys.length;
        if (!this.fix) this.fix = { x: cx, y: cy, start: this.fixWin[0].t, dur: span };
        else { this.fix.x = cx; this.fix.y = cy; this.fix.dur = t - this.fix.start; }
      } else if (disp >= DISP) {
        this.fix = null;
        this.fixWin = this.fixWin.slice(-2);
      }
      // edge: the raw point was outside the viewport and got clamped, so it should not count as reading
      const edge = rawX < 0 || rawX > W || rawY < 0 || rawY > H;
      // The dwell region: a slow centroid that follows the gaze while it stays roughly in one
      // place (reading a few lines), and restarts when it jumps. Pages show the circle and count
      // reading only once region.dur has passed their hold time.
      const rg = this.region;
      if (!rg || Math.hypot(x - rg.x, y - rg.y) > REGION_R * 1.4) this.region = { x, y, start: t, dur: 0, r: REGION_R };
      else { rg.x += 0.12 * (x - rg.x); rg.y += 0.12 * (y - rg.y); rg.dur = t - rg.start; }
      this.onGaze({ t, x, y, fix: this.fix, region: this.region, blink: false, face: true, away: false, edge, drift: this._drift(f) });
    }

    // How far the head is from where it was during calibration, 0..1+ (1 ≈ should recalibrate)
    _drift(f) {
      const m = this.model;
      if (!m || !m.head) return 0;
      const [yaw, pitch, roll, tx, ty, tz] = f.head;
      const [Y, Pch, Rl, X, Yy, Z] = m.head;
      const ang = Math.hypot(yaw - Y, pitch - Pch, roll - Rl) / 0.12;     // ~7° of turn
      const mov = Math.hypot(tx - X, ty - Yy) / (m.headScale || 4) + Math.abs(tz - Z) / (m.headScale || 4) / 2;
      return Math.max(ang, mov);
    }

    /* ---- calibration ---- */

    // moving: the head is meant to move while this dot is looked at, so keep every frame
    collect(x, y, { moving = false } = {}) { this.collecting = { x, y, rows: [], ears: [], moving }; }

    // Returns how many frames were kept for the dot
    stopCollecting() {
      const c = this.collecting;
      this.collecting = null;
      if (!c || c.rows.length < 5) return 0;
      let keep = c.rows;
      if (!c.moving) {
        // drop the frames furthest from the dot's typical reading (a blink, a glance away)
        const hs = c.rows.map(r => r[5]), vs = c.rows.map(r => r[6]);
        const mh = median(hs), mv = median(vs);
        const scored = c.rows.map(r => ({ r, d: Math.hypot(r[5] - mh, r[6] - mv) })).sort((a, b) => a.d - b.d);
        keep = scored.slice(0, Math.max(5, Math.ceil(scored.length * 0.75))).map(s => s.r);
      }
      // how far the lids closed while looking here: the lowest dots set the "looking down" threshold
      const ears = [...c.ears].sort((a, b) => a - b);
      this.points.push({ x: c.x, y: c.y, rows: keep, moving: c.moving, ear: ears[Math.floor(ears.length * 0.1)] || 0.25 });
      return keep.length;
    }

    resetCalibration() { this.points = []; this.model = null; this.history = []; this.smooth = null; this.fix = null; this.fixWin = []; }

    // Fit the regression. λ is chosen by leaving each dot out in turn and picking the one that
    // predicts the held-out dot best, so a shaky calibration leans on the simpler model.
    fit() {
      const pts = this.points;
      if (pts.length < 5) throw new Error('Need at least five calibration dots');
      const all = pts.flatMap(p => p.rows);
      const d = all[0].length;
      const mean = new Float64Array(d), std = new Float64Array(d).fill(1);
      for (let i = 1; i < d; i++) {
        mean[i] = all.reduce((s, r) => s + r[i], 0) / all.length;
        std[i] = Math.sqrt(all.reduce((s, r) => s + (r[i] - mean[i]) ** 2, 0) / all.length) || 1;
      }
      const z = r => r.map((v, i) => i === 0 ? 1 : (v - mean[i]) / std[i]);
      const Z = pts.map(p => p.rows.map(z));
      const fitOn = (idx, lambda) => {
        const X = [], yx = [], yy = [];
        idx.forEach(k => Z[k].forEach(r => { X.push(r); yx.push(pts[k].x); yy.push(pts[k].y); }));
        return { wx: ridge(X, yx, lambda * X.length), wy: ridge(X, yy, lambda * X.length) };
      };
      const predictWith = (w, r) => { let x = 0, y = 0; for (let i = 0; i < d; i++) { x += r[i] * w.wx[i]; y += r[i] * w.wy[i]; } return { x, y }; };
      let best = null;
      for (const lambda of [0.003, 0.01, 0.03, 0.1, 0.3, 1]) {
        let err = 0;
        for (let k = 0; k < pts.length; k++) {
          const w = fitOn(pts.map((_, i) => i).filter(i => i !== k), lambda);
          const errs = Z[k].map(r => { const p = predictWith(w, r); return Math.hypot(p.x - pts[k].x, p.y - pts[k].y); });
          err += median(errs);
        }
        err /= pts.length;
        if (!best || err < best.err) best = { lambda, err };
      }
      const w = fitOn(pts.map((_, i) => i), best.lambda);
      // the resting head pose, for the drift warning: only the dots looked at with a still head
      const still = pts.filter(p => !p.moving);
      const headRows = still.flatMap(p => p.rows).map(r => r.slice(-6));
      const head = headRows[0].map((_, j) => headRows.reduce((s, r) => s + r[j], 0) / headRows.length);
      const headScale = Math.max(1, Math.abs(head[5]) * 0.08);   // a few percent of the distance to the camera
      // lids are lowest when looking at the bottom row; "looking away" has to be clearly below that
      const earMin = Math.min(...still.map(p => p.ear));
      this.model = { mean, std, wx: w.wx, wy: w.wy, head, headScale, earMin, error: best.err, lambda: best.lambda, at: Date.now(), w: innerWidth, h: innerHeight };
      this.model.rbf = this._fitResidualRbf(still, z, w, predictWith);
      this.history = []; this.smooth = null; this.fix = null; this.fixWin = [];
      return { error: Math.round(best.err), lambda: best.lambda, points: pts.length };
    }

    // Error against a check dot, from the samples collected for it: `steady` is the error of the
    // averaged prediction (what a fixation gives), `frame` the typical single-frame error.
    validate() {
      const c = this.collecting;
      this.collecting = null;
      if (!c || !this.model || c.rows.length < 3) return null;
      const ps = c.rows.map(r => this._predict(r));
      const mx = median(ps.map(p => p.x)), my = median(ps.map(p => p.y));
      return { steady: Math.round(Math.hypot(mx - c.x, my - c.y)), frame: Math.round(median(ps.map(p => Math.hypot(p.x - c.x, p.y - c.y)))) };
    }

    exportModel() {
      const m = this.model;
      return m && { ...m, mean: [...m.mean], std: [...m.std], wx: [...m.wx], wy: [...m.wy] };
    }

    importModel(m) {
      if (!m || !m.wx) return false;
      this.model = { ...m, mean: Float64Array.from(m.mean), std: Float64Array.from(m.std), wx: Float64Array.from(m.wx), wy: Float64Array.from(m.wy) };
      this.history = []; this.smooth = null; this.fix = null; this.fixWin = [];
      return true;
    }
  }

  window.GazeTracker = GazeTracker;
})();
