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

## Source of truth in code

`scripts/multi-aroll-stage3-4.mjs` → `calculateSquareCrop()` is the single
implementation of this rule. Both the circle and stacked paths consume its
output. Do not reintroduce band-stretching crop math.
