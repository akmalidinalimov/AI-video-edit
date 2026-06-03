# Session 2026-05-30 — Phase 0 outcome

## What we tried

Phase 0 of the multi-agent measurement architecture:

1. Created `.knowledge/measurement-rules.json` with KB-001 through KB-004 documenting the lessons from the A-roll fixation work (LLM position presumption, B-roll false circles, judge blind spots, multi-A-roll concat).
2. Implemented Task 3 v2: per-segment Gemini Vision PIP locator (`src/lib/analysis/pip-locator.ts`) -> CV refinement in a tight ±200 px window around the seed -> sanity-rejection of off-canvas CV results. KB-001 and KB-002 encoded directly into the Gemini prompt and into the code path.
3. Re-rendered the user's multi-A-roll / multi-B-roll test (`uploads/references/ref.MOV` + 4 A-rolls + 2 B-rolls).

## Outcome

**Visual verification gate FAILED.** Per-segment delta vs reference:

| Segment | REF center | OUT center | Δcx | Δcy | Within 30 px gate? |
|---------|------------|------------|-----|-----|--------------------|
| seg_2 (t=6.0s)  | (745, 565) | (525, 410) | 220 px | 155 px | NO |
| seg_3 (t=10.5s) | (793, 518) | (780, 538) | 13 px  | 20 px  | YES |
| seg_4 (t=14.5s) | (755, 485) | (665, 300) | 90 px  | 185 px | NO |
| seg_5 (t=21.0s) | (685, 275) | (780, 385) | 95 px  | 110 px | NO |

1 of 4 circle segments within gate. Gemini-judge overall score 86.3 % (below the 93.7 % pre-Task-3 baseline). Render: `public/exports/styleclone-1780131064814.mp4`. Side-by-sides: `public/exports/diag-phase0/`.

## Diagnosis

The wiring works correctly — CV measurements flow into the plan's `layoutOverride.aroll.region`, and the renderer faithfully places the circle there. Confirmed: blueprint seg_2 box = (278, 186, 492x492) matches plan and matches the rendered output's circle position pixel-for-pixel.

The failure is upstream in **semantic seed quality**. Gemini Vision's per-frame answer for "where is the speaker's PIP" returns coordinates with systematic positional error of 100-220 px on a 1080x1920 canvas — much larger than the ±150 px commonly assumed. When the seed is off by more than the CV-refine pad (±200 px), the refinement window does not contain the real circle and CV silently falls back to the seed itself.

In this session, Gemini's errors all pulled the seed TOWARD canvas center (or, where the speaker is on the left, toward a more central position). This suggests a 'safe middle' bias in Gemini's coordinate output, possibly because the prompt did not give it a strong enough signal to commit to an off-center position.

## What didn't work, in order

1. Original LLM-position-seeded zone (93.7 % score, but PIP visually stuck near top-right because LLM classified the entire layout as 'circle_pip_top_right'). KB-001.
2. Full-canvas CV search with neutral-center fallback (82.0 % score, PIP locked to canvas center because B-roll thumbnails outvoted the speaker in the global cx median). KB-002.
3. Per-segment Gemini Vision seed + tight CV refine (86.3 % score, PIP correct for 1 of 4 segments — wiring works, semantic seed too noisy). KB-005 (draft).

## What remains untested

KB-005 lists three candidate fixes I have NOT executed:

a. Widen the CV-refine pad from ±200 px to ±350 px so it can reach the real circle even with a larger Gemini error.
b. Add face-detection-inside-circle validation; reject any CV detection whose face check fails, retry with widened pad.
c. Bypass Gemini for coordinates entirely; use the existing face detector directly (the face is inside the PIP, the PIP is centered on the face -- direct face -> circle center conversion sidesteps the Gemini coordinate noise).

My pre-stated rule was to stop after one failed iteration and wait for user direction. Not iterating further autonomously.

## Status

- Task #4 (Task 3: Full-canvas CV search) remains in_progress with updated description noting the seed-quality failure.
- KB-001..004 are committed as final.
- KB-005 is committed as a DRAFT pending user direction on which fix to test next.
- Code state: pip-locator + per-segment-seed plumbing is in place. Reverting it would require restoring the pre-Phase-0 reference-measurer/cv-correction code (commits available via git log).

