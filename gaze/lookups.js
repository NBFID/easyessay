// LookupMapper: turns a stream of gaze samples into "which sentence did I just look up".
//
// Webcam gaze is only good to a few lines, so it is fused with where you are up to in the essay:
// each gaze frame inside the reference panel scores every sentence by how close its text sits to
// the gaze point, times a prior that favours the sentence you are writing and the ones just after
// it. The best sentence collects that frame's dwell time. A "look" is one visit to the panel
// (gaze arrives, stays a while, leaves), and each sentence read during it gets a lookup.
//
//   const map = new LookupMapper({ panel, sentences, onLook, errorPx: gaze.model.error });
//   map.setCursor(sentenceIndex)   // from the typed text (see cursorFromTyping) or null if writing on paper
//   map.onGaze(sample)             // from GazeTracker
//   map.stats()                    // [{ s, time, looks, tier, words, phrases }]
//   map.undoLast() / map.resetAll() / map.setPaused(true) / map.paint()
//
// sentences: [{ el, s, p, text }] where el is the span holding sentence s of paragraph p.

(() => {
  // Tuning, exposed as LookupMapper.TUNE so a test can sweep it (see test/noise.js)
  const TUNE = {
    SIGMA_X: 160,   // px: horizontal gaze error is forgiven generously (sentences wrap anyway)
    SIGMA_Y: 50,    // px: vertical error, about two lines; a mapper built with errorPx scales it to the calibration
    PANEL_PAD: 24,  // px: once reading, gaze this far outside the panel still counts as being in it
    LEAVE_MS: 900,  // gaze off the panel (or not settled) for this long ends a look
    HOLD_MS: 600,   // default: the gaze has to settle in one place this long before it counts
    ENTER_MS: 120,  // gaze must stay on the panel this long before it counts as reading
    SWITCH_MS: 300, // a different sentence must win for this long before the highlight moves
    MIN_LOOK: 300,  // ms of dwell on a sentence within one look before it counts as a lookup
    PRIOR_SD: 4.0,  // sentences: how far from the cursor a lookup is still expected
    STICK: 0.6,     // score margin a different sentence must win by before it takes the highlight
    STICK_AFTER: 400, // ms a highlight has to have held before that margin protects it
  };

  const normalise = s => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

  // Split into paragraphs and sentences. A full stop after an abbreviation ("e.g.", "Mr.", an
  // initial) or before a lowercase word does not end a sentence; closing quotes stay attached.
  const ABBR = /^(?:[A-HJ-Za-z]|e\.g|i\.e|etc|vs|cf|Mr|Mrs|Ms|Dr|St|No|p|pp|l|ll|ch|vol|fig|approx)$/;
  function splitSentences(para) {
    const out = [];
    let start = 0, m;
    const re = /[.!?]+["'”’)\]]*(?=\s+|$)/g;
    while ((m = re.exec(para))) {
      const end = m.index + m[0].length;
      if (m[0] === '.') {   // a bare full stop: a closing quote or "?!" after it always ends the sentence
        const lastWord = (para.slice(start, m.index).match(/(\S+)$/) || ['', ''])[1];
        const next = para.slice(end).match(/^\s+(\S)/);
        if (ABBR.test(lastWord) || (next && /\p{Ll}/u.test(next[1]))) continue;
      }
      const t = para.slice(start, end).trim();
      if (t) out.push(t);
      start = end;
    }
    const rest = para.slice(start).trim();
    if (rest) out.push(rest);
    return out;
  }

  function splitEssay(text) {
    const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    const out = [];
    let s = 0;
    paras.forEach((para, p) => {
      splitSentences(para).forEach(text => out.push({ s: s++, p, text, words: text.split(/\s+/).map(normalise).filter(Boolean) }));
    });
    return out;
  }

  // Which sentence the writer is up to, from what they have typed so far. The last few typed words
  // are matched against the essay near the previous position, so a skipped or reworded word
  // doesn't lose the place.
  function makeCursor(sentences) {
    const W = [];
    sentences.forEach(sn => sn.words.forEach(w => W.push({ w, s: sn.s })));
    let pos = -1;
    return function cursorFromTyping(typed) {
      const toks = typed.split(/\s+/).map(normalise).filter(Boolean);
      if (!toks.length) { pos = -1; return null; }
      const K = Math.min(5, toks.length);
      const tail = toks.slice(-K);
      // search near the last position, but as far as the typed length suggests (a paste jumps a long way)
      const lo = Math.max(0, pos - 25), hi = Math.min(W.length - K, Math.max(pos + 90, toks.length + 40));
      let best = -1, bestN = 0;
      for (let j = lo; j <= hi; j++) {
        let n = 0;
        for (let k = 0; k < K; k++) {
          const w = W[j + k].w;
          if (w === tail[k] || (w.length > 4 && tail[k].length > 4 && (w.startsWith(tail[k]) || tail[k].startsWith(w)))) n++;
        }
        // ties (a phrase the essay repeats) go to the candidate nearest where the writer should be
        const expect = pos >= 0 ? pos : toks.length - 1;
        if (n > bestN || (n === bestN && n && Math.abs(j - expect) < Math.abs(best - expect))) { bestN = n; best = j; }
      }
      const need = K <= 2 ? K : Math.ceil(K * 0.6);
      if (bestN >= need) pos = best + K - 1;
      else if (pos < 0 && toks.length < 3) pos = 0;
      return pos >= 0 ? W[Math.min(pos, W.length - 1)].s : null;
    };
  }

  class LookupMapper {
    // ring: the gaze highlight is an ellipse rx wide and ry tall (half-axes, px); ringR makes it a circle.
    // sentenceTint: also underline whole sentences by tier (the report wants it, the live reference not)
    constructor({ panel, sentences, onLook, onCurrent, onRing, holdMs = TUNE.HOLD_MS, ringR = null, ring = null, inset = {}, errorPx = null, sentenceTint = false }) {
      this.panel = panel;
      this.sentences = sentences;
      this.setRing(ring || { rx: ringR || 45, ry: ringR || 45 });
      this.sentenceTint = sentenceTint;
      this.sentOf = new Map();   // word span → sentence index
      sentences.forEach((sn, i) => (sn.wordEls || []).forEach(w => this.sentOf.set(w, i)));
      // how far to trust the gaze vertically: the calibration's own error, within reason
      this.sigmaY = errorPx ? Math.min(90, Math.max(45, errorPx * 0.6)) : TUNE.SIGMA_Y;
      this.inset = inset;        // px per side (left/right/top/bottom) the gaze must be inside the panel to start a look:
                                 // set on the side that faces the writing, so a glance near that edge is not reading
      this.holdMs = holdMs;
      this.ringR = ringR;        // px: radius of the gaze ring; words inside it collect time
      this.onRing = onRing || (() => {});   // ({ x, y, r, hits }) while settled on the panel, null otherwise
      this.ringOn = false;
      this.wordTime = new Map(); // word span → ms under the ring
      this.paused = false;
      this.settled = false;      // true while the gaze has dwelt in one place for holdMs
      this.onLook = onLook || (() => {});
      this.onCurrent = onCurrent || (() => {});
      this.cursor = null;        // sentence index being written, or null when writing on paper
      this.progress = -1;        // last sentence looked up: the paper-mode stand-in for the cursor
      this.time = sentences.map(() => 0);
      this.looks = sentences.map(() => 0);
      this.log = [];             // [{ t, dur, s: [sentence indices] }]
      this.look = null;          // { start, last, dwell: Map }
      this.rects = null;
      this.lastT = null;
      this.current = -1;
      this.started = performance.now();
      this.inPanelMs = 0;
      const invalidate = () => { this.rects = null; };
      addEventListener('resize', invalidate);
      addEventListener('scroll', invalidate, { passive: true });   // the panel may sit in a page that scrolls
      panel.addEventListener('scroll', invalidate, { passive: true });
      this._invalidate = invalidate;
    }

    setCursor(s) { this.cursor = s; }

    _measure() {
      this.rects = this.sentences.map(sn => Array.from(sn.el.getClientRects(), r => ({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom })));
      this.panelRect = this.panel.getBoundingClientRect();
    }

    // Closest point of any line box of the sentence to the gaze, as (dx, dy)
    _gap(rects, x, y) {
      let best = Infinity, bdx = 0, bdy = 0;
      for (const r of rects) {
        const dx = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0;
        const dy = y < r.y0 ? r.y0 - y : y > r.y1 ? y - r.y1 : 0;
        const sy = this.sigmaY || TUNE.SIGMA_Y;
        const d = dx * dx / (TUNE.SIGMA_X * TUNE.SIGMA_X) + dy * dy / (sy * sy);
        if (d < best) { best = d; bdx = dx; bdy = dy; }
      }
      return { d: best, dx: bdx, dy: bdy };
    }

    onGaze(sample) {
      const t = sample.t;
      const dt = this.lastT == null ? 0 : Math.min(100, t - this.lastT);
      this.lastT = t;
      if (this.paused) { this._leave(t, true); return -1; }
      if (!this.rects) this._measure();
      const pr = this.panelRect;
      // hysteresis: the gaze has to land well inside the panel to start counting, and only stops
      // once it is clearly outside, so hovering near the edge between panel and page does nothing
      const reading = this.enteredAt != null, ins = this.inset;
      const edge = side => reading ? TUNE.PANEL_PAD : -(ins[side] || 0);
      const inPanel = sample.x != null && !sample.away && !sample.edge && sample.x >= pr.left - edge('left') && sample.x <= pr.right + edge('right') && sample.y >= pr.top - edge('top') && sample.y <= pr.bottom + edge('bottom');

      if (!inPanel) { this._leave(t, false); return -1; }
      // a brief pass through the panel (a saccade on the way elsewhere) is not reading, and
      // nothing counts until the gaze has settled in one place for the hold time
      if (this.enteredAt == null) this.enteredAt = t;
      this.settled = !!(sample.region && sample.region.dur >= this.holdMs);
      if (t - this.enteredAt < TUNE.ENTER_MS || !this.settled) {
        if (this.current !== -1 && !this.settled) { this.current = -1; this.candidate = -1; this.onCurrent(-1); }
        if (this.ringOn) { this.ringOn = false; this.onRing(null); }
        return this.current;
      }
      this.inPanelMs += dt;
      // the ring sits on the dwell centroid: steadier than the raw point, and what the user sees
      const x = sample.region.x, y = sample.region.y;
      const anchor = this.cursor != null ? this.cursor : this.progress;
      let best = -1, bestScore = -Infinity, curScore = -Infinity;
      for (let i = 0; i < this.sentences.length; i++) {
        const rects = this.rects[i];
        if (!rects.length) continue;
        const g = this._gap(rects, x, y);
        if (g.d > 9) continue;   // more than three sigmas away
        let score = -g.d / 2;
        if (anchor >= 0) {
          const off = i - anchor - 0.5;         // centred between the sentence being written and the next
          score -= (off * off) / (2 * TUNE.PRIOR_SD * TUNE.PRIOR_SD);
        }
        if (i === this.current) curScore = score;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      // the sentence already highlighted keeps it unless another wins by a clear margin; a highlight
      // only just set gets no such protection, since it may have landed on the way to the real one
      if (best !== this.current && curScore > -Infinity && t - (this.currentAt || 0) >= TUNE.STICK_AFTER && bestScore - curScore < TUNE.STICK) best = this.current;
      if (best < 0) { if (this.ringOn) { this.ringOn = false; this.onRing(null); } return -1; }
      if (!this.look) this.look = { start: t, last: t, dwell: new Map(), words: new Map() };
      const lk = this.look;
      lk.last = t;
      lk.dwell.set(best, (lk.dwell.get(best) || 0) + dt);
      this.time[best] += dt;
      // the words under the ring collect time too: that is the phrase-level "gap"
      // words at the centre of the ring earn full time, words at its rim only a fifth, so the
      // phrase actually being read pulls ahead of its neighbours on the lines above and below
      const { rx, ry } = this.ring;
      const hits = wordsInEllipse(this.sentences, x, y, rx, ry);
      for (const w of hits) {
        const b = w.getBoundingClientRect();
        const d2 = (((b.left + b.right) / 2 - x) / rx) ** 2 + (((b.top + b.bottom) / 2 - y) / ry) ** 2;   // 1 at the rim
        const share = dt * Math.exp(-1.6 * d2);
        lk.words.set(w, (lk.words.get(w) || 0) + share);
        this.wordTime.set(w, (this.wordTime.get(w) || 0) + share);
      }
      this.ringOn = true;
      this.onRing({ x, y, rx, ry, r: Math.max(rx, ry), hits });
      // the highlight only moves once a different sentence has won for a while
      if (best === this.current) this.candidate = -1;
      else if (best !== this.candidate) { this.candidate = best; this.candidateAt = t; }
      else if (t - this.candidateAt >= TUNE.SWITCH_MS || this.current === -1) { this.current = best; this.currentAt = t; this.candidate = -1; this.onCurrent(best); }
      return this.current === -1 ? best : this.current;
    }

    // Gaze is off the panel (or tracking is paused): end the look once it has been away long enough
    _leave(t, now) {
      this.enteredAt = null;
      if (this.look && (now || t - this.look.last > TUNE.LEAVE_MS)) this._endLook(t);
      if (this.current !== -1) { this.current = -1; this.candidate = -1; this.onCurrent(-1); }
      if (this.ringOn) { this.ringOn = false; this.onRing(null); }
    }

    _endLook(t) {
      const lk = this.look;
      this.look = null;
      const read = [...lk.dwell].filter(([, ms]) => ms >= TUNE.MIN_LOOK).map(([s]) => s).sort((a, b) => a - b);
      if (!read.length) { this._subtract(lk); return; }   // too brief to be a lookup: do not let it tint anything
      read.forEach(s => { this.looks[s]++; });
      if (this.cursor == null) this.progress = Math.max(this.progress, read[read.length - 1]);
      const entry = { t: Math.round(lk.start - this.started), dur: Math.round(lk.last - lk.start), s: read, dwell: lk.dwell, words: lk.words };
      this.log.push(entry);
      this.onLook(entry);
    }

    _subtract(lk) {
      lk.dwell.forEach((ms, s) => { this.time[s] = Math.max(0, this.time[s] - ms); this.inPanelMs = Math.max(0, this.inPanelMs - ms); });
      lk.words.forEach((ms, w) => { const left = (this.wordTime.get(w) || 0) - ms; left > 0 ? this.wordTime.set(w, left) : this.wordTime.delete(w); });
    }

    // Take back the look in progress, or failing that the last logged one. Returns what was undone or null.
    undoLast() {
      if (this.look && this.look.dwell.size) {
        const lk = this.look;
        this.look = null;
        this._subtract(lk);
        this.onLook(null);
        return { s: [...lk.dwell.keys()] };
      }
      const entry = this.log.pop();
      if (!entry) return null;
      entry.s.forEach(s => { this.looks[s] = Math.max(0, this.looks[s] - 1); });
      this._subtract(entry);
      this.onLook(null);
      return entry;
    }

    resetAll() {
      this.look = null;
      this.log = [];
      this.time = this.sentences.map(() => 0);
      this.looks = this.sentences.map(() => 0);
      this.wordTime = new Map();
      this.inPanelMs = 0;
      this.progress = -1;
      this.onLook(null);
    }

    setPaused(p) {
      this.paused = !!p;
      if (this.paused) this._leave(this.lastT || 0, true);
    }

    finish() { if (this.look) this._endLook(this.look.last + TUNE.LEAVE_MS); }

    // 0 = never read, 1 = glanced (yellow), 2 = looked (orange), 3 = stared or kept coming back (red)
    static tier(ms, looks = 0) {
      if (looks >= 3 || ms >= 4000) return 3;
      if (looks >= 2 || ms >= 1500) return 2;
      if (looks >= 1 || ms >= 350) return 1;
      return 0;
    }

    // Per sentence: dwell, lookups, tier, per-word dwell and the phrases (runs of words) that were read
    stats() {
      return this.sentences.map((sn, i) => {
        const words = (sn.wordEls || []).map(w => Math.round(this.wordTime.get(w) || 0));
        const phrases = [];
        let run = null;
        words.forEach((ms, k) => {
          if (ms >= 300) { if (!run) run = { from: k, to: k, ms: 0 }; run.to = k; run.ms = Math.max(run.ms, ms); }
          else if (run) { phrases.push(run); run = null; }
        });
        if (run) phrases.push(run);
        const toks = sn.text.split(/\s+/);
        return { s: i, p: sn.p, text: sn.text, time: Math.round(this.time[i]), looks: this.looks[i], tier: LookupMapper.tier(this.time[i], this.looks[i]), words,
          phrases: phrases.map(r => ({ text: toks.slice(r.from, r.to + 1).join(' '), ms: r.ms, from: r.from, to: r.to })) };
      });
    }

    // Apply the tier classes (h1/h2/h3) to every word span (and sentence, with sentenceTint), for
    // the live reference and the report
    paint() {
      this.sentences.forEach((sn, i) => {
        const st = this.sentenceTint ? LookupMapper.tier(this.time[i], this.looks[i]) : 0;
        sn.el.classList.remove('h1', 'h2', 'h3');
        if (st) sn.el.classList.add('h' + st);
        (sn.wordEls || []).forEach(w => {
          const wt = LookupMapper.tier(this.wordTime.get(w) || 0);
          w.classList.remove('h1', 'h2', 'h3');
          if (wt) w.classList.add('h' + wt);
        });
      });
    }

    setRing(ring) { this.ring = { rx: Math.max(10, ring.rx), ry: Math.max(8, ring.ry) }; }

    // The tier a word span shows now (0 to 3)
    tierOf(w) { return LookupMapper.tier(this.wordTime.get(w) || 0); }

    // Mark words by hand: tier 1 to 3 gives them at least that colour (and their sentence a
    // lookup), 0 clears them. The time is the lowest that shows the tier, so the report ranks a
    // hand mark like a look of that strength.
    mark(wordEls, tier) {
      const ms = LookupMapper.TIER_MS[tier] || 0;
      const touched = new Set();
      wordEls.forEach(w => {
        if (!tier) this.wordTime.delete(w);
        else this.wordTime.set(w, Math.max(this.wordTime.get(w) || 0, ms));
        const s = this.sentOf.get(w);
        if (s != null) touched.add(s);
      });
      touched.forEach(s => {
        if (tier) { this.time[s] = Math.max(this.time[s], ms); this.looks[s] = Math.max(this.looks[s], 1); this.manual = true; }
        else {
          // nothing marked or read in the sentence any more: it was never looked up
          const any = (this.sentences[s].wordEls || []).some(w => this.wordTime.has(w));
          if (!any) { this.time[s] = 0; this.looks[s] = 0; }
        }
      });
      this.paint();
    }

    destroy() { removeEventListener('resize', this._invalidate); removeEventListener('scroll', this._invalidate); this.panel.removeEventListener('scroll', this._invalidate); }
  }

  // Render a sentence's text as word spans (so single words can light up) and remember them.
  // Returns the sentence span; sn.wordEls holds the words.
  function renderSentence(sn, el) {
    const span = el('span', { className: 'sent' });
    sn.wordEls = [];
    sn.text.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) return span.append(part);
      const w = el('span', { className: 'w', textContent: part });
      sn.wordEls.push(w);
      span.append(w);
    });
    sn.el = span;
    return span;
  }

  // The words whose boxes an ellipse (half-axes rx, ry) covers: what the page lights up inside the
  // gaze highlight. Only sentences whose own boxes come near it are inspected, so it stays cheap.
  function wordsInEllipse(sentences, cx, cy, rx, ry) {
    const hit = [];
    for (const sn of sentences) {
      if (!sn.wordEls) continue;
      let near = false;
      for (const b of sn.el.getClientRects()) if (cx + rx > b.left && cx - rx < b.right && cy + ry > b.top && cy - ry < b.bottom) { near = true; break; }
      if (!near) continue;
      for (const w of sn.wordEls) {
        const b = w.getBoundingClientRect();
        const dx = Math.max(b.left - cx, 0, cx - b.right) / rx, dy = Math.max(b.top - cy, 0, cy - b.bottom) / ry;
        if (dx * dx + dy * dy <= 1) hit.push(w);
      }
    }
    return hit;
  }
  const wordsInCircle = (sentences, cx, cy, r) => wordsInEllipse(sentences, cx, cy, r, r);

  // How wide a highlight of `words` words is, from the words as rendered: the average word box
  // plus a space, times the count. Returns { rx, ry } half-axes, ry being most of a line.
  function ringFor(sentences, words = 6) {
    let w = 0, n = 0, h = 0;
    for (const sn of sentences) for (const el of sn.wordEls || []) { const b = el.getBoundingClientRect(); if (!b.width) continue; w += b.width; h += b.height; n++; if (n >= 80) break; }
    const avgW = n ? w / n : 50, avgH = n ? h / n : 24;
    return { rx: (avgW + avgH * 0.3) * words / 2, ry: avgH * 0.85 };
  }

  /* ---- marking by hand ---- */

  // Click a word to raise its colour (yellow → orange → red → clear), drag across words or
  // right-click one for a picker with the three colours and clear; 1 2 3 set the colour of the
  // selection, 0 clears it, Esc closes the picker. Returns { destroy, open: bool }.
  // onChange fires after every mark; onBusy(true/false) while the picker is open, so the page can
  // keep the camera out of it.
  const PICK_CSS = `
  .gz-pick { position: fixed; z-index: 1003; display: flex; gap: 4px; padding: 4px; border-radius: 8px; background: var(--bg, #fff); border: 1px solid var(--line, #ddd); box-shadow: 0 4px 14px rgba(0,0,0,.18); font: 13px system-ui, sans-serif; }
  .gz-pick button { width: 30px; height: 26px; border: 1px solid var(--line, #ccc); border-radius: 6px; cursor: pointer; font: inherit; color: inherit; background: var(--bg, #fff); }
  .gz-pick button:hover { outline: 2px solid var(--accent, #2563eb); }
  .gz-pick .t1 { background: rgba(250, 204, 21, .5); } .gz-pick .t2 { background: rgba(255, 140, 0, .55); } .gz-pick .t3 { background: rgba(225, 45, 45, .6); }
  .gz-pick .t0 { width: auto; padding: 0 8px; }
  .gz-marking .w { cursor: pointer; }
  `;
  function attachMarking(mapper, panel, { onChange = () => {}, onBusy = () => {} } = {}) {
    if (!document.getElementById('gz-pick-css')) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'gz-pick-css', textContent: PICK_CSS }));
    panel.classList.add('gz-marking');
    const pick = document.createElement('div');
    pick.className = 'gz-pick';
    pick.hidden = true;
    pick.title = 'Mark the words: 1 yellow, 2 orange, 3 red, 0 clear';
    const mk = (cls, label, tier, title) => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.title = title; b.addEventListener('mousedown', e => e.preventDefault()); b.addEventListener('click', () => apply(tier)); pick.append(b); };
    mk('t1', '1', 1, 'Yellow: glanced (1)'); mk('t2', '2', 2, 'Orange: looked (2)'); mk('t3', '3', 3, 'Red: priority (3)'); mk('t0', 'clear', 0, 'Clear (0)');
    document.body.append(pick);
    let target = [];
    const wordAt = node => { const w = node && (node.nodeType === 3 ? node.parentElement : node); return w && w.closest ? w.closest('.w') : null; };
    const open = (words, x, y) => {
      target = words;
      if (!target.length) return close();
      pick.hidden = false;
      const r = pick.getBoundingClientRect();
      pick.style.left = Math.max(6, Math.min(innerWidth - r.width - 6, x - r.width / 2)) + 'px';
      pick.style.top = Math.max(6, (y - r.height - 12 < 6 ? y + 16 : y - r.height - 12)) + 'px';
      onBusy(true);
    };
    const close = () => { if (!pick.hidden) { pick.hidden = true; onBusy(false); } target = []; };
    const apply = tier => { if (target.length) { mapper.mark(target, tier); onChange(); } close(); const sel = getSelection(); if (sel) sel.removeAllRanges(); };
    // the word spans a selection touches
    const selectedWords = () => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
      const range = sel.getRangeAt(0);
      if (!panel.contains(range.commonAncestorContainer)) return [];
      return [...panel.querySelectorAll('.w')].filter(w => range.intersectsNode(w));
    };
    let downAt = null;
    const onDown = e => { if (e.button === 0) downAt = { x: e.clientX, y: e.clientY, t: Date.now() }; };
    const onUp = e => {
      if (e.button !== 0) return;
      const sel = selectedWords();
      if (sel.length > 1 || (sel.length === 1 && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6)) return open(sel, e.clientX, e.clientY);
      const w = wordAt(e.target);
      if (!w || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
      // a plain click: one step up the colours, and back to clear after red
      if (e.shiftKey) return open([w], e.clientX, e.clientY);
      mapper.mark([w], (mapper.tierOf(w) + 1) % 4);
      onChange();
    };
    const onMenu = e => { const w = wordAt(e.target); if (!w) return; e.preventDefault(); const sel = selectedWords(); open(sel.includes(w) ? sel : [w], e.clientX, e.clientY); };
    const onKey = e => {
      if (pick.hidden) {
        // a selection with no picker yet (made with the keyboard, or the picker closed): the digits still work
        if (!/^[0-3]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
        const sel = selectedWords();
        if (!sel.length) return;
        target = sel;
      } else if (e.key === 'Escape') { e.preventDefault(); return close(); }
      if (/^[0-3]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); apply(+e.key); }
    };
    const onDocDown = e => { if (!pick.hidden && !pick.contains(e.target)) close(); };
    panel.addEventListener('mousedown', onDown);
    panel.addEventListener('mouseup', onUp);
    panel.addEventListener('contextmenu', onMenu);
    addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocDown, true);
    return {
      get open() { return !pick.hidden; },
      close,
      destroy() { close(); pick.remove(); panel.classList.remove('gz-marking'); panel.removeEventListener('mousedown', onDown); panel.removeEventListener('mouseup', onUp); panel.removeEventListener('contextmenu', onMenu); removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDocDown, true); },
    };
  }

  LookupMapper.TUNE = TUNE;
  LookupMapper.TIER_MS = [0, 350, 1500, 4000];   // the least dwell that shows each tier (see tier())
  window.LookupMapper = LookupMapper;
  window.splitEssay = splitEssay;
  window.makeCursor = makeCursor;
  window.renderSentence = renderSentence;
  window.wordsInCircle = wordsInCircle;
  window.wordsInEllipse = wordsInEllipse;
  window.ringFor = ringFor;
  window.attachMarking = attachMarking;
})();
