<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Video editing / style cloning

Before working on any video-edit or style-clone task, read
`docs/style-cloning-principles.md` — 13 learned rules for faithfully
replicating a reference layout (measure-vs-apply separation, deterministic CV
coordinate measurement, multi-frame median, glitch-free PIP motion, overlay-vs-
content text classification, single-pass FFmpeg, etc.). They are general and
apply to any edit style.

**Before ANY talking-person crop**, read `docs/cropping-rules.md` (the 1:1-square
rule, encoded from the user's diagram `docs/cropping-rules.png`) and
`docs/editing-craft.md` (framing, stacking, pacing). Core rule: always crop the
talking person to a 1:1 SQUARE (head + shoulders, ~90% fill, small top gap, no
default zoom), then place per the reference layout (circle mask, or top/bottom
stack with B-roll). Never stretch a portrait/landscape source into a band.

## A-roll editing — the GENERAL process (read first)

**`docs/aroll-pipeline.md` is the canonical, reference-agnostic rule for editing any
talking-head ("A-roll") footage to match a reference.** It is generic over the
number of A-rolls and any language. Don't build a per-video template — follow the
process. One command runs the whole thing:

```bash
node scripts/aroll-pipeline.mjs --gemini        # ingest -> align -> select -> edit (closed loop)
```

Two non-negotiables: (1) never cut a word/sentence; (2) never present an edit that
hasn't passed every closed-loop gate. The deterministic word check + boundary guard
(re-transcribe the output) are the real word guarantee; word times come from MMS
FORCED ALIGNMENT, never raw Gemini timestamps.

## Multi-A-roll closed-loop QA (mandatory before presenting an edit)

Read `.knowledge/lessons/multi-aroll-qa.md` first. Before presenting ANY edited
multi-A-roll video, run the closed loop (the EDIT stage of the pipeline above) — it
renders, verifies, auto-tunes, and only declares READY when EVERY gate passes:

```bash
node scripts/multi-aroll-closed-loop.mjs --method 2 --gemini
```

Gates (never present unless all pass): word completeness 100% (each segment keeps
its intended sentence COMPLETE — no cut/overlap), no boundary dead-air, crop
head-safety (top gap + head&shoulders, every sampled frame), no blank circle,
boundary-guard (output re-transcription confirms first/last word of each segment).

Key rules:
- **Precise word times come from MMS FORCED ALIGNMENT**, not raw Gemini timestamps
  (which drift 300-1000ms and clip words). Run `node scripts/multi-aroll-align.mjs`
  after transcription; it writes detector:"mms" times. One-time ~1GB model download
  via PowerShell (see `.knowledge/lessons/multi-aroll-qa.md`).
- Anchor trims to the intended sentence by `id`; the deterministic word check is the
  100% gate; the boundary-guard (`scripts/lib/boundary-guard.mjs`) re-transcribes the
  OUTPUT and auto-extends any clipped boundary word.
- Same-clip adjacent sentences (within ~0.6s) stay merged as one continuous shot.

## Mandatory regression test

**Before committing ANY change to pipeline code**, run:

```bash
node scripts/test-regression.mjs
```

This executes 8 structural checks in ~2 seconds. ALL must pass.

For full verification (after render changes), also run:

```bash
node scripts/test-regression.mjs --full
```

This adds 3 render-based checks (audio continuity, black frames, duration) ~30s.

If ANY check fails, **DO NOT COMMIT**. Fix the regression first.

When fixing a bug, **add a new check** to `test-regression.mjs` that would
catch the bug if it ever returns. Follow the pattern in the file header.

### Hard rules enforced by the regression suite

1. **Sentence boundaries**: ALL layout transitions must snap to sentence
   boundaries. No mid-sentence PIP position/size changes.
2. **Single-pass FFmpeg**: Never render segments separately and concatenate.
   One FFmpeg command, `enable='between(t,...)'` switching. `-map 1:a` for audio.
3. **Contiguous enables**: No gaps between enable expressions (causes black frames).
4. **Frame alignment**: Range boundaries must be frame-aligned (`time * fps` is integer).
5. **Audio continuity**: Audio is mapped directly from continuous A-roll input, never
   filtered/split per segment.
