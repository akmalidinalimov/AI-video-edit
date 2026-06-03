# Cropping Rules — Talking-Person Crop (the GO-TO guide)

> **Whenever the pipeline crops a talking person (A-roll), it MUST follow this.**
> This encodes the user's hand-drawn diagram (`cropping-rules.png`). Re-read it
> before writing or changing any crop math.

## The one rule: ALWAYS crop the person to a 1:1 SQUARE

The atomic unit for any talking person is a **1:1 square** — never a stretched
16:9 band, never a stretched 9:16 strip. You take a square out of the source
(whatever the source aspect), then PLACE that square per the reference layout.

This is true for BOTH source orientations:

```
SOURCE 9:16 (portrait)            SOURCE 16:9 (landscape)
┌──────────┐                      ┌───────────────────────┐
│          │                      │      ┌─────────┐      │
│  small   │                      │      │  1:1    │      │
│  gap     │                      │ B    │ square  │  B   │
│ ┌──────┐ │  ← 1:1 square        │ roll │ (face,  │ roll │ ← 1:1 square
│ │ face │ │    around face       │ side │ head+sh)│ side │   around face
│ │ head │ │    head + shoulders  │      └─────────┘      │   head+shoulders
│ │+shldr│ │    ~90% fill         └───────────────────────┘
│ └──────┘ │
│          │
└──────────┘
```

## How to size and place the square

1. **Find the face.** Get face center (x, y), head-top y, and face height.
2. **Small gap above the head.** Leave a small margin (~8% of the square) between
   the top of the head and the top of the square. Never clip the top of the head.
3. **Include shoulders.** The square must show the head AND some shoulder/chest —
   not a floating head. Size the square so the head occupies ~35–45% of its height,
   leaving room for the small top gap and shoulders below.
4. **~90% fill.** The talking person should fill ~90% of the square. Not a tiny
   head in a sea of background, not an extreme close-up.
5. **NO zoom by default.** Never zoom in unless the user explicitly asks. Default
   is a natural medium shot.
6. **Center horizontally on the face**, clamped so the square stays inside the
   source frame.

## What to do with the square (placement)

The square is the building block. Placement depends on the reference layout:

- **Circle PIP** → mask the square into a circle, overlay on the full-canvas
  B-roll background (top-right, per reference geometry).
- **Stacked / "fullscreen"** → DO NOT stretch into a band. Place the 1:1 square
  (scaled to 1080×1080) at the **top** of the 1080×1920 canvas; fill the
  **bottom** (1080×840) with B-roll. (Top/bottom split — the standard 9:16 reel
  layout.) Square may also be centered or placed at the reference's position if
  the reference dictates.
- **Keep as square / other** → future reference styles may keep the square as-is
  or use other placements; the SQUARE crop step is unchanged regardless.

## Stacking A-roll + B-roll (and 3+ layers later)

Inside one reel we stack videos: A-roll (the square) + B-roll. The square is
always the talking person; B-roll fills the remaining canvas (top, bottom, or
background). This keeps both looking professional. The same principle extends to
3+ stacked sources: each talking person → its own 1:1 square; non-person footage
fills the rest.

## Quality gate (the system must self-check)

After cropping, ANALYZE the result and reject/iterate if:
- the top of the head is cut off,
- the chin or shoulders are cut off (floating head),
- the face is over-zoomed (fills >~95%, looks like an extreme close-up),
- the person is too small (<~70% fill, too much background).

When a crop is off, the system should adjust and offer 2–3 improved versions
(varying the head+shoulder ratio) for comparison.

## Iteration rule — check BOTH transcript and visuals (don't eyeball only)

When iterating on an edit, a looks-only review misses two whole classes of defect.
Every iteration you MUST:
1. **Check the transcript** — transcribe/derive the edited output and confirm each
   segment keeps its intended sentence COMPLETE (no word cut at the start/end, no
   neighbour sentence bleeding in). See `scripts/lib/transcript-verify.mjs`.
2. **Check the framing on the RENDERED output, every sampled frame** — the speaker
   moves, so confirm the circle holds the head AND shoulders with a clear TOP GAP
   in the worst frame, not just the median. See `scripts/multi-aroll-crop-check.mjs`
   (YuNet on the rendered circle).
3. **Check boundary silence** — no dead air at a cut.

