# Writeout with eye tracking

Write an essay out from memory with the reference on screen. The laptop camera watches where you
look, and every glance up at the reference is logged against the sentence you needed. The report
at the end shows the sentences you don't know yet.

Open `gaze/` in Chrome or Edge on the laptop. The camera only works over https or localhost, so
either use the deployed EasyEssay site (`/gaze/`) or run the app locally:

```bash
node tools/serve.js
```

then open http://localhost:8787/gaze/

## How a session goes

1. **Setup.** Paste the essay (blank lines between paragraphs). Choose whether you are typing the
   writeout in the app or writing on paper, and whether the reference should blur except around
   where you are looking (recommended: it stops you reading the next line "for free" with
   peripheral vision, so a lookup is a real lookup). **Check camera** shows a live preview with
   a verdict on face, distance and light before you commit to a calibration, and a picker
   appears if the laptop has more than one camera. **Test accuracy** runs the five-target test
   below (calibrating first if there is no fit yet). Optional: a soft tick when a lookup is
   counted, the reference scrolling to follow your typing so a lookup never needs the mouse, and
   how many words wide the gaze highlight is (six by default).
2. **Calibration.** The app goes fullscreen. Sixteen dots appear one at a time: look at the dot,
   click it (or press Space) and keep looking until it disappears. The top and bottom rows are
   held a little longer, because that is where a webcam fit is weakest. Then three dots are
   looked at while you slowly move your head about (left, right, up, down, closer, further) so
   the fit learns how a moved head changes things. Five more dots check the fit, two on the top
   row, one in the middle and two on the bottom, and the verdict reports the error overall and
   per row, and which local correction the check dots chose (fitted from both eyes together,
   per eye, or none). Under about 80 px is good; over 150 px, redo it with the room lit from the
   front. The frame-to-frame figure is always larger; it is the raw jitter the smoothing removes.
   Press **T** on the verdict for the accuracy test: five targets across the screen, look at and
   click each, and the screen shows where each look landed against its target with the miss per
   row and column. The test is also a button on the setup page and in the session bar (Ctrl+T).
3. **Writeout.** The reference sits on the left, the writing box on the right (or the reference
   fills the screen in paper mode). Write. When you look up and your gaze settles somewhere for
   the hold time (600 ms by default), a red oval about six words wide and a line tall appears
   there, and the words inside it are what gets counted. Words you read stay tinted: yellow for a
   glance, orange for a proper look, red for a stare or a phrase you keep coming back to. Whole
   sentences are not highlighted in the live view; the report ranks them. Nothing shows for a
   glance shorter than the hold time, a blink, or a look away.
   **Marking by hand.** Moving the touchpad pauses the camera for a moment (as typing does), so
   you can mark the reference yourself: click a word to step its colour (yellow, orange, red,
   then clear), drag across words or right-click one for a picker with the three colours and
   clear, or make a selection and press 1, 2 or 3 for the colour and 0 to clear. A hand mark
   counts in the report like a look of that strength.
   The top bar has **Pause** (the camera is ignored until you resume), **Undo look** (takes back
   the last lookup, for when you glanced at it by accident), **Reset** (clears every lookup),
   **Quick fix** (one dot, two seconds, re-centres the tracking after you have shifted in your
   chair), **Test** (the accuracy test) and **Recalibrate**. Hold time and highlight width are
   adjustable on the setup page.
   Keyboard: Ctrl+P pause, Ctrl+U undo, Ctrl+R reset, Ctrl+Q quick fix, Ctrl+T test accuracy,
   Ctrl+C recalibrate (it still copies when text is selected), Ctrl+D gaze dot, Ctrl+B blur,
   Ctrl+Enter finish.
4. **Report.** The weakest sentences ranked by tier and time, the exact phrases that sat under
   the highlight, the whole essay with every word tinted by how long you looked at it, and a
   timeline of lookups. Download the JSON or copy the summary. The last 30 sessions stay in the
   browser under "Past writeouts", with lookups per hundred words and the trend against the
   writeout before.

A calibration is saved and can be reused next time if the window is the same size, but the
camera angle, your chair and your posture all shift, so recalibrating per session is the
reliable option.

## How it works

