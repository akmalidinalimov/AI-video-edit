# StyleClone — Master Build Spec & Sequenced Roadmap (v2)
### The "why this order" document — what to build, in what order, with the reasoning that makes quality and maintenance cheaper later.

*v2 compiled 2026-06-22 after a 6-specialist engine audit + an adversarial code-level review + research on Google video AI and the `claude-watch` frame-analysis tooling. The big change from v1: the engine is make-or-break not because it can't **see** enough, but because the **measure → schema → apply → evaluate** loop is broken in the running code. v2 is **foundation-first and demo-first**. Deep sub-specs (not duplicated here):*
- *[`REFERENCE-ANALYSIS-ENGINE.md`](REFERENCE-ANALYSIS-ENGINE.md) — StyleProfile schema + extraction stack + the extraction frontier.*
- *[`MOTION-GRAPHICS-AND-LEARNING-SPEC.md`](MOTION-GRAPHICS-AND-LEARNING-SPEC.md) — component system + (deferred) self-learning.*
- *[`REELSTACK-CAPABILITIES.md`](REELSTACK-CAPABILITIES.md) — ReelStack's role + the 1.5 fps render finding.*
- *Repo rules: [`../AGENTS.md`](../AGENTS.md), `aroll-pipeline.md`, `cropping-rules.md`, `style-cloning-principles.md`.*

---

## 0. How to read this

Phases are **Goal → Why now → Tasks → Exit gate → Status**. Two things changed the whole ordering and you should read them first: **§1 the three blockers** (verified against the running code) and **§3 the sequencing philosophy**. Everything else follows.

---

## 1. The three blockers (fix these before anything else — verified in code)

An adversarial review read the *shipping* code, not just these docs, and found the engine improvements have no home until three things are true. These supersede the old v1 "Phase 0."

| # | Blocker | Evidence | Fix |
|---|---|---|---|
| **B1** | **The product doesn't use the spec's StyleProfile.** Three competing schemas exist; the live pipeline (`src/app/api/clone-style/route.ts`) runs `VisualBlueprint → VCSTemplate → EditingPlan`. The engine-spec schema is markdown-only. | `route.ts:46-53`; `src/lib/gemini/schemas/styleProfile.ts` (tiny layout enum); `src/lib/types/styleProfile.ts` (a third type). | **Collapse to ONE StyleProfile, wire the live pipeline to it, and co-design it with the Composer's expressive ceiling** (never measure what the renderer can't apply). |
| **B2** | **The #1 non-negotiable is violated right now.** A-roll word times come from **Gemini**, not forced alignment; the WhisperX script exists but the product never calls it; the Uzbek aligner is broken (no align-model override → throws → silent segment-level fallback = drift that clips words). | `route.ts:156-188`; `scripts/python/transcribe_whisperx.py:44,59-68`. | **Wire WhisperX/Scribe into the product path; pass the Uzbek align model; add a regression that fails if any LLM timestamp reaches the trim.** |
| **B3** | **"95% fidelity" is unfalsifiable.** The score compares output-vs-**profile** (a mis-read style faithfully reproduced scores 100% while looking wrong) and the scorer is a VLM (violates "AI labels, never measures"). | `route.ts:966-987` (Gemini-vision "verifyRender" as the metric). | **Build an output-vs-REFERENCE, human-anchored evaluation harness** (held-out references, perceptual similarity vs the reference, 2-3 raters, Uz+En) before chasing 0.95. |

**Until B1-B3 are done, every "extract more" improvement is dead weight.** This was the single most important correction to v1.

---

## 2. North star, scope, non-negotiables

**North star.** Decode a professionally-edited 9:16 reference's *editing style* into a reusable **StyleProfile**, then auto-re-edit a creator's raw footage to match that **style — not content** — at **95%+ fidelity, in minutes**, getting better with each reference studied.

**MVP scope (demo-first).** Vertical 9:16; **Uzbek + English**; AI motion graphics; best-quality budget (paid OK); **one golden-path reference style + one language proven end-to-end before any breadth.** The goal is a *convincing, honest demo*, not a perfect system.

**Non-negotiables.** (1) never cut a word/sentence — word times from **forced alignment**, never raw LLM; (2) never present an edit that fails any closed-loop gate; (3) style separated from content in the data model; (4) deterministic where measurable, AI only to label/select; (5) verify before "done", with evidence; (6) licensing-clean in the shipped path.

---

