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

## 8. CONTENT-AWARE B-roll: the background SWITCHES per narrative segment
- The reference's full-canvas B-roll behind the circle PIP CHANGES per phase (demo →
  features → proof → CTA). One static window looks lazy and off-topic. So match the
  RIGHT window of the B-roll source to each segment by what the speaker is saying.
- Build: `scripts/multi-aroll-broll-match.mjs` — uploads the B-roll to Gemini, sends
  each segment's MMS-timed speech + role + needed duration, gets back a per-segment
  `{brollStartSec, screen, relevance, reason}` → `stage2/broll-plan.json`. "Gemini
  proposes." Unassigned segments get a deterministic fallback (tail of the richest
  scene). Continuous screencasts have NO hard cuts → segment SEMANTICALLY (Gemini),
  not by CV scene-cut (which finds 0).
- Render: `multi-aroll-stage3-4.mjs` reads broll-plan.json and CONCATENATES one
  B-roll window per SEGMENT into the background `[bg]` (not per merged A-roll run —
  B-roll switches with the narrative independently of A-roll run-merging). Concat,
  NOT enable-switching: each window's duration == its segment's TIMELINE duration so
  seams are frame-exact with zero overlay-sync/pad risk. Tail only on the LAST window
  (no drift). Clamp `brollStartSec + dur <= brollDuration`. No plan → static fallback.
  This is still SINGLE-PASS (concat lives inside the one filter_complex, like audio).
- Verify (the content gate, mirrors boundary-guard's "re-check the OUTPUT"):
  `scripts/multi-aroll-broll-verify.mjs --method 2` samples the rendered background
  at each segment midpoint, asks Gemini if it depicts that segment's speech, gates on
  relevance >= threshold (default 50). Wired into the closed loop under --gemini.
  Below-threshold segments are surfaced for re-match/generation (a larger action), not
  auto-looped. Honest ceiling: a content-ANALYSIS app illustrating a content-CREATION
  pitch tops out ~60-90 (avg ~76) — true 98% needs bespoke generated footage (B4).
- Regression MA6: `broll-plan.json` must cover every segment with an in-bounds window
  (guards against silent revert to static; a generated `source` must exist on disk).
  Renderer crop/A-roll math is UNTOUCHED — per-segment B-roll did not regress any A-roll gate.

## 9. GENERATION fills the gap when the source pool can't depict the speech (B4)
- When a segment's relevance is capped because no available footage shows what the speaker
  describes (e.g. a content-ANALYSIS app can't illustrate a content-CREATION pitch),
  GENERATE bespoke b-roll. Add `"source": "<path>"` (+ `"brollStartSec":0`) to that segment
  in `broll-plan.json`; the renderer treats it as a dedicated MULTI-SOURCE input.
- Multi-source renderer (`multi-aroll-stage3-4.mjs`): input 0 = main B-roll, 1..K = A-roll
  (UNCHANGED → no A-roll/audio regression), generated clips = inputs K+1.. (after A-roll).
  Each `[bgseg_i]` is forced to EXACTLY its segment's timeline duration via
  `tpad=stop_mode=clone:stop_duration=1,trim=duration=<segDur>` so a clip that is a hair
  short can never drift the concat. Still single-pass.
- Tooling: MCP `generate_video` model `kling3_0`, `mode:"pro"` (1080p-class), `sound:"off"`,
  `aspect_ratio:"9:16"`; decline the preset notice via `params.declined_preset_id` to render
  literally; STRONG cinematic prompts that FORBID on-screen text/captions/logos (nothing must
  compete with the circle PIP) and keep subjects center/lower (circle sits top-right).
  Poll with `show_generations`; download the result URL to `public/uploads/gen/`.
- Result (reel 1): all four narrative segments were generated bespoke (seg1 dull→eye-catching
  product, seg2 creative team, seg3 product styling, seg4 CTA journey), ALL A-roll gates green.
  ~10–17 credits/clip (Kling pro). See [[multi-aroll-broll-content-aware]].

## 10. MULTI-SHOT generation: prompt-driven (the MCP Kling 3.0 ignores structured params)
- This MCP's `kling3_0` does NOT accept `multi_shots`/`multi_prompt`/`multi_shot_mode` (the server
  reports "not supported" and omits them). So drive multi-shot via the PROMPT: write explicit
  `SHOT 1 (0-3s): … HARD CUT. SHOT 2 (3-6s): … HARD CUT. SHOT 3 (6-Ns): …` with a scene change
  every ~3s. Kling 3.0 (multi-shot-capable) honors it — verified 3 distinct scenes per clip.
- Any generated clip longer than ~3s should be multi-shot (scene change ~every 3s) for energy,
  matching the reference's fast cutting. Always forbid on-screen text/captions/logos (Kling still
  renders faint GIBBERISH UI text — an unavoidable artifact; keep UIs minimal/abstract to minimize).
