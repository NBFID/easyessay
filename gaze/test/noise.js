// Noise test: a pretend reader whose true gaze sits on one sentence, then jumps to another, with
// webcam-sized noise (σ about 100 px frame to frame) on every frame. The samples go through
// GazeTracker._emit (median, average, fixation, dwell region) and LookupMapper.onGaze (panel
// hysteresis, hold, sentence scoring, switch delay), and the run reports, averaged over seeds:
//   switches   how many times the highlighted sentence changed (ideal: one per sentence read, 5)
//   flaps      extra switches while one sentence was being read (the highlight jittering)
//   far        switches that landed more than one sentence from the one being read
//   settle     median ms from a true jump to the highlight landing on the right sentence or its neighbour
//   missed     sentences the highlight never caught up with
//   lookups    counted lookups (ideal: 4 visits to the panel) and wrong (sentences counted that were not read)
// Besides the frame noise each visit to the panel carries a steady offset (σ 45 px, the calibration
// error), which is why a neighbouring sentence counts as a hit: the mapper cannot know better.
//
//   node gaze/test/noise.js            the current tuning at three noise levels
//   node gaze/test/noise.js sweep      try alternatives and print a table
//   node gaze/test/noise.js check      exit 1 if the current tuning is worse than the floor
const { rng } = require('./shim.js');

const FPS = 30, DT = 1000 / FPS;
const LINE = 28, LEFT = 60, TOP = 120, WIDTH = 820, N_SENT = 14;

// A fake reference panel: sentences two lines long, stacked, in a panel on the left of the screen
function fakeDom() {
  const sentences = [];
  for (let i = 0; i < N_SENT; i++) {
    const y0 = TOP + i * 2 * LINE;
    const boxes = [{ left: LEFT, right: LEFT + WIDTH, top: y0, bottom: y0 + LINE }, { left: LEFT, right: LEFT + WIDTH * 0.6, top: y0 + LINE, bottom: y0 + 2 * LINE }];
    const wordEls = [];
    for (let k = 0; k < 16; k++) {
      const b = boxes[k < 10 ? 0 : 1];
      const x0 = b.left + ((k % 10) / 10) * (b.right - b.left);
      wordEls.push({ classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ left: x0, right: x0 + 60, top: b.top, bottom: b.bottom }) });
    }
    sentences.push({ s: i, p: 0, text: 'sentence ' + i + ' ' + 'w '.repeat(14), words: [], wordEls,
      el: { getClientRects: () => boxes.map(b => ({ ...b })), classList: { add() {}, remove() {} } } });
  }
  const panel = { getBoundingClientRect: () => ({ left: LEFT - 20, right: LEFT + WIDTH + 20, top: TOP - 20, bottom: TOP + N_SENT * 2 * LINE + 20 }), addEventListener() {}, removeEventListener() {} };
  return { panel, sentences };
}

// the script: [sentence, ms] or [null, ms] for writing (gaze down on the box to the right)
const PLAN = [[null, 1500], [2, 1800], [null, 2500], [3, 1400], [4, 1300], [null, 2000], [7, 2200], [null, 1200], [1, 1600], [null, 2000]];

