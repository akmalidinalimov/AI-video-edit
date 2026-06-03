# Element motions

How on-screen objects (cards, wires, shapes, stats) enter and animate. Drive with `spring`/`interpolate`.

---
## draw-on (line / wire / stroke reveal)
- **When:** a connector forms, an underline draws, an SVG path reveals.
- **Signature:** path traces from start→end; optional drifting dashes for "flow".
- **params:** `{ appear, color, x1,y1,x2,y2, flowSpeed:3 }`.
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
- **Snippet:**
```tsx
const s = spring({ frame: frame-appear, fps, config:{ damping:20, stiffness:110 } });
if (frame < appear-2) return null;
// style: opacity:s, transform:`translateY(${(1-s)*24}px) scale(${0.92+0.08*s})`, transformOrigin:"center top"
```
- **source:** `NodeCard` in `Act2NodeEditor`.

---
## slide-in
- **When:** lower-thirds, side panels, chips entering from an edge.
- **Signature:** translate from offset→0 with clamp ease + opacity.
- **params:** `{ appear, dur:12, fromX|fromY }`.
- **Snippet:**
```tsx
const p = interpolate(frame, [appear, appear+dur], [0,1], ease);
// style: opacity:p, transform:`translateX(${(1-p)*fromX}px)`
```
- **source:** standard `interpolate` ease (see `remotion-best-practices/rules/text-animations.md`).

---
## mask-reveal (wipe)
- **When:** reveal an image/clip behind a moving edge (clip-path wipe).
- **Signature:** `clip-path inset()` animates one edge 100%→0%.
- **params:** `{ appear, dur, dir:"left"|"up" }`.
- **Snippet:**
```tsx
const r = interpolate(frame, [appear, appear+dur], [100,0], ease);
// style: clipPath:`inset(0 ${dir==="left"?r:0}% 0 0)`  (animate the right inset for an L→R reveal)
```
- **source:** clip-path pattern (Remotion-safe; no CSS transition).

---
## number-counter (stat roll-up)
- **When:** infographic stats, metrics counting up.
- **Signature:** number interpolates to target, eased; often paired with scale-pop on the card.
- **params:** `{ appear, dur, to, decimals:0, prefix, suffix }`.
- **Snippet:**
```tsx
const v = interpolate(frame, [appear, appear+dur], [0, to], ease);
const text = `${prefix??""}${v.toFixed(decimals)}${suffix??""}`;
```
- **source:** `interpolate` value-drive (general).
</content>
