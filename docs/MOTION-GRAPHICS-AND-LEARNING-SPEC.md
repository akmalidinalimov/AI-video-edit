# StyleClone — Motion-Graphics Component System & Self-Learning Engine (Spec v2)

*Extends [`REFERENCE-ANALYSIS-ENGINE.md`](REFERENCE-ANALYSIS-ENGINE.md) (the analysis/StyleProfile heart). This doc rewrites how StyleClone **produces** motion graphics and how it **gets better over time**, per the 2026-06-22 product feedback. Companion to `STARTUP-ROADMAP.md` and `BUILD-PLAN.md`. MVP-scoped: every section ends with the smallest version that proves the power.*

---

## 0. The four pillars (your feedback, made architectural)

1. **Componentized + variant-based.** Every motion graphic is a *typed component* with explicit **variants**. The variant is the style skin (glass / dark / paper / warm / forbidden / **profile-derived**); the motion logic is shared.
2. **Every component has a specialized input contract** — it *knows* exactly what it needs: a **goal/intent**, a **style**, a **placement**, **timing**, and a **content payload** (data / text / media). No component guesses.
3. **Every component has a dedicated super-specialist** — an agent whose only job is to author/extend/perfect that one graphic type to a hard **perfection bar**, driven by a per-component **prompt card**.
4. **The system self-learns.** Each reference video it studies is one *lesson*. After each lesson it has more StyleProfiles, more reusable **idioms**, and more **components** — measurably more capable. Motion graphics are **AI-rendered code** (Remotion), authored creatively the way the references do it — never real-time, always rendered.

> **One sentence:** StyleClone builds motion graphics from a registry of typed, variant, specialist-authored Remotion components, and grows that registry (plus an idiom playbook and a style library) every time it analyzes a new reference — like a professor who gets sharper with each video.

---

## 1. ReelStack's role + how we integrate it

ReelStack is our **style vocabulary + primitive toolbox + reference corpus** (full assessment: [`REELSTACK-CAPABILITIES.md`](REELSTACK-CAPABILITIES.md)). It is **not** our motion-graphics engine and **not** an infographics generator (it ships zero charts). So:

- **Wrap, don't fork.** Each StyleClone `MotionComponent` may *internally* compose ReelStack primitives (StaggeredWords, Counter, SonarRings, CausticBlobs, IridescentText, BentoGrid, FilmStrip…) but always behind **our** input contract + variant system. ReelStack stays an implementation detail.
- **Adopt its discipline.** Port its 20 lint rules (hw-accel-only, motion-floor ≥3 layers, IG safe-zones top 290 / bottom 422, reduce-motion parity, 4px grid) into our **perfection bar** (§2.5).
- **Adopt its tokens.** Vendor the 5 families' palette + easing/spring + grid + safe-zone tokens into `src/remotion/motion/tokens/` as the seed `style` variants.
- **Never call its CLI from our pipeline** (Windows-broken; interactive). Render via Remotion's Node API (`renderMedia()`), or Remotion Lambda for throughput. Replicate its ffmpeg GIF/BGM recipes if needed.
- **⚠ Licensing decision (open, §6):** ReelStack is a per-machine license. Confirm whether vendoring its component *source* into our repo is permitted. Default-safe path: **re-implement the handful of primitives we need as our own**, keep ReelStack as a per-dev local reference. We were going to wrap them in our own contract anyway.

**Build-it-ourselves (the gap):** all **data-viz / infographics** (bar, column, line/area, donut, %-ring, progress, counter-with-context, comparison/versus, leaderboard, timeline, annotated callout). This is exactly where your "infographics animation" interest lands and where ReelStack is empty.

---

## 2. The Motion-Graphics Component System (MGCS)

### 2.1 Principle — graphics are rendered code, not real-time
A motion graphic is a **Remotion composition** parameterized by an input contract and rendered offline into the edit (FFmpeg base track + Remotion overlay compositor, per the engine spec). "AI-renderable" = the AI's job is to (a) pick the component + variant, (b) fill the contract from the StyleProfile + ContentPlan, (c) when a needed graphic doesn't exist, have a specialist *author the code*. The creativity comes from the specialists studying reference frames + the learned idiom bank — not from real-time generation.

