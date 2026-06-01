# Multi-A-Roll Pipeline — Session Handoff

**Date:** 2026-05-31
**Status:** 3 reported defects FIXED and validated. Ready for next phase (agentic workflow build).

---

## What was fixed this session

The user reported three defects in the latest render. All three are now fixed and verified.

### 1. Blank circle at A-roll transitions ✓ FIXED

**Symptom:** When the A-roll switched, the white border ring showed for ~1-2 frames with no face inside.

**Root cause:** Enable expressions used a half-frame offset (`alignedStart - 0.5/FPS`) while the transparent pad duration used the full `alignedStart`. During that ~16ms gap the border ring (a `d=999` color source, always present) showed but the circle content (padded) was still transparent.

**Fix** (`scripts/multi-aroll-stage3-4.mjs`):
- Removed all half-frame offsets. Enable expressions now use exact frame-aligned boundaries (`range.alignedStart.toFixed(4)`).
- Pad duration (`timelineStart = range.alignedStart`) now exactly equals enable start. Border ring and circle content appear on the same frame.
- Adjacent segments share the boundary frame; the later overlay in the chain wins (correct next segment).

### 2. Sentence cuts mid-way ✓ FIXED

**Symptom:** At ~11s (seg 1) audio cut before the sentence ended; at ~24s (seg 3) it included ~720ms of trailing silence.

**Root cause:** Gemini transcription timestamps were imprecise. Trim points didn't align to actual speech boundaries.

**Fix** (`public/exports/multi-aroll/stage2/clean-timeline.json`) — derived from `silencedetect`:
- Seg 1 (clip 0 IMG_6751): sourceEnd `16.88 → 17.20` (speech actually runs to 17.237s).
- Seg 3 (clip 1 IMG_6752): sourceEnd `24.971 → 24.25` (sentence ends at 24.251s; removed 720ms trailing silence).
- totalDuration `36.61 → 36.24`. Timeline starts/ends recomputed downstream.
- Each corrected segment carries a `_trimNote` explaining the change.

### 3. Audio delay between sentences ✓ FIXED

**Symptom:** User wanted zero-delay back-to-back sentences, not the prior 50ms crossfade.

**Fix** (`scripts/multi-aroll-stage3-4.mjs`, `buildAudioConcat()`):
- Same-clip contiguous segments (e.g. seg 2→3, both from clip 1): hard `concat` filter, zero delay.
- Different-clip segments: minimal 33ms (1-frame) anti-click crossfade only — imperceptible, not a gap.

---

## Validation results

**Automated** (`node scripts/multi-aroll-verify.mjs --method all`): OVERALL PASS, all 7 checks green on all 3 methods.
- Check 7 (NEW — transition-frame blank-circle detection): 0 blank circles detected.
- Audio gaps: 0 critical.
- Duration: 36.30s actual vs 36.24s expected (within encoder tail).

