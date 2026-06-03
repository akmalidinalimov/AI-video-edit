# Remotion Authoring — the craft playbook for the `remotion-author` translator

The **`remotion-author`** is the agent that turns a *decoded reference style* into *concrete, high-quality
Remotion code*. It sits between decode and the render gates (Step A of `NEXT-SESSION-HANDOFF.md`):

```
recipe.json ──► STYLE/MOTION SPEC ──► [ remotion-author ] ──► composition patch (.tsx) ──► GATES
(decode)        (motion-library names + params)  THIS DOC      typechecks + renders        (closed loop)
```

This is the **craft layer**. It does not invent APIs — it composes the patterns already proven in
`src/remotion/compositions/Reel2Video.tsx` and `Act2NodeEditor.tsx`, the 16 patterns in
`docs/motion-library/`, and the installed **`remotion-best-practices`** skill
(`~/.agents/skills/remotion-best-practices/`). Read those alongside this doc; do not contradict the skill.

> **One divergence from the skill, on purpose.** The skill recommends `<Video>`/`<Audio>` from
> `@remotion/media`. THIS repo uses **`OffthreadVideo` from `remotion` core** for every clip, by a documented
> rule (the HTML5 `<Video>` seeks per-frame and emits a black frame at each cut — the "seek-black"). When
> authoring for this repo, follow the repo: `OffthreadVideo` everywhere. Keep `<Audio>` from `remotion` core
> (as both compositions do). See §6.

---

## 1. Role & I/O contract

**Input** (three objects):
- **shot spec** — canvas (`{fps,width,height,durationInFrames}`), per-segment `{startFrame,endFrame,kind,src…}`,
  layout boxes (the split is `TOP_H=840` band + `1080×1080` square at `BOTTOM_Y=840`; see `Reel2Video.tsx`).
- **motion recipe** — `{cameraMotion, elementMotion, transitions, caption}` already resolved by the
  Motion-Designer to **motion-library pattern names + params** (e.g. `push-in {from:1, to:1.12, …}`).
- **edit plan** — segment order, sentence-aligned cut frames, which segment fades in (only index 0).

**Output:** a **composition patch** (edit to a `*.tsx` under `src/remotion/compositions/`, or a new probe
comp) that:
1. **typechecks** (`tsc` — esbuild transpiling is NOT enough; lesson 1337: syntax-valid can be type-invalid),
2. **renders** with no error / black frame, and
3. **passes every gate in §7** on the rendered output.

**Hard contract:** the remotion-author **NEVER re-encodes or trims source clips on disk**. Every transform
(crop, grade, Ken-Burns, seek) lives in the composition (`startFrom`, `style.transform`, CSS `filter`,
`objectFit:"cover"`). The "no-clobber-source" rule. Sources are read-only inputs.

---

## 2. Core Remotion vocabulary (copy-paste)

All imports come from the `remotion` core package in this repo.

```tsx
import {
  AbsoluteFill, Sequence, Series, Audio, OffthreadVideo, Img,
  useCurrentFrame, useVideoConfig, interpolate, spring, Easing, staticFile,
} from "remotion";
```

**`useCurrentFrame()` / `useVideoConfig()`** — frame is LOCAL inside a `<Sequence>` (starts at 0).
```tsx
const frame = useCurrentFrame();
const { fps, durationInFrames, width, height } = useVideoConfig();
```

**`interpolate`** — the workhorse. ALWAYS clamp both ends; add an `Easing`.
```tsx
const opacity = interpolate(frame, [0, 12], [0, 1], {
  extrapolateLeft: "clamp", extrapolateRight: "clamp",
  easing: Easing.bezier(0.16, 1, 0.3, 1),   // repo default ease
});
```

**`spring`** — organic entrances. `fps` is required. Two flavors used in this repo:
```tsx
const settle = spring({ frame: frame - appear, fps, config: { damping: 200 } });          // no overshoot
const pop    = spring({ frame: frame - appear, fps, config: { damping: 20, stiffness: 120 } }); // springy
```

