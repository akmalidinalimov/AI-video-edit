# Style-Cloning Principles (Learned)

Hard-won rules for faithfully replicating a reference video's layout onto new
A-roll/B-roll. These are **general** — they apply to any video edit style, not
just the test reference. Each rule is paired with the concrete evidence that
produced it.

---

## 1. Separate MEASUREMENT from APPLICATION — and suspect measurement first

The single biggest lesson. For a long time the layout "looked off" and every
instinct was to fix the renderer. The renderer was correct. **It was faithfully
applying wrong coordinates.**

- The reference analysis (LLM vision) had measured circle PIPs ~120–150px too
  high and ~60px too small, the rectangle A-roll ~80px too high, and header
  text too high and half-size.
- We reproduced those numbers perfectly — so the output was perfectly wrong.

**Rule:** When the output is geometrically off, first prove whether the stored
coordinates match the reference. Don't touch the application/render layer until
you've ruled out the source data.

## 2. Never trust LLM vision for pixel-precise coordinates

LLM vision (Gemini etc.) is excellent at **classification** — "this is a
circle", "this text is yellow", "B-roll fills the background" — and unreliable
at **absolute pixel bounding boxes**. The errors are large (50–150px) and
systematic (it biased circles up-and-small consistently).

**Rule:** Use the LLM for *what* and *which*, use deterministic computer vision
for *where* and *how big*.

## 3. Measure from the actual reference pixels (deterministic CV)

Replace estimates with measurement:

- **Circles** → gradient-Hough: every edge pixel votes for a center along its
  gradient direction at each candidate radius; the true center wins because its
  whole perimeter votes consistently. Pick radius by **mean perimeter edge
  strength** (not a count — counts bias toward large radii that sweep clutter).
- **Rectangles (full-width A-roll)** → row-brightness/texture profile: the
  talking-head video is a long, sustained bright band, unlike the short bright
  bands of header text above it. Detect the top edge there; derive height from
  the source aspect ratio (more stable than detecting a dark lower edge).
- **Text lines** → row-projection of "ink" pixels groups contiguous bright rows
  into bands; column extent gives the box.

This is free, instant, deterministic, and pixel-accurate. `sharp` (raw pixel
access) is enough — no OpenCV required.

## 4. Diagnose by overlaying stored values on ground truth

The breakthrough moment was drawing the stored bounding boxes (red) directly
onto the real reference frame. The mismatch was instantly visible.

**Rule:** Before debugging logic, *render the data against reality*. One overlay
image is worth a hundred lines of speculation. Draw detected (green) vs stored
(red) side by side.

## 5. Multi-frame median beats single-frame detection

A single frame is corrupted by transient clutter (scrolling B-roll, a menu
overlapping the PIP, motion blur). The layout element is stable across a state;
the noise is not.

**Rule:** Sample N frames (~12) across a state, detect in each, take the
**median** and reject outliers. The stable element dominates; false peaks wash
out. Detection that fails on 1 frame succeeds on the median of 12.

## 6. Lock constants from physical reality; only vary what truly varies

Measured across the whole video, the PIP's **x and radius were constant** — it
only slid vertically. Treating every per-segment measurement as independent let
noise in. Locking x and radius to the global median (a two-pass approach: pass 1
finds the constants, pass 2 derives only the per-segment variable) made
detection dramatically more robust.

**Rule:** Identify which dimensions are invariant across the reference and
constrain them globally. Solve for fewer degrees of freedom = more robust.

## 7. Smooth repositioning is NOT a layout change (no glitch)

The sentence-boundary rule (layout switches only at sentence boundaries, to
avoid audio/video glitches) applies to **layout-TYPE changes (rect↔circle) and
hard cuts** — NOT to continuously moving an overlay. A circle that slides its
x/y over time is one continuous overlay: no cut, no encoding boundary, no audio
touch.