## 3. Sequencing philosophy — *why some steps come earlier*

| # | Principle | Why earlier = cheaper quality & management later |
|---|---|---|
| **P0** | **Co-design the schema with the consumer (Composer), not just the producer.** | Fidelity = the *weaker* of {measure, reproduce}. Measuring an easing curve the renderer can't apply is wasted. The contract must be shaped by what we can render, not only what we can detect. |
| **P1** | **Contracts before producers/consumers.** | A schema change after N profiles + M components exist forces churn everywhere. (And today we have *three* schemas — B1.) |
| **P2** | **Deterministic spine before AI labels.** | CV/DSP numbers are reproducible and testable; VLM output is noisy. Let the AI *select among measured parameters*, never invent timing/positions — or 95% becomes unmeasurable. |
| **P3** | **A real evaluation harness before optimizing toward a number.** | You can't improve toward, or claim, a target you can't falsify. Output-vs-reference + human anchor must exist before any "0.95" or "it learns." (B3.) |
| **P4** | **One vertical slice before horizontal breadth.** | A thin end-to-end clone surfaces integration bugs cheap; breadth-first guarantees the "disconnected pipelines" failure (already in this repo). |
| **P5** | **Verification harness before scale.** | An enforced gate makes every later artifact trustworthy; without it defects compound silently (proven: the component gate caught a safe-zone bug a self-review missed). |
| **P6** | **Legally-clean tools before they're load-bearing.** | A swap is config now, a re-architecture under legal pressure later. |
| **P7** | **Buy everything that isn't the moat.** | The moat is the Analysis Engine + the Composer mapping. Transcription, GPU hosting, render farm, B-roll/image gen, music = managed APIs. Building them is wasted runway. |

---

## 4. System architecture

```
Reference video ─▶ [Frame-Sampling Intake] ─▶ [Reference Analysis Engine] ─▶ StyleProfile (content-free, shareable)
                     (claude-watch-style          [D] CV/DSP numbers + [V] VLM labels (Gemini)
                      ffmpeg frame budget +
                      scene-change + hook pass)
Creator footage ─▶ [Content Analyzer] ─▶ ContentPlan (transcript + FORCED-ALIGNED word times + what footage shows)
StyleProfile + ContentPlan ─▶ [Context-Aware Resource Planner] ─▶ Storyboard + ResourceList   (§7.1)
        │  per-beat B-roll intent → route: CAPTURE real UI (reel-capture) | GENERATE concept (Seedance 2.0 → Kling) | reuse creator footage
StyleProfile + ContentPlan + Resources ─▶ [Composer] ─▶ EditingPlan
        │  motion graphics → [MG Registry] typed/variant/gated Remotion components (Google can't do these)
        ▼
   Render: FFmpeg base track + Remotion overlay → Remotion Lambda (frame-parallel; local = 1.5 fps = too slow)
        ▼
   [Evaluation] output-vs-REFERENCE perceptual score + per-layer Fidelity readout (READ-ONLY) + human nudge knobs
        ▼
   [Demo surface] side-by-side Reference→Output player · Style Card · nudge knobs · feedback capture
```

---

## 5. Roadmap (foundation-first, then demo-first)

### Phase 0 — Unblock (B1-B3) + name the golden path
**Goal.** One schema wired to the live pipeline (co-designed with the Composer), real forced alignment incl. Uzbek, an output-vs-reference eval harness, and ONE named golden-path reference+language.
**Why now [P0,P1,P2,P3,P7].** Nothing downstream is real until the product and the spec describe the same object, word-timing is honest, and fidelity is measurable. Naming the golden-path artifact makes the build self-prioritize.
**Tasks.** Reconcile `VisualBlueprint` / `styleProfile.ts` / engine-spec into one typed StyleProfile (zod) that the renderer can consume → rewire `clone-style` to it (unify-by-replacement, delete the fork). Wire WhisperX (+ Uzbek align model) / Scribe v2 into the A-roll path; regression-fail on any LLM word time at trim. Build the eval harness (held-out refs, output-vs-reference perceptual similarity, 2-3 raters, Uz+En). Pick the one golden-path reference style + language.
**Exit gate.** Live pipeline emits & consumes the one schema; a real forced-alignment word-time path for Uz+En with a passing regression; an eval number that compares output to the *reference*; golden path named.
**Status.** ❌ all open. **This is the most important phase and currently the least done.**

