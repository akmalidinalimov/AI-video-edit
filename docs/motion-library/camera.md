# Camera motions

Camera = a transform on a WORLD layer (`translate()scale()`), NOT on fixed chrome. Wrap the moving content
in one `<AbsoluteFill>` with `transformOrigin: "0 0"`; keep title/minimap/PiP outside it. Source of all four:
`Act2NodeEditor.tsx` `CameraRig` (lines ~176-201).

---
## push-in / pull-out
- **When:** emphasize a subject (push-in) or reveal context / a dense graph (pull-out, the reference's end).
- **Signature:** scale grows (push) or shrinks (pull) with slight Y drift; eased, no jitter.
- **params:** `{ from:scale, to:scale, startF, endF, originX, originY, yDrift }` (e.g. push `1→1.15`, pull `1→0.52`).
- **Concrete ranges @30fps:**
  - **scale:** push-in `1.0→1.05…1.12` (subtle UI), `1.0→1.15` (subject emphasis); pull-out/reveal `1.0→0.52`.
    `Act2NodeEditor` ships a *very* gentle drift: `1.05 → 1.0 → 1.012 → 1.022` (a settle, then a slow breathe).
    Bottom-half Ken-Burns in `Reel2Video` is `scale 1.06 → 1.12` (overscan ≥1.06 so no black edge under `cover`).
  - **duration:** a single push runs **60–120f** (2–4s); the `Reel2Video` drift spans the whole segment (`[0, dur]`).
  - **yDrift:** `±8…12px` (`Act2NodeEditor` opens with `camY 12→0`; Reel2 Ken-Burns `kbY 0→-12`).
  - **easing:** repo default `Easing.bezier(0.16,1,0.3,1)`; Ken-Burns uses a softer `Easing.bezier(0.33,0,0.4,1)`.
  - **transformOrigin:** `"50% 42%"` (Act2 world) or `"50% 45%"` (Reel2 Ken-Burns) — bias above center so the push reads toward the face/subject, not the floor.
- **Snippet:**
```tsx
const camS = interpolate(frame, [startF, endF], [from, to],
  { easing: Easing.bezier(0.16,1,0.3,1), extrapolateLeft:"clamp", extrapolateRight:"clamp" });
const camY = interpolate(frame, [startF, endF], [0, yDrift], {/* same ease */});
return <AbsoluteFill style={{ transform:`translateY(${camY}px) scale(${camS})`, transformOrigin:`${originX}% ${originY}%` }}>{world}</AbsoluteFill>;
```
- **source:** `camS`/`camY` in `Act2NodeEditor.tsx` (lines 179-181, 211) and `kbScale`/`kbY` in `Reel2Video.tsx` (lines 210-224, bottom-half only — never drift the real talking band).

---
## camera-pan (L→R / R→L tracking)
- **When:** traverse a wide layout, follow action across the canvas.
- **Signature:** horizontal translate across keyframes, content wider than frame; pair with parallax.
- **params:** `{ keysF:number[], xs:number[] }` (multi-keyframe so it can ease-hold-move).
- **Concrete ranges @30fps:**
  - **keyframes:** 3–4 stops so it can **hold → move → settle**, e.g. frames `[70,150,230,300]` (≈2.3s→10s).
    A pure drift uses just `[0, 240, 470]` with small offsets (`camX -8 → 6 → -4`, `Act2NodeEditor` line 180).
  - **translate distance:** subtle drift `±4…22px`; a true traverse moves `60 → -880px` (well past one frame width).
  - **hold:** repeat the same x on the first two keys (`[60,60,…]`) to sit still before the pan begins.
  - **easing:** `Easing.bezier(0.16,1,0.3,1)`, both ends clamped.
- **Snippet:**
```tsx
const camX = interpolate(frame, [70,150,230,300], [60,60,-360,-880], ease); // hold, then pan
return <AbsoluteFill style={{ transform:`translate(${camX}px,0) scale(${camS})`, transformOrigin:"0 0" }}>{world}</AbsoluteFill>;
```
- **source:** `camX` in `Act2NodeEditor.tsx` (line 180 — slow horizontal drift across the node world).

---
## parallax
- **When:** depth under a pan/zoom — background drifts slower than foreground.
- **Signature:** ≥2 layers, background `camX * k` (k≈0.4-0.5) vs foreground `camX * 1`.
- **params:** `{ bgFactor:0.45 }`.
- **Concrete ranges @30fps:**
  - **bgFactor:** `0.35…0.50` (background moves 35–50% of foreground); never `0` (looks pasted) or `1` (no depth).
  - **layer count:** 2 is enough (bg + world); add a mid layer at `~0.7` for a 3-plane feel.
  - **bg opacity:** dim the background plane to `0.5…0.65` so the foreground reads as the subject.
  - shares the SAME `camX`/`camS`/`ease` as the pan/push it sits under — only the multiplier differs.
- **Snippet:**
```tsx
<AbsoluteFill style={{ transform:`translateX(${camX*0.45}px) scale(${camS})`, opacity:0.6 }}>{dotGrid}</AbsoluteFill>
<AbsoluteFill style={{ transform:`translate(${camX}px,${camY}px) scale(${camS})` }}>{world}</AbsoluteFill>
```
- **source:** dot-grid parallax in `Act2NodeEditor` (bg at `camX*0.45`); the same depth idea drives the bottom-half Ken-Burns `kbX` drift in `Reel2Video.tsx` (line 211, `±22px` alternating by segment index).

---
## orbit
- **When:** thumbnails/elements circle a center (intro flourish, "options around a hub").
- **Signature:** items on an ellipse, angle advances with frame, scale/opacity-in stagger.
- **params:** `{ cx, cy, R, yScale:0.78, speed:0.012, items:[] }`.
- **Concrete ranges @30fps:**
  - **speed:** `0.008…0.018 rad/frame` (`0.012` ≈ one full revolution every ~8.7s — a calm, hypnotic orbit).
  - **R (radius):** size to your canvas — `~280…420px` on a 1080-wide frame.
  - **yScale:** `0.70…0.82` flattens the circle into a believable perspective ellipse (`0.78` is the default).
  - **stagger entrance:** `i*5` frame delay, each item easing in over `~22f`; scale `0.6 → 1.0`, opacity `0 → 0.92`.
  - subtract `w/2`,`h/2` to center each item on its `(x,y)` point.
- **Snippet:**
```tsx
const ang = (i/items.length)*Math.PI*2 + frame*0.012;
const inn = interpolate(frame, [i*5, i*5+22], [0,1], ease);
const x = cx + Math.cos(ang)*R - w/2, y = cy + Math.sin(ang)*R*0.78 - h/2;
// style: left:x, top:y, opacity:inn*0.92, transform:`scale(${0.6+0.4*inn})`
```
- **source:** `OrbitIntro` in `Act2NodeEditor` (character ring behind the title).
</content>
