# Transitions (between shots/segments)

Use sparingly and ONLY where the reference uses them — most modern social cuts are HARD cuts (no transition).
For real scene transitions prefer `@remotion/transitions` (`<TransitionSeries>`); the snippets below are the
manual equivalents. Cross-ref `remotion-best-practices/rules/transitions.md`.

> **Hard cut (default).** No pattern — just adjacent segments. Do NOT fade-from-black at internal cuts
> (only fade segment index 0). This is the black-flash rule; `reel2-cut-check.mjs` guards it.

---
## whip-pan (swish)
- **When:** energetic same-energy cut; fast directional blur between shots.
- **Signature:** outgoing shot slides+blurs out one way, incoming slides in same direction; ~5-7 frames.
- **params:** `{ atF, dur:6, dir:"left", blurPx:18 }`.
- **Concrete ranges @30fps:**
  - **duration:** `5…7f` total (≈0.2s) — a whip MUST be fast or it reads as a slow slide.
  - **translate:** outgoing `0% → -100%`, incoming `+100% → 0%` over the SAME window (same direction = the "whip").
  - **blur:** peaks at `12…20px` mid-transition, scaled by distance `Math.abs(o)/100*blurPx` so it's 0 at the ends.
  - **easing:** `Easing.in(Easing.cubic)` out / `Easing.out(Easing.cubic)` in, clamped — accelerate away, decelerate in.
  - keep both shots mounted (two stacked AbsoluteFills) only for the transition window; cut to a single layer after.
- **Snippet:**
```tsx
// outgoing
const o = interpolate(frame, [atF, atF+dur], [0,-100], ease); // % translateX
// style A: transform:`translateX(${o}%)`, filter:`blur(${Math.abs(o)/100*blurPx}px)`
// incoming starts at +100% → 0 over the same window
```
- **source:** `@remotion/transitions` `slide()` analog (manual). Note: the repo's reel-2 path prefers HARD CUTS — only whip where the reference actually swishes.

---
## match-cut
- **When:** continuity between two visually-aligned shots (shape/position carries across the cut).
- **Signature:** NO dissolve — align a common element's position/scale on both sides so the cut "matches".
- **params:** `{ atF, anchorBox:{x,y,w,h} }` — author both shots so the anchor lands identically at `atF`.
- **note:** this is a COMPOSITION constraint, not an animation: place the shared element at the same
  on-screen box in the last frame of shot A and first frame of shot B. The Editor role enforces it.
- **Concrete tolerances:** the anchor box should land within **±~10px** position and **±~3%** scale across the cut
  (closer = cleaner). The cut itself is a HARD cut (`dur=0`) — there is NO dissolve/blur; the match IS the effect.
  Tip: if push-in is active, freeze `camS` to the same value on the last A-frame and first B-frame so scale matches.
- **source:** layout discipline (no snippet — it's framing); enforced by the editor/crop gates, not a motion param.

---
## cross-dissolve (fade between)
- **When:** soft, reflective mood; B-roll montages; time passing.
- **Signature:** outgoing opacity 1→0 while incoming 0→1 over the overlap window.
- **params:** `{ atF, dur:12 }`.
- **Concrete ranges @30fps:**
  - **duration:** `8…18f` (`12` ≈ 0.4s is the repo's value — `SplitChrome` fades the Act-1 chrome out over `FADE=12`, Reel2 line 287).
  - **easing:** `Easing.bezier(0.16,1,0.3,1)`, both ends clamped (the repo default; a one-sided clamp keeps it from flickering past the window).
  - **first-segment open:** the only fade-FROM-BLACK allowed is segment index 0, over `[0,4]` (Reel2 `fadeIn`, line 192-193); internal cuts are HARD (no per-cut fade-from-black — the black-flash rule).
  - **music bed under a dissolve:** keep `<Audio volume={0.25} />` continuous across the dissolve (don't gate it per segment).
- **Snippet:**
```tsx
const out = interpolate(frame, [atF, atF+dur], [1,0],
  { easing: Easing.bezier(0.16,1,0.3,1), extrapolateLeft:"clamp", extrapolateRight:"clamp" });
const inc = interpolate(frame, [atF, atF+dur], [0,1], { /* same ease */ });
// stack both absolutely; opacity:out (top) over opacity:inc (bottom)
```
- **source:** `@remotion/transitions` `fade()` analog; the repo's own fades = `SplitChrome` fade-out (`FADE=12`) and segment-0 `fadeIn` in `Reel2Video.tsx` (lines 192, 287-291).
</content>