The closed loop `scripts/multi-aroll-closed-loop.mjs` enforces all three and
auto-tunes the crop; never present a result that hasn't passed it.

## How to ADD a top gap (encoded)

Top of the head clipped by the circle? LOWER `faceFraction` (smaller face → more
margin all round) and RAISE `faceCenterYIn` (push the face DOWN → headroom above).
Converged head-safe values live in `reference-circle-target.json`
(`faceFraction ~0.48`, `faceCenterYIn ~0.457`); the crop-check auto-tunes them from
YuNet measurements on the rendered circle.

## Position by FACE CENTER, and a band is a CROP — never a stretch

Position the crop window by the **face-box CENTER** at a target fraction of the
region (≈0.45–0.46), as `calculateSquareCrop` does (`faceCenterYIn`). This is robust
when the speaker LEANS IN: the face moves but its center stays near the same fraction,
so neither the head-top nor the chin clips. Anchoring to the (estimated) head-top is
fragile — it over-gives headroom and clips the chin on lean-in shots (reel-2 §13).

If the reference layout uses a wide BAND for the talking head (not a square — e.g.
reel-2's split-screen top), that is still a **crop, never a stretch**: take a window
of the band's aspect (e.g. 1080:840) sized/positioned head-safe, then scale. Verify
head-safety on the RENDERED output for ANY layout (circle OR band): reel-1 circle →
`scripts/multi-aroll-crop-check.mjs`; Remotion band → `scripts/reel2-crop-check.mjs`.

## Band sizing — use the lean-in MOTION ENVELOPE, prefer FULL-BLEED, letterbox is a minimal last resort

Encoded from reel-2 §13–§18 (the t3 turn, twice). For a BAND crop (not a square), three rules:

1. **Size from the motion envelope, not the median face.** The speaker LEANS IN: across the turn the
   crown rises and the chin drops. A window sized to the *median/static* face fits the median frame but
   clips the chin at the lean-in extreme. Take the per-frame extremes — **highest crown + lowest chin**
   across the detection samples — and size the window to the MINIMAL height that keeps that whole
   envelope head-safe (crown gap ≥ `GAP_MIN` 0.03, face bottom ≤ `BOTTOM_MAX` 0.99). `detectFace`
   returns `crownMinY`/`chinMaxY` from `j.samples`; `calculateBandCrop` consumes them.
2. **Prefer FULL-BLEED full-width; letterbox only when the envelope truly can't fit, and then minimally.**
   Do NOT zoom out to a fixed face fraction (the old `FACE_FRAC_TARGET=0.52` shrank one turn to half-size
   and added a 17%-per-side blurred pillarbox — visibly "cropped"/inconsistent with the other turns).
   Grow the window only as much as the lean-in requires: most turns stay full-width (no bars); a close
   lean-in gets a *thin* (~4%) side-fill, not a heavy one. Consistency across turns matters — a single
   turn framed differently reads as a defect.
3. **A re-encode that uses `-filter_complex` MUST `-map 0:a` (or it silently drops audio).** ffmpeg's
   automatic audio passthrough is OFF whenever `-filter_complex` is used. The letterbox branch uses
   `-filter_complex`; without an explicit audio map the turn renders SILENT. (This is exactly how reel-2's
   t3 lost its audio while the simple `-vf` turns kept theirs.) Always map `[outv]` + `0:a?`.

## NEVER re-encode/overwrite a source clip in place — transform in the composition

Do all visual changes — crop, zoom, reframe, color grade — **in the render composition** (CSS
transform / objectFit / filter, or the band-crop step that writes to the turns dir), never by
re-encoding a source asset in `public/uploads/**` over itself. Sources are gitignored originals (no
undo) and an ad-hoc re-encode commonly drops the audio track. If you genuinely need a transformed clip
on disk, write it to a NEW path and point the props/manifest at it. To repair one turn, use the surgical
`node scripts/reel2-build-act1.mjs --recut-top <t>` (re-cuts head-safe + audio, touches nothing else).

## Source of truth in code

`scripts/multi-aroll-stage3-4.mjs` → `calculateSquareCrop()` is the single
implementation for the circle/stack square. The Remotion band variant is
`calculateBandCrop()` in `scripts/reel2-build-act1.mjs` (same head-safe intent,
band aspect). Do not reintroduce band-STRETCHING crop math.
