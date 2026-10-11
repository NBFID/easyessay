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
   peripheral vision, so a lookup is a real lookup).
2. **Calibration.** The app goes fullscreen. Sixteen dots appear one at a time: look at the dot,
   click it (or press Space) and keep looking for a second. Then three dots are looked at while
   you slowly move your head about (left, right, up, down, closer, further) so the fit learns how
   a moved head changes things. Four more dots check the fit and report the error when holding a
   look. Under about 80 px is good; over 150 px, redo it with the room lit from the front.
   The frame-to-frame figure is always larger; it is the raw jitter the smoothing removes.
3. **Writeout.** The reference sits on the left, the writing box on the right (or the reference
   fills the screen in paper mode). Write. Whenever you look up, the sentence under your gaze
   highlights in orange and collects dwell time. The top bar shows elapsed time, lookups so far
   and a warning if your head has moved far from where it was calibrated. **Quick fix** is one
   dot and two seconds: it re-centres the tracking after you have shifted in your chair.
   Recalibrate redoes the whole thing; the tallies and your draft are kept either way.
4. **Report.** The weakest sentences ranked by how long and how often you looked at them, the
   whole essay shaded as a heat map, and a timeline of lookups. Download the JSON or copy the
   summary. The last 30 sessions stay in the browser under "Past writeouts".

A calibration is saved and can be reused next time if the window is the same size, but the
camera angle, your chair and your posture all shift, so recalibrating per session is the
reliable option.

## How it works

`gaze.js` (`GazeTracker`) runs MediaPipe's Face Landmarker in the browser. From the 478 face
landmarks it takes the iris centre relative to the eye corners of each eye (that is what moves
when the eyes move) plus the head pose, and maps them to screen coordinates with a ridge
regression fitted on the calibration dots. The regularisation strength is picked by leaving each
dot out in turn. Predictions go through a median filter and an exponential average, and a
dispersion test marks fixations. Blinks are skipped. Nothing leaves the machine.

`lookups.js` (`LookupMapper`) turns gaze samples into sentence lookups. Webcam gaze is only good
to about two lines, so it is fused with where you are up to in the essay: each gaze frame on the
reference scores every sentence by distance from the gaze point, multiplied by a prior around the
sentence you are currently writing (found by matching the last few typed words against the essay;
in paper mode the last looked-up sentence stands in). One visit to the panel is one "look";
each sentence read for at least 180 ms during it gets a lookup.

Limits worth knowing: accuracy depends on lighting, glasses glare and keeping still; it cannot
tell which word in a sentence you needed, only the sentence; and if you move the window or
yourself much, recalibrate.

`calibrate.js` (`GazeCalibrate`) is the calibration overlay: it adds its own full-screen layer
and styles to whatever page loads it, runs the nine fitting dots and four check dots, and offers
the last saved model for reuse (press U) when the window is the same size.

## Inside EasyEssay

The same three scripts run inside the main essay tool as **Modes → Writeout with eye tracking**.
They are loaded on first use (plain script tags), so the rest of the app is unaffected. The mode
is the ordinary Blank page with the essay beside it in a dimmed panel, the blur-band and gaze-dot
options in a bar above, and a Recalibrate button; the camera's view sits small in the corner.

- The sentence spans for `LookupMapper` come from EasyEssay's per-word model: one span per run
  of words sharing `words[i].s`, in order, so the mapper's numbering follows the essay's.
- `setCursor()` is driven by `makeCursor()` over the blank-page textarea.
- On **Check**, the usual grading runs, then each looked-up sentence adds its lookup count to
  `wrong[]` for its key words and marks them missed, so Trouble spots and the Missed words drill
  pick them up. The session goes on the essay record as
  `essay.looks: [{ at, target, mins, lookups: [{ s, looks, time }], reading, error }]`
  and the result banner lists the sentences looked up.
- The last calibration is kept in the app's store (`store.gazeModel`) and offered next time.

The standalone page at `gaze/` keeps working on its own and is the quickest place to test the
camera and calibration.