- Get the result URL from `show_generations`; download to `public/uploads/gen/`. 10s pro clips take
  ~2–3 min — poll, don't block.

## 11. The B-roll relevance gate is ADVISORY and must be AVERAGED (LLM scores are noisy)
- A single Gemini relevance call varies ±10–15 on IDENTICAL footage (seg scores flip-flopped
  20→50→60 across runs). `multi-aroll-broll-verify.mjs` now (a) samples 3 frames across the segment
  and (b) AVERAGES N=3 Gemini votes → stable scores (votes printed as `[a/b/c]`). Do this before
  trusting any number.
- The gate is ADVISORY, never a hard blocker: it surfaces weak matches; the HARD gates are the
  A-roll ones (words 100%, crop head-safe, no black/blank, audio continuous). A low relevance score
  can be legitimately OVERRIDDEN by explicit user creative direction; all hard gates still pass.

## 12. The B-ROLL GENERATION SYSTEM (the reusable way to make clips) — `docs/broll-generation.md`
The canonical KB is `docs/broll-generation.md` (the adapted Kling-3.0 Cinematic Director). Four house
rules fix the three failure modes we hit generating reel 1 by hand:
- **No fabricated UIs / readable text.** Gen models render text as gibberish — it ONLY appeared on
  fake phone/app-UI clips; real-world clips were clean. So generate REAL-WORLD scenes and REFRAME any
  screen/app/text concept to a real-world metaphor (problem→dull vs beautifully-styled product;
  CTA→creative team / inviting gesture / handshake — NOT a phone screen). The cleanliness gate catches
  any residual text (clutter with papers, a visible phone screen) → regen with the text source removed.
- **Single-shot BEATS assembled by us** (NOT the model's internal multishot, which mis-orders + seams
  badly). The director plans the beat shot-list; each beat is generated single-shot; the renderer
  concatenates beats frame-exact → perfect order + clean hard cuts.
- **Text-free, PIP-aware** prompts (subject lower-two-thirds, clean top-right for the inset).
- **Model routing:** Seedance 2.0 for product/identity (holds the SAME product across beats),
  Kling 3.0 for human motion.
Pipeline: `scripts/multi-aroll-broll-generate.mjs --plan [--segs ...]` (director `scripts/lib/
broll-director.mjs` → beat manifest) → AGENT generates each beat via MCP `generate_video` → write
`broll-gen-results.json {beatId:url}` → `--ingest` downloads, runs the CLEANLINESS gate
(`scripts/lib/broll-cleanliness.mjs`: reject any on-screen text/gibberish; clean<70 → regen) and
writes ordered `beats[]` into `broll-plan.json` only when ALL a segment's beats pass. Renderer
(`multi-aroll-stage3-4.mjs`) concatenates a segment's beats by frame-distributed sub-durations.
Regression MA6 now also asserts every `beats[]` source exists on disk.
Result (reel 1 seg1+seg4 regenerated): every beat clean=100 (zero gibberish), relevance seg1 20→90,
seg4 25→90, avg 83, ALL A-roll gates green. The closed loop auto-rejected 2 text-bearing beats and
regenerated them clean. See [[multi-aroll-broll-content-aware]].