function runOne({ seed, sigma, bias = 45, holdMs = 600, trace = false }) {
  const R = rng(seed);
  const g = new GazeTracker({ video: {} });
  g.model = { w: innerWidth, h: innerHeight };
  const { panel, sentences } = fakeDom();
  const switches = [], looks = [];
  let current = -1, t = 0;
  const m = new LookupMapper({ panel, sentences, holdMs, onCurrent: s => { current = s; switches.push({ t, s }); }, onLook: e => { if (e) looks.push(e); } });
  g.onGaze = s => m.onGaze(s);
  // the writer types what they just looked up, so the cursor sits on the last sentence read
  let cursor = 0, lastRead = 0;
  m.setCursor(0);
  let flaps = 0, far = 0, missed = 0, wrong = 0;
  const settles = [];
  const centreOf = s => ({ x: LEFT + WIDTH * 0.4, y: TOP + s * 2 * LINE + LINE * 0.8 });
  const near = (a, b) => Math.abs(a - b) <= 1;
  let lookN = 0;
  for (const [s, ms] of PLAN) {
    const target = s == null ? { x: 1500, y: 600 } : centreOf(s);
    if (s != null) lastRead = s;
    else { cursor = lastRead; m.setCursor(cursor); }
    // calibration error: a steady offset that lasts for the whole look, on top of the frame noise
    const bx = R.g() * bias * 1.3, by = R.g() * bias;
    const n0 = switches.length, t0 = t, l0 = looks.length;
    let landed = null;
    for (let i = 0; i < ms / DT; i++) {
      t += DT;
      // the eye lands a little left of centre and wanders right as it reads along the line
      const drift = s == null ? 0 : (i * DT / ms) * WIDTH * 0.5 - WIDTH * 0.2;
      g._emit(t, target.x + drift + bx + R.g() * sigma, target.y + by + R.g() * sigma, { head: [0, 0, 0, 0, 0, 0], ear: 0.3 });
      if (s != null && landed == null && current !== -1 && near(current, s)) landed = t - t0;
    }
    if (s != null) {
      if (landed == null) missed++; else settles.push(landed);
      const sw = switches.slice(n0).filter(x => x.s !== -1);
      flaps += Math.max(0, sw.length - 1);
      far += sw.filter(x => !near(x.s, s)).length;
    } else {
      // the look that just ended: every sentence it counted should be the one read (or its neighbour)
      looks.slice(l0).forEach(l => l.s.forEach(x => { if (!near(x, lastRead)) wrong++; }));
    }
  }
  m.finish();
  if (trace) console.log('seed ' + seed + ' switches: ' + switches.map(x => Math.round(x.t) + ':' + x.s).join(' ') + '\n  looks: ' + looks.map(l => 'S' + l.s.join(',')).join(' '));
  const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
  return { switches: switches.filter(x => x.s !== -1).length, flaps, far, settle: med(settles), missed, lookups: looks.length, wrong };
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
function score(sigma, holdMs) {
  const acc = { switches: 0, flaps: 0, far: 0, settle: [], missed: 0, lookups: 0, wrong: 0 };
  for (const seed of SEEDS) {
    const r = runOne({ seed, sigma, holdMs });
    acc.switches += r.switches; acc.flaps += r.flaps; acc.far += r.far; acc.missed += r.missed; acc.lookups += r.lookups; acc.wrong += r.wrong;
    if (r.settle != null) acc.settle.push(r.settle);
  }
  const n = SEEDS.length, f = v => +(v / n).toFixed(1);
  return { switches: f(acc.switches), flaps: f(acc.flaps), far: f(acc.far), settle: Math.round(acc.settle.reduce((a, b) => a + b, 0) / (acc.settle.length || 1)), missed: f(acc.missed), lookups: f(acc.lookups), wrong: f(acc.wrong) };
}

const T = GazeTracker.TUNE, L = LookupMapper.TUNE;
const fmt = r => Object.entries(r).map(([k, v]) => k + ' ' + v).join('  ');
const mode = process.argv[2];
if (mode === 'trace') {
  for (const seed of [1, 2]) runOne({ seed, sigma: 100, trace: true });
} else if (mode === 'sweep') {
  const base = { ...T }, baseL = { ...L };
  const trials = [
    ['current', {}],
    ['MED_N 5', { MED_N: 5 }], ['MED_N 13', { MED_N: 13 }],
    ['EMA_A 0.22', { EMA_A: 0.22 }], ['EMA_A 0.1', { EMA_A: 0.1 }],
    ['JUMP 150', { JUMP: 150 }], ['JUMP 300', { JUMP: 300 }],
    ['REGION_R 80', { REGION_R: 80 }], ['REGION_R 150', { REGION_R: 150 }],
    ['REGION_WX 1', { REGION_WX: 1 }], ['REGION_WX 4', { REGION_WX: 4 }],
    ['REGION_RATE 0.06', { REGION_RATE: 0.06 }], ['REGION_RATE 0.2', { REGION_RATE: 0.2 }],
    ['SWITCH_MS 160', {}, { SWITCH_MS: 160 }], ['SWITCH_MS 450', {}, { SWITCH_MS: 450 }],
    ['SIGMA_Y 40', {}, { SIGMA_Y: 40 }], ['SIGMA_Y 70', {}, { SIGMA_Y: 70 }],
    ['PRIOR_SD 2', {}, { PRIOR_SD: 2 }], ['PRIOR_SD 6', {}, { PRIOR_SD: 6 }],
    ['STICK 0', {}, { STICK: 0 }], ['STICK 0.3', {}, { STICK: 0.3 }], ['STICK 1', {}, { STICK: 1 }],
    ['MIN_LOOK 180', {}, { MIN_LOOK: 180 }], ['MIN_LOOK 450', {}, { MIN_LOOK: 450 }],
  ];

  for (const [name, tune, ltune = {}] of trials) {
    Object.assign(T, base, tune); Object.assign(L, baseL, ltune);
    const r100 = score(100), r60 = score(60), r150 = score(150);
    console.log(name.padEnd(17), 'σ100:', fmt(r100), ' | σ60 flaps', r60.flaps, 'far', r60.far, 'settle', r60.settle, ' | σ150 flaps', r150.flaps, 'far', r150.far, 'settle', r150.settle, 'missed', r150.missed, 'wrong', r150.wrong);
  }
  Object.assign(T, base); Object.assign(L, baseL);
} else {
  const out = {};
  for (const sigma of [60, 100, 150]) { out[sigma] = score(sigma); console.log('σ ' + sigma + ':', fmt(out[sigma])); }
  if (mode === 'check') {
    const r = out[100], fails = [];
    if (r.flaps + r.far > 1) fails.push('too many false switches at σ100: ' + (r.flaps + r.far));
    if (r.settle > 1000) fails.push('slow to settle at σ100: ' + r.settle + ' ms');
    if (r.missed > 0.7) fails.push('sentences missed at σ100: ' + r.missed);
    if (r.wrong > 0.6) fails.push('wrong sentences counted at σ100: ' + r.wrong);
    if (fails.length) { console.error('FAIL: ' + fails.join('; ')); process.exit(1); }
    console.log('ok');
  }
}