**Manual** (the user-flagged points):
- Silence detection on final output: NO gap at seg 1→2 boundary (12.40s, old "11s cut"), NO gap at seg 3→4 boundary (25.909s, old "24s trailing silence"). Only a natural 330ms mid-speech pause within seg 2 (speaker's own delivery) and trailing end.
- Visual frame inspection at all 4 transition boundaries (5.21s, 12.40s, 18.72s, 25.909s) ±2 frames: face present in circle at every frame, no bare ring.

---

## Current file state

| File | State |
|------|-------|
| `scripts/multi-aroll-stage3-4.mjs` | Fixed (enable offsets, audio concat). B-roll path = `public/uploads/IMG_6163.MP4` |
| `scripts/multi-aroll-verify.mjs` | Enhanced with Check 7 (transition frames) |
| `public/exports/multi-aroll/stage2/clean-timeline.json` | Corrected trims + `_trimNote` annotations |
| `public/exports/multi-aroll/stage4/method-{1,2,3}-rendered.mp4` | Re-rendered, all pass verification |
| `docs/multi-aroll-spec.md` | Full architecture spec + agentic workflow design |

**Source assets** (Windows paths):
- B-roll: `C:\Users\akmal\styleclone\public\uploads\IMG_6163.MP4`
- A-rolls: `C:\Users\akmal\styleclone\public\uploads\arolls\IMG_675{1,2,3,4}.MOV`
- Face data: `C:\Users\akmal\styleclone\public\exports\multi-aroll\stage1\clip_{0-3}_face.json`

**Tooling:**
- FFMPEG: `node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe`
- FFPROBE: `node_modules\@remotion\compositor-win32-x64-msvc\ffprobe.exe`

---

## PHASE A (2026-05-31) — COMPLETE: 4 new defects fixed

Beyond the original 3 fixes, the user found 4 more defects. All fixed:

1. **Seg 0 was a circle, should be 16:9 (Defect 1)** — `multi-aroll-stage3-4.mjs` no longer hardcodes circle. New `loadReferenceLayout()` reads `public/exports/sp-temp/reference-ground-truth.json` (seg_1=rectangle, seg_2..5=circle) and assigns `range.layoutType` per reference. Hook now renders 16:9.
2. **Gap between seg 1→2 + 25s mid-sentence cut (Defects 2&3)** — new reusable `scripts/lib/trim-validator.mjs` (pure module; reads precomputed `clip_N_silence.json` maps) snaps each segment's sourceStart→speech onset and sourceEnd→speech offset, then rebuilds a contiguous zero-gap timeline. Reproduces the old manual fixes automatically from raw Gemini values; generalizes to any clip set.
3. **Inconsistent circle headroom (Defect 4)** — `calculateCircleCrop()` rewritten: square size driven by face HEIGHT (face fills a constant fraction of the circle) + separate head-top gap; centered on face X. Consistent framing across clips.
4. **Hook chin cut off (found mid-Phase-A)** — `calculateRectCrop()` now places the face center at a fixed fraction down the 16:9 band (M1 0.46 / M2 0.38 / M3 0.42) → full face with headroom, chin in frame.

**Verifier** (`multi-aroll-verify.mjs`) now has 9 checks — added Check 8 (layout: rect segments are full-width 16:9) and Check 9 (sentence-cut: trims within 0.2s of silence boundaries). All 3 methods PASS.

Silence maps generated for all 4 clips: `public/exports/multi-aroll/stage1/clip_N_silence.json`.

## PHASE A.2 (2026-05-31) — COMPLETE: 1:1-square crop model + stacked layout

User feedback (with a hand-drawn cropping diagram) corrected the crop model. The
hook's 16:9 band stretched the 9:16 portrait → giant, head-clipped face. Fixed:

- **The atomic crop is now ALWAYS a 1:1 square** (`calculateSquareCrop()` in
  `multi-aroll-stage3-4.mjs`) — the single source of truth for BOTH circle and
  stacked layouts. Shows head + shoulders, no stretch, no default zoom.
- **Stacked layout for "rectangle"/hook**: the 1:1 square (1080×1080) is placed
  at the TOP of the canvas, B-roll fills the bottom 840px. Industry-standard 9:16
  top/bottom split. Replaced the band-stretch `calculateRectCrop` (deleted) and
  the header-zone black bar (removed).
- **Square sized for head + shoulders**: square = faceHeight / headFraction with
  a high floor (820px) because brightness-based face detection under-measures the
  head. M1 tight / M2 widest (full-width, most torso) / M3 balanced.
- **Guides saved**: `docs/cropping-rules.md` (encodes the user's diagram — the
  1:1-square rule), `docs/editing-craft.md` (framing/stacking/pacing from
  research), both referenced from `AGENTS.md`. The diagram image should be saved
  as `docs/cropping-rules.png` (binary, pending).
- **Blank circle re-checked**: all 4 transition boundaries ×(±3 frames) on the
  new render → 0 blank frames (both the verifier's Check 7 and a manual sweep).

Verifier: all 9 checks PASS on all 3 methods (0 critical). Timeline totalDuration
now 37.0s (silence-snapped trims). Comparison images:
`public/exports/multi-aroll/stage4/final2/cmp_*.png`.

**Deferred to Phase B (per plan):** full crop auto-self-correction loop (analyze
→ adjust → re-render → present best+alternatives), robust face detection (removes
the under-measurement workaround), and 16:9 source support (square model already
generalizes).

## Next phase (PHASE B): WhisperX-based flexible system (NOT yet built)

See plan file `C:\Users\akmal\.claude\plans\modular-floating-snowflake.md` § PHASE B. Locked decisions: WhisperX install for word-timing (Gemini keeps words/sentences for Uzbek), reference-layout auto-analysis, orchestrator + data-driven QA gate.

## (original) Agentic workflow architecture (NOT yet built)

The user wants a robust, agent-orchestrated pipeline so that "whenever an A-roll is uploaded, we always go through a workflow." Full design is in `docs/multi-aroll-spec.md` § Agentic Workflow. Summary:

```
Orchestrator Agent (knows who does what, verifies each step)
├── Trim Agent      → silence detection per source, validate sentence boundaries, output validated-trims.json
├── Assembly Agent  → build filter graph (pad+enable+mask), crop from face data, output filter-complex.txt
├── Render Agent    → execute single-pass FFmpeg, monitor, output MP4
└── QA Agent        → extract transition frames, audio checks, compare vs spec, output pass/fail + diagnostics
```

**Recommended build order for the fresh session:**
1. **Trim Agent first** — extract the silence-detection + boundary-snapping logic (currently done manually this session) into a reusable module `scripts/trim-validator.mjs`. This is the highest-value automation: it prevents the sentence-cut class of bugs at the source.
2. **Wire QA gate** — `multi-aroll-verify.mjs` already exists with 7 checks; wrap it as the QA Agent's tool. Make it block assembly if trims fail.
3. **Orchestrator** — a single `scripts/multi-aroll-orchestrator.mjs` that runs Trim → Assembly → Render → QA in sequence, halting on any failure, with structured logging of each agent's verdict.
4. **Generalize inputs** — currently the timeline is hand-authored. The orchestrator should accept N A-roll uploads + 1 B-roll and produce the timeline via the existing Gemini transcription + narrative-ordering step (see `clean-timeline.json` structure).

**Key invariants to preserve (from `AGENTS.md` + spec):**
- Single-pass FFmpeg only — never concat video segments.
- All transitions snap to sentence boundaries (validated by Trim Agent BEFORE assembly).
- Frame-aligned boundaries; pad duration == enable start (the blank-circle invariant).
- Run `node scripts/test-regression.mjs` before committing pipeline changes.

**Open items / nice-to-haves:**
- The 330ms natural pause within seg 2 is the speaker's own delivery — acceptable, but the Trim Agent could optionally tighten intra-segment pauses if the user wants snappier pacing.
- Face data for clip 0 has a `_corrected` note (brightness detection found buildings, manually corrected to 0.38). A robust face-detection step would remove the need for manual correction.
- `docs/multi-aroll-spec.md` § Trim Validation Protocol defines the exact 5-point check the Trim Agent should implement.
