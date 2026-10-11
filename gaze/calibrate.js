// GazeCalibrate: the calibration overlay, shared by gaze/index.html and EasyEssay's writeout mode.
//
// Plain script, no markup needed: it adds its own full-screen overlay and styles to the page on
// first use. Colours follow the page's --bg / --ink (or --fg) / --accent / --muted variables.
//
//   const err = await GazeCalibrate.calibrate(gaze, { reusable: savedModel });
//     → average check error in px, or null if the user pressed Escape or the fit failed
//   await GazeCalibrate.accuracyTest(gaze)   // five targets; → { targets, rows, cols, error } or null
//   await GazeCalibrate.prompt(html)   // a message on the overlay; resolves on click, Space or Enter
//   GazeCalibrate.hide()
//
// Sixteen dots fit the model (the top and bottom rows are held longer, where the fit is weakest),
// three are looked at with the head moving, and five more check it, two on the top row, one in the
// middle and two on the bottom. The user looks at each dot, clicks it (or presses Space) and keeps
// looking for a second. The check dots also decide which local correction the model keeps. With
// `reusable` (a model from gaze.exportModel()), the opening message offers U to reuse it instead,
// which only works while the window is the same size.

(() => {
  const CSS = `
  .gz-cal { position: fixed; inset: 0; z-index: 1000; background: var(--bg, #fff); color: var(--ink, var(--fg, #1b1b1b)); cursor: crosshair; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .gz-cal[hidden] { display: none; }
  .gz-cal .gz-msg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center; max-width: 520px; padding: 0 16px; cursor: default; }
  .gz-cal .gz-msg p { margin: 6px 0; }
  .gz-cal .gz-msg.gz-corner { top: 56px; transform: translate(-50%, 0); font-size: 14px; color: var(--muted, #6b6b6b); }
  .gz-cal .gz-muted { color: var(--muted, #6b6b6b); }
  .gz-dot { position: absolute; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%; background: var(--accent, #2563eb); box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent, #2563eb) 25%, transparent); display: none; }
  .gz-dot::after { content: ''; position: absolute; left: 10px; top: 10px; width: 6px; height: 6px; border-radius: 50%; background: #fff; }
  .gz-dot.gz-hold { animation: gz-shrink 1.1s linear forwards; }
  @keyframes gz-shrink { from { transform: scale(1.5); } to { transform: scale(0.8); } }
  .gz-cal .gz-hit { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid var(--accent, #2563eb); background: color-mix(in srgb, var(--accent, #2563eb) 20%, transparent); }
  .gz-cal .gz-aim { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: var(--muted, #6b6b6b); opacity: .6; }
  .gz-cal .gz-aim b { position: absolute; left: 18px; top: -4px; font-size: 13px; white-space: nowrap; color: var(--ink, var(--fg, #1b1b1b)); }
  .gz-cal .gz-line { position: absolute; height: 2px; background: var(--muted, #6b6b6b); opacity: .5; transform-origin: 0 50%; }
  .gz-cal table { border-collapse: collapse; margin: 8px auto; font-size: 14px; }
  .gz-cal td, .gz-cal th { padding: 2px 10px; text-align: left; }
  .gz-cal th { font-weight: 600; color: var(--muted, #6b6b6b); }
  `;

  let root = null, msg = null, dot = null;
  function ensure() {
    if (root) return;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
    root = Object.assign(document.createElement('div'), { className: 'gz-cal', hidden: true });
    msg = Object.assign(document.createElement('div'), { className: 'gz-msg' });
    dot = Object.assign(document.createElement('div'), { className: 'gz-dot' });
    root.append(msg, dot);
    document.body.appendChild(root);
  }
  const show = () => { ensure(); root.hidden = false; };
  const clearMarks = () => { if (root) root.querySelectorAll('.gz-hit, .gz-aim, .gz-line').forEach(n => n.remove()); };
  const hide = () => { if (root) { root.hidden = true; dot.style.display = 'none'; clearMarks(); } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Needs a click to have just happened; waits for the resize so the dots land on the fullscreen layout
  async function goFullscreen() {
    if (document.fullscreenElement) return;
    try { await document.documentElement.requestFullscreen(); await sleep(500); } catch (e) {}
  }

  // Resolves with 'click', 'escape', or one of the extra keys (lowercase); Space and Enter count as a click
  function waitInput(extra = []) {
    return new Promise(r => {
      const done = v => { root.removeEventListener('click', h); removeEventListener('keydown', h); r(v); };
      const h = e => {
        if (e.type === 'click') return done('click');
        const k = e.key.toLowerCase();
        if (k === 'escape') { e.preventDefault(); return done('escape'); }
        if (k === ' ' || k === 'enter') { e.preventDefault(); return done('click'); }
        if (extra.includes(k)) { e.preventDefault(); return done(k); }
      };
      root.addEventListener('click', h);
      addEventListener('keydown', h);
    });
  }

  function setMsg(html, corner) {
    msg.className = 'gz-msg' + (corner ? ' gz-corner' : '');
    msg.innerHTML = html;
  }

  async function prompt(html, extra = []) {
    show();
    setMsg(html, false);
    return waitInput(extra);
  }

  function gridPoints(nx, ny, inset = 0.07) {
    const W = innerWidth, H = innerHeight, pts = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push({ x: W * (inset + (1 - 2 * inset) * i / (nx - 1)), y: H * (inset + (1 - 2 * inset) * j / (ny - 1)) });
    return pts;
  }

  // One dot: show it, wait for the click, collect samples for `hold` ms. Returns the sample count, or -1 on Escape.
  async function showDot(gaze, p, collect, { hold = 1100, moving = false } = {}) {
    dot.style.left = p.x + 'px'; dot.style.top = p.y + 'px';
    dot.style.display = 'block'; dot.classList.remove('gz-hold');
    if (await waitInput() === 'escape') { dot.style.display = 'none'; return -1; }
    dot.style.animationDuration = hold + 'ms';
    dot.classList.add('gz-hold');
    gaze.collect(p.x, p.y, { moving });
    await sleep(hold);
    const n = collect();
    dot.style.display = 'none';
    await sleep(250);
    return n;
  }

  // The pursuit sweep: a 3:2 Lissajous figure covering most of the screen, eased in from the
  // centre. Returns the frames collected, or -1 on Escape.
  function pursuit(gaze, ms) {
    return new Promise(resolve => {
      const W = innerWidth, H = innerHeight, ax = W * 0.42, ay = H * 0.40;
      setMsg('Follow the dot…', true);
      dot.classList.remove('gz-hold');
      dot.style.display = 'block';
      dot.style.left = W / 2 + 'px'; dot.style.top = H / 2 + 'px';
      let stop = false;
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); stop = true; } };
      addEventListener('keydown', onKey);
      const t0 = performance.now();
      gaze.collect(W / 2, H / 2, { pursuit: true });
      // animation frames stop when the page is hidden behind another window; a timer carries on
      const next = cb => document.hidden ? setTimeout(cb, 16) : requestAnimationFrame(cb);
      const step = () => {
        const now = performance.now(), u = (now - t0) / ms;
        if (stop || u >= 1) {
          removeEventListener('keydown', onKey);
          dot.style.display = 'none';
          const n = stop ? (gaze.collecting = null, -1) : gaze.stopCollecting();
          return resolve(n);
        }
        const ease = Math.min(1, u * 4);                 // grow out from the centre over the first quarter
        const ph = u * ms / 1000 * 2 * Math.PI;
        const x = W / 2 + ax * ease * Math.sin(3 * ph / 4.2), y = H / 2 + ay * ease * Math.sin(2 * ph / 4.2 + Math.PI / 3);
        dot.style.left = x + 'px'; dot.style.top = y + 'px';
        gaze.pursuitAt(x, y, now);
        next(step);
      };
      next(step);
    });
  }

  // One centre dot to re-centre the model after shifting in the chair: about two seconds.
  // Returns the correction applied in px, or null if cancelled.
  async function quickFix(gaze) {
    if (!gaze.model) return null;
    show();
    setMsg('<p><b>Quick fix</b></p><p>Sit as you are now, look at the dot and click it.</p><p class="gz-muted">Esc cancels.</p>', false);
    await sleep(50);
    const p = { x: innerWidth / 2, y: innerHeight / 2 };
    let fix = null;
    const n = await showDot(gaze, p, () => { fix = gaze.rebias(); return 9; });
    hide();
    return n < 0 ? null : fix;
  }

  const when = ms => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  async function calibrate(gaze, { reusable = null, fullscreen = true } = {}) {
    show();
    // the last calibration, from the caller or from the copy every page shares in this browser
    let offer = reusable && reusable.wx ? reusable : null;
    if (!offer) try { const m = JSON.parse(localStorage.getItem(SHARED_KEY)); if (m && m.wx) offer = m; } catch (e) {}
    const k = await prompt('<p><b>Calibration</b></p>' +
      (offer ? '<p><b>Press U</b> to reuse the calibration from ' + when(offer.at) + ' (error ' + Math.round(offer.error || 0) + ' px). One dot then re-centres it for how you are sitting now: about three seconds.</p><p><b>Click</b> to calibrate afresh: ' : '<p>Click to begin. ') +
      'a dot will appear; look at its centre, click it (or press Space) and keep looking until it disappears. Keep your head where it will be while you write.</p>' +
      '<p class="gz-muted">Esc cancels.</p>', offer ? ['u'] : []);
    if (k === 'escape') { hide(); return null; }
    if (fullscreen) await goFullscreen();
    if (k === 'u' && offer) {
      if (offer.w === innerWidth && offer.h === innerHeight && gaze.importModel(offer)) {
        setMsg('<p><b>Re-centring</b></p><p>Sit as you are now, look at the dot and click it.</p>', false);
        await sleep(50);
        const n = await showDot(gaze, { x: innerWidth / 2, y: innerHeight / 2 }, () => { gaze.rebias(); return 9; });
        if (n < 0) { hide(); return null; }
        remember(gaze);
        hide();
        return Math.round(offer.error || 0);
      }
      setMsg('<p>The window is a different size from last time, so a fresh calibration is needed.</p>', false);
      await sleep(1500);
    }
    gaze.resetCalibration();
    const pts = gridPoints(4, 4);
    for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
    for (let i = 0; i < pts.length; i++) {
      setMsg('Dot ' + (i + 1) + ' of ' + pts.length, true);
      // the top and bottom rows are where the fit is weakest (the lids get in the way), so they
      // are held longer and give the fit more frames
      const edgeRow = pts[i].y < innerHeight * 0.2 || pts[i].y > innerHeight * 0.8;
      const n = await showDot(gaze, pts[i], () => gaze.stopCollecting(), { hold: edgeRow ? 1600 : 1100 });
      if (n < 0) { hide(); return null; }
      if (n < 5) { setMsg('Lost your face on that one, again…', true); await sleep(700); i--; }
    }
    // Smooth pursuit: a dot that glides around the screen for a dozen seconds, so the fit sees the
    // eyes at hundreds of positions between the grid points rather than sixteen. Each frame is
    // paired with where the dot was a tenth of a second earlier, since the eye trails it.
    {
      const k = await prompt('<p><b>Now follow the dot</b></p><p>It will glide around the screen for about twelve seconds. Keep your eyes on it the whole way, head still.</p><p class="gz-muted">Click when ready.</p>');
      if (k === 'escape') { hide(); return null; }
      const n = await pursuit(gaze, 12000);
      if (n < 0) { hide(); return null; }
      if (n < 60) { setMsg('Lost your face for most of that; carrying on with the dots alone', true); await sleep(1200); }
    }
    // Head movement: the same dot looked at while the head drifts about, so the fit learns how a
    // moved or turned head changes what the eyes have to do. Without this, any shift in the chair
    // throws the prediction off.
    const movers = [[0.5, 0.5], [0.2, 0.25], [0.8, 0.75]].map(([a, b]) => ({ x: innerWidth * a, y: innerHeight * b }));
    for (let i = 0; i < movers.length; i++) {
      const k = await prompt('<p><b>Now with your head moving</b> (' + (i + 1) + ' of ' + movers.length + ')</p><p>Keep your eyes on the next dot while you slowly move your head: a little left and right, up and down, then closer to the screen and back. About five seconds.</p><p class="gz-muted">Click when ready.</p>');
      if (k === 'escape') { hide(); return null; }
      setMsg('Keep looking at the dot and move your head gently…', true);
      const n = await showDot(gaze, movers[i], () => gaze.stopCollecting(), { hold: 5000, moving: true });
      if (n < 0) { hide(); return null; }
    }
    setMsg('Fitting…', true);
    let fit;
    try { fit = gaze.fit(); } catch (e) { setMsg('<p>' + e.message + '</p>', false); await sleep(1500); hide(); return null; }
    // check dots between the grid points: two on the top row, one in the middle, two on the bottom,
    // so the verdict can say where the fit is weak
    const checks = CHECKS.map(([a, b]) => ({ x: innerWidth * a, y: innerHeight * b }));
    const errs = [];
    for (let i = 0; i < checks.length; i++) {
      setMsg('Check ' + (i + 1) + ' of ' + checks.length + ' — same again', true);
      const n = await showDot(gaze, checks[i], () => { const e = gaze.validate(); if (e) errs.push(e); return 9; });
      if (n < 0) { hide(); return null; }
    }
    // the check dots pick the local correction: with it, per eye, or the plain fit
    const pick = gaze.chooseCorrection();
    const scored = pick ? pick.checks : errs;
    const avg = k => Math.round(scored.reduce((a, b) => a + b[k], 0) / scored.length);
    const e = scored.length ? avg('steady') : fit.error, frame = scored.length ? avg('frame') : e;
    gaze.model.error = e;
    const lineH = 28, lines = Math.round(innerHeight / lineH);
    const verdict = e < 80 ? 'Good: about ' + Math.max(1, Math.round(e / lineH)) + ' lines of text when you hold a look.' : e < 150 ? 'Usable: a look lands within ' + Math.round(e / lineH) + ' lines or so, and your typing position sorts out which sentence.' : 'Rough: lighting, glasses glare or a moving head make this hard. Try again with the room lit from the front, and sit still through the dots.';
    const rows = byRow(scored);
    const rowLine = rows.length ? '<p class="gz-muted">By row: ' + rows.map(r => r.name + ' ' + r.error + ' px').join(' · ') + (rows.some(r => r.error > e * 1.6 && r.error > 100) ? ' — the weak row is where looks will land a line or two out' : '') + '</p>' : '';
    const pickLine = pick ? '<p class="gz-muted">' + ({ none: 'The plain fit did best on the check dots; no local correction', both: 'Local correction from both eyes together', eyes: 'Local correction fitted per eye' })[pick.chosen] +
      ' (' + Object.keys(pick.errors).map(k => ({ none: 'none', both: 'both', eyes: 'per eye' })[k] + ' ' + pick.errors[k]).join(', ') + ' px).' + (fit.headFit ? '' : ' Head movement did not help the fit and was left out.') + '</p>' : '';
    const again = await prompt('<p><b>Error when holding a look: ' + e + ' px</b> <span class="gz-muted">(' + frame + ' px frame to frame; the screen is ' + lines + ' lines tall)</span></p><p>' + verdict + '</p>' + rowLine + pickLine +
      '<p class="gz-muted">Click to continue, press T to test the accuracy on five targets, R to redo, or Esc to cancel.</p>', ['r', 't']);
    if (again === 'escape') { hide(); return null; }
    if (again === 'r') return calibrate(gaze, { reusable: null, fullscreen });
    remember(gaze);
    if (again === 't') {
      const t = await accuracyTest(gaze, { keepOpen: true });
      if (t === null) { hide(); return null; }
      if (t && t.redo) return calibrate(gaze, { reusable: null, fullscreen });
    }
    hide();
    return e;
  }

  const CHECKS = [[0.3, 0.14], [0.7, 0.14], [0.5, 0.5], [0.3, 0.86], [0.7, 0.86]];
  const rowName = y => y < innerHeight / 3 ? 'top' : y < innerHeight * 2 / 3 ? 'middle' : 'bottom';
  const colName = x => x < innerWidth / 3 ? 'left' : x < innerWidth * 2 / 3 ? 'centre' : 'right';
  // mean steady error per screen row (top, middle, bottom), in that order, for the rows that have a dot
  function byRow(list, key = rowName, order = ['top', 'middle', 'bottom']) {
    const by = new Map();
    list.forEach(c => { const k = key(key === rowName ? c.y : c.x); (by.get(k) || by.set(k, []).get(k)).push(c.steady); });
    return order.filter(k => by.has(k)).map(k => ({ name: k, error: Math.round(by.get(k).reduce((a, b) => a + b, 0) / by.get(k).length) }));
  }

  // The accuracy test: five targets across the screen, the user looks at and clicks each, and the
  // result shows where the prediction landed against each target and the error per row and column.
  // Returns { targets: [{ x, y, px, py, steady, frame }], rows, cols, error }, { redo: true } if the
  // user asked to recalibrate, or null if cancelled or there is no model.
  async function accuracyTest(gaze, { keepOpen = false, fullscreen = true } = {}) {
    if (!gaze.model) return null;
    show();
    const k = await prompt('<p><b>Accuracy test</b></p><p>Five targets, one at a time: look at the centre, click it (or press Space) and keep looking until it disappears. The result shows how far off each one landed.</p><p class="gz-muted">Esc cancels.</p>');
    if (k === 'escape') { if (!keepOpen) hide(); return null; }
    if (fullscreen) await goFullscreen();
    const targets = [[0.15, 0.12], [0.85, 0.12], [0.5, 0.5], [0.15, 0.88], [0.85, 0.88]].map(([a, b]) => ({ x: innerWidth * a, y: innerHeight * b }));
    const got = [];
    for (let i = 0; i < targets.length; i++) {
      setMsg('Target ' + (i + 1) + ' of ' + targets.length, true);
      const n = await showDot(gaze, targets[i], () => { const m = gaze.measure(); if (m) got.push(m); return m ? 9 : 0; }, { hold: 1200 });
      if (n < 0) { if (!keepOpen) hide(); return null; }
      if (n < 5) { setMsg('Lost your face on that one, again…', true); await sleep(700); i--; }
    }
    // draw each target, where the look landed and a line between them
    clearMarks();
    got.forEach((m, i) => {
      const aim = Object.assign(document.createElement('div'), { className: 'gz-aim' });
      aim.style.left = m.x + 'px'; aim.style.top = m.y + 'px';
      aim.append(Object.assign(document.createElement('b'), { textContent: m.steady + ' px' }));
      const hit = Object.assign(document.createElement('div'), { className: 'gz-hit' });
      hit.style.left = m.px + 'px'; hit.style.top = m.py + 'px';
      const line = Object.assign(document.createElement('div'), { className: 'gz-line' });
      line.style.left = m.x + 'px'; line.style.top = m.y + 'px';
      line.style.width = Math.hypot(m.px - m.x, m.py - m.y) + 'px';
      line.style.transform = 'rotate(' + Math.atan2(m.py - m.y, m.px - m.x) + 'rad)';
      root.append(line, aim, hit);
    });
    const error = Math.round(got.reduce((s, m) => s + m.steady, 0) / got.length);
    const rows = byRow(got), cols = byRow(got, colName, ['left', 'centre', 'right']);
    const lineH = 28;
    const table = '<table><tr><th></th>' + rows.map(r => '<th>' + r.name + '</th>').join('') + '</tr><tr><td>by row</td>' + rows.map(r => '<td>' + r.error + ' px</td>').join('') + '</tr></table>' +
      '<table><tr><th></th>' + cols.map(c => '<th>' + c.name + '</th>').join('') + '</tr><tr><td>by column</td>' + cols.map(c => '<td>' + c.error + ' px</td>').join('') + '</tr></table>';
    const worst = [...got].sort((a, b) => b.steady - a.steady)[0];
    const note = error < 80 ? 'Good: a held look lands within about ' + Math.max(1, Math.round(error / lineH)) + ' lines.' : error < 150 ? 'Usable: within ' + Math.round(error / lineH) + ' lines or so.' : 'Rough: recalibrate with the room lit from the front, sitting still.';
    const r = await prompt('<p><b>Average miss: ' + error + ' px</b> <span class="gz-muted">(grey = target, blue = where the look landed)</span></p>' + table +
      '<p>' + note + (worst && worst.steady > error * 1.6 && worst.steady > 100 ? ' The ' + rowName(worst.y) + ' ' + colName(worst.x) + ' target was the worst at ' + worst.steady + ' px.' : '') + '</p>' +
      '<p class="gz-muted">Click to continue, press R to recalibrate, or Esc to cancel.</p>', ['r']);
    clearMarks();
    if (r === 'escape') { if (!keepOpen) hide(); return null; }
    if (r === 'r') { if (!keepOpen) hide(); return { redo: true }; }
    if (!keepOpen) hide();
    return { targets: got, rows, cols, error };
  }

  // One copy of the calibration for every page on this site, so the standalone page and
  // EasyEssay's writeout mode offer each other's last fit
  const SHARED_KEY = 'easyessay-gaze-model';
  function remember(gaze) {
    try { const m = gaze.exportModel(); if (m) localStorage.setItem(SHARED_KEY, JSON.stringify(m)); } catch (e) {}
  }

  window.GazeCalibrate = { calibrate, accuracyTest, pursuit, quickFix, prompt, show, hide, goFullscreen, sleep };
})();