`gaze.js` (`GazeTracker`) runs MediaPipe's Face Landmarker in the browser. From the 478 face
landmarks it takes the iris centre relative to the eye corners of each eye (that is what moves
when the eyes move), where the iris sits between the lids, and the head pose, and maps them to
screen coordinates with a ridge regression fitted in two stages: the eye terms on the dots
looked at with a still head, then the eye×head cross terms and the pose on what that gets wrong
once the head moves, which the head-movement dots supply. Each stage picks its regularisation by
leaving each dot out in turn, and the head stage is dropped if it does not help. On top sits a
local correction, radial basis functions centred on each calibration dot that soak up what the
global fit gets wrong at the top and bottom rows; it is fitted two ways (both eyes in one, or one
per eye averaged) and the check dots decide which to keep, or neither. The head pose is clamped
to the range the calibration covered, and the drift warning fires outside it rather than letting
the fit extrapolate. Predictions go through a median filter and an exponential average, and a
dispersion test marks fixations. Blinks are skipped. Nothing leaves the machine.

`lookups.js` (`LookupMapper`) turns gaze samples into sentence lookups. Webcam gaze is only good
to about two lines, so it is fused with where you are up to in the essay: each gaze frame on the
reference scores every sentence by distance from the gaze point (the vertical tolerance follows
the calibration's own error), multiplied by a weak prior around the sentence you are currently
writing (found by matching the last few typed words against the essay; in paper mode the last
looked-up sentence stands in). The sentence already chosen keeps the highlight unless another
wins by a clear margin, so the choice does not flap between neighbours. One visit to the panel is
one "look"; each sentence read for long enough during it gets a lookup. The words under the oval
collect time of their own, which is where the phrases in the report come from, and `mark()` lets
the page add hand marks the same way.

Limits worth knowing: accuracy depends on lighting, glasses glare and keeping still; it cannot
tell which word in a sentence you needed beyond the oval's width; and if you move the window or
yourself much, recalibrate.

`calibrate.js` (`GazeCalibrate`) is the calibration overlay: it adds its own full-screen layer
and styles to whatever page loads it, runs the sixteen fitting dots, the three head-movement dots
and the five check dots, offers the last saved model for reuse (press U) when the window is the
same size, and holds the accuracy test (`accuracyTest`) and the one-dot quick fix.

## Tests

Two Node scripts exercise the modules without a camera:

```bash
node gaze/test/fit.js
```

pushes a synthetic eye (with lid droop, a head that turns and moves, and optional glare on one
eye) through collect, fit, validate and chooseCorrection, and checks that a head turn inside the
calibrated range is compensated and one outside it warns.

```bash
node gaze/test/noise.js
```

feeds a pretend reader (frame noise of 60 to 150 px plus a steady per-look offset) through the
smoothing and the mapper and reports switches, flaps, far landings, settle time, misses and
wrongly counted sentences; `sweep` tries alternative tunings and `check` enforces a floor. The
tuning constants live in `GazeTracker.TUNE` and `LookupMapper.TUNE`.

## Inside EasyEssay

The same three scripts run inside the main essay tool as **Modes → Writeout with eye tracking**.
They are loaded on first use (plain script tags), so the rest of the app is unaffected. The mode
is the ordinary Blank page with the essay beside it in a dimmed panel, a bar above with the clock,
the count, the blur and gaze-dot switches, the hold time and highlight width, and the Pause, Undo,
Reset, Quick fix, Test and Recalibrate buttons; the camera's view sits small in the corner. The
same settings, plus the tick and follow-typing options, live under **Options → Eye tracking** and
are remembered.

- The sentence spans for `LookupMapper` come from EasyEssay's per-word model: one span per run
  of words sharing `words[i].s`, in order, so the mapper's numbering follows the essay's.
- `setCursor()` is driven by `makeCursor()` over the blank-page textarea.
- On **Check**, the usual grading runs, then each looked-up sentence adds its lookup count to
  `wrong[]` for its key words and marks them missed, so Trouble spots and the Missed words drill
  pick them up. The session goes on the essay record as
  `essay.looks: [{ at, target, mins, n, words, marked, lookups: [{ s, looks, time, tier, phrases }], reading, error }]`
  and the result banner gives the lookups per hundred words with the trend against the last
  writeout, the sentences by tier, the exact phrases, and two buttons: drill just those sentences,
  or the Missed sentences drill. The essay's card in the saved list shows the rate and trend too.
- The last calibration is kept in the app's store (`store.gazeModel`) and offered next time.

The standalone page at `gaze/` keeps working on its own and is the quickest place to test the
camera and calibration.