### Phase 1 — The thin vertical slice ("Hello, clone") on the 4 visible layers
**Goal.** One reference → one creator clip → a rendered, side-by-side output, on the layers that *read on screen*: **captions, pacing, layout, color.**
**Why now [P4].** Prove integration end-to-end on the highest-perceived-style layers before depth or breadth. Render on **Remotion Lambda from day one** — "in minutes" is part of the pitch and local is 1.5 fps (21 min/65s).
**Tasks.** Extract captions+pacing+layout+color to the schema (deterministic spine, Gemini for labels only). Composer maps → FFmpeg base + Remotion caption/MG overlay → Lambda render. Reuse the repo's existing closed-loop QA (word completeness, boundary guard, crop safety, no-black-frames) as hard gates beneath the eval score.
**Exit gate.** One real output beside its reference, rendered in minutes, passing all hard gates; captions/cuts/layout/color visibly match.

### Phase 2 — Make it convincing + provable + fixable
**Goal.** The persuasive demo.
**Tasks.** Style Card (visualize the decoded StyleProfile). Read-only per-layer Fidelity readout (trust display, not a control loop). Human-in-the-loop nudge knobs (caption pos/size, color intensity, pacing tightness, music swap, B-roll on/off). Feedback capture (thumbs + note + profile + knobs used = the seed of future learning). B-roll fallback so gaps never break the demo.
**Exit gate.** End-to-end demo with a fidelity number on screen and a human able to push the 2 worst layers to "looks 95%."

### Phase 3 — Second style, second language (de-risk the claim)
**Goal.** Same pipeline, a second distinct reference style and the other language — kills "you hard-coded the demo," which is more convincing than a learning curve.

### Phase 4 — Deepen the engine (the extraction frontier) — *post-demo*
**Goal.** Raise fidelity with the audit's deeper extractors, **scoped to what the Composer renders.**
**Tasks (see engine spec "Extraction frontier"):** mask geometry + element tracking; transition motion-signatures + measured easing; speed-ramps; arrow targets; audio ducking-curve + SFX function; the content-free `story_spine` + per-beat `modality_alignment`. License-guarded (no CC-BY-NC/AGPL weights).
**Why later [P4,P5].** These add real fidelity but only matter once the slice works and the eval harness can prove the gain. Build each as an independent extractor with its own reproducibility test.

### Phase 5 — Composer power, then (optionally) learning
**Goal.** Closed-loop auto-tune (only once the read-only score + human nudge prove the layers are independently adjustable), then the self-learning loop **if** the demo earns it. Until then "learning" = saved StyleProfiles + lessons notes + the Phase-2 feedback table.

### Phase 6 — Scale & productize
Throughput already on Lambda; legal music/SFX; more languages; StyleProfile library/marketplace; creator UI (grown from the Phase-2 demo surface). **Adopt Gemini Omni here if its API has shipped.**

---

## 6. Best MVP stack (paid-OK; buy everything that isn't the moat — P7)