**`Sequence`** — delay + duration; `premountFor` so a clip finishes seeking before its first frame.
```tsx
<Sequence from={seg.startFrame} durationInFrames={seg.endFrame - seg.startFrame}
          premountFor={15} name="seg0-split">…</Sequence>
```
**`Series` / `Series.Sequence`** — back-to-back scenes without computing `from` by hand (durationInFrames each;
`offset={-n}` to overlap). Use `Sequence` when you need absolute `from` frames (the repo's segment model does).

**`AbsoluteFill`** — full-canvas positioned div; the base for every layer.
**`OffthreadVideo`** — every video clip. Repo wrapper pattern (forwards `loop` past the prop type, sets the
generous timeout):
```tsx
type VideoTagProps = React.ComponentProps<typeof OffthreadVideo> & { loop?: boolean };
const VideoTag: React.FC<VideoTagProps> = (p) =>
  <OffthreadVideo delayRenderTimeoutInMilliseconds={120000}
    {...(p as React.ComponentProps<typeof OffthreadVideo>)} />;

<VideoTag src={rsrc(seg.topSrc)} startFrom={Math.round((seg.topFromSec ?? 0) * fps)}
          muted loop style={{ width:"100%", height:"100%", objectFit:"cover" }} />
```
Props: `startFrom` (in-point, FRAMES), `muted`, `loop`, `volume`, `toneFrequency`, `style`.
**`Img`** — static images (`<Img src={rsrc(path)} />`). **`Audio`** — `<Audio src={rsrc(music)} volume={0.25} />`.

**`staticFile` / `rsrc()` helper** — both compositions ship this exact helper. Use it for every asset path so
absolute/remote URLs pass through and `public/`-relative paths resolve:
```tsx
const rsrc = (s: string) =>
  (s.startsWith("http") || s.startsWith("/") || s.includes("://")) ? s : staticFile(s);
```

**`Easing`** — `Easing.bezier(0.16,1,0.3,1)` (repo default, crisp ease-out), `Easing.out(Easing.cubic)` for
enters, `Easing.in(Easing.cubic)` for exits, `Easing.bezier(0.34,1.56,0.64,1)` for a controlled overshoot.

---

## 3. Translating each motion-library category → code

Resolve recipe fields to patterns via `docs/motion-library/README.md`'s mapping table, then emit code below.
Each pattern's canonical implementation already exists in `Act2NodeEditor.tsx`/`Reel2Video.tsx` — cite it.

### Camera (`docs/motion-library/camera.md`) — a transform on a WORLD layer, never on fixed chrome
Wrap moving content in ONE `<AbsoluteFill>`; keep pills/logo/PiP outside it (`Act2NodeEditor` `CameraRig`).

| pattern | params → inputs | code |
|---|---|---|
| **push-in / pull-out** | `{from,to,startF,endF,originX,originY,yDrift}` → scale + Y | `const camS=interpolate(frame,[startF,endF],[from,to],ease); const camY=interpolate(frame,[startF,endF],[0,yDrift],ease);` → `transform:\`translateY(${camY}px) scale(${camS})\`, transformOrigin:\`${originX}% ${originY}%\`` (push `1→1.12`, pull `1→0.52`) |
| **camera-pan** | `{keysF:number[], xs:number[]}` | `const camX=interpolate(frame,[70,150,230,300],[60,60,-360,-880],ease);` → `transform:\`translate(${camX}px,0) scale(${camS})\`, transformOrigin:"0 0"` |
| **parallax** | `{bgFactor:0.45}` | background layer `translateX(${camX*0.45}px)`, foreground `translateX(${camX}px)` — two stacked AbsoluteFills |
| **orbit** | `{cx,cy,R,yScale:0.78,speed:0.012,items}` | `const ang=(i/items.length)*Math.PI*2+frame*0.012; x=cx+Math.cos(ang)*R; y=cy+Math.sin(ang)*R*0.78;` + per-item `interpolate(frame,[i*5,i*5+22],[0,1],ease)` opacity/scale |

Live repo camera (`Act2NodeEditor` lines ~179-211): multi-keyframe push-in + drift inside a contained world
— `camS`,`camX`,`camY` interpolated, applied to the inner `<AbsoluteFill transform=… transformOrigin:"50% 42%">`.
For an A-roll talking band, **do NOT add camera motion to the real top band** (head-safety) — drift the
B-roll/character half only (`Reel2Video` Ken-Burns is bottom-only).

### Elements (`docs/motion-library/elements.md`) — drive with `spring`/`interpolate`
- **draw-on** `{appear,color,x1,y1,x2,y2,flowSpeed}` → `spring(damping:200)` drives `strokeDashoffset = total*(1-draw)`; a second dashed path with drifting `strokeDashoffset` = flow (see `Wire`).
- **scale-pop** `{appear,damping:20,stiffness:110,rise:24}` → `const s=spring({frame:frame-appear,fps,config:{damping:20,stiffness:110}}); if(frame<appear-2) return null;` → `opacity:s, transform:\`translateY(${(1-s)*rise}px) scale(${0.92+0.08*s})\`` (see `NodeCard`, the big/small players).
- **slide-in** `{appear,dur,fromX|fromY}` → `interpolate(frame,[appear,appear+dur],[0,1],ease)` → `transform:\`translateX(${(1-p)*fromX}px)\``.
- **mask-reveal** `{appear,dur,dir}` → `const r=interpolate(frame,[appear,appear+dur],[100,0],ease);` → `clipPath:\`inset(0 ${dir==="left"?r:0}% 0 0)\``.
- **dim-deemphasize** `{appear,dur,toBright:0.45,toOpacity:0.7}` → ramp `filter:brightness()`+`opacity` DOWN on the demoted element only (sibling stays `brightness(1)`).
- **number-counter** `{appear,dur,to,decimals,prefix,suffix}` → `const v=interpolate(frame,[appear,appear+dur],[0,to],ease); text=\`${prefix}${v.toFixed(decimals)}${suffix}\``.

### Text (`docs/motion-library/text.md`) — NO per-char opacity for typewriter (slice the string)
- **kinetic-typography** `{words,startF,perWordF:4,damping:14}` → per word `spring({frame:frame-(startF+i*perWordF),fps,config:{damping:14}})` → `translateY((1-s)*20) scale(0.8+0.2*s)`.
- **word-highlight** `{words:[{w,start,end}],activeColor,dimColor}` — **start/end in seconds from MMS forced alignment** (`scripts/python/align_mms.py`), compare `t=frame/fps`. The current word brightens/scales; never use a CSS `transition`.
- **typewriter** `{text,startF,charsPerF:0.7}` → `const n=Math.floor(Math.max(0,frame-startF)*0.7); text.slice(0,n)` + a caret blinked by `Math.floor(frame/15)%2`.
- **lower-third** `{appear,hold,name,sub,accent}` → slide-in bar (`inP`) × fade-out (`outP`); accent left border.

### Transitions (`docs/motion-library/transitions.md`) — default is HARD CUT (no pattern)
- **hard cut** — adjacent `<Sequence>`s, nothing between. Only segment index 0 fades in. This is the
  black-flash rule (`reel2-cut-check.mjs`).
- **whip-pan** `{atF,dur:6,dir,blurPx:18}` → outgoing `translateX 0→-100%` + `blur`, incoming `+100%→0`.
- **match-cut** — a COMPOSITION constraint, not animation: place the shared element at the same on-screen box
  on the last frame of A and first frame of B.
- **cross-dissolve** `{atF,dur:12}` → stack both AbsoluteFills; top `opacity 1→0`, bottom `0→1`.
- For *true* scene transitions you may use `@remotion/transitions` `<TransitionSeries>` (`fade`/`slide`/`wipe`)
  — but it SHORTENS the timeline (overlap), which breaks the repo's frame-aligned absolute segment model. In
  the reel2 path, prefer the manual cross-dissolve so cut frames stay exact.

---

## 4. Color grading in Remotion

**Default: CSS `filter` per element** — render-safe (applied on the video/img element), cheap, what reel2 ships.
The repo's grade is a **divergent two-band** look (NOT a harmonized single grade — see `Reel2Video.tsx`
`GRADE_TOP`/`GRADE_BOTTOM`):
```tsx
const GRADE_TOP    = { filter: "saturate(0.82) brightness(0.90) contrast(1.16) hue-rotate(-12deg)" }; // moody cool
const GRADE_BOTTOM = { filter: "saturate(1.18) brightness(1.10) contrast(1.06) hue-rotate(4deg)" };   // vibrant warm
// applied: <VideoTag style={{ ...fitCover, ...GRADE_TOP }} />
```
Reinforce with a low-alpha tint wash over the clip (`mixBlendMode:"soft-light"`, `zIndex:5` so it sits over the
video, under chrome) — `COOL_WASH_TOP` / `WARM_WASH_BOTTOM`. Use `filter` for: temperature, brightness,
contrast, saturation, single hue-rotate.

