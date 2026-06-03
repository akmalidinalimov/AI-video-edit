# A-Roll Editing Pipeline — the general rule

> **Read this before editing ANY talking-head ("A-roll") footage to match a
> reference.** It is reference-AGNOSTIC and generic over the number of A-rolls.
> Every problem we hit on the first video is encoded here as a stage with its
> principle, technique, the failure mode it prevents, and a quality gate. Follow
> the process, not a per-video template.
>
> Run it: `node scripts/aroll-pipeline.mjs --gemini`
> (stages are also independently runnable; see each below.)

## A-ROLL DEFINITION OF DONE (the pre-flight checklist — every gate must pass on the RENDERED output)

Before presenting ANY A-roll edit — any layout, any renderer — confirm ALL of these. Each line is a
defect class we have actually shipped by accident; the gate is how you catch it. Verify on the
**rendered output**, not the plan or the source clips.

- [ ] **Words complete** — every segment keeps its intended sentence(s) whole; no clipped first/last word.
      (deterministic word check; trims come from MMS-aligned word edges, never raw Gemini sentence times)
- [ ] **No mid-word start** — no turn/segment begins or ends inside a word. (boundary-guard re-transcribes
      the OUTPUT; MMS alignment is what makes this reliable)
- [ ] **Head-safe crop, every sampled frame** — head + shoulders in frame with a top gap; the head is
      NEVER clipped, for ANY layout (circle PIP OR stack/band). Position the crop by FACE-BOX CENTER so a
      lean doesn't clip the chin. (YuNet on the rendered output: `crop-check`)
- [ ] **Lip-sync (only if an AI-character layer mirrors the speech)** — generate ONE lip-sync clip PER
      turn from that turn's EXACT audio; never a concatenated clip + per-turn seek (mouth desyncs).
- [ ] **Continuity at cuts — NO black/blank flash** — hard cuts are instant; no fade-from-black, no
      seek-black, no blank circle. (FFmpeg: contiguous `enable=` ranges; Remotion: `OffthreadVideo`
      everywhere + fade only the FIRST segment. Verify with a per-frame brightness probe: `cut-check`)