### 2.2 A component is five things
```ts
// src/remotion/motion/types.ts
export interface MotionComponent<I extends MGBaseInput> {
  id: string;                          // "data-viz/bar-chart"
  category: GraphicType;               // matches StyleProfile.motion_graphics.graphic_type
  inputSchema: z.ZodType<I>;           // (2) the typed contract — the component KNOWS its input
  variants: VariantTable;              // (1) cva variant table: style skins
  Render: React.FC<I>;                 // the Remotion component (renders code, not realtime)
  defaults: Partial<I>;
  gates: PerfectionGate[];             // (3) the perfection bar — must all pass to ship
  specialistId: string;               // (4) the dedicated specialist agent
  promptCardPath: string;             // the specialist's prompt
  exemplars: ExemplarRef[];           // reference frames/clips this graphic should resemble (grows via learning)
}
```

### 2.3 The input contract — every component *knows* what it needs
A shared **base** (the goal + style + placement + timing) plus a per-type **payload**. Built on `zod` (already a dependency), validated before render so a malformed plan never reaches the renderer.

```ts
// src/remotion/motion/contract.ts
export const MGBaseInput = z.object({
  intent:     z.string(),                       // THE GOAL: what this graphic must communicate
                                                //   e.g. "emphasize 3× revenue growth in 2s"
  style:      StyleRef,                          // family name OR profile-derived token set (§2.4)
  placement:  z.object({                         // from StyleProfile.layout (normalized 0-1)
                bbox_norm: Vec4, anchor: AnchorEnum, z_order: z.number().int() }),
  timing:     z.object({                         // from StyleProfile.motion_graphics.animation
                time_range: Vec2,
                enter:    AnimSpec, emphasis: AnimSpec.optional(), exit: AnimSpec,
                easing:   EasingEnum, beat_lock: z.boolean().default(false) }),
  palette:    z.array(Hex).max(6),
  reduceMotion: z.boolean().default(false),
});

// Example payload — the data-viz gap ReelStack can't fill:
export const BarChartInput = MGBaseInput.extend({
  data:        z.array(z.object({ label: z.string(), value: z.number(), color: Hex.optional() })).min(1).max(8),
  reveal:      z.enum(["grow","wipe","stagger"]).default("grow"),
  value_format:z.string().default("{n}"),       // "{n}", "${n}", "{n}%"
  baseline:    z.number().optional(),           // draw a reference line
  highlight_index: z.number().int().optional(), // the bar to pop
});
```
The four words you used map cleanly: **goal → `intent`**, **view → `style` + `placement`**, **enrol/role → `category` + the chosen variant**, **input/prompt → the validated payload**. The component "knows" because the schema is its law and the specialist's prompt card is its training.

### 2.4 Variants — your "dividing the variants"
Powered by `class-variance-authority` (already a dependency). Each component declares a variant table; the **motion is shared, the skin varies**:
```ts
variants: cva(base, { variants: {
  style: { glass:…, dark:…, paper:…, warm:…, forbidden:…, profile:…/* tokens injected from a StyleProfile */ },
  density: { calm:…, standard:…, energetic:… },   // motion intensity
}, defaultVariants: { style: "profile", density: "standard" } })
```
The killer variant is **`profile`**: it pulls palette/easing/spring/typography straight from the *current* StyleProfile, so the same bar-chart component renders "in the reference's style" automatically. That is how one component serves any cloned style.

### 2.5 The perfection bar (each component "perfectly compiled and done")
A component is not "production" until **every** gate passes (ported from ReelStack lint + our own):
1. **Compiles & registers** — TS builds; `remotion compositions` lists it.
2. **Static lint** — hw-accel-only (transform/opacity), motion-floor ≥3 layers (≥4 opener), safe-zones, reduce-motion prop present, 4px grid, no placeholder copy/assets *(close the asset-gap ReelStack lint missed)*.
3. **Contract test** — invalid input rejected by zod; valid input renders.
4. **Golden render** — render frame 0/mid/last at every variant; assert non-black, within ΔE tolerance of an approved snapshot.
5. **Critique ≥ threshold** — the specialist self-scores (palette/motion/timing/hierarchy) and a `qa-verifier` pass signs off.
A component carries a `status: draft | gated | production` and only `production` components are eligible for auto-use by the Composer.

### 2.6 The registry + catalog
```ts
// src/remotion/motion/registry.ts
export const MG_REGISTRY: Record<GraphicType, MotionComponent<any>[]> = { … };
export function resolve(graphic: StyleProfileGraphic): MotionComponent<any>  // picks component+variant
```
The registry is the single source of truth the Composer queries: *"I need a `data_viz` graphic that communicates X in the `profile` style"* → registry returns the best `production` component + variant, or signals a **gap** (→ learning loop §3 spawns the specialist to build it).

