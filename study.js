// EasyEssay beyond essays: the Today page, flashcards, exam dates and past papers.
// It runs after the script in index.html and shares its globals (store, opts, el, today, sameWord, ...).
(() => {
  const $ = id => document.getElementById(id);

  const fmtMins = m => m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + m % 60 + ' min' : '');
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const clock = secs => Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  // 'YYYY-MM-DD' as the same day number today() counts in
  const dayOf = date => Math.floor(Date.parse(date + 'T00:00:00Z') / 864e5);
  const lead = (...kids) => el('p', { className: 'lead' }, ...kids);
  const linkTo = (label, page) => el('a', { href: '#' + page, textContent: label });
  const row = (...kids) => el('div', { className: 'row' }, ...kids);
  const touch = matchMedia('(pointer: coarse)').matches;  // no keys to press, and a keyboard that covers half the screen

  function button(label, fn, cls = '') {
    const b = el('button', { type: 'button', className: 'btn ' + cls, textContent: label });
    b.addEventListener('click', fn);
    return b;
  }

  // The "···" menu on a row: items are [label, action, 'danger' | undefined]
  function menu(items) {
    const panel = el('div', { className: 'panel' });
    items.forEach(([label, fn, cls]) => {
      const b = el('button', { type: 'button', className: 'item ' + (cls || ''), textContent: label });
      b.addEventListener('click', () => { closeMenus(); fn(); });
      panel.append(b);
    });
    return el('details', { className: 'menu' }, el('summary', { className: 'btn', textContent: '···', title: 'More' }), panel);
  }

  /* ---------- today ---------- */

  const todayPage = $('today');
  const countdowns = $('countdowns');
  const todo = $('todo');
  const focusSet = $('focusSet');
  const focusSubject = $('focusSubject');
  const focusMins = $('focusMins');
  const focusRun = $('focusRun');
  const week = $('week');

  function renderToday() {
    drawCountdowns();
    drawTodo();
    focusSubject.value = opts.focusSubject || '';
    focusMins.value = opts.focusMins || 25;
    markPreset();
    drawFocus();
    drawWeek();
  }

  function when(x) {
    const d = new Date(x.date + 'T' + (x.time || '00:00'));
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
      + (x.time ? ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
  }

  // The next few exams, soonest first
  function drawCountdowns() {
    const t = today();
    const next = (store.exams || []).map(x => ({ x, left: dayOf(x.date) - t })).filter(e => e.left >= 0)
      .sort((a, b) => a.left - b.left || (a.x.time || '').localeCompare(b.x.time || '')).slice(0, 4);
    countdowns.textContent = '';
    next.forEach(({ x, left }) => countdowns.append(el('div', { className: 'card tile' },
      el('span', { className: 'muted', textContent: x.subject }),
      el('b', { textContent: left === 0 ? 'Today' : left === 1 ? 'Tomorrow' : left + ' days' }),
      el('span', { textContent: [x.name, when(x)].filter(Boolean).join(' · ') }))));
    if (!next.length) countdowns.append(lead('No exams coming up. ', linkTo('Add your exam dates', 'exams'), ' to see a countdown here.'));
  }

  // What's worth doing now: reviews that have come due first, then what's half learned, then what's new
  function drawTodo() {
    const t = today(), items = [];
    store.essays.forEach(rec => {
      const lad = rec.ladder;
      const due = Object.entries(rec.review || {}).filter(([p, r]) => lad && lad[p] >= MASTERED && r.due <= t).length;
      const learned = lad ? lad.filter(s => s >= MASTERED).length : 0;
      const run = () => openEssay(rec, false, true);
      if (due) items.push([0, titleOf(rec), plural(due, 'paragraph') + ' to review', 'Review', run]);
      else if (!lad) items.push([2, titleOf(rec), 'not started', 'Start', run]);
      else if (learned < lad.length) items.push([1, titleOf(rec), learned + ' of ' + plural(lad.length, 'paragraph') + ' learned', 'Keep learning', run]);
    });
    (store.decks || []).forEach(deck => {
      const due = dueOf(deck), fresh = freshOf(deck);
      if (!due && !fresh) return;
      const note = [due && due + ' due', fresh && fresh + ' new'].filter(Boolean).join(' · ');
      items.push([due ? 0 : 2, deck.name, note, 'Study', () => { go('cards'); startStudy(deck); }]);
    });
    todo.textContent = '';
    items.sort((a, b) => a[0] - b[0]).forEach(([, name, note, label, fn]) => todo.append(row(
      el('span', { className: 'open', textContent: name }),
      el('span', { className: 'muted meta', textContent: note }),
      button(label, fn, 'primary'))));
    if (items.length) return;
    if (store.essays.length || (store.decks || []).length) todo.append(lead('Nothing is due. A good time for a past paper.'));
    else todo.append(lead('Nothing here yet. ', linkTo('Add an essay', 'essays'), ' to memorise, or ', linkTo('make a deck of cards', 'cards'), '.'));
  }

  // The countdown, drawn large here; index.html keeps the time and logs the minutes
  function drawFocus() {
    const f = store.focus;
    focusSet.hidden = !!f;
    focusRun.hidden = !f;
    if (!f) return;
    const total = f.end - f.start, left = Math.ceil((f.end - Date.now()) / 1000);
    $('focusTime').textContent = left <= 0 ? "Time's up" : clock(left);
    $('focusWhat').textContent = (f.subject || 'Study') + ' · ' + fmtMins(Math.round(total / 60000)) + (left <= 0 ? ' logged' : '');
    $('focusFill').style.width = Math.min(100, 100 * (Date.now() - f.start) / total) + '%';
    $('focusStop').textContent = left <= 0 ? 'Done' : 'Stop and log';
  }

  // the preset that matches the minutes box is shown as chosen
  const markPreset = () => focusSet.querySelectorAll('[data-mins]').forEach(b => b.classList.toggle('selected', b.dataset.mins === String(+focusMins.value)));
  focusSet.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mins]');
    if (b) { focusMins.value = b.dataset.mins; markPreset(); }
  });
  focusMins.addEventListener('input', markPreset);

  focusSet.addEventListener('submit', (e) => {
    e.preventDefault();
    opts.focusMins = Math.min(600, Math.max(1, Math.round(+focusMins.value) || 25));
    opts.focusSubject = focusSubject.value.trim();
    startFocus(opts.focusMins, opts.focusSubject);
  });

  $('focusStop').addEventListener('click', () => {
    stopFocus();
    drawWeek();
  });

  // The last seven days of timed study, and what else today has seen
  let weekKey = '';
  function drawWeek() {
    const t = today(), days = store.days || {};
    weekKey = JSON.stringify(days[t] || 0);
    const mins = d => Object.values((days[d] || {}).min || {}).reduce((a, b) => a + b, 0);
    const active = d => !!days[d] && (mins(d) > 0 || days[d].cards > 0 || days[d].words > 0);
    const span = Array.from({ length: 7 }, (_, i) => t - 6 + i);
    const top = Math.max(30, ...span.map(mins));
    const bars = el('div', { className: 'bars' });
    const bySubject = {};
    span.forEach(d => {
      const bar = el('i');
      bar.style.height = Math.round(100 * mins(d) / top) + '%';
      bars.append(el('div', { className: d === t ? 'now' : '', title: mins(d) ? fmtMins(mins(d)) : 'No timed study' },
        el('span', { className: 'track' }, bar),
        el('span', { textContent: 'SMTWTFS'[new Date(d * 864e5).getUTCDay()] })));
      Object.entries((days[d] || {}).min || {}).forEach(([s, m]) => { bySubject[s] = (bySubject[s] || 0) + m; });
    });
    const total = span.reduce((a, d) => a + mins(d), 0);
    let streak = 0;
    for (let d = active(t) ? t : t - 1; active(d); d--) streak++;
    const now = days[t] || {};
    const seen = [mins(t) && fmtMins(mins(t)) + ' timed', now.cards && plural(now.cards, 'card'), now.words && plural(now.words, 'word') + ' recalled'].filter(Boolean);
    week.textContent = '';
    week.append(
      el('div', { className: 'sum' },
        el('b', { textContent: total ? fmtMins(total) + ' of timed study' : 'No timed study yet' }),
        el('span', { className: 'muted', textContent: streak > 1 ? streak + ' days in a row' : '' })),
      bars,
      el('div', { className: 'muted', textContent: Object.entries(bySubject).sort((a, b) => b[1] - a[1]).map(([s, m]) => s + ' ' + fmtMins(m)).join(' · ') }),
      el('div', { className: 'muted', textContent: 'Today: ' + (seen.join(' · ') || 'nothing yet') }));
  }

  // Twice a second while a timer runs: keep this page's copy of it moving
  function tick() {
    if (todayPage.hidden) return;
    drawFocus();
    if (JSON.stringify((store.days || {})[today()] || 0) !== weekKey) drawWeek();
  }

  /* ---------- cards ---------- */

  // store.decks: [{ id, name, subject, swap, updated, cards: [{ f, b, n, due }] }]
  // n counts clean recalls in a row and sets the gap before a card is asked again (the same gaps
  // as essay reviews); a card with no due day hasn't been seen yet
  const SESSION = 30;   // cards in one sitting
  const ENOUGH = 0.75;  // share of an answer's key words that makes it right

  const cardsPage = $('cards');
  const decksView = $('decksView');
  const deckList = $('deckList');
  const newDeck = $('newDeck');
  const deckEditor = $('deckEditor');
  const deckName = $('deckName');
  const deckSubject = $('deckSubject');
  const deckText = $('deckText');
  const deckCount = $('deckCount');
  const studyView = $('study');
  const cardType = $('cardType');
  const cardFront = $('cardFront');
  const cardInput = $('cardInput');
  const cardBack = $('cardBack');
  const cardVerdict = $('cardVerdict');
  const cardActions = $('cardActions');
  const studyHelp = $('studyHelp');

  let editing = null;  // the deck open in the editor (null = a new one)
  let session = null;  // { deck, queue, at, shown, mark, total, done, again } while cards are being studied

  const dueOf = deck => deck.cards.filter(c => c.due != null && c.due <= today()).length;
  const freshOf = deck => deck.cards.filter(c => c.due == null).length;

  function renderCards() {
    session = null;
    studyView.hidden = true;
    decksView.hidden = false;
    const decks = store.decks || [];
    $('cardsIntro').hidden = decks.length > 0;
    deckList.textContent = '';
    decks.forEach(deck => {
      const due = dueOf(deck), fresh = freshOf(deck);
      const open = el('button', { className: 'link open', textContent: deck.name });
      open.addEventListener('click', () => startStudy(deck));
      const meta = [deck.subject, plural(deck.cards.length, 'card'), due && due + ' due', fresh && fresh + ' new',
        !due && !fresh && 'nothing due', deck.swap && 'sides swapped'].filter(Boolean).join(' · ');
      deckList.append(row(open, el('span', { className: 'muted meta', textContent: meta }),
        button(due || fresh ? 'Study' : 'Study anyway', () => startStudy(deck), 'primary'),
        menu([
          ['Edit cards', () => openDeck(deck)],
          [deck.swap ? 'Ask the question first' : 'Ask the answer first', () => { deck.swap = !deck.swap; saveStore(); renderCards(); }],
          ['Export', () => download(deck.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.txt', deck.cards.map(c => c.f + '\t' + c.b).join('\n') + '\n', 'text/plain')],
          ['Delete', () => {
            if (!confirm('Delete "' + deck.name + '" and its ' + plural(deck.cards.length, 'card') + '?')) return;
            store.decks = store.decks.filter(d => d !== deck);
            saveStore();
            renderCards();
            drawBackup();
          }, 'danger']
        ])));
    });
    if (decks.length) closeDeck();
    else openDeck(null, true);
  }

  // A field from a spreadsheet or an Anki export: no wrapping quotes, no markup
  const clean = s => s.trim().replace(/^"([\s\S]*)"$/, (_, x) => x.replace(/""/g, '"'))
    .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

  // One card per line: question, a separator, answer. A tab is the separator if there is one (a paste
  // from a spreadsheet, an Anki export); otherwise the first " - ", " = " or " :: " on the line.
  // An Anki cloze line, "The {{c1::mitochondrion}} makes ATP", asks for the hidden part.
  function parseCards(text) {
    const CLOZE = /\{\{c\d+::(.*?)(?:::.*?)?\}\}/g;
    const cards = [], bad = [];
    text.split('\n').forEach(raw => {
      const line = raw.trim();
      if (!line || line[0] === '#') return;
      const first = line.split('\t')[0];
      const gaps = [...first.matchAll(CLOZE)].map(m => m[1]);
      if (gaps.length) return cards.push({ f: clean(first.replace(CLOZE, '_____')), b: gaps.join(', ') });
      const cols = line.includes('\t') ? line.split('\t') : (line.match(/^(.+?) (?:::|[-–—=]) (.+)$/) || []).slice(1);
      const f = clean(cols[0] || ''), b = clean(cols[1] || '');
      f && b ? cards.push({ f, b }) : bad.push(line);
    });
    return { cards, bad };
  }

  const cardLine = c => c.f + (/ (?:::|[-–—=]) /.test(c.f) ? '\t' : ' - ') + c.b;

  function countCards() {
    const { cards, bad } = parseCards(deckText.value);
    deckCount.textContent = plural(cards.length, 'card')
      + (bad.length ? ' · ' + (bad.length === 1 ? '1 line has' : bad.length + ' lines have') + ' no answer: "' + bad[0].slice(0, 28) + '"' : '');
  }

  // unasked: it opened by itself because there are no decks yet, so don't call up the keyboard
  function openDeck(deck, unasked) {
    editing = deck;
    deckName.value = deck ? deck.name : '';
    deckSubject.value = deck && deck.subject || '';
    deckText.value = deck ? deck.cards.map(cardLine).join('\n') : '';
    deckEditor.hidden = false;
    newDeck.hidden = true;
    $('deckCancel').hidden = !(store.decks || []).length;
    countCards();
    if (!unasked || !touch) (deck ? deckText : deckName).focus();
  }

  function closeDeck() {
    editing = null;
    deckEditor.hidden = true;
    newDeck.hidden = false;
  }

  newDeck.addEventListener('click', () => openDeck(null));
  $('deckCancel').addEventListener('click', closeDeck);
  deckText.addEventListener('input', countCards);

  deckEditor.addEventListener('submit', (e) => {
    e.preventDefault();
    const { cards } = parseCards(deckText.value);
    if (!cards.length) { deckCount.textContent = 'Add at least one card, like:  mitosis - cell division'; return; }
    // a card that's still here keeps its place in the schedule, even if its answer was reworded
    const old = editing ? editing.cards : [];
    const kept = cards.map(c => {
      const was = old.find(o => o.f === c.f && o.b === c.b) || old.find(o => o.f === c.f);
      return was ? { ...was, b: c.b } : c;
    });
    const deck = editing || { id: newId() };
    Object.assign(deck, { name: deckName.value.trim() || 'Deck ' + ((store.decks || []).length + 1), subject: deckSubject.value.trim() || undefined, cards: kept, updated: Date.now() });
    if (!editing) (store.decks ||= []).push(deck);
    saveStore();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    renderCards();
    fillSubjects();
    drawBackup();
  });

  // How much of the answer is in what was typed. Order doesn't matter and little words don't count:
  // a definition is right if its key words are there, give or take a typo or a close synonym. Notes in brackets aren't asked for, and in a
  // short answer "x / y", "x; y" or "x or y" are alternatives: any one of them will do.
  function markAnswer(given, answer) {
    const got = given.split(/\s+/).flatMap(subKeys);
    const has = key => got.some(g => sameWord(g, key));
    const nearly = key => got.some(g => synonym(g, key));
    const bare = answer.replace(/\([^)]*\)/g, ' ');
    const alts = bare.split(/\s*(?:[\/;]|\bor\b)\s*/).filter(a => a.trim());
    const scored = (alts.length > 1 && alts.every(a => wc(a) <= 4) ? alts : [bare]).map(text => {
      const keys = text.split(/\s+/).flatMap(subKeys);
      const main = keys.filter(k => !STOP.has(k));
      const want = main.length ? main : keys;
      const missing = want.filter(k => !has(k) && !nearly(k));
      return { score: want.length ? 1 - missing.length / want.length : 0, missing, loose: want.some(k => !has(k) && nearly(k)) };
    });
    // the alternative that fits best; between equals, the one matched without leaning on a synonym
    const best = scored.reduce((a, b) => b.score > a.score || (b.score === a.score && a.loose && !b.loose) ? b : a);
    return { ok: best.score >= ENOUGH, exact: best.score === 1 && !best.loose, missing: new Set(best.missing) };
  }

  function startStudy(deck) {
    loadSynonyms();
    const t = today();
    const mix = list => list.map(c => [Math.random(), c]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    // what's due, shuffled, then cards not seen yet in the order they were written
    let queue = mix(deck.cards.filter(c => c.due != null && c.due <= t)).concat(deck.cards.filter(c => c.due == null));
    if (!queue.length) queue = mix(deck.cards);  // nothing due: go over them anyway
    queue = queue.slice(0, SESSION);
    if (!queue.length) return;
    session = { deck, queue, total: queue.length, done: 0, again: new Set() };
    decksView.hidden = true;
    studyView.hidden = false;
    $('studyName').textContent = deck.name;
    cardType.checked = opts.cardType !== false;
    nextCard();
  }

  function setActions(list) {
    cardActions.textContent = '';
    list.forEach(([label, fn, cls]) => cardActions.append(button(label, fn, cls)));
  }

  // The question side: with a box to type in, or just to think and then look
  function askCard() {
    const s = session;
    cardFront.textContent = s.deck.swap ? s.at.b : s.at.f;
    cardBack.hidden = cardVerdict.hidden = true;
    cardInput.hidden = !cardType.checked;
    cardInput.disabled = false;
    cardInput.value = '';
    setActions([['Show answer', reveal, 'primary']]);
    studyHelp.textContent = cardType.checked ? 'Type the answer' + (touch ? '' : ' and press Enter') + '. Leave it empty to just look.'
      : 'Say the answer to yourself, then ' + (touch ? 'look.' : 'press Space.');
    if (cardType.checked) cardInput.focus();
  }

  function nextCard() {
    const s = session;
    s.at = s.queue.shift();
    s.shown = false;
    s.mark = null;
    if (!s.at) return endStudy();
    const left = s.queue.length + 1;
    $('studyLeft').textContent = left + ' to go';
    $('studyFill').style.width = 100 * s.done / (s.done + left) + '%';
    askCard();
  }

  // The answer side. A typed answer is marked, and the button it earned is the one Enter presses;
  // the other button is there to overrule the marking.
  function reveal() {
    const s = session;
    if (!s || !s.at || s.shown) return;
    s.shown = true;
    const answer = s.deck.swap ? s.at.f : s.at.b;
    const given = cardInput.hidden ? '' : cardInput.value.trim();
    s.mark = given ? markAnswer(given, answer) : null;
    cardInput.disabled = true;
    cardBack.textContent = '';
    answer.split(/(\s+)/).forEach(tok => {
      const missed = s.mark && !s.mark.ok && subKeys(tok).some(k => s.mark.missing.has(k));
      cardBack.append(missed ? el('span', { className: 'miss', textContent: tok }) : tok);
    });
    cardBack.hidden = false;
    cardVerdict.hidden = !s.mark;
    if (s.mark) cardVerdict.textContent = s.mark.ok ? (s.mark.exact ? 'Right.' : 'Close enough. Check the exact wording.') : 'Not quite: the words in red were missing.';
    const good = !s.mark || s.mark.ok;
    setActions([['Again', () => answerCard(false), good ? '' : 'primary'], ['Got it', () => answerCard(true), good ? 'primary' : '']]);
    studyHelp.textContent = touch ? '' : 'Enter takes the dark button. 1 is Again, 2 is Got it.';
  }

  function answerCard(ok) {
    const s = session, c = s.at;
    if (!c || !s.shown) return;
    if (ok) {
      c.n = Math.min((c.n || 0) + 1, GAPS.length);
      c.due = today() + GAPS[c.n - 1];
      s.done++;
    } else {
      c.n = 0;
      c.due = today();
      s.again.add(c);
      s.queue.push(c);  // it comes round again before the sitting ends
    }
    bump('cards');
    s.deck.updated = Date.now();
    saveStore();
    nextCard();
  }

  function endStudy() {
    const s = session;
    $('studyLeft').textContent = '';
    $('studyFill').style.width = '100%';
    cardFront.textContent = 'Done. ' + (s.again.size ? plural(s.total, 'card') + ', ' + s.again.size + ' needed another go.' : s.total === 1 ? 'Right first time.' : 'All ' + s.total + ' right first time.');
    cardBack.hidden = cardVerdict.hidden = cardInput.hidden = true;
    const more = dueOf(s.deck) + freshOf(s.deck);
    setActions(more ? [['Study ' + Math.min(more, SESSION) + ' more', () => startStudy(s.deck), 'primary'], ['Back to decks', renderCards]] : [['Back to decks', renderCards, 'primary']]);
    studyHelp.textContent = more ? '' : 'Nothing else in this deck is due today.';
  }

  $('studyBack').addEventListener('click', renderCards);

  cardType.addEventListener('change', () => {
    opts.cardType = cardType.checked;
    saveStore();
    if (session && session.at && !session.shown) askCard();
  });

  document.addEventListener('keydown', (e) => {
    if (!session || !session.at || cardsPage.hidden || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest('.menu .panel')) return;
    const typing = e.target === cardInput;
    if (!session.shown) {
      if (e.key !== 'Enter' && (e.key !== ' ' || typing)) return;
      reveal();
    } else if (e.key === '1') answerCard(false);
    else if (e.key === '2') answerCard(true);
    else if (e.key === 'Enter' || e.key === ' ') answerCard(!session.mark || session.mark.ok);
    else return;
    e.preventDefault();
  });

  /* ---------- exam dates and past papers ---------- */

  // store.exams: [{ id, subject, name, date: 'YYYY-MM-DD', time: 'HH:MM', updated }]
  // store.papers: [{ id, subject, name, mark, outOf, at }]
  const examList = $('examList');
  const examForm = $('examForm');
  const examSubject = $('examSubject');
  const examName = $('examName');
  const examDate = $('examDate');
  const examTime = $('examTime');
  const paperList = $('paperList');
  const paperForm = $('paperForm');

  let examEditing = null;  // the exam loaded into the form (null = adding a new one)

  function renderExams() {
    drawExams();
    drawBank();
    drawPapers();
  }

  // The question bank, a module to a fold-out, with the questions ready to copy
  const bankList = $('bankList');
  function drawBank() {
    if (bankList.childElementCount) return;
    loadBank().then(b => {
      bankList.textContent = '';
      b.modules.forEach(m => {
        const list = el('div', { className: 'bank' });
        m.questions.forEach(x => list.append(el('p', {}, x.q, ' ', el('span', { className: 'muted', textContent: '[' + x.src + ']' }))));
        const copy = button('Copy', () => {
          navigator.clipboard.writeText(m.questions.map(x => x.q + ' [' + x.src + ']').join('\n')).then(() => { copy.textContent = 'Copied'; });
        });
        bankList.append(el('details', { className: 'card' },
          el('summary', {}, el('b', { textContent: m.name }), ' ', el('span', { className: 'muted', textContent: plural(m.questions.length, 'question') + ' · ' + m.paper })),
          el('p', { className: 'muted', textContent: m.text }), copy, list));
      });
    }).catch(() => { bankList.append(lead('The question bank needs a connection the first time.')); });
  }

  function editExam(x) {
    examEditing = x;
    examSubject.value = x ? x.subject : '';
    examName.value = x ? x.name || '' : '';
    examDate.value = x ? x.date : '';
    examTime.value = x ? x.time || '' : '';
    $('examSave').textContent = x ? 'Save' : 'Add exam';
    $('examCancel').hidden = !x;
    if (x) examSubject.focus();
  }

  function drawExams() {
    const t = today();
    // what's coming, soonest first; then what's been sat
    const at = x => x.date + (x.time || '');
    const list = (store.exams || []).slice().sort((a, b) => (dayOf(a.date) < t) - (dayOf(b.date) < t) || (dayOf(a.date) < t ? at(b).localeCompare(at(a)) : at(a).localeCompare(at(b))));
    examList.textContent = '';
    list.forEach(x => {
      const left = dayOf(x.date) - t;
      const r = row(
        el('span', { className: 'open', textContent: [x.subject, x.name].filter(Boolean).join(' · ') }),
        el('span', { className: 'muted meta', textContent: when(x) }),
        el('span', { className: 'badge' + (left >= 0 && left <= 7 ? ' soon' : ''), textContent: left < 0 ? 'done' : left === 0 ? 'today' : left === 1 ? 'tomorrow' : 'in ' + left + ' days' }),
        menu([
          ['Edit', () => editExam(x)],
          ['Delete', () => {
            if (!confirm('Delete this exam date?')) return;
            store.exams = store.exams.filter(e => e !== x);
            saveStore();
            editExam(null);
            renderExams();
            drawBackup();
          }, 'danger']
        ]));
      if (left < 0) r.classList.add('past');
      examList.append(r);
    });
    if (!list.length) examList.append(lead('Add each exam with its date, and Today counts down to the next ones.'));
  }

  examForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!examSubject.value.trim() || !examDate.value) return;
    const x = examEditing || { id: newId() };
    Object.assign(x, { subject: examSubject.value.trim(), name: examName.value.trim(), date: examDate.value, time: examTime.value || undefined, updated: Date.now() });
    if (!examEditing) (store.exams ||= []).push(x);
    saveStore();
    const subject = x.subject;
    editExam(null);
    examSubject.value = subject;  // the next paper is often the same subject
    renderExams();
    fillSubjects();
    drawBackup();
  });

  $('examCancel').addEventListener('click', () => editExam(null));

  // Each subject's papers, newest first, with how the marks are tracking
  function drawPapers() {
    const all = store.papers || [];
    const pct = p => Math.round(100 * p.mark / p.outOf);
    paperList.textContent = '';
    [...new Set(all.map(p => p.subject))].sort().forEach(subject => {
      const list = all.filter(p => p.subject === subject).sort((a, b) => a.at - b.at);
      const spark = el('span', { className: 'spark', title: 'Oldest to newest' });
      list.forEach(p => {
        const bar = el('i', { title: p.name + ': ' + pct(p) + '%' });
        bar.style.height = Math.max(8, Math.min(100, pct(p))) + '%';
        spark.append(bar);
      });
      const avg = Math.round(list.reduce((a, p) => a + pct(p), 0) / list.length);
      const box = el('div', { className: 'card papers' }, el('div', { className: 'sum' },
        el('b', { textContent: subject }),
        el('span', { className: 'muted', textContent: plural(list.length, 'paper') + ' · average ' + avg + '% · best ' + Math.max(...list.map(pct)) + '%' }),
        spark));
      list.slice().reverse().forEach(p => {
        const remove = el('button', { type: 'button', className: 'link muted', textContent: 'Remove' });
        remove.addEventListener('click', () => {
          if (!confirm('Remove "' + p.name + '" from the log?')) return;
          store.papers = store.papers.filter(q => q !== p);
          saveStore();
          drawPapers();
          drawBackup();
        });
        box.append(el('div', { className: 'line' },
          el('span', { textContent: p.name }),
          el('span', { className: 'muted', textContent: p.mark + ' / ' + p.outOf + ' · ' + daysAgo(p.at) }),
          el('b', { textContent: pct(p) + '%' }),
          remove));
      });
      paperList.append(box);
    });
    if (!all.length) paperList.append(lead('Log each past paper you finish with its mark, and see how every subject is tracking.'));
  }

  paperForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const mark = +$('paperMark').value, outOf = +$('paperOutOf').value;
    const subject = $('paperSubject').value.trim(), name = $('paperName').value.trim();
    if (!subject || !name || !(outOf > 0) || !(mark >= 0)) return;
    (store.papers ||= []).push({ id: newId(), subject, name, mark, outOf, at: Date.now(), updated: Date.now() });
    saveStore();
    $('paperName').value = $('paperMark').value = '';  // subject and total stay for the next one
    drawPapers();
    fillSubjects();
    drawBackup();
    $('paperName').focus();
  });

  /* ---------- hand over to index.html ---------- */

  pages.today = renderToday;
  pages.cards = renderCards;
  pages.exams = renderExams;
  onTick = tick;
  window.startStudy = startStudy;
})();
