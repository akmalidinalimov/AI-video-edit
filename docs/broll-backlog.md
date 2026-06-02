# B-roll Generation — Improvement Backlog

The content-aware B-roll system (`scripts/lib/broll/` — classifier + pluggable strategy
registry behind a stable contract; see `docs/broll-generation.md`) is **production-usable
and ISOLATED**: every item below can be implemented by editing one strategy/classifier file
without touching the orchestrator, gates, renderer, or A-roll pipeline. The 15-check
regression suite guards against breaking anything. So these are **on-demand, not blockers** —
prioritize them as real reels surface concrete needs.

## How it works / how to think about each
Each item lists: *what*, *why*, *where it'd live* (the isolated file), and *priority*.

## 1. Smarter, multi-label classification
- **What:** a segment can be BOTH a service pitch AND mention products; today `classifier.mjs`
  picks one `contentType`. Allow a primary + secondary label, or a confidence-weighted blend,
  so e.g. "service that makes product content" can mix team + product beats.
- **Where:** `scripts/lib/broll/classifier.mjs` (+ registry routing).
- **Priority:** medium. (Reel 1 seg1 already worked via the cross-cutting product rule.)

## 2. Deeper entity extraction → more specific beats
- **What:** extract concrete nouns/actions the speech names (a specific product, tool, place,
  emotion) and feed them into the beat prompts so beats depict EXACTLY what's said, not a
  generic stand-in.
- **Where:** `classifier.mjs` (entities) → strategy prompts.
- **Priority:** high (biggest relevance lever).

## 3. Relevance-driven re-planning loop
- **What:** today the relevance gate is advisory and reported; close the loop so a low-relevance
  beat is automatically RE-PLANNED (adjusted concept/entity) and regenerated, like the cleanliness
  gate already does for text.
- **Where:** orchestrator `--ingest` + a `replan(beat, reason)` in the strategy.
- **Priority:** high.

## 4. Keep a dull→styled CONTRAST within product VARIETY
- **What:** in variety mode, relevance dipped (65) vs the single-product dull→hero arc (90). Let the
  product strategy express the "must be attention-grabbing" contrast ACROSS the varied products
  (e.g. beat 0 dull, beats 1-2 stunning different products) to lift relevance while staying varied.
- **Where:** `scripts/lib/broll/strategies/product.mjs` (variety prompt).
- **Priority:** medium-high (directly addresses the reel-1 seg1 score).

## 5. Image-to-video (`start_image`) for composition + identity hold
- **What:** generate a clean still first (image model), then animate it as the beat's `start_image`
  — gives compositional control (reserve the PIP corner) and stronger product-identity hold in
  IDENTITY mode (same product across beats).
- **Where:** strategy emits an image step; orchestrator generates image → video.
- **Priority:** medium.

## 6. Brand consistency across beats
- **What:** carry a shared "brand grade" (lighting, palette, set style) across a segment's beats so a
  variety of products still feels like one brand; optionally a per-reel brand kit.
- **Where:** `_shared.mjs` system fragment + per-reel config.
- **Priority:** low-medium.

## 7. Non-generated B-roll KINDS (the contract already declares them)
- **What:** implement `Beat.kind` values beyond `generated`:
  - `image_sequence` — the reference's "storyboard frames highlighted one-by-one" style: an ordered
    set of provided images, each held/zoomed (Ken-Burns) for its step.
  - `screen_recording` — use a REAL screen capture for genuine app/tool demos (no fabricated UI).
  - `stock` — pull a matched stock clip when generation isn't ideal.
- **Where:** `strategies/tutorial.mjs` (already stubbed + TODO'd) + a small renderer consumer.
- **Priority:** medium (needed when a reel is a tutorial/screen demo).

## 8. Tune the relevance gate (weighting + thresholds)
- **What:** the 3-frame × 3-vote average is stable but conservative; consider weighting the
  "payoff" frame higher, or per-content-type thresholds.
- **Where:** `scripts/multi-aroll-broll-verify.mjs`.
- **Priority:** low.

## 9. Better "what to show / how to show" reasoning
- **What:** a deeper director pass that reasons about narrative beat purpose (hook vs proof vs CTA)
  and picks shot TYPE accordingly (macro detail, wide establishing, in-use, reaction), not just
  content. Tie to the reference's editing rhythm.
- **Where:** `strategies/*` system prompts + the classifier's narrative signal.
- **Priority:** medium.

---
Pointer: `.knowledge/lessons/multi-aroll-qa.md` §12 and `[[broll-generation-system]]`.
