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
//   map.stats()                    // [{ s, time, looks }]
//
// sentences: [{ el, s, p, text }] where el is the span holding sentence s of paragraph p.

(() => {
  const SIGMA_X = 160;   // px: horizontal gaze error is forgiven generously (sentences wrap anyway)
  const SIGMA_Y = 60;    // px: vertical error, two to three lines of text
  const PANEL_PAD = 24;  // px: gaze this far outside the panel still counts as being in it
  const LEAVE_MS = 450;  // gaze off the panel for this long ends a look
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
    constructor({ panel, sentences, onLook, onCurrent }) {
      this.panel = panel;
      this.sentences = sentences;
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
      if (!this.rects) this._measure();
      const pr = this.panelRect;
      const inPanel = sample.x != null && !sample.away && !sample.edge && sample.x >= pr.left - PANEL_PAD && sample.x <= pr.right + PANEL_PAD && sample.y >= pr.top - PANEL_PAD && sample.y <= pr.bottom + PANEL_PAD;

      if (!inPanel) {
        this.enteredAt = null;
        if (this.look && t - this.look.last > LEAVE_MS) this._endLook(t);
        if (this.current !== -1) { this.current = -1; this.candidate = -1; this.onCurrent(-1); }
        return -1;
      }
      // a brief pass through the panel (a saccade on the way elsewhere) is not reading
      if (this.enteredAt == null) this.enteredAt = t;
      if (t - this.enteredAt < ENTER_MS) return this.current;
      this.inPanelMs += dt;
      // use the fixation centre when there is one: it is steadier than the raw point
      const x = sample.fix ? sample.fix.x : sample.x, y = sample.fix ? sample.fix.y : sample.y;
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
      if (best < 0) return -1;
      if (!this.look) this.look = { start: t, last: t, dwell: new Map() };
      this.look.last = t;
      this.look.dwell.set(best, (this.look.dwell.get(best) || 0) + dt);
      this.time[best] += dt;
      // the highlight only moves once a different sentence has won for a while
      if (best === this.current) this.candidate = -1;
      else if (best !== this.candidate) { this.candidate = best; this.candidateAt = t; }
      else if (t - this.candidateAt >= SWITCH_MS || this.current === -1) { this.current = best; this.candidate = -1; this.onCurrent(best); }
      return this.current === -1 ? best : this.current;
    }

    _endLook(t) {
      const lk = this.look;
      this.look = null;
      const read = [...lk.dwell].filter(([, ms]) => ms >= MIN_LOOK).map(([s]) => s).sort((a, b) => a - b);
      if (!read.length) return;
      read.forEach(s => { this.looks[s]++; });
      if (this.cursor == null) this.progress = Math.max(this.progress, read[read.length - 1]);
      const entry = { t: Math.round(lk.start - this.started), dur: Math.round(lk.last - lk.start), s: read };
      this.log.push(entry);
      this.onLook(entry);
    }

    finish() { if (this.look) this._endLook(this.look.last + LEAVE_MS); }

    stats() { return this.sentences.map((sn, i) => ({ s: i, p: sn.p, text: sn.text, time: Math.round(this.time[i]), looks: this.looks[i] })); }

    destroy() { removeEventListener('resize', this._invalidate); removeEventListener('scroll', this._invalidate); this.panel.removeEventListener('scroll', this._invalidate); }
  }

  window.LookupMapper = LookupMapper;
  window.splitEssay = splitEssay;
  window.makeCursor = makeCursor;
})();
