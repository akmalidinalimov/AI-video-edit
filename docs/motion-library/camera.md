# Camera motions

Camera = a transform on a WORLD layer (`translate()scale()`), NOT on fixed chrome. Wrap the moving content
in one `<AbsoluteFill>` with `transformOrigin: "0 0"`; keep title/minimap/PiP outside it. Source of all four:
`Act2NodeEditor.tsx` `CameraRig` (lines ~176-201).

---
## push-in / pull-out
- **When:** emphasize a subject (push-in) or reveal context / a dense graph (pull-out, the reference's end).
- **Signature:** scale grows (push) or shrinks (pull) with slight Y drift; eased, no jitter.
- **params:** `{ from:scale, to:scale, startF, endF, originX, originY, yDrift }` (e.g. push `1→1.15`, pull `1→0.52`).
- **Snippet:**
```tsx
const camS = interpolate(frame, [startF, endF], [from, to],
  { easing: Easing.bezier(0.16,1,0.3,1), extrapolateLeft:"clamp", extrapolateRight:"clamp" });
const camY = interpolate(frame, [startF, endF], [0, yDrift], {/* same ease */});
return <AbsoluteFill style={{ transform:`translateY(${camY}px) scale(${camS})`, transformOrigin:`${originX}% ${originY}%` }}>{world}</AbsoluteFill>;
```
- **source:** `camS`/`camY` in `Act2NodeEditor` (zoom-out reveal at f360→440).

---
## camera-pan (L→R / R→L tracking)
- **When:** traverse a wide layout, follow action across the canvas.
- **Signature:** horizontal translate across keyframes, content wider than frame; pair with parallax.
- **params:** `{ keysF:number[], xs:number[] }` (multi-keyframe so it can ease-hold-move).
- **Snippet:**
```tsx
const camX = interpolate(frame, [70,150,230,300], [60,60,-360,-880], ease); // hold, then pan
return <AbsoluteFill style={{ transform:`translate(${camX}px,0) scale(${camS})`, transformOrigin:"0 0" }}>{world}</AbsoluteFill>;
```
- **source:** `camX` in `Act2NodeEditor` (L→R pan across the node world).

---
## parallax
- **When:** depth under a pan/zoom — background drifts slower than foreground.
- **Signature:** ≥2 layers, background `camX * k` (k≈0.4-0.5) vs foreground `camX * 1`.
- **params:** `{ bgFactor:0.45 }`.
- **Snippet:**
```tsx
<AbsoluteFill style={{ transform:`translateX(${camX*0.45}px) scale(${camS})`, opacity:0.6 }}>{dotGrid}</AbsoluteFill>
<AbsoluteFill style={{ transform:`translate(${camX}px,${camY}px) scale(${camS})` }}>{world}</AbsoluteFill>
```
- **source:** dot-grid parallax in `Act2NodeEditor` (bg at `camX*0.45`).

---
## orbit
- **When:** thumbnails/elements circle a center (intro flourish, "options around a hub").
- **Signature:** items on an ellipse, angle advances with frame, scale/opacity-in stagger.
- **params:** `{ cx, cy, R, yScale:0.78, speed:0.012, items:[] }`.
- **Snippet:**
```tsx
const ang = (i/items.length)*Math.PI*2 + frame*0.012;
const inn = interpolate(frame, [i*5, i*5+22], [0,1], ease);
const x = cx + Math.cos(ang)*R - w/2, y = cy + Math.sin(ang)*R*0.78 - h/2;
// style: left:x, top:y, opacity:inn*0.92, transform:`scale(${0.6+0.4*inn})`
```
- **source:** `OrbitIntro` in `Act2NodeEditor` (character ring behind the title).
</content>
