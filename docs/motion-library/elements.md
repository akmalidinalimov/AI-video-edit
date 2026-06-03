# Element motions

How on-screen objects (cards, wires, shapes, stats) enter and animate. Drive with `spring`/`interpolate`.

---
## draw-on (line / wire / stroke reveal)
- **When:** a connector forms, an underline draws, an SVG path reveals.
- **Signature:** path traces from start→end; optional drifting dashes for "flow".
- **params:** `{ appear, color, x1,y1,x2,y2, flowSpeed:3 }`.
- **Concrete ranges @30fps:**
  - **trace spring:** `config:{ damping:200 }` (no overshoot — a line shouldn't bounce); reaches ~full in **~20–28f**.
  - **connector stagger:** when drawing a chain, delay each by `i*14 + 18` frames (`Reel2Video` StepFlow connector, line 128).
  - **base/flow strokes:** base path `strokeWidth 5, strokeOpacity 0.28`; bright flow path `strokeWidth 2.5, dasharray "3 25"`.
  - **flowSpeed:** `2…4` px/frame drift on the dashed overlay (`-(frame-appear)*3 % 28` gives a steady traveling pulse).
  - **glow:** `drop-shadow(0 0 6px ${color})` on the flow path only.
- **Snippet:**
```tsx
const draw = spring({ frame: frame-appear, fps, config:{ damping:200 } });
const d = `M ${x1} ${y1} C ${(x1+x2)/2} ${y1}, ${(x1+x2)/2} ${y2}, ${x2} ${y2}`;
const total = Math.hypot(x2-x1,y2-y1) + Math.abs((x1+x2)/2 - x1)*2 + 160;
const flow = -((frame-appear)*3) % 28;
return (<>
  <path d={d} stroke={color} strokeOpacity={0.28} strokeWidth={5} fill="none" strokeDasharray={total} strokeDashoffset={total*(1-draw)} />
  <path d={d} stroke={color} strokeWidth={2.5} fill="none" strokeDasharray="3 25" strokeDashoffset={flow} strokeOpacity={draw} style={{ filter:`drop-shadow(0 0 6px ${color})` }} />
</>);
```
- **source:** `Wire` in `Act2NodeEditor` (node connectors).

---
## scale-pop (spring entrance)
- **When:** a card/node/badge appears with life (not a flat fade).
- **Signature:** scales `~0.92→1` + slight translateY, springy settle; opacity in.
- **params:** `{ appear, damping:20, stiffness:110, rise:24 }`.
- **Concrete ranges @30fps:**
  - **spring config:** the repo's pop is `{ damping:20, stiffness:120 }` (players in `Act2NodeEditor` lines 204-205);
    panels use a slightly stiffer `{ damping:22, stiffness:120 }` (line 108); step chips `{ damping:18, stiffness:120 }`.
    Higher `damping` = less bounce; drop to `12…14` for a punchy CTA overshoot.
  - **scale range:** `0.96 → 1.0` (big/small players) or `0.97 → 1.0` (timeline panel); `0.92 → 1.0` for a livelier badge.
  - **rise (translateY):** `22…26px` settling to 0 (`(1-s)*24`); pairs with `transformOrigin:"center top"`.
  - **stagger:** for a group, offset `appear` by `i*14 + 8` frames (Reel2 StepFlow chips, line 133).
  - **mount guard:** `if (frame < appear-2) return null;` so it never flashes a pre-spring frame.
- **Snippet:**
```tsx
const s = spring({ frame: frame-appear, fps, config:{ damping:20, stiffness:120 } });
if (frame < appear-2) return null;
// style: opacity:s, transform:`translateY(${(1-s)*24}px) scale(${0.96+0.04*s})`, transformOrigin:"center top"
```
- **source:** `bigS`/`smallS` players + `TimelinePanel` in `Act2NodeEditor.tsx` (lines 108, 204-205, 224-225); step chips in `Reel2Video.tsx` (line 133).

---
## slide-in
- **When:** lower-thirds, side panels, chips entering from an edge.
- **Signature:** translate from offset→0 with clamp ease + opacity.
- **params:** `{ appear, dur:12, fromX|fromY }`.
- **Concrete ranges @30fps:**
  - **duration:** `10…16f` (`Reel2Video` track rows animate over a `[8+i*6, 22+i*6]` window — ~14f each).
  - **distance:** `±40px` is the repo default (step chips slide `translateX (1-sp)*-40`, Reel2 line 135);
    panels/headers use `±16…26px` for a subtler nudge. Keep it small — big slides read as jumpy.
  - **easing:** `Easing.bezier(0.16,1,0.3,1)`, both ends clamped; opacity rides the same `p`.
  - **stagger:** `i*6` frame offset per row for a cascading list (Reel2 `trackIn`, Act2NodeEditor line 109).
  - **spring alternative:** a slide can also be spring-driven (`{ damping:18, stiffness:120 }`) for an organic settle.
- **Snippet:**
```tsx
const p = interpolate(frame, [appear, appear+dur], [0,1], ease);
// style: opacity:p, transform:`translateX(${(1-p)*fromX}px)`   // fromX ≈ -40
```
- **source:** `trackIn` rows in `Act2NodeEditor.tsx` (line 109) and step-chip slide in `Reel2Video.tsx` (line 135).

---
## mask-reveal (wipe)
- **When:** reveal an image/clip behind a moving edge (clip-path wipe).
- **Signature:** `clip-path inset()` animates one edge 100%→0%.
- **params:** `{ appear, dur, dir:"left"|"up" }`.
- **Concrete ranges @30fps:**
  - **duration:** `12…20f` (a wipe wants to be readable — slower than a pop, ~0.4–0.7s).
  - **inset:** animate one side `100% → 0%` (L→R reveal animates the RIGHT inset; up-reveal animates the BOTTOM).
  - **easing:** `Easing.out(Easing.cubic)` (decisive entrance) or the repo `Easing.bezier(0.16,1,0.3,1)`, clamped.
  - **soft edge (optional):** pair with a `~6f` opacity fade so the revealing edge doesn't pop hard.
  - **render-safe:** `clip-path` animates from `useCurrentFrame`, never a CSS `transition`.
- **Snippet:**
```tsx
const r = interpolate(frame, [appear, appear+dur], [100,0], ease);
// style: clipPath:`inset(0 ${dir==="left"?r:0}% 0 0)`  (animate the right inset for an L→R reveal)
```
- **source:** clip-path pattern (Remotion-safe; no CSS transition); same `inset()` idea as the timeline clip thumbnails in `Act2NodeEditor`.

---
## dim-deemphasize (de-emphasis / "layer removed")
- **When:** demote one element while a sibling stays bright — e.g. "remove the video layer, keep audio":
  the V1 clip dims (darker/lower opacity) while the A1 waveform holds full brightness.
- **Signature:** target's brightness/opacity ramps DOWN to a floor (not to 0) over a hold window; no movement,
  no layout shift; sibling untouched. Pairs with a `cross-dissolve` of any thumbnail content fading to black.
- **params:** `{ appear, dur, fromBright:1, toBright:0.45, fromOpacity:1, toOpacity:0.7 }`.
- **Snippet:**
```tsx
const b = interpolate(frame, [appear, appear+dur], [fromBright, toBright], ease);
const o = interpolate(frame, [appear, appear+dur], [fromOpacity, toOpacity], ease);
// style on the demoted element only: filter:`brightness(${b})`, opacity:o  (sibling keeps brightness(1))
```
- **source:** `interpolate` brightness/opacity ramp (general); de-emphasis ramp, sibling-isolated.

---
## number-counter (stat roll-up)
- **When:** infographic stats, metrics counting up.
- **Signature:** number interpolates to target, eased; often paired with scale-pop on the card.
- **params:** `{ appear, dur, to, decimals:0, prefix, suffix }`.
- **Concrete ranges @30fps:**
  - **duration:** `24…45f` (~0.8–1.5s) — long enough to read the roll, short enough to feel snappy.
  - **easing:** `Easing.out(Easing.cubic)` so it decelerates into the final value (a linear count feels mechanical).
  - **decimals:** `0` for counts, `1…2` for rates/currency; `v.toFixed(decimals)` keeps digit width stable.
  - **pairing:** mount the card with `scale-pop` (`{damping:20, stiffness:120}`) and start the count `~6f` after the card lands.
  - **fixed width (optional):** `fontVariantNumeric:"tabular-nums"` stops digits from jittering as they change.
- **Snippet:**
```tsx
const v = interpolate(frame, [appear, appear+dur], [0, to],
  { easing: Easing.out(Easing.cubic), extrapolateLeft:"clamp", extrapolateRight:"clamp" });
const text = `${prefix??""}${v.toFixed(decimals)}${suffix??""}`;
```
- **source:** `interpolate` value-drive (general); same eased `interpolate` family as the playhead sweep / progress bar in `Act2NodeEditor`.
</content>
