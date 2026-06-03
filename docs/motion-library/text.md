# Text / typography motions

Modern social-video typography. Cross-ref `remotion-best-practices/rules/text-animations.md` +
`display-captions.md` for caption-from-transcript workflows.

---
## kinetic-typography (word-by-word pop)
- **When:** punchy captions, hook text, beat-synced words.
- **Signature:** each word springs in slightly after the previous (stagger), bold, large.
- **params:** `{ words:[], startF, perWordF:4, damping:14 }`.
- **Snippet:**
```tsx
{words.map((w,i)=>{ const s = spring({ frame: frame-(startF+i*perWordF), fps, config:{damping:14} });
  return <span key={i} style={{ display:"inline-block", marginRight:14, opacity:s, transform:`translateY(${(1-s)*20}px) scale(${0.8+0.2*s})` }}>{w}</span>; })}
```
- **source:** `spring` stagger (per `text-animations` rule).

---
## word-highlight (active-word emphasis)
- **When:** karaoke/caption emphasis synced to audio word times (we have MMS word times!).
- **Signature:** the current word brightens/scales; others dim.
- **params:** `{ words:[{w,start,end}], activeColor, dimColor }` (start/end in frames from MMS alignment).
- **Snippet:**
```tsx
const t = frame/fps;
{words.map((wd,i)=>{ const on = t>=wd.start && t<wd.end;
  return <span key={i} style={{ color:on?activeColor:dimColor, transform:`scale(${on?1.08:1})`, display:"inline-block", transition:"none" }}>{wd.w} </span>; })}
```
- **source:** pairs with `scripts/python/align_mms.py` word times → exact highlight timing.

---
## typewriter
- **When:** terminal/log feel, "typing a prompt" (our node-editor caption vibe).
- **Signature:** characters reveal over time; optional blinking caret.
- **params:** `{ text, startF, charsPerF:0.7 }`.
- **Snippet:**
```tsx
const n = Math.floor(Math.max(0,(frame-startF))*0.7);
const shown = text.slice(0, n);
// render shown + a caret that blinks: (Math.floor(frame/15)%2 ? "▌" : "")
```
- **source:** `text-animations` typewriter asset in remotion-best-practices.

---
## lower-third (name tag)
- **When:** speaker name / label strip, bottom-left.
- **Signature:** bar slides in from the left + text fades; holds; slides out.
- **params:** `{ appear, hold, name, sub, accent }`.
- **Snippet:**
```tsx
const inP = interpolate(frame, [appear, appear+10], [0,1], ease);
const outP = interpolate(frame, [appear+hold, appear+hold+10], [1,0], ease);
// bar: transform:`translateX(${(1-inP)*-40}px)`, opacity:inP*outP; accent left border
```
- **source:** slide-in + fade composite (general).
</content>
