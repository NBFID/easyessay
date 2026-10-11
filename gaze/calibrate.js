// GazeCalibrate: the calibration overlay, shared by gaze/index.html and EasyEssay's writeout mode.
//
// Plain script, no markup needed: it adds its own full-screen overlay and styles to the page on
// first use. Colours follow the page's --bg / --ink (or --fg) / --accent / --muted variables.
//
//   const err = await GazeCalibrate.calibrate(gaze, { reusable: savedModel });
//     → average check error in px, or null if the user pressed Escape or the fit failed
//   await GazeCalibrate.prompt(html)   // a message on the overlay; resolves on click, Space or Enter
//   GazeCalibrate.hide()
//
// Sixteen dots fit the model, four more check it. The user looks at each dot, clicks it (or presses
// Space) and keeps looking for a second. With `reusable` (a model from gaze.exportModel()), the
// opening message offers U to reuse it instead, which only works while the window is the same size.

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
  const hide = () => { if (root) { root.hidden = true; dot.style.display = 'none'; } };
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
    const offer = reusable && reusable.wx ? reusable : null;
    const k = await prompt('<p><b>Calibration</b></p><p>A dot will appear. Look at its centre, click it (or press Space) and keep looking until it disappears. Keep your head where it will be while you write.</p>' +
      '<p class="gz-muted">Click anywhere to begin' + (offer ? ', or press U to use the last calibration (from ' + when(offer.at) + ', error ' + Math.round(offer.error || 0) + ' px)' : '') + '. Esc cancels.</p>', offer ? ['u'] : []);
    if (k === 'escape') { hide(); return null; }
    if (fullscreen) await goFullscreen();
    if (k === 'u' && offer) {
      if (offer.w === innerWidth && offer.h === innerHeight && gaze.importModel(offer)) { hide(); return Math.round(offer.error || 0); }
      setMsg('<p>The window is a different size from last time, so a fresh calibration is needed.</p>', false);
      await sleep(1500);
    }
    gaze.resetCalibration();
    const pts = gridPoints(4, 4);
    for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
    for (let i = 0; i < pts.length; i++) {
      setMsg('Dot ' + (i + 1) + ' of ' + pts.length, true);
      const n = await showDot(gaze, pts[i], () => gaze.stopCollecting());
      if (n < 0) { hide(); return null; }
      if (n < 5) { setMsg('Lost your face on that one, again…', true); await sleep(700); i--; }
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
    // check dots between the grid points
    const checks = [[0.28, 0.3], [0.72, 0.3], [0.5, 0.55], [0.3, 0.8]].map(([a, b]) => ({ x: innerWidth * a, y: innerHeight * b }));
    const errs = [];
    for (let i = 0; i < checks.length; i++) {
      setMsg('Check ' + (i + 1) + ' of ' + checks.length + ' — same again', true);
      const n = await showDot(gaze, checks[i], () => { const e = gaze.validate(); if (e) errs.push(e); return 9; });
      if (n < 0) { hide(); return null; }
    }
    const avg = k => Math.round(errs.reduce((a, b) => a + b[k], 0) / errs.length);
    const e = errs.length ? avg('steady') : fit.error, frame = errs.length ? avg('frame') : e;
    gaze.model.error = e;
    const lineH = 28, lines = Math.round(innerHeight / lineH);
    const verdict = e < 80 ? 'Good: about ' + Math.max(1, Math.round(e / lineH)) + ' lines of text when you hold a look.' : e < 150 ? 'Usable: a look lands within ' + Math.round(e / lineH) + ' lines or so, and your typing position sorts out which sentence.' : 'Rough: lighting, glasses glare or a moving head make this hard. Try again with the room lit from the front, and sit still through the dots.';
    const again = await prompt('<p><b>Error when holding a look: ' + e + ' px</b> <span class="gz-muted">(' + frame + ' px frame to frame; the screen is ' + lines + ' lines tall)</span></p><p>' + verdict + '</p><p class="gz-muted">Click to continue, press R to redo, or Esc to cancel.</p>', ['r']);
    if (again === 'escape') { hide(); return null; }
    if (again === 'r') return calibrate(gaze, { reusable: null, fullscreen });
    hide();
    return e;
  }

  window.GazeCalibrate = { calibrate, quickFix, prompt, show, hide, goFullscreen, sleep };
})();