- [ ] **Audio continuous, no overlap, no SILENT segment** — one speaker at a time, no dead air at a
      junction, no doubled voices, AND every talking segment actually carries audio (no segment whose
      source clip lost its audio stream). The frame/style score is BLIND to audio — it will happily rise
      while a turn is silent. Measure audio on the rendered output per segment, never assume.
      (Remotion path: `scripts/reel2-audio-check.mjs` — per-segment `volumedetect`, fails any silent
      talking segment, tolerates a known CTA/music-bed tail. 2026-06-03: a re-encode dropped one turn's
      audio and the loop still scored it "improved" — this gate is why that can't ship again.)
- [ ] **Output re-transcription clean** — transcribe the finished video: full dialogue, in order, no
      overlap, `audioIssues` empty.

## Render paths are interchangeable; the gates are NOT

This pipeline has shipped two render paths: **(A)** reel-1's single-pass **FFmpeg** circle-PIP renderer
(`multi-aroll-stage3-4.mjs`), and **(B)** reel-2's **Remotion** stacked/split-screen composition
(`src/remotion/compositions/Reel2Video.tsx`). The *gates above are identical for both* — only the
mechanics differ (e.g. continuity = contiguous `enable=` ranges in FFmpeg vs `OffthreadVideo` + first-only
fade in Remotion; crop = circle mask vs band/stack placement, but head-safety is checked the same way on
the rendered output).

> **META-RULE (the lesson that cost us 3 iterations): a NEW A-roll render path inherits NONE of these
> gates automatically.** When you build or port a pipeline, wire EVERY gate from the checklist before
> presenting. Reel-2's split-screen path re-discovered clipped words, a cropped head, and a black-flash
> at cuts — each a gate reel-1 already had but that wasn't carried over. Porting a pipeline = porting all
> its gates. The Remotion-path gate tools are `scripts/reel2-crop-check.mjs`, `scripts/reel2-cut-check.mjs`,
> `scripts/reel2-audio-check.mjs`, and `scripts/reel2-transcribe.mjs`; the FFmpeg-path closed loop is
> `scripts/multi-aroll-closed-loop.mjs`. (2026-06-03 added the **audio-continuity** gate after the
> style-director loop silenced a turn while the visual score rose — a gate no render path had yet.)

## The two non-negotiables

1. **Never cut a word or sentence.** Every rendered segment must contain its
   intended sentence(s) COMPLETE — no clipped first/last word, no neighbour
   sentence bleeding in, no audible dead air at the cut.
2. **Never present an unverified edit.** A deterministic closed loop must pass
   EVERY gate (below) before a result is shown. If a gate fails, fix and re-render;
   don't ship it.

## What is UNIVERSAL vs PER-REFERENCE

- **Universal (this rule):** transcription, forced alignment, sentence selection,
  sentence-anchored trimming, the 1:1-square talking-head crop, single-pass render,
  and the closed-loop verification. These apply to any A-roll, any language, any
  reference.
- **Per-reference (config, measured once per reference video):** the *layout
  rhythm* (which segments are circle PIP vs fullscreen/stack), the circle geometry
  (position + radius), and the crop target (how face-dominant). These live in data
  files (`reference-ground-truth.json`, `reference-circle-target.json`), measured
  from the reference with CV — never hardcoded per project.

---

## The pipeline (stages)

### 1. INGEST — transcribe + detect the speaker  (`multi-aroll-stage1.mjs`)
- **Do:** discover every clip in `public/uploads/arolls/`, transcribe each with
  Gemini (words + sentences, `is_complete` flag), and detect the face per clip with
  **OpenCV YuNet** (`detect_face_yunet.py`) — a real DNN, consistent across clips.
- **Failure prevented:** a brightness "face guesser" returned a *different wrong*
  box per clip, so circles framed inconsistently. YuNet gives one consistent box.
- **Gate:** every `clip_N_face.json` is `detector:"yunet"` with a consistent face
  height (regression-checked).

### 2. ALIGN — precise word timestamps  (`multi-aroll-align.mjs`)
- **Do:** force-align Gemini's words to the audio with **MMS** (torchaudio MMS_FA,
  1100+ languages incl. Uzbek) → exact per-word `[start,end]` (detector:"mms").
- **Failure prevented (the big one):** Gemini word timestamps drift **300–1000ms**
  (a last word's end can be a full second late). Trusting them clips words
  ("kerak", "Mahsulotingizni") AND blinds the checks that also trust them. Energy
  alone can't disambiguate a word's tail from filler. Forced alignment pins each
  word to the audio.
- **Setup:** the ~1GB MMS model crashes on the SSL proxy from Python; download it
  ONCE via PowerShell to `scripts/python/.torch/hub/checkpoints/model.pt`
  (`https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt`).
- **Gate:** word times are `detector:"mms"` (regression-checked).

### 3. SELECT — choose & order complete sentences  (`multi-aroll-stage2.mjs`)
- **Do:** Gemini picks the COMPLETE take of each sentence (drops false starts /
  duplicates / incompletes) and orders them into the narrative the reference uses
  (e.g. hook → problem → solution → CTA). Output: a rough timeline of segments,
  each tagged with `id = "C{clip}_S{n}"` (clip + sentence index — the exact key).
- **Failure prevented:** picking a false-start retake. The `id` indexes EXACTLY
  into `clip_N_transcription.json.sentences[n]`, disambiguating duplicates.

### 4. EDIT — trim, render, verify, auto-fix until READY  (`multi-aroll-closed-loop.mjs`)
The closed loop. Runs trim → render → all gates → targeted auto-fix → repeat.

- **Trim (sentence-anchored)** (`trim-validator.mjs`): cut each segment at its
  INTENDED sentence's first word onset and last word offset (from the precise MMS
  times), never the nearest word. Small fixed pre-roll/tail; no silence-hunting
  needed now that times are exact.
  - *Failure prevented:* nearest-word snapping stole a neighbour's word or dropped
    the segment's own first/last word.
