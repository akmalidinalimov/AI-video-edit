# Multi-A-Roll — START HERE (new session handoff)

**Date:** 2026-06-01
**Why a new session:** We chased the circle-framing problem for ~2 days across one
very long chat. The chat accumulated 6+ rounds of *superseded* crop-tuning numbers
that kept causing regressions. This doc is the clean, correct starting point. All
assets are on disk — nothing is lost.

---

## THE REAL ROOT CAUSE (read this first)

Every crop "fix" so far tuned math that runs on **bad input**. Two upgrades were
written but **never actually produced data**, so the renderer still runs on the
old brittle inputs:

1. **Face detection was never actually replaced.** All 4 clips still report
   `detector = BRIGHTNESS/none` in `public/exports/multi-aroll/stage1/clip_*_face.json`.
   MediaPipe failed to install correctly (`mp.solutions` missing — broken build in
   BOTH venvs). The renderer uses the old **brightness guesser**, which returns a
   *different wrong* face box per clip (clip2 height=0.14 vs others 0.13; topY
   ranges 0.24–0.27). **This is exactly why segs 1–2 look OK but segs 3–4 have the
   head too low / circle not 85–90% filled.** The crop formula is fine; its INPUT
   is wrong and inconsistent per clip. Tuning the formula can never fix this.

2. **Breathing-in is included in trims** because trims use `ffmpeg silencedetect`,
   which finds where *sound* starts. A breath IS sound (above the silence floor),
   so the cut lands on the breath, not the first word. The WhisperX **word**-level
   output (`clip_*_words.json`) that would fix this was **never generated**.

3. **Blank circle MID-SENTENCE at ~19s (seg2→seg3 boundary) — STILL PRESENT, new
   bug.** User reports: around 18–19s the circle briefly goes empty (you see the
   B-roll through the circle, no face), then the next A-roll snaps in. This is NOT
   the transition blank-circle we fixed earlier (that was the half-frame enable
   offset). This one is specific: **seg2 (12.701→19.066) and seg3 (19.066→26.316)
   BOTH come from the SAME source clip 1 (IMG_6752)**, rendered via `split=2` into
   two separate circle overlays, each with its own transparent pad + enable window.
   Likely cause: the two same-clip overlays' pad/enable windows don't perfectly
   abut at 19.066s — a 1-frame gap where neither overlay is "on", so the circle
   shows only background for a frame or two. **Fix hypothesis:** when consecutive
   segments share the same source clip AND are contiguous in source time
   (seg2.sourceEnd ≈ seg3.sourceStart), DON'T split them into two overlays — render
   them as ONE continuous circle overlay spanning both segments (single pad, single
   enable window). Only split when the layout/clip actually changes. Verify by
   extracting frames at 19.0/19.033/19.066/19.1s and confirming a face every frame.

**Conclusion:** stop tuning crop constants. Fix the two INPUTS (accurate per-frame
face box, accurate word onset), and the same-clip-split circle gap, then the
existing single crop formula + render pipeline produce consistent circles and clean
cuts automatically.

---

## DECISIONS LOCKED WITH USER

- **Face detector → OpenCV YuNet.** Verified working NOW: `cv2.FaceDetectorYN`
  exists in the installed OpenCV 4.13 (`scripts/python/.venv-vision`). No MediaPipe,
  no new heavy install — just download one ~340KB ONNX model. Proper DNN face box
  per frame → consistent circle across ALL segments.
- **Breath/trim → WhisperX word onset.** Use the first real WORD's timestamp (not
  silencedetect) as the in-point. A breath is sound but not a word. WhisperX is
  already installed and working in `scripts/python/.venv`. Also makes trimming
  language-agnostic (Uzbek).
- **User's preferred look = Method 2** (loosest / most face-dominant circle). Keep
  M2's framing intent; the goal is to make it CONSISTENT across all 4 A-rolls.
- **Circle target = 85–90% face fill**, head near top with a small consistent gap,
  per the user's hand-drawn diagram in `docs/cropping-rules.md`.

---

## WHAT ALREADY WORKS (don't rebuild these)

- **Single-pass FFmpeg render** — `scripts/multi-aroll-stage3-4.mjs`. Renders all
  3 methods, `enable='between(t,...)'` switching, transparent-pad circle overlays
  (no blank circle at transitions — verified), zero-gap audio. KEEP this.
- **The ONE crop function** — `calculateSquareCrop()` in that same file. It already
  has the `mode` param ("circle" = face-dominant, "stack" = head+shoulders). It is
  CORRECT — it just needs accurate `faceTopY`/`faceHeight`/`faceCenterX/Y` inputs.
- **Stacked hook layout** (1:1 square on top + B-roll below) — works, looks good.
- **QA gate** — `scripts/multi-aroll-verify.mjs --method all` (9 checks incl.
  blank-circle + silence). Use as the regression gate.
- **WhisperX wrapper** — `scripts/python/transcribe_whisperx.py` (word-level,
  works). Run with `scripts/python/.venv/Scripts/python.exe`.
- **Trim snapper** — `scripts/lib/trim-validator.mjs` +
  `scripts/multi-aroll-validate-trims.mjs`. Currently silence-based; swap its input
  from silencedetect to WhisperX word onset.
- **Python env** — `scripts/python/.venv` (whisperx) and `.venv-vision` (opencv).
  `uv` needs `UV_SYSTEM_CERTS=1` on this machine (SSL-inspecting proxy).

---