**Stronger: SVG `feColorMatrix` / `feComponentTransfer`** via `filter: url(#id)` — when you need a *split-tone*
(shadows one hue, highlights another), a *channel curve*, or a precise color matrix that CSS `filter` can't
express. Define the filter once in an inline `<svg>` (zero-size, absolutely positioned), reference by id:
```tsx
<svg width={0} height={0} style={{ position: "absolute" }}>
  <filter id="splitTone">
    {/* lift+tint shadows toward teal, push highlights warm via per-channel curves */}
    <feComponentTransfer>
      <feFuncR type="gamma" amplitude={1.05} exponent={0.95} offset={0.0} />
      <feFuncG type="gamma" amplitude={1.0}  exponent={1.0}  offset={0.0} />
      <feFuncB type="gamma" amplitude={0.95} exponent={1.05} offset={0.02} />
    </feComponentTransfer>
    {/* or a 4x5 matrix for a true colour transform */}
    {/* <feColorMatrix type="matrix" values="…20 numbers…" /> */}
  </filter>
</svg>
<VideoTag style={{ ...fitCover, filter: "url(#splitTone)" }} />
```
**When to use which:** CSS `filter` for everything reel2 needs today (the proven path). Reach for
`feColorMatrix`/`feComponentTransfer` only for split-tone / per-channel-curve grades the CSS primitives can't
do — this is the intended implementer for the Step-C `color` role (the 76→85 fidelity blocker). Verify any new
grade with `style-fidelity.mjs`'s colorGrade dimension AND by eyeballing rendered frames (filters can clip).