**Rule:** Replicate intra-sentence motion (a PIP that drifts) by animating the
overlay position (`overlay=x='<expr of t>':y='<expr of t>'`) within the single
FFmpeg pass. Match the reference's actual motion profile — usually
**hold-then-move** (piecewise-constant with short transitions at boundaries),
not a constant linear slide. Linear interpolation across a whole range drifts
the element away from where the reference held it steady.

## 8. Distinguish editor overlays from source content

B-roll/app-UI text that happens to be in the reference must **not** be re-drawn
as an overlay (it belongs to the B-roll source, which differs in the edit).

**Rule:** Classify text by authoritative signals: over a full-screen background
B-roll, *all* detected text is content → skip. Otherwise, treat text inside a
real header/black strip (a top band, not a full-canvas region) as an editor
overlay. The template's `isBackground` flag is more reliable than a per-segment
bounding box.

## 9. Size text from its bounding box, not the font-size estimate

Headlines fill their bounding box. The LLM's per-glyph font-size estimate was
consistently too small (rendered text looked shrunken). Box height is the better
signal: `fontSize ≈ boxHeight × ~0.9`.

## 10. Match typeface by STYLE class, not exact font

Classify each text's style (serif/display/sans/rounded/script/mono +
italic/weight) and map to the nearest bundled local font (e.g. didone/display →
Bodoni Bold Italic; rounded sans → Trebuchet Bold). Exact font identification is
rarely worth the effort; style-class matching captures ~90% of the visual
character.

## 11. Prefer strict confidence gates over risky auto-features

A wrong automated transform is worse than not transforming. Example: splitting a
headline into per-word colors ("2026-yil" yellow + "SMM" white). When detection
fragmented on thin serif strokes, a naive split produced garbled text
("kerakkerak").

**Rule:** Gate aggressive features behind confidence checks (e.g. each color
must form one clean, non-overlapping block ≥18% of the line). If the check
fails, fall back to the safe single path. Silent correctness beats loud
breakage.

## 12. LLM verification scores are lenient AND noisy — don't over-trust them

The Gemini structural verifier scored 98% while coordinates were 150px off, and
scored the *same* render 91–100% across runs. It's a useful smoke test, not
ground truth.

**Rule:** For anything that must be pixel-precise, verify with an objective
measurement (detect the element in both reference and render, compare
center/radius/box numerically), not only an LLM judgment. And always eyeball a
human side-by-side — it catches what the score smooths over.

## 13. Single-pass FFmpeg, always

One command, continuous inputs, layout switching via `enable='between(t,…)'`,
audio mapped straight from the continuous A-roll (`-map 1:a`). Per-range B-roll
offsets, per-range overlay positions, and animated x/y all live inside this one
pass. Never render segments separately and concatenate — concat creates flashes
at video boundaries and pops/gaps at audio boundaries.

---

## The pipeline shape this produces

```
Reference video
  → LLM analysis (classification: shapes, colors, layout types, content tags)
  → CV measurement (pixel-exact geometry: circle/rect/text boxes)   ← Rule 2,3
       • multi-frame median + outlier rejection                     ← Rule 5
       • global constants locked, per-segment variable solved       ← Rule 6
  → Layout Map (the reusable virtual-coordinate template/library)
  → Plan builder (sentence-aligned layout TYPE; PIP motion keyframes) ← Rule 7
  → Single-pass FFmpeg render                                        ← Rule 13
       • per-range overlay positions, animated where the ref moves
       • editor-overlay text only, sized from its box, style-matched ← Rule 8,9,10
  → Verification (LLM smoke test + objective pixel deltas + human eye) ← Rule 12
```

## Quick debugging checklist when "the layout looks off"

1. Draw stored coordinates onto the real reference frame. Do they match? (Rule 4)
2. If not → fix measurement (CV), not the renderer. (Rule 1)
3. If yes but it still looks off → check the application: overlay position,
   crop, scale, enable expressions.
4. Detection flaky? Median more frames; constrain invariants. (Rule 5, 6)
5. Element moves within a sentence? Animate position, don't cut. (Rule 7)
6. Unwanted text? Check the overlay-vs-content classifier. (Rule 8)