### 2.7 Per-component specialist agents (super-specialized)
One **agent template**, instantiated per component type via a manifest. Each specialist:
- **Owns one graphic type** (e.g. `mg-bar-chart-specialist`, `mg-kinetic-caption-specialist`, `mg-lower-third-specialist`, `mg-donut-specialist`).
- **Prompt card** encodes: purpose, the exact input contract, the motion-design principles for *that* graphic, the easing/spring vocabulary, the available ReelStack primitives, the perfection gates, and **exemplar frames** from the learned library.
- **Loop:** read StyleProfile + reference frames → write/upgrade the TSX → run lint + golden-render → iterate until all gates pass → mark `production`.
- Spawned **in parallel** (independent components don't block each other), ending each with `qa-verifier` as the adversarial gate (per the global operating protocol).

### 2.8 The `motion-graphics-author` skill
A local skill (project-scoped: `.claude/skills/motion-graphics-author/`) that *is* the MGCS operating manual: the contract, the variant system, the perfection gates, the ReelStack primitive catalog, the registry API, and the specialist-dispatch rules. Invoking it is how any future task "authors a motion graphic correctly." It composes the existing `reelstack`, `gsap-core`, `gsap-timeline` skills. *(We build this rather than adopt one — no existing skill covers typed, variant, gated, data-viz Remotion components.)*

### 2.9 Component roadmap (MVP order — infographics first, since that's the gap)
**Wave 1 (data-viz, build ourselves):** counter-with-context · bar/column · donut/%-ring · progress-bar · comparison/versus.
**Wave 2 (wrap ReelStack):** kinetic caption (StaggeredWords) · lower-third · callout/arrow/highlight · sonar/particle emphasis · bento stat-grid.
**Wave 2.5 (tutorial / UI annotation — powers context-based B-roll, master spec §7.1):** cursor (move/click) · zoom-to-element (focus + Ken Burns) · highlight-box / spotlight · arrow-to-target · numbered step-callout. These animate **over a captured real UI** (`reel-capture`) — never a generated one.
**Wave 3:** timeline · leaderboard · annotated diagram · logo/sticker/emoji.
MVP = Wave 1 (3–5 components) + 2 from Wave 2, each at `production` with its specialist.

---

## 3. The Self-Learning Engine ("the professor")

Goal you set: feed it 20–50 already-edited reference videos, one at a time; each makes it more capable; MVP, just good enough to **show the power**.

### 3.1 What "learning" means at MVP — **no model training**
The system gets more capable by **growing three banks** and **sharpening its prompts** — pure data + retrieval, no fine-tuning. (Training is the graduation path, §3.6.)

### 3.2 The three growing banks
1. **StyleProfile Library** — every analyzed video → a stored, versioned StyleProfile (the engine-spec schema). The reusable style assets / future marketplace.
2. **Idiom Bank** — distilled, *reusable editing idioms* generalized across videos and linked to the components that implement them. Examples:
   - `hook.bold_text_zoom` → bold caption + `zoom_punch_in` in first ≤1.5s.
   - `data.reveal_on_beat` → counter + sonar-ring fired on the downbeat.
   - `broll.cover_jumpcut` → b-roll over a jump-cut at a sentence boundary.
   Each idiom = {trigger conditions, parameters seen (ranges), component(s), exemplars}. This is the **playbook** that thickens with every video. (Grounded in Leake et al. composable idioms, already cited in the engine spec.)
3. **Component Library** — when a reference uses a graphic we can't yet reproduce well, the loop **spawns the specialist to build it**. The system literally *gains new motion-graphics abilities by watching references.*

### 3.3 The learning loop (one pass per reference video)
```
for each reference video (sequential — one lesson at a time):
  1. ANALYZE   → StyleProfile                        (existing engine: [D] CV + [V] VLM)
  2. DISTILL   → extract idioms from profile+frames; generalize; embed;
                 dedupe/merge against Idiom Bank (RAG similarity)            → grow Idiom Bank
  3. GAP-CHECK → which graphics/idioms can't we reproduce at `production`?   → enqueue specialist builds
  4. SELF-TEST → re-synthesize this reference's STYLE onto a fixed neutral
                 "exam" footage; render; Style-Fidelity Score vs the profile (the engine-spec scorer)
  5. CRITIC    → where predicted ≠ measured, refine analysis prompts/heuristics;
                 write the lesson to `.knowledge/lessons/` (repo already uses this)  → sharper prompts
  6. COMMIT    → StyleProfile→Library, idioms→Bank, new components→Library, lesson→knowledge
```
Each iteration leaves the system strictly richer: more profiles, more idioms, more components, better prompts.

### 3.4 Retrieval (RAG) is the capability multiplier
At synthesis time, given a new edit's intent + ContentPlan, **retrieve the K nearest idioms / StyleProfiles / components** (embedding similarity over the structured profile + intent text). More learned data → closer matches → better, more reference-faithful edits — with **zero retraining**. This is the pragmatic MVP "intelligence."

### 3.5 The capability metric — the demo that *shows the power*
Hold out a fixed **eval set** (e.g., 5 reference videos never used for learning). After each of the N learning videos, run the eval set through synthesis and record the mean **Style-Fidelity Score**. Plot the **learning curve**: it should climb as the banks grow (retrieval finds closer idioms/components; gaps get filled). That rising curve *is* the MVP proof — "watch it get better with every video it studies." Also surface: idioms learned, components gained, prompt-lessons logged per lesson.

### 3.6 Graduation path (post-MVP, not now)
- Fine-tune the Uzbek aligner on accumulated data (already planned).
- Train small classifiers for transition/idiom labels to cut VLM cost & latency.
- Distill the Idiom Bank into a learned "editing policy" model.

---

## 4. How it fits the pipeline
```
Reference ─▶ Analysis Engine ─▶ StyleProfile ─┐
                                              ├▶ Idiom Bank (RAG)        ┐
Creator footage ─▶ Content Analyzer ─▶ ContentPlan                       │
StyleProfile+ContentPlan ─▶ Resource Planner ─▶ Storyboard+ResourceList │
Composer queries ─▶ MG Registry ─▶ MotionComponent+variant (or GAP→specialist builds it)
   ├─ fills each component's typed contract from StyleProfile+ContentPlan+retrieved idioms
   └─ EditingPlan ─▶ Render (FFmpeg base + Remotion overlay) ─▶ Style-Fidelity Scorer ─▶ closed loop
Every analyzed reference ─▶ Learning Loop ─▶ grows Library/Idioms/Components/Prompts
```

---

## 5. MVP scope & phases

**Phase 0 — Integration foundation**
- `src/remotion/motion/` skeleton: `types.ts`, `contract.ts`, `registry.ts`, `tokens/` (5 ReelStack families + `profile`).
- `motion-graphics-author` skill + `mg-component-specialist` agent template.
- Decision on ReelStack vendoring vs re-implement (§6).

**Phase 1 — First components (prove the pattern)**
- Build Wave-1 data-viz (counter-with-context, bar, donut/%-ring) + 2 wrapped ReelStack (kinetic caption, lower-third), each to `production` via its specialist. Golden renders in repo.

**Phase 2 — Learning loop v1**
- StyleProfile Library + Idiom Bank (JSON + embeddings) + RAG retrieve.
- `node scripts/learn.mjs <video>` runs ANALYZE→DISTILL→GAP→SELF-TEST→CRITIC→COMMIT for one video.
- Held-out eval set + learning-curve report.

**Phase 3 — Show the power**
- Feed 20–30 references; produce the learning-curve chart + a before/after synthesis on the same footage (lesson 1 vs lesson 30).

**Acceptance (MVP "good enough"):** (a) ≥5 `production` components incl. ≥3 data-viz; (b) one specialist demonstrably builds a *new* component from a reference it hadn't seen; (c) learning curve rises measurably across ≥20 videos on the held-out eval set; (d) a cloned edit visibly uses retrieved idioms + profile-styled graphics.

---

## 6. Open decisions (need a steer)
1. **ReelStack vendoring vs re-implement** — copy its component source into the repo (confirm license allows) **or** re-implement the few primitives we use (default-safe). *Recommendation: re-implement primitives + vendor only tokens.*
2. **Skill scope** — project-local (`AI-video-edit/.claude/`) **(recommended)** vs global (`~/.claude/`).
3. **Embeddings provider for RAG** — Gemini embeddings (already have the key) vs local (e.g., bge-small). *Recommendation: Gemini for MVP.*
4. **Self-test "exam" footage** — one fixed neutral Uzbek + one English clip we control. Need ~2 short clips to standardize the learning-curve metric.
