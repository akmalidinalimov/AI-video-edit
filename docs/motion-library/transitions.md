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
- **Snippet:**
```tsx
// outgoing
const o = interpolate(frame, [atF, atF+dur], [0,-100], ease); // % translateX
// style A: transform:`translateX(${o}%)`, filter:`blur(${Math.abs(o)/100*blurPx}px)`
// incoming starts at +100% → 0 over the same window
```
- **source:** `@remotion/transitions` `slide()` analog (manual).

---
## match-cut
- **When:** continuity between two visually-aligned shots (shape/position carries across the cut).
- **Signature:** NO dissolve — align a common element's position/scale on both sides so the cut "matches".
- **params:** `{ atF, anchorBox:{x,y,w,h} }` — author both shots so the anchor lands identically at `atF`.
- **note:** this is a COMPOSITION constraint, not an animation: place the shared element at the same
  on-screen box in the last frame of shot A and first frame of shot B. The Editor role enforces it.
- **source:** layout discipline (no snippet — it's framing).

---
## cross-dissolve (fade between)
- **When:** soft, reflective mood; B-roll montages; time passing.
- **Signature:** outgoing opacity 1→0 while incoming 0→1 over the overlap window.
- **params:** `{ atF, dur:12 }`.
- **Snippet:**
```tsx
const out = interpolate(frame, [atF, atF+dur], [1,0], ease);
const inc = interpolate(frame, [atF, atF+dur], [0,1], ease);
// stack both absolutely; opacity:out (top) over opacity:inc (bottom)
```
- **source:** `@remotion/transitions` `fade()` analog.
</content>
