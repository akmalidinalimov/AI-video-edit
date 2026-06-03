# Text / typography motions

Modern social-video typography. Cross-ref `remotion-best-practices/rules/text-animations.md` +
`display-captions.md` for caption-from-transcript workflows.

---
## kinetic-typography (word-by-word pop)
- **When:** punchy captions, hook text, beat-synced words.
- **Signature:** each word springs in slightly after the previous (stagger), bold, large.
- **params:** `{ words:[], startF, perWordF:4, damping:14 }`.
- **Concrete ranges @30fps:**
  - **perWordF (stagger):** `3…6f` between words (`4` ≈ a brisk, readable cascade; lower feels frantic).
  - **spring config:** `{ damping:14 }` for a lively pop with a touch of overshoot; `{ damping:18 }` to calm it.
  - **scale:** `0.8 → 1.0`; **rise:** `translateY (1-s)*20px → 0`.
  - **type:** bold/heavy weight (`800…900`), large (`58…88px` on a 1080w hook); `display:inline-block` so transforms apply.
  - **spacing:** `marginRight:12…16px` between word spans.
- **Snippet:**
```tsx
{words.map((w,i)=>{ const s = spring({ frame: frame-(startF+i*perWordF), fps, config:{damping:14} });
  return <span key={i} style={{ display:"inline-block", marginRight:14, opacity:s, transform:`translateY(${(1-s)*20}px) scale(${0.8+0.2*s})` }}>{w}</span>; })}
```
- **source:** `spring` stagger (per `text-animations` rule); same staggered-spring pattern as the Reel2 step chips (`frame-(i*14+8)`).

---
## word-highlight (active-word emphasis)
- **When:** karaoke/caption emphasis synced to audio word times (we have MMS word times!).
- **Signature:** the current word brightens/scales; others dim.
- **params:** `{ words:[{w,start,end}], activeColor, dimColor }` (start/end in frames from MMS alignment).
- **Concrete ranges @30fps:**
  - **timing source:** `start`/`end` are **MMS-forced-alignment SECONDS** — compare `t = frame/fps` (NOT Gemini timestamps).
  - **active scale:** `1.06…1.10` (`1.08` default) — enough to read as "current word," not a jarring jump.
  - **colors:** active = the reel accent (reel-2 blue `#5b9cf0` / soft `#9cc3fb`); dim = `rgba(255,255,255,0.45…0.55)`.
  - **transition:** ALWAYS `"none"` — the highlight is frame-driven; a CSS transition would lag/desync the render.
  - **optional soft ramp:** lerp scale over a `~3f` window around each boundary so the pop isn't a hard binary flip.
- **Snippet:**
```tsx
const t = frame/fps;
{words.map((wd,i)=>{ const on = t>=wd.start && t<wd.end;
  return <span key={i} style={{ color:on?activeColor:dimColor, transform:`scale(${on?1.08:1})`, display:"inline-block", transition:"none" }}>{wd.w} </span>; })}
```
- **source:** pairs with `scripts/python/align_mms.py` word times → exact highlight timing; accent palette from `Act2NodeEditor.tsx` (`TEAL`/`TEAL_SOFT`, lines 33-34).

---
## typewriter
- **When:** terminal/log feel, "typing a prompt" (our node-editor caption vibe).
- **Signature:** characters reveal over time; optional blinking caret.
- **params:** `{ text, startF, charsPerF:0.7 }`.
- **Concrete ranges @30fps:**
  - **charsPerF:** `0.5…0.9` chars/frame (`0.7` ≈ 21 chars/s — a natural fast type; `>1.2` looks like a paste, not typing).
  - **reveal by SLICE, never per-char opacity:** `text.slice(0, n)` — per-char `interpolate` is the typewriter anti-pattern (see authoring §3).
  - **caret blink:** `Math.floor(frame/15)%2` toggles a `▌` every ~0.5s (15f on / 15f off).
  - **font:** monospace (`ui-monospace, Menlo, monospace`, the repo `MONO`) sells the terminal feel.
- **Snippet:**
```tsx
const n = Math.floor(Math.max(0,(frame-startF))*0.7);
const shown = text.slice(0, n);
// render shown + a caret that blinks: (Math.floor(frame/15)%2 ? "▌" : "")
```
- **source:** `text-animations` typewriter asset in remotion-best-practices; mono font = `MONO` in `Act2NodeEditor.tsx` (line 27).

---
## lower-third (name tag)
- **When:** speaker name / label strip, bottom-left.
- **Signature:** bar slides in from the left + text fades; holds; slides out.
- **params:** `{ appear, hold, name, sub, accent }`.
- **Concrete ranges @30fps:**
  - **in/out:** `~10f` each (slide+fade); `hold` typically `60…120f` (2–4s) of full-opacity dwell.
  - **slide distance:** `-40px → 0` (matches the repo slide-in default), eased & clamped.
  - **accent:** a left border in the reel accent (reel-2 blue `#5b9cf0`); avoid a second hue.
  - **type:** name `700…800 / 30…46px`, sub `500…600 / 22…28px` — the repo's label/body tiers.
  - **chrome:** glass bar `rgba(8,12,16,0.7)` + `backdropFilter:"blur(8px)"` reads premium under footage.
- **Snippet:**
```tsx
const inP  = interpolate(frame, [appear, appear+10], [0,1], ease);
const outP = interpolate(frame, [appear+hold, appear+hold+10], [1,0], ease);
// bar: transform:`translateX(${(1-inP)*-40}px)`, opacity:inP*outP; accent left border
```
- **source:** slide-in + fade composite; glass-bar styling per `Act2NodeEditor.tsx` transport pill (line 232) and authoring §5.
</content>
