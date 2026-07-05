# B1 — Schema Reconciliation & Migration Plan

*The keystone of the master spec's Blocker B1: collapse the competing schemas + two pipelines onto ONE content-free StyleProfile, co-designed with what the renderer can actually apply. Compiled 2026-06-22 from a code-level map of the running product.*

---

## 1. What's actually in the code today (the mess B1 fixes)

There are **two parallel product pipelines** and **several schemas** for "style":

### Pipeline A — `/api/clone-style` (FFmpeg single-pass A-roll cloner; the rigorous one)
```
reference video
 → VisualBlueprint        (src/lib/types/blueprint.ts)         — pixel-accurate CV + Gemini measurement
 → VCSTemplate            (src/lib/pipeline/vcs-templates.ts)  — canonical layout coordinates (static or generated)
 → EditingPlan            (src/lib/pipeline/editing-plan.ts)   — the render contract (layoutRanges, B-roll timing, text)
 → FFmpeg single-pass     (src/lib/pipeline/plan-renderer.ts)  — circle mask, drawtext, overlay enable-exprs
```
A-roll word times here come from **Gemini** (`route.ts:156-188`) — violates the forced-alignment rule (Blocker B2).

### Pipeline B — `/api/analyze/reference` → `/api/match` (Remotion)
```
reference video
 → Pass1-4 zod            (src/lib/gemini/schemas/styleProfile.ts) — Gemini input validation (discarded after parse)
 → StyleProfile (TS)      (src/lib/types/styleProfile.ts)          — merged style type (buildStyleProfile)
 → buildTimeline          (src/lib/matching/timelineBuilder.ts)    — TimelineDefinition
 → Remotion render        (src/remotion/compositions/StyleCloneVideo.tsx)
```

### The schemas
| Schema | File | Role | Status |
|---|---|---|---|
| `VisualBlueprint` | `src/lib/types/blueprint.ts:242` | CV measurement of the reference | live in A; **never fed to a Composer as "style"** |
| `StyleProfile` (zod Pass1-4) | `src/lib/gemini/schemas/styleProfile.ts` | Gemini input validation | live in B; discarded after parse |
| `StyleProfile` (TS) | `src/lib/types/styleProfile.ts` | merged style type | live in B (UI + match + Remotion) |
| `EditingPlan` | `src/lib/pipeline/editing-plan.ts:257` | render contract | live in A |
| `VCSTemplate` | `src/lib/pipeline/vcs-templates.ts:109` | layout coordinates | live in A |
| companion zod (aroll/broll/match/editIntelligence) | `src/lib/gemini/schemas/*` | content analysis + matching | live, **keep** (these are ContentPlan/Resource, not style) |

**Net:** "style" is described 3 different ways, neither A nor B is the canonical truth, and the two render paths diverge. This is the "two disconnected pipelines" problem in code.

---

## 2. The render ceiling (what the schema is allowed to promise)

