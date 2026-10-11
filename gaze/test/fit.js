// Synthetic calibration: a made-up eye whose features bend at the top and bottom rows and shift
// with the head, pushed through collect/fit/validate/chooseCorrection the way calibrate.js does.
//   node gaze/test/fit.js
const { rng } = require('./shim.js');
const W = innerWidth, H = innerHeight;

// The pretend eye. h/v are what the iris does for a screen point; the lids droop looking down,
// the head turning adds its own offset, and the two eyes disagree a little.
function features(x, y, head, R) {
  const nx = x / W - 0.5, ny = y / H - 0.5;
  const [yaw, pitch, roll, tx, ty, tz] = head;
  const h = 0.30 * nx + 0.5 * yaw + 0.02 * tx, v = 0.18 * ny + 0.06 * ny * ny * Math.sign(ny) + 0.5 * pitch + 0.02 * ty;
  const n = () => R.g() * 0.006;
  const hR = h + n() + 0.01 * nx * nx, hL = h + n() - 0.012 * ny, Rv = v + n() + 0.015 * ny * ny, Lv = v + n();
  const lid = 0.5 + 0.35 * ny + 0.08 * ny * ny + n(), Rl = lid + n() * 2, Ll = lid + n();
  const size = 0.3 + 0.01 * tz + n();
  const hh = (hR + hL) / 2, vv = (Rv + Lv) / 2;
  const row = [1, hR, Rv, hL, Lv, hh, vv, hh * hh, vv * vv, hh * vv, Rl, Ll, lid, lid * lid, hh * lid, size,
    hh * yaw, vv * pitch, hh * tx, vv * ty, lid * pitch, lid * ty, yaw, pitch, roll, tx, ty, tz];
  return { row, ear: 0.3 - 0.1 * ny };
}

function run({ glare = 0, seed = 1 } = {}) {
  const R = rng(seed);
  const g = new GazeTracker({ video: {} });
  const rest = [0.02, -0.05, 0.01, 1, -2, -45];
  const collect = (x, y, n, moving) => {
    g.collect(x, y, { moving });
    for (let i = 0; i < n; i++) {
      const head = moving ? rest.map((v, j) => v + (j < 3 ? 0.12 : 4) * Math.sin(i / (5 + 2 * j) + j)) : rest.map((v, j) => v + R.g() * (j < 3 ? 0.004 : 0.2));
      const f = features(x, y, head, R);
      if (glare) f.row[1] += R.g() * glare * (0.5 + 0.5 * Math.sin(i));   // the right eye's iris jitters
      g.collecting.rows.push(f.row); g.collecting.ears.push(f.ear);
    }
    return g.stopCollecting();
  };
  const inset = 0.07;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) collect(W * (inset + (1 - 2 * inset) * i / 3), H * (inset + (1 - 2 * inset) * j / 3), j === 0 || j === 3 ? 45 : 33, false);
  [[0.5, 0.5], [0.2, 0.25], [0.8, 0.75]].forEach(([a, b]) => collect(W * a, H * b, 150, true));
  const fit = g.fit();
  const checks = [[0.3, 0.14], [0.7, 0.14], [0.5, 0.5], [0.3, 0.86], [0.7, 0.86]];
  const live = [];
  checks.forEach(([a, b]) => { collect(W * a, H * b, 30, false); g.points.pop(); g.collect(W * a, H * b); for (let i = 0; i < 30; i++) { const f = features(W * a, H * b, rest, R); g.collecting.rows.push(f.row); g.collecting.ears.push(f.ear); } live.push(g.validate()); });
  const pick = g.chooseCorrection();
  // a moved head, inside and outside the calibrated range
  const at = (x, y, head) => { const f = features(x, y, head, R); const p = g._predict(f.row); return Math.round(Math.hypot(p.x - x, p.y - y)); };
  const turned = rest.map((v, j) => v + (j === 0 ? 0.08 : 0));
  const far = rest.map((v, j) => v + (j === 0 ? 0.5 : 0));
  return { fit, live: live.map(c => c.steady), pick, moved: at(W * 0.6, H * 0.4, turned), outOfRange: at(W * 0.6, H * 0.4, far), drift: Math.round(g._drift({ head: far }) * 10) / 10 };
}

for (const glare of [0, 0.01, 0.03]) {
  const r = run({ glare });
  console.log('glare ' + glare + ':', 'fit loo ' + r.fit.error + ' px, head terms ' + (r.fit.headFit ? 'kept' : 'dropped') + ';',
    'checks before choice ' + r.live.join('/') + ';', 'chosen ' + r.pick.chosen, JSON.stringify(r.pick.errors) + ';',
    'per check ' + r.pick.checks.map(c => c.steady).join('/') + ';', 'head turned 5° → ' + r.moved + ' px; 30° (out of range, clamped) → ' + r.outOfRange + ' px, drift ' + r.drift);
}

// what has to hold
const r = run({ glare: 0 });
const fails = [];
if (r.pick.chosen === 'none' && r.pick.errors.both < r.pick.errors.none - 4) fails.push('a correction that beats the plain fit was not chosen');
if (r.moved > 60) fails.push('a 5° head turn inside the calibrated range should be compensated, got ' + r.moved + ' px');
if (!(r.drift > 1)) fails.push('a head pose outside the calibrated range should warn, drift was ' + r.drift);
if (fails.length) { console.error('FAIL: ' + fails.join('; ')); process.exit(1); }
console.log('ok');