---

## 5. Graphic-design craft (how `Act2NodeEditor` builds its UI)

- **Layering by `zIndex`** — content (video/cards) low, washes ~5, chrome (divider/pills) ~25-40, CTA ~50-70.
- **Glass / blur cards** — `background:"rgba(8,12,16,0.7)"`, `border:"1px solid <accentLine>"`,
  `backdropFilter:"blur(8px)"` + `WebkitBackdropFilter`, soft+glow `boxShadow:"0 22px 60px rgba(0,0,0,0.55), 0 0 30px <accentDim>"`. (the transport pill, timeline panel, player borders.)
- **Spacing / negative space** — single centered content column (`COL_X=90, COL_W=900` on 1080w), consistent
  gaps (`gap:22-26`, panel padding `22-28px`), generous top margin. Don't fill edge-to-edge.
- **One accent color, used consistently** — reel2 = a **purer blue** `#5b9cf0` (+ `#9cc3fb` soft, dim/line
  alphas). The lesson (obs 1465): a teal/cyan accent diverged from the reference's blue; pick the reference's
  accent and reuse it for borders, progress, waveform, glow. Avoid a second hue.
- **Type hierarchy** — `Inter, Arial, sans-serif` (UI), `ui-monospace, Menlo, monospace` (timecodes/labels).
  Tiers: title `900 / 58-66`, label `700-800 / 30-46`, body `500-600 / 22-28`, caption/mono `14-18`.
- **Render-safe icons** — inline `<svg>` strokes, **never emoji** (emoji → tofu boxes in headless render).
  See the `Icon`/`StepIcon`/`MGlyph` components.
- **Active-UI feel** — a scrubbing playhead (`interpolate` sweep), play/pause toggling
  (`Math.floor(frame/45)%2`), a deterministic waveform (sampled sines, `useMemo`) read as a live editor.

---

## 6. Gotchas & hard rules (repo-enforced — violating these fails a gate)