| Layer | Pick | Why |
|---|---|---|
| **Frame-sampling intake** | **`claude-watch`-style harness (MIT, reuse code)** | Duration-aware frame budget + scene-change selection + 0-10s "hook microscope" + sub-agent token isolation. Lift the plumbing; keep our structured decode as the moat. |
| **Own Python CV/ML hosting** | **Modal** | Python-native, per-second, fast cold start; run PySceneDetect/OCR/face/color/WhisperX as functions. |
| **Generative media backend (MVP)** | **Higgsfield MCP** (Creator plan, credit-based) | One backend for B-roll + image gen + edits on the existing subscription — no per-call fal/Google billing to wire for the demo. Balance ~2,074 credits (confirm monthly allotment). |
| **B-roll video (gen)** | **Seedance 2.0** (`seedance_2_0`, std 720p) primary · **Kling 3.0** (`kling3_0`, 1080p; `kling3_0_turbo` = budget) fallback · *bake-off Minimax Hailuo (`minimax_hailuo`) — Higgsfield's top "natural physics" pick* — all via Higgsfield MCP | Seedance = reference-driven (image+video+audio refs), identity-consistent, 9:16 — best fit for style-matched B-roll; Kling = cinematic 1080p fallback (`sound:off` = fewer credits). Veo 3.1 (Gemini API / fal) stays as a non-Higgsfield alternative. Per-clip credit cost is computed at gen time → confirm via a real test gen. |
| **Still images (thumbnails, title cards, B-roll plates, bg swap)** | **Higgsfield MCP image gen** (primary) · **Nano Banana Pro** (`gemini-3-pro-image-preview`) as alt | Keep image gen on the same Higgsfield backend for MVP; Nano Banana Pro = standalone-best image editor if a shot needs it. |
| **Background replacement on creator *video*** | **Veo masked editing (Vertex, Veo 2)** — *flagged* | The only Google API that edits an uploaded video today, but preview/allowlist, ≤8s, masks DIY, $0.50/s, Veo-2 quality. Use only if the style demands it; otherwise prefer video-to-video alts (Runway/Luma/Kling via fal). |
| **Video-to-video style re-edit (the core primitive)** | **Gemini Omni — WATCH-LIST** | "Nano Banana for video," exactly our re-edit-to-a-style primitive, but **no API yet** (consumer-only as of mid-2026). Adopt the moment the Gemini/Vertex endpoint ships. |
| **Transcription / alignment** | **WhisperX (En, BSD-2)** + **ElevenLabs Scribe v2 (Uz, word+char)** | Forced alignment = the word guarantee; Scribe covers Uzbek; self-host WhisperX+`xls-r-uzbek-cv8` (Apache) as the clean precision path. |
| **VLM (labels + narrative)** | **Gemini** (Flash for bulk labels, Pro for narrative) — *verify exact version at procurement* | Native audio+visual reasoning; already wired. Labels only, never timing. |
| **Render** | **FFmpeg (base) + Remotion Lambda (overlay/MG)** | Frame-parallel render = "in minutes." **Google has no motion-graphics generator — Remotion is non-negotiable here.** |
| **Music (MVP)** | **Storyblocks / ElevenLabs Music** by genre/mood/BPM | License-clean, one call; defer stem-separation/fingerprint guardrails. |
| **State / storage / app** | **Supabase Postgres · Cloudflare R2 · Next.js** | Reuse existing muscle; R2 = no egress; Next.js app = the demo surface. |

**Watch-outs (from the review):** price one end-to-end run (analysis already makes 6+ Gemini calls/job; adding GPU models compounds it); keep the vendor count lean for the demo; budget the **Remotion company license** (>3 employees) and the **ReelStack per-machine license**; all Google outputs carry **SynthID** (confirm no visible watermark on your delivery endpoint).

---

## 7. What Google can and can't do for us (honest)
- ✅ **Generate B-roll** — Veo 3.1 (already primary).
- ✅ **Edit/Generate still images** — Nano Banana Pro (thumbnails, title cards, B-roll plates).
- ⚠️ **Edit the creator's existing video** (bg replace) — only Veo-2 masked inpainting on Vertex today: preview, ≤8s, masks DIY, weak. Prefer non-Google video-to-video until Gemini Omni's API ships.
- ❌ **Motion graphics** — Google does not do this. **Remotion stays.**
- 🔭 **Gemini Omni** — the highest-upside fit for our core primitive; **no API yet** → watch-list, fast-follow.

---

## 7.1 Context-Aware Resource Planner — the context-based B-roll differentiator

The biggest differentiator we've found: B-roll that matches the **meaning**, not just the style. When the VO says "open the Layers panel and click the mask icon," the B-roll shows the *actual* interface with that icon highlighted, step by step. This turns StyleClone from "matches the look" into "matches what's being taught" — especially powerful for educational/tutorial content.

**The make-or-break rule: capture real UIs, generate only concepts.** Any generative model (Seedance/Kling/Omni) fed "the Magnific interface" produces a *plausible-but-fake* UI — invented menus, garbled text, wrong icons — and hallucinates the steps. In a tutorial that is actively misleading. So route by B-roll type:

| B-roll type | Acquire | Animate |
|---|---|---|
| **Real UI / software steps** ("click here → then here") | **`reel-capture`** (real screenshot / scroll-recording of the actual site/app) | **Remotion motion graphics** (cursor · zoom-to-element · highlight/spotlight · arrow-to-target · numbered step callouts) — **never generate a real UI** |
| **Conceptual / organic / real-world** (a concept, mood, product in use) | generate start image (Higgsfield / Nano Banana Pro) | **Seedance 2.0** image-to-video → **Kling 3.0** fallback |
| **Creator's own real screen-recording, restyled to the reference look** | creator footage | **Google Omni** (watch-list, when its API ships) — restyle, *not* fabricate steps |