- **Same-clip merge:** adjacent sentences from the SAME clip within ~0.6s are ONE
  continuous take — keep them merged (one overlay, natural pause kept, no jump cut,
  no split-overlay blank-circle). Detect contiguity from the ORIGINAL input times.
- **Crop (1:1 square, per `docs/cropping-rules.md`)**: crop the talking head to a
  square (YuNet), mask into the reference's circle or place in the stack. Verify on
  the RENDERED output that the head + shoulders are fully inside with a TOP GAP in
  EVERY sampled frame (the speaker moves); auto-tune the crop target until so.
- **Single-pass render** (`multi-aroll-stage3-4.mjs`): one FFmpeg command,
  `enable='between(t,...)'` switching, transparent-pad circle overlays with a
  frame-guard (no blank circle at clip changes), continuous audio.

#### The gates (ALL must pass before READY)
| Gate | What it guarantees | Check |
|------|--------------------|-------|
| Word completeness (100%) | no word cut / overlapping | deterministic, source words vs intended sentence + energy recheck |
| Boundary guard | first & last word of each segment really present in the OUTPUT | re-transcribe the rendered segment (Gemini), auto-extend if clipped |
| Boundary silence | no audible dead air at a cut | sustained-silence run < 180ms at junctions |
| Crop head-safety | head+shoulders inside circle, top gap, every frame | YuNet on the rendered circle |
| No blank circle | no transparent/B-roll flash at transitions | every-frame interior + transient-outlier check |
| Duration / layout / motion | structure matches the plan | existing QA checks |
| Gemini confidence | gross-error catch (Uzbek ASR self-agrees ~85-95%, so this is a floor, not a 95% gate) | re-transcription %, critical < 80% |

The deterministic word check + boundary guard are the REAL word guarantee; Gemini
is advisory (its Uzbek transcription isn't self-consistent enough to be a hard gate).

---

## Adding a new reference video (per-reference config)
1. Measure the reference's layout rhythm (per segment: circle vs stack) → write
   `reference-ground-truth.json`.
2. Measure the circle geometry + face-fill from the reference (YuNet) → the crop
   target. The crop auto-tunes from there on the rendered output.
3. Drop the raw A-rolls in `public/uploads/arolls/` and run the pipeline. Nothing
   else is per-project — clip count, names, and timings are all discovered.

## When something is wrong
- A word sounds cut → the boundary guard or deterministic check will flag it;
  trust ALIGNMENT over Gemini timestamps. Widen the trim via the guard's extend.
- A circle looks off → re-check head-safety on the RENDERED frames, not the source.
- Don't eyeball only: every iteration checks the TRANSCRIPT (no cut/overlap) AND
  the framing (head+shoulders+gap). See `.knowledge/lessons/multi-aroll-qa.md`.

## Source-of-truth files
| Concern | File |
|---------|------|
| This rule | `docs/aroll-pipeline.md` (you are here) |
| Crop rule | `docs/cropping-rules.md` |
| Lessons | `.knowledge/lessons/multi-aroll-qa.md` |
| Clip registry (generic) | `scripts/lib/aroll-clips.mjs` (reads `stage1-summary.json`) |
| Trim logic | `scripts/lib/trim-validator.mjs` |
| Forced alignment | `scripts/python/align_mms.py` |
| Closed loop (FFmpeg path) | `scripts/multi-aroll-closed-loop.mjs` |
| Boundary guard | `scripts/lib/boundary-guard.mjs` |
| Remotion-path gates | `scripts/reel2-crop-check.mjs` (head-safe), `scripts/reel2-cut-check.mjs` (no black-flash), `scripts/reel2-transcribe.mjs` (output transcript) |
| Remotion A-roll builder | `scripts/reel2-build-act1.mjs` (transcribe → MMS-align → word-anchor turns → head-safe band crop → rebuild props) |
| Regression suite | `scripts/test-regression.mjs` |
