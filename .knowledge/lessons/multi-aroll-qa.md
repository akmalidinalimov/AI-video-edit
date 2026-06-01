# Multi-A-roll editing — lessons learned (closed-loop QA)

These are hard-won rules. Encode them in code/checks, don't re-discover them.

## 1. Anchor trims to the INTENDED SENTENCE, not the nearest word
- `segment.id = "C{clip}_S{n}"` indexes EXACTLY into
  `clip_{clip}_transcription.json.sentences[n]`. Use it to find the intended
  sentence (disambiguates false-start retakes). Cut at that sentence's FIRST and
  LAST word — never the nearest word in a window (that steals a neighbour's word
  or drops your own). Code: `scripts/lib/trim-validator.mjs::resolveIntendedSentence`.

## 2. Gemini word TIMESTAMPS are unreliable — get PRECISE times by FORCED ALIGNMENT
- Gemini word timestamps drift 300-1000ms (onsets early; last-word END can be ~1s
  late). Trusting them clips words ("kerak", "Mahsulotingizni"), and the checks
  that ALSO trust them miss it. Energy refinement alone can't disambiguate (e.g.
  is the speech after the cut the word's tail or filler?).
- FIX (the solid one): **MMS forced alignment** — Gemini gives the WORDS, MMS pins
  each to the audio precisely. `scripts/python/align_mms.py` (torchaudio MMS_FA,
  1100+ langs incl. Uzbek). Run via `node scripts/multi-aroll-align.mjs` at
  transcription time — it updates clip_N_transcription.json + clip_N_words.json
  with precise times (detector:"mms"), backing up the Gemini versions.
- The ~1GB model crashes on the SSL proxy via Python; download ONCE via PowerShell:
  `Invoke-WebRequest https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt`
  -> `scripts/python/.torch/hub/checkpoints/model.pt` (TORCH_HOME=scripts/python/.torch).
- With precise times the acoustic energy refiners are unnecessary (off by default;
  `--acoustic` re-enables them for non-aligned fallback). They only risked nicking
  soft word edges.

## 2b. Same-clip adjacent sentences = ONE take (keep merged, pause included)
- MMS reveals real ~0.3s pauses between adjacent sentences that Gemini hid by
  abutting them. Treat same-clip segments within ~0.6s as a contiguous run (merged
  overlay, continuous shot, natural pause) — don't split (jump cut + blank-circle
  risk). Detect contiguity from the ORIGINAL (input) source times, not the mutated
  ones. `CONTIG_EPS = 0.6` in trim-validator (mirror it in renderer/verify).

## 3. A "clipped word" must be judged by AUDIO, not labels
- A boundary word can look "clipped" by Gemini timing while the cut only removed
  SILENCE (mistimed onset). The deterministic word-completeness check rechecks the
  cut-off region for SUSTAINED speech (>=2 windows >-34dB); only sustained speech
  in the cut-off = a real clip. Code: `scripts/lib/transcript-verify.mjs`.

## 4. Boundary silence = sustained DEAD AIR, not "last 150ms isn't all speech"
- Natural sentence trail-off is fine. Flag only a continuous silence RUN >=180ms
  at a junction (or >=350ms at the final video end). Code: CHECK 12 in
  `scripts/multi-aroll-verify.mjs`.

## 5. Crop: verify head-in-circle on the RENDERED output, EVERY frame
- The speaker moves, so a median-based crop can clip the head in the worst frame.
  To ADD a top gap: LOWER faceFraction (smaller face) and RAISE faceCenterYIn
  (push face down). Verify with YuNet on the rendered circle across K frames:
  head-box top >= GAP below the rim AND chin/shoulders inside. Auto-tune until
  every sampled frame passes. Code: `scripts/multi-aroll-crop-check.mjs`,
  `scripts/python/measure_circle_head.py`. Converged target lives in
  `reference-circle-target.json` (faceFraction ~0.48, faceCenterYIn ~0.457).

## 6. Uzbek ASR can't self-agree at 95% — use the DETERMINISTIC check as the gate
- Re-transcribing the output with Gemini and comparing to the source self-agrees
  only ~85-95% on Uzbek (spelling variants, occasional dropped word). So:
  - The 100% word-completeness GATE is the deterministic check (source word
    timings vs intended sentence + energy recheck) — language-independent, exact.
  - Gemini re-transcription is a CONFIDENCE cross-check with fuzzy (Levenshtein)
    matching + padded cuts; a GROSS shortfall (<80%) flags a likely real cut,
    80-95% is ASR noise. WhisperX has NO Uzbek aligner, so it's not better here.

## 7. ALWAYS run the closed loop before presenting
- `node scripts/multi-aroll-closed-loop.mjs --method 2 [--gemini]` renders →
  verifies (words, silence, crop, blank, +Gemini) → auto-tunes crop → re-renders →
  only declares READY when every gate passes. Never present a result that hasn't.
- When checking visually, also check the TRANSCRIPT (no cut/overlap) AND confirm
  the circle holds head + shoulders with a top gap. Looks-only review misses both
  the word cuts and the head clipping.