The unified schema is **co-designed** to what the renderer can actually apply (never measure what we can't reproduce):

| Layer | Renderer can do | Renderer CANNOT do |
|---|---|---|
| Captions | word-by-word **karaoke** highlight; font class/weight(normal\|bold)/size/fill/highlight/box/padding/radius/align/uppercase | typewriter, per-word pop/slide, text stroke, gradient |
| Layout | rect (aspect-preserve) + **circle** (center-crop+mask+border); PIP **linear** position keyframes; layout change at **sentence boundaries** | mid-sentence shape/size change; elliptical mask; dissolve between layouts; spring on PIP |
| Transitions | hard_cut, fade, dissolve, slide_(l/r/up), zoom — **ease-out-cubic only** | other easings, whip/wipe/spin, cross-dissolve |
| Color | brightness, saturation, contrast, temperature(warm\|neutral\|cool) — **global** | LUT/curves, lift/gamma/gain, per-segment grade |
| Motion graphics | MGCS components (bar/donut/counter/comparison/statbar/kinetic-caption/lower-third) — **spring** easing | arbitrary new components without code; timeline sequencing inside a component |
| B-roll | static/scroll/ken-burns/pan/zoom keyframes, crop region, speed, per-range offset | rotation, opacity, multi-clip overlap, per-frame content switch |
| Audio | A-roll voice (continuous), bg music, **SFX from a fixed set** (whoosh_soft/hard,pop,ding,click,swoosh,rise), ducking envelope, fade | per-word ducking, time-stretch, custom SFX |

---

## 3. The unified target

**`StyleProfile` (zod) → `src/lib/style-profile/style-profile.ts`** (`schema_version: "style-profile/2.0"`). Written 2026-06-22. Content-free, normalized [0,1] coords, 8 layers (pacing, layout, captions, transitions, motion_graphics, color, audio, narrative) + an optional `frontier` block for engine-detectable-but-not-yet-renderable signals (mask feather, ducking curve, speed ramps, full story_spine). Every enum is constrained to the §2 ceiling; render-target mappings are inline (`→`).

### Convergence decision
```
Reference ─▶ Reference Analysis Engine ─▶ StyleProfile (2.0)   ← the ONE style source
                (uses VisualBlueprint CV measurement + Gemini labels internally)
Creator footage ─▶ Content Analyzer ─▶ ContentPlan (forced-aligned word times)
StyleProfile + ContentPlan ─▶ Composer ─▶ EditingPlan ─▶ FFmpeg base + Remotion overlay (Lambda)
```
- **`VisualBlueprint` is demoted** from a competing "style" schema to a raw CV **measurement** artifact that *populates* StyleProfile. It stays; it stops being a parallel truth.
- **`EditingPlan` stays** as the render contract but becomes **derived** from StyleProfile + ContentPlan (not produced directly from VisualBlueprint).
- **Pass1-4 zod + legacy TS StyleProfile are deprecated** — folded into the engine that emits the 2.0 schema.
- Companion content/matching schemas (aroll/broll/match/editIntelligence) **stay** — they're ContentPlan/Resource, not style.

---

## 4. Field mapping (legacy → unified 2.0)

| Unified field | Source today |
|---|---|
| `pacing.*` | Pass1 `editing_rhythm` + blueprint segment timing |
| `layout.patterns[].aroll{shape,bbox_norm,border,motion}` | blueprint `segments[].aroll` / VCS `LayoutVariant.aroll` / EditingPlan `layoutOverride.aroll` (normalize px→0..1) |
| `layout.patterns[].broll{bbox_norm,is_background}` | blueprint `broll` / VCS `broll` |
| `captions.*` | Pass2/Pass4 `text_style` + timeline `CaptionStyle` (this is where co-design matters most) |
| `transitions.*` | Pass1 `cut_style` + `editIntelligence` transitions (constrain to ceiling enum) |
| `motion_graphics.*` | NEW — reference the MGCS registry (`src/remotion/motion/registry.ts`) |
| `color.*` | Pass4 `color_grade` (already matches ceiling 1:1) |
| `audio.*` | NEW — not in any current schema (Blocker-adjacent gap) |
| `narrative.*` | Pass1 `description` (free text) → structured; `broll_role` NEW (feeds Resource Planner §7.1) |
| `frontier.*` | engine spec §0.5 deeper extractors (post-demo) |

---

## 5. Migration / rewire plan (the actual B1 work, in order)

1. **[done] Write the unified schema** (`style-profile/style-profile.ts`). New file, breaks nothing.
2. **Adapters (non-breaking):** write `fromVisualBlueprint(blueprint, pass4?) → StyleProfile` and `fromLegacyStyleProfile(old) → StyleProfile`. Unit-test that both produce a valid `StyleProfileSchema.parse`.
3. **Engine emits it:** make the Reference Analysis Engine return `StyleProfile 2.0` (via the blueprint adapter for A, via Pass-merge for B) as the single output.
4. **Composer consumes it:** change `buildEditingPlan(...)` to take `StyleProfile + ContentPlan` instead of `VisualBlueprint` directly; map StyleProfile (normalized) → EditingPlan (px) using the VCS template. Keep the FFmpeg + Remotion render unchanged.
5. **Converge the two pipelines:** `/api/clone-style` and `/api/match` both call the one engine → one Composer → one render (FFmpeg base + Remotion overlay). Delete the divergent path.
6. **Deprecate:** remove the legacy TS `StyleProfile` + Pass1-4-as-output (keep Pass schemas only as transient Gemini validators feeding the adapter). Mark `VisualBlueprint` "measurement-only."
7. **Gate:** a regression test that fails if (a) any producer/consumer imports a non-2.0 style type, or (b) a StyleProfile carries content (transcript text / clip path) — enforcing content-free.

**Co-design guard (the rule that prevents B1 from regressing):** a field may only be added to StyleProfile if the Composer/renderer can apply it. Frontier-detectable-but-unrenderable signals go under `frontier` (optional), never the core.

---

## 6. Status
- ✅ Code-level map of both pipelines + the render ceiling.
- ✅ Unified `StyleProfile 2.0` zod schema (`src/lib/style-profile/style-profile.ts`).
- ✅ Adapters `fromVisualBlueprint` + `fromLegacyStyleProfile` (`src/lib/style-profile/adapters.ts`) + passing test (`scripts/test-style-profile.ts`, run `npx tsx scripts/test-style-profile.ts`): both legacy pipelines → valid, **content-free** StyleProfile 2.0.
- ✅ **Step 3** — `clone-style` route emits `StyleProfile 2.0` as a non-breaking **shadow output** (`fromVisualBlueprint(blueprint)` → `tempDir/style-profile-2.0.json` + a one-line log) right after the blueprint is CV-finalized. Typechecks clean (0 errors in B1 files; the repo's 7 pre-existing TS errors are unrelated). Will exercise on the next real reference analysis.
- ⏳ Next: **step 4** — Composer (`buildEditingPlan`) consumes 2.0 (start with captions/color/layout — the renderable layers); **steps 5–6** — converge the two routes + deprecate legacy schemas + add the content-free regression gate to `test-regression.mjs`.
