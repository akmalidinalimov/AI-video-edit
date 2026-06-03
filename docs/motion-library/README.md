# Motion Library — named motion patterns → Remotion recipes

The **Motion-Designer** role's knowledge base. Each pattern is a reusable, parameterized Remotion
implementation of a modern motion-graphics technique, distilled from patterns we've already shipped
(`src/remotion/compositions/Act2NodeEditor.tsx`, `Reel2Video.tsx`) and the official
`remotion-best-practices` skill (`~/.agents/skills/remotion-best-practices/rules/`).

## Why this exists
The reference→output gap is mostly a TRANSLATION gap: a reference video shows a motion, and we must
reproduce it in Remotion. Free-text descriptions lose fidelity. This library gives the Motion-Designer a
**fixed vocabulary** of motions, each with concrete `interpolate`/`spring`/`Easing` params, so
"push-in + draw-on wire" maps to working code, not a guess.

## How the Motion-Designer uses it (mapping)
Given a decoded shot from `recipe.json` (`cameraMotion`, `elementMotion`, `fingerprint.transitions`),
resolve each to a pattern below and emit `{pattern, params}` for the Remotion-Engineer:

| Recipe field | Value → Pattern |
|---|---|
| `cameraMotion` | `push_in`/`pull_out` → **push-in/pull-out** · `pan_left`/`pan_right` → **camera-pan** · `orbit` → **orbit** · `parallax` → **parallax** · `zoom` → push-in (scale only) |
| `elementMotion` | "draw-on / wire connects" → **draw-on** · "nodes/cards pop/appear" → **scale-pop** · "slides in" → **slide-in** · "reveal / mask" → **mask-reveal** · "counter / stat" → **number-counter** · "images orbit" → **orbit** |
| `fingerprint.transitions` | "whip / swish" → **whip-pan** · "match cut" → **match-cut** · "dissolve / fade" → **cross-dissolve** · hard cut → (no transition pattern; just a cut) |
| caption / `elementMotion` text | "kinetic / animated words" → **kinetic-typography** · "highlight word" → **word-highlight** · "typed" → **typewriter** · "lower third / name tag" → **lower-third** |

## Hard rules (inherited from our lessons + the remotion skill)
- **NO CSS transitions/animations** — they don't render. Drive everything from `useCurrentFrame()` +
  `interpolate`/`spring`. (Confirmed by `remotion-best-practices` and our black-flash incident.)
- Default eased motion: `Easing.bezier(0.16, 1, 0.3, 1)` with `extrapolateLeft/Right: "clamp"`.
- Video = `OffthreadVideo` with `delayRenderTimeoutInMilliseconds={120000}`; `loop` short clips; fade only
  the FIRST segment (no per-cut fade-from-black).
- All timing in FRAMES (use `fps` from `useVideoConfig()`); keep range boundaries frame-aligned.

## Catalogue (16 patterns)
- **Camera** → [camera.md](camera.md): push-in/pull-out · camera-pan · orbit · parallax
- **Elements** → [elements.md](elements.md): draw-on · scale-pop · slide-in · mask-reveal · number-counter
- **Text** → [text.md](text.md): kinetic-typography · word-highlight · typewriter · lower-third
- **Transitions** → [transitions.md](transitions.md): whip-pan · match-cut · cross-dissolve

Each entry follows the same shape:
> **name** — when-to-use · visual signature · `params` · Remotion snippet · source.
</content>
</invoke>