**Content-aware architecture (`scripts/lib/broll/`):** the director is now a CLASSIFIER + pluggable
STRATEGY REGISTRY behind a stable CONTRACT (`contract.mjs`), so a content type can be improved in
ISOLATION — orchestrator/gates/renderer/A-roll only ever touch the contract. `classifier.mjs` →
{contentType (product|service|tutorial|lifestyle|social_proof|other), productSpecificity, entities};
`registry.planDirective` routes to a strategy. **Product depiction is CROSS-CUTTING**: if products are
the visual subject (specific/generic) it uses the PRODUCT strategy even inside a service pitch.
`strategies/product.mjs` = VARIETY (generic → different product per beat) vs IDENTITY+scene-variation
(specific → same product, varied scenes); `default.mjs` = real-world reframe; service/tutorial/lifestyle
= stubs→default (one file to flesh out later; tutorial is the home for future non-generated
`image_sequence`/`screen_recording` kinds — the contract's `Beat.kind` already declares them).
Regression MA8 validates the generation manifest against the contract. Adding a content type = one new
strategy file + one registry line; nothing downstream changes. See [[broll-generation-system]].

---

## REEL-2 lessons (a NEW render path — Remotion split-screen — re-taught us reel-1's gates the hard way)

Reel-2 stacks a real A-roll (top band) over an AI cartoon (bottom square), rendered in **Remotion**
(`src/remotion/compositions/Reel2Video.tsx`), NOT the FFmpeg circle-PIP renderer. Fixing it took 3
iterations; each was a reel-1 gate that wasn't carried into the new path. See [[reel2-per-turn-lipsync]].

## 13. Head-safe crop applies to ANY stack layout (a BAND too), not just the circle
- v3 cut the top clips at the full 720×1280 portrait and let the compositor `objectFit:cover` them into a
  1080×840 band → vertical center-crop → top of the head sliced off. The crop RULE (`docs/cropping-rules.md`)
  and reel-1's head-safety closed loop existed; they just weren't applied to the new layout.
- FIX: detect the face per turn with YuNet (`scripts/python/detect_face_yunet.py`) and crop a full-width
  head-safe band (`calculateBandCrop` in `scripts/reel2-build-act1.mjs`), then scale to 1080×840 so the
  compositor's cover is a no-op. **Position by FACE-BOX CENTER (~0.45 of the band), not by the extended
  head-top** — center positioning is stable when the speaker LEANS IN (their face moves but its center
  stays put); head-top anchoring over-gave headroom and clipped the chin on the lean turns.
- GATE: `scripts/reel2-crop-check.mjs` (ports `multi-aroll-crop-check.mjs`) measures the RENDERED top band
  with `measure_circle_head.py`; head-top gap ≥ GAP_MIN and face-bottom ≤ BOTTOM_MAX on EVERY sampled
  frame. Band thresholds are looser than the circle's (0.03 / 0.99 vs 0.06 / 0.93) because a wide-short
  band is tight for close subjects — a chin at the band's bottom edge meets the panel below, not a clip.

## 14. Per-turn lip-sync for a stacked AI-character layer (not concat + offset)
- v2 concatenated one talking clip per character and seeked into it per turn (`bottomFromSec`) → the mouth
  didn't match the words. FIX: generate ONE `wan2_7` clip PER dialogue turn from the character image
  (`start_image`) + that turn's EXACT audio (`audio` role), 1:1, 1080p. `wan2_7` min duration is 2s — pad
  short turns' audio to `max(2, ceil(dur))` with trailing silence; the segment's frame range bounds
  playback so only the spoken words show. The visible layer is `muted`; the real A-roll carries the audio.
  Producer-grade prompt per line (emotion-matched expression, blinks, gesture, explicit "lip-sync to the
  attached audio"). Upload local image+audio via `media_upload`→PUT→`media_confirm` (model needs URLs/UUIDs).

## 15. No black-flash at cuts (Remotion render path)
- The user caught a glitch at the first cut (~3.37s). TWO causes: (a) `SegmentView` faded EVERY segment in
  from opacity 0 over the black canvas → a 3-frame fade-from-black at each cut → fade only the FIRST
  segment, hard cuts elsewhere; (b) the compositor forced the legacy HTML5 `<Video>` during render, which
  seeks per frame and emits ONE black frame at each clip's frame 0 → use **`OffthreadVideo` EVERYWHERE**.
  In Remotion 4.x OffthreadVideo is frame-exact AND renders audio (`volume`/`toneFrequency`/
  `audioStreamIndex` props), so the dialogue survives — VERIFY with the output transcript after switching.
  `premountFor` only half-helped; OffthreadVideo is the real fix.
- GATE: `scripts/reel2-cut-check.mjs` samples brightness around every segment boundary and fails on a
  near-black dip. Diagnose cuts with a per-frame brightness probe (`ffmpeg -vsync 0` dump), not by eye.
- The FFmpeg path's equivalent rule is "contiguous `enable=` ranges, no gaps → no black frames" (AGENTS.md).

## 16. META — a new render path starts with ZERO gates; port them ALL, and verify the RENDERED output
- Every reel-2 iteration (clipped words → cropped head → black-flash) was a gate reel-1 ALREADY had but
  that didn't transfer to the new Remotion pipeline. The rules were written only in FFmpeg/circle-PIP terms.
- RULE: when building or porting an A-roll render path, wire EVERY gate from the "A-roll Definition of Done"
  checklist (`docs/aroll-pipeline.md`) before presenting — words, no-mid-word, head-safe crop, lip-sync,
  cut-continuity, audio, output transcript. NEVER present an A-roll edit that hasn't passed every gate ON
  THE RENDERED OUTPUT. "Looks fine in the plan" and "the source is clean" are not verification.
