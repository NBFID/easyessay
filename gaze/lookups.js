// LookupMapper: turns a stream of gaze samples into "which sentence did I just look up".
//
// Webcam gaze is only good to a few lines, so it is fused with where you are up to in the essay:
// each gaze frame inside the reference panel scores every sentence by how close its text sits to
// the gaze point, times a prior that favours the sentence you are writing and the ones just after
// it. The best sentence collects that frame's dwell time. A "look" is one visit to the panel
// (gaze arrives, stays a while, leaves), and each sentence read during it gets a lookup.
//
//   const map = new LookupMapper({ panel, sentences, onLook });
//   map.setCursor(sentenceIndex)   // from the typed text (see cursorFromTyping) or null if writing on paper
//   map.onGaze(sample)             // from GazeTracker
//   map.stats()                    // [{ s, time, looks, tier, words, phrases }]
//   map.undoLast() / map.resetAll() / map.setPaused(true) / map.paint()
//
// sentences: [{ el, s, p, text }] where el is the span holding sentence s of paragraph p.

(() => {
  const SIGMA_X = 160;   // px: horizontal gaze error is forgiven generously (sentences wrap anyway)
  const SIGMA_Y = 60;    // px: vertical error, two to three lines of text
  const PANEL_PAD = 24;  // px: gaze this far outside the panel still counts as being in it
  const LEAVE_MS = 900;  // gaze off the panel (or not settled) for this long ends a look
  const HOLD_MS = 600;   // default: the gaze has to settle in one place this long before it counts
  const ENTER_MS = 120;  // gaze must stay on the panel this long before it counts as reading
  const SWITCH_MS = 160; // a different sentence must win for this long before the highlight moves
  const MIN_LOOK = 180;  // ms of dwell on a sentence within one look before it counts as a lookup
  const PRIOR_SD = 2.0;  // sentences: how far from the cursor a lookup is still expected

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
      const lo = Math.max(0, pos - 25), hi = Math.min(W.length - K, pos + 90);
      let best = -1, bestN = 0;
      for (let j = lo; j <= hi; j++) {
        let n = 0;
        for (let k = 0; k < K; k++) {
          const w = W[j + k].w;
          if (w === tail[k] || (w.length > 4 && tail[k].length > 4 && (w.startsWith(tail[k]) || tail[k].startsWith(w)))) n++;
        }
        if (n > bestN || (n === bestN && n && Math.abs(j - pos) < Math.abs(best - pos))) { bestN = n; best = j; }
      }
      const need = K <= 2 ? K : Math.ceil(K * 0.6);
      if (bestN >= need) pos = best + K - 1;
      else if (pos < 0 && toks.length < 3) pos = 0;
      return pos >= 0 ? W[Math.min(pos, W.length - 1)].s : null;
    };
  }

  class LookupMapper {
    constructor({ panel, sentences, onLook, onCurrent, onRing, holdMs = HOLD_MS, ringR = 45 }) {
      this.panel = panel;
      this.sentences = sentences;
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
        const d = dx * dx / (SIGMA_X * SIGMA_X) + dy * dy / (SIGMA_Y * SIGMA_Y);
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
      const inPanel = sample.x != null && !sample.away && !sample.edge && sample.x >= pr.left - PANEL_PAD && sample.x <= pr.right + PANEL_PAD && sample.y >= pr.top - PANEL_PAD && sample.y <= pr.bottom + PANEL_PAD;

      if (!inPanel) { this._leave(t, false); return -1; }
      // a brief pass through the panel (a saccade on the way elsewhere) is not reading, and
      // nothing counts until the gaze has settled in one place for the hold time
      if (this.enteredAt == null) this.enteredAt = t;
      this.settled = !!(sample.region && sample.region.dur >= this.holdMs);
      if (t - this.enteredAt < ENTER_MS || !this.settled) {
        if (this.current !== -1 && !this.settled) { this.current = -1; this.candidate = -1; this.onCurrent(-1); }
        if (this.ringOn) { this.ringOn = false; this.onRing(null); }
        return this.current;
      }
      this.inPanelMs += dt;
      // the ring sits on the dwell centroid: steadier than the raw point, and what the user sees
      const x = sample.region.x, y = sample.region.y;
      const anchor = this.cursor != null ? this.cursor : this.progress;
      let best = -1, bestScore = -Infinity;
      for (let i = 0; i < this.sentences.length; i++) {
        const rects = this.rects[i];
        if (!rects.length) continue;
        const g = this._gap(rects, x, y);
        if (g.d > 9) continue;   // more than three sigmas away
        let score = -g.d / 2;
        if (anchor >= 0) {
          const off = i - anchor - 0.5;         // centred between the sentence being written and the next
          score -= (off * off) / (2 * PRIOR_SD * PRIOR_SD);
        }
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) { if (this.ringOn) { this.ringOn = false; this.onRing(null); } return -1; }
      if (!this.look) this.look = { start: t, last: t, dwell: new Map(), words: new Map() };
      const lk = this.look;
      lk.last = t;
      lk.dwell.set(best, (lk.dwell.get(best) || 0) + dt);
      this.time[best] += dt;
      // the words under the ring collect time too: that is the phrase-level "gap"
      // words at the centre of the ring earn full time, words at its rim only a fifth, so the
      // phrase actually being read pulls ahead of its neighbours on the lines above and below
      const hits = wordsInCircle(this.sentences, x, y, this.ringR);
      const sig = this.ringR / 1.8;
      for (const w of hits) {
        const b = w.getBoundingClientRect();
        const d2 = ((b.left + b.right) / 2 - x) ** 2 + ((b.top + b.bottom) / 2 - y) ** 2;
        const share = dt * Math.exp(-d2 / (2 * sig * sig));
        lk.words.set(w, (lk.words.get(w) || 0) + share);
        this.wordTime.set(w, (this.wordTime.get(w) || 0) + share);
      }
      this.ringOn = true;
      this.onRing({ x, y, r: this.ringR, hits });
      // the highlight only moves once a different sentence has won for a while
      if (best === this.current) this.candidate = -1;
      else if (best !== this.candidate) { this.candidate = best; this.candidateAt = t; }
      else if (t - this.candidateAt >= SWITCH_MS || this.current === -1) { this.current = best; this.candidate = -1; this.onCurrent(best); }
      return this.current === -1 ? best : this.current;
    }

    // Gaze is off the panel (or tracking is paused): end the look once it has been away long enough
    _leave(t, now) {
      this.enteredAt = null;
      if (this.look && (now || t - this.look.last > LEAVE_MS)) this._endLook(t);
      if (this.current !== -1) { this.current = -1; this.candidate = -1; this.onCurrent(-1); }
      if (this.ringOn) { this.ringOn = false; this.onRing(null); }
    }

    _endLook(t) {
      const lk = this.look;
      this.look = null;
      const read = [...lk.dwell].filter(([, ms]) => ms >= MIN_LOOK).map(([s]) => s).sort((a, b) => a - b);
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

    finish() { if (this.look) this._endLook(this.look.last + LEAVE_MS); }

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

    // Apply the tier classes (h1/h2/h3) to every sentence and word span, for the live reference and the report
    paint() {
      this.sentences.forEach((sn, i) => {
        const st = LookupMapper.tier(this.time[i], this.looks[i]);
        sn.el.classList.remove('h1', 'h2', 'h3');
        if (st) sn.el.classList.add('h' + st);
        (sn.wordEls || []).forEach(w => {
          const wt = LookupMapper.tier(this.wordTime.get(w) || 0);
          w.classList.remove('h1', 'h2', 'h3');
          if (wt) w.classList.add('h' + wt);
        });
      });
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

  // The words whose boxes a circle covers: what the page lights up inside the gaze ring.
  // Only sentences whose own boxes come near the circle are inspected, so it stays cheap.
  function wordsInCircle(sentences, cx, cy, r) {
    const hit = [];
    for (const sn of sentences) {
      if (!sn.wordEls) continue;
      let near = false;
      for (const b of sn.el.getClientRects()) if (cx + r > b.left && cx - r < b.right && cy + r > b.top && cy - r < b.bottom) { near = true; break; }
      if (!near) continue;
      for (const w of sn.wordEls) {
        const b = w.getBoundingClientRect();
        const dx = Math.max(b.left - cx, 0, cx - b.right), dy = Math.max(b.top - cy, 0, cy - b.bottom);
        if (dx * dx + dy * dy <= r * r) hit.push(w);
      }
    }
    return hit;
  }

  window.LookupMapper = LookupMapper;
  window.splitEssay = splitEssay;
  window.makeCursor = makeCursor;
  window.renderSentence = renderSentence;
  window.wordsInCircle = wordsInCircle;
})();