1. **`OffthreadVideo` EVERYWHERE** (incl. render) — never the HTML5 `<Video>`; it seeks per frame → one black
   frame at each clip's first frame. (`Reel2Video.tsx` top comment; `aroll-pipeline.md`.) Set
   `delayRenderTimeoutInMilliseconds={120000}` (the 28s default times out under concurrent proxy fetches).
2. **Fade only segment 0** — fading every segment from `opacity:0` over the black root = a black frame +
   fade-up at every cut. Internal cuts are instant (`fadeIn = index===0 ? interpolate(…) : 1`).
3. **NO CSS transitions/animations** (and no Tailwind animation classes) — they don't render deterministically.
   Drive *everything* from `useCurrentFrame()` + `interpolate`/`spring`. (skill §"Designing a video"; black-flash incident.)
4. **Frame-aligned ranges** — all cut boundaries integer frames (`Math.round(sec*fps)`); keep `startFrame`/
   `endFrame` contiguous (no gaps → no black frames between segments).
5. **Never clip a word** — segment trims come from MMS forced alignment, sentence-anchored; the boundary guard
   re-transcribes the output. Caption/word-highlight timings use MMS seconds, not Gemini timestamps.
6. **Head-safe crop is a band CROP, not a stretch** — never stretch a portrait into a band; take a band-aspect
   window with `objectFit:"cover"` + `overflow:"hidden"`, position by FACE-BOX CENTER, and don't drift the
   real talking head with camera motion. Verify on the RENDERED worst frame (lean-in), not the median.
7. **Audio continuity** — map audio from the continuous source; never silence a talking segment. The reel2
   incident: a turn rendered SILENT while the visual score rose. Use `<Audio>`/`OffthreadVideo` audio directly;
   decouple a narrator's `<Audio>` from its muted PiP visual so the final word isn't cut (`Act2NodeEditor`).
8. **Fixed chrome mounts once** — divider/pills/logo render OUTSIDE the per-segment `<Sequence>`s
   (`SplitChrome`) so they never re-mount/flash on a hard cut.
9. **Never re-encode/trim sources in place** (§1). Seek with `startFrom`, crop with style — keep originals.
10. **Typecheck, don't trust transpile** — run `tsc`; esbuild can transpile type-invalid code (obs 1337).

---

## 7. Verification hook (mandatory — never present an unverified render)

After authoring, render and run the **full closed loop on the RENDERED output**. Definition of Done lives in
`docs/aroll-pipeline.md`; the orchestrated loop is `NEXT-SESSION-HANDOFF.md` §6. The Remotion-path gates:

```bash
node scripts/reel2-crop-check.mjs   <mp4>   # head-safe band (worst/lean-in frame), top gap + head&shoulders
node scripts/reel2-cut-check.mjs    <mp4>   # no black-flash / brightness dip at any cut boundary
node scripts/reel2-audio-check.mjs  <mp4>   # per-segment volumedetect — fails any SILENT talking segment
node scripts/reel2-transcribe.mjs   <mp4>   # output words complete, in order, no overlap (boundary guard)
node scripts/style-fidelity.mjs     …       # style match + punch-list (incl. colorGrade dimension)
node scripts/test-regression.mjs            # 8 structural checks (~2s) — REQUIRED before any commit
```

- **A rising style score is NOT "done."** The frame/style score is blind to audio and to per-frame motion.
  As the FINAL step, **WATCH the video and LISTEN to it** (sample frames across the timeline; check audio
  levels/silence). This hard rule exists because a silent, zoom-cropped turn once shipped at "76/100".
- **Before any commit to pipeline code:** `node scripts/test-regression.mjs` must be all-green; when you fix a
  bug, add a new check that would catch it. (`AGENTS.md` "Mandatory regression test".)
- Pattern render-tests (Step B) go through a throwaway `MotionLibraryProbe` comp + `motion-library-check.mjs`:
  every pattern renders with no error/black frame, output watched.

**Meta-rule:** a new render path starts with ZERO gates earned — wire EVERY Definition-of-Done item before
presenting. The three reel-2 iterations (clipped words → cropped head → black-flash) were each a reel-1 gate
that wasn't ported. See `.knowledge/lessons/multi-aroll-qa.md` §13-§18.