**The router (Resource Planner v2):**
```
VO transcript (forced-aligned word times)
  └▶ Entity & action extraction (Gemini): products, UIs, menus, actions ("click/open/drag"), concepts → per-beat B-roll INTENT
       └▶ Resource router (classify each intent):
            • real UI/product    → CAPTURE (reel-capture the real site/app)        [accuracy path]
            • conceptual/organic → GENERATE start image → Seedance 2.0 i2v (Kling fallback)
            • creator already has footage → use it
       └▶ Animation router:
            • UI steps → Remotion motion-gfx (cursor · zoom-highlight · arrow-to-target · numbered step callouts)
            • organic  → Seedance 2.0 (Kling 3.0 fallback)
       └▶ Composer places each clip on the exact beat the VO mentions it (word-time anchored)
```

**Reuses what we already have** — forced-aligned word times (place B-roll exactly on the spoken word), the `reel-capture` skill (accurate UI), and the MGCS annotation components. Additive, not a new subsystem.

**Flagship demo candidate:** a **tutorial clone** — take a polished tutorial reference, feed a creator's raw tutorial VO + screen-recording, and auto-produce context-matched, annotated B-roll. It exercises the whole pipeline and is very convincing to an audience.

---

## 8. The critical path (one page)
```
B1-B3 + golden path (Phase 0) ─▶ thin 4-layer slice on Lambda (Phase 1) ─▶ convince+prove+fix (Phase 2) ─▶ 2nd style/lang (Phase 3) ─▶ engine frontier (Phase 4) ─▶ composer/learning (Phase 5) ─▶ scale (Phase 6)
        MG component library (gate-enforced) runs alongside, feeding Phase 1's overlay render.
```
**Single most important call:** do **Phase 0 (B1-B3 + golden path)** before any extraction depth. We are ahead on motion-graphics components and behind on the foundation — close that gap first.

---

## 9. Decision log & open decisions
**Decided.** ReelStack = wrap-not-fork (re-implement primitives + tokens). MG variants via token resolver (inline styles). Build all data-viz ourselves. Never call the ReelStack CLI from the pipeline. Self-learning deferred to "saved profiles + lessons + feedback" for MVP. Remotion for all motion graphics (Google can't). Generation via **Higgsfield MCP**: **Seedance 2.0 = primary B-roll, Kling 3.0 = fallback** (bake off Hailuo); image gen via Higgsfield / Nano Banana Pro; **Gemini Omni = watch-list** (restyle, not generation). **Context-based B-roll (§7.1): CAPTURE real UIs (`reel-capture`) + Remotion annotation; GENERATE only concepts (Seedance) — never fabricate a real UI.** `claude-watch` = reuse-as-scaffold, not dependency.
**Open (recommendation italic).** Golden-path style + language → *pick the caption-heavy, fast-cut talking-head style in the stronger-alignment language first.* RAG embeddings (if learning is built) → *Gemini.* Exam/eval footage → *need ~2 fixed Uz+En clips.* Fidelity target → *start 0.90, raise to 0.95 once the eval harness + nudge loop are stable.* Verify exact model versions (Gemini, SAM, Veo masked editing = Veo 2 vs 3.1) at procurement.

---

## 10. Pointers
StyleProfile schema + extraction stack + frontier → `REFERENCE-ANALYSIS-ENGINE.md`. Component system + (deferred) learning → `MOTION-GRAPHICS-AND-LEARNING-SPEC.md`. ReelStack role/limits/render-cost → `REELSTACK-CAPABILITIES.md`. A-roll process/cropping/QA → `../AGENTS.md` + `docs/*`.

---

### One paragraph
The engine is make-or-break, but not because it can't see enough — because in the running code the product ignores the spec's schema, fakes word-timing (breaking the #1 rule, worst for Uzbek), and measures fidelity against the profile instead of the reference. Fix those three first, co-designing the schema with what the Composer can actually render. Then prove ONE style end-to-end on the four layers that read on screen, rendered on Lambda so it's truly "in minutes," with the result visible side-by-side and a human able to nudge it to convincing. Buy everything that isn't the moat (Veo for B-roll, Nano Banana Pro for stills, Modal/Lambda for compute/render, Scribe/WhisperX for alignment), keep Remotion for the motion graphics Google can't make, and put Gemini Omni on a watch-list. Only after the demo convinces do you deepen extraction and build learning. Each step earns the next by passing a gate.