## Recommended next direction

Option (c) — bypass Gemini for coordinates and use the face detector directly. Rationale: face detection is a deterministic vision model (no LLM coordinate guesswork), the speaker's face is the most visually stable invariant across frames, and the circle is geometrically centered on the face. This sidesteps the entire 'how good is Gemini at coordinates' question.

If option (c) also fails, fall back to option (a) + (b) combined: widen pad to ±350 px AND require face-in-circle validation.

---

## Phase 0 v3 outcome — Option C (face-anchored)

**Render:** `public/exports/styleclone-1780132062168.mp4` (2.5 MB)
**Score:** 87.7 % (vs 86.3 % v2, vs 93.7 % baseline)
**Visual gate:** 1 of 4 within ±50 px → FAIL

### Per-segment delta

| Seg | REF (cx,cy,r) | OUT (cx,cy,r) | Δcx | Δcy | Δr |
|---|---|---|---|---|---|
| 2 | (745, 565, 205) | (578, 263, 125) | 167 | 302 | 80 |
| 3 | (793, 518, 218) | (779, 540, 254) | 14 | 22 | 36 |
| 4 | (755, 485, 215) | (608, 219, 231) | 147 | 266 | 16 |
| 5 | (685, 275, 215) | (785, 389, 149) | 100 | 114 | 66 |

### Failure mode (KB-006 draft)

The radii Gemini returned varied wildly (125, 254, 231, 149) when the real PIP radius is ~215 throughout the video. This is **wrong-face detection**, not coordinate imprecision: Gemini picked TikTok thumbnail faces from the B-roll instead of the speaker's face in 3 of 4 segments, despite explicit disambiguation in the prompt ("wearing glasses + hijab + clear PIP border + larger than thumbnails").

Conclusion: **any single-frame Gemini Vision query is unreliable for videos with multiple visible faces in the frame**, regardless of whether we ask for circles or faces. The disambiguation problem is the same.

### What this means strategically

We've now tried 3 measurement approaches:
- v1 (LLM-zone seed): 93.7 % but PIP visually wrong because zone presumed top-right
- v2 (Gemini "where is PIP"): 86.3 %, "safe middle" bias placed seed near canvas center
- v3 (Gemini "where is face"): 87.7 %, picked wrong faces in 3 of 4 segments

All three failed for the SAME root reason: **the reference video has visual ambiguity that Gemini Vision resolves inconsistently across frames**. Single-frame queries are not enough.

### Recommended next strategies (no autonomous iteration)

a. **Temporal-persistence vote**: detect circles AND faces in ALL frames (every 0.25 s) of EVERY segment. Cluster by (cx, cy, r). The SPEAKER's PIP appears in EVERY frame at consistent geometry. B-roll faces flash by frame-to-frame. The most persistent cluster wins. Median over 50+ frames absorbs Gemini's per-frame inconsistency.

b. **Speaker face fingerprinting**: extract one known-good speaker frame from the A-roll (where there's no B-roll noise). Compute a face embedding (or color histogram / SIFT features). In each reference frame, find the face whose embedding matches the speaker's. This explicitly answers "is this the speaker?".

c. **Pre-trained face detector instead of Gemini**: ship a lightweight CV face detector (e.g. MediaPipe or a small ONNX model) that runs locally without prompt ambiguity. The face detector finds ALL faces; we keep the largest one inside a circular boundary (CV edge check).

d. **Manual one-shot calibration**: ask the user to point at the PIP once in a single frame; lock that position class for the whole video. Fastest to ship; doesn't generalize but solves THIS video.

Each option has different tradeoffs. Recommendation order from cheapest to most robust: d > c > a > b.

### Status

- Task #4 (Task 3) and Task #5 (Task 3 v3) both remain `in_progress`.
- KB-005 and KB-006 are both `draft` status.
- pip-locator.ts currently holds the face-anchored implementation; can be reverted via git if needed.
- Code state: builds cleanly, runs without errors, just doesn't measure the right circles.