## THE FIX (5 concrete steps)

### Step 1 — Real face detection (YuNet)
New `scripts/python/detect_face_yunet.py`:
- Download model once: `face_detection_yunet_2023mar.onnx` from
  `https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/`
  into `scripts/python/models/`.
- Sample ~15 frames/clip, run `cv2.FaceDetectorYN`, take the median box.
- YuNet box is the FACE (eyes-brow-mouth). Extend UP for the full head (hair/hijab):
  `headTop = faceTop - faceH * ~0.5`. Also record `faceHeight` (true, ~0.16–0.18 of
  frame — much larger than brightness's wrong 0.13).
- Emit the SAME `clip_N_face.json` schema the renderer reads: `{median:{centerX,
  centerY,topY,height}, medianPixels:{...}, detector:"yunet"}`.
- Run for all 4 clips; overwrite `clip_N_face.json`. (Old brightness files are
  already backed up as `clip_N_face.brightness.bak.json`.)
- Reuse the structure of the written-but-MediaPipe-broken `scripts/python/detect_face.py`
  as a template — just swap the detector to YuNet.

### Step 2 — Measure the real circle target from the REFERENCE
The reference video is `public/uploads/IMG_6018.MOV` (circle at cx=792, cy=397,
r=214 per `dynamic-template.json`). Extract a circle-segment frame, run YuNet on
the speaker inside the circle, measure actual face-fill %. Use THAT number to set
`faceFraction` in `calculateSquareCrop()` "circle" mode — one value, data-driven,
not hand-guessed. (Likely ~0.78–0.85.)

### Step 3 — Re-tune circle crop ONCE on correct data, verify consistency
With accurate YuNet `faceHeight` (~0.17) and the measured target, set the "circle"
`faceFraction` so face fills 85–90%. Because every clip now has an accurate box,
all 4 segments frame consistently. Render M2, extract the circle region at the
MIDDLE of each of the 5 segments, confirm face-fill and head-gap match across all.

### Step 4 — Word-accurate trims (kill the breath)
Run `transcribe_whisperx.py` on each source clip → `clip_N_words.json`. In
`trim-validator.mjs`, replace the silence-onset logic with: in-point = first WORD
whose `start` ≥ segment's intended start (minus a tiny ~30ms pre-roll), so the cut
lands on speech, not the breath. Re-emit `clean-timeline.json`, re-render, verify
no breath at any segment start (listen + check first 150ms energy).

### Step 5 — Fix the mid-sentence blank circle at ~19s (same-clip split gap)
In `scripts/multi-aroll-stage3-4.mjs`, segments that share the SAME source clip
AND are contiguous in source time are currently rendered as TWO separate circle
overlays (via `split=2`), each with its own transparent pad + enable window. At the
boundary (19.066s for seg2→seg3, both clip 1) the two windows don't perfectly abut
→ a 1–2 frame gap where neither overlay is on → empty circle showing B-roll.
**Fix:** detect contiguous same-clip runs and MERGE them into ONE circle overlay
spanning the whole run (single source trim, single pad, single enable window).
Split overlays ONLY where the clip changes or the source is non-contiguous. This
removes the gap entirely (no abutment to get wrong). Re-render; extract frames at
19.00 / 19.033 / 19.066 / 19.10s and confirm a face in the circle EVERY frame.
NOTE: the existing verifier Check 7 (blank circle) samples transition frames but
missed this one — extend it to also sample at EVERY same-clip internal boundary.

---

## VERIFICATION (must pass before declaring done)
1. `clip_N_face.json` all show `detector:"yunet"` with `height ≈ 0.16–0.18`.
2. Render M2; extract circle region at mid-point of segs 0–4; **face-fill 85–90%
   and head-gap consistent across ALL five** (the core complaint).
3. `node scripts/multi-aroll-verify.mjs --method all` → 0 critical, 0 blank circle.
4. First 150ms of each segment = speech, not breath (spot-check segs 1–4 audio).
5. No leading silence, no gap between segments (`silencedetect` on output).
6. **No blank circle at 19.066s** (seg2→seg3, same clip) — extract frames at
   19.00/19.033/19.066/19.10s, face present in circle every frame.

## KEY FILES
| File | Role |
|------|------|
| `scripts/multi-aroll-stage3-4.mjs` | render + `calculateSquareCrop()` (the ONE formula) |
| `scripts/python/detect_face_yunet.py` (NEW) | YuNet face boxes → clip_N_face.json |
| `scripts/python/detect_face.py` | MediaPipe template (broken) — reuse structure |
| `scripts/python/transcribe_whisperx.py` | word timings (works) |
| `scripts/lib/trim-validator.mjs` | swap silence→word onset |
| `scripts/multi-aroll-verify.mjs` | QA gate |
| `docs/cropping-rules.md` | the user's cropping diagram (the rule) |
| `public/exports/multi-aroll/stage1/clip_N_face.json` | THE input that was wrong |
| `public/uploads/IMG_6018.MOV` | reference video (measure 85% target here) |
| `public/uploads/arolls/IMG_675{1,2,3,4}.MOV` | the 4 A-roll sources |

## DO NOT
- Do NOT tune crop constants before fixing the face-detector input. That's the trap.
- Do NOT use MediaPipe (broken here). Use YuNet.
- Do NOT use silencedetect for the in-point (catches breath). Use WhisperX words.
- Do NOT concatenate segments. Single-pass FFmpeg only (AGENTS.md hard rule).
