# StyleClone — Detailed Build Plan (all phases)

*Companion to `STARTUP-ROADMAP.md` (strategy) and `REFERENCE-ANALYSIS-ENGINE.md` (the core spec). Task-level execution plan. Sizes are relative effort (S/M/L/XL), not calendar. Every phase ends with a gate that must pass before the next begins.*

**Guiding invariants (never violate):**
- **Style is separated from Content.** Reference → StyleProfile (style DNA only); creator footage → ContentPlan; a Composer applies one to the other. **Never leak the reference's words/clips.**
- **Never hardcode a style.** Machinery is generic; a "style" is a test target. Adding a style = feeding a new reference, zero code.
- **Never cut a word.** Trims land in inter-word silence, validated deterministically against per-word timestamps.
- **Never ship un-gated.** Render → Style-Fidelity Score + hard correctness gates → auto-tune → re-render; READY only when all pass.
- **Reproduce style, license/generate the assets.** Never copy the reference's exact music/SFX/footage (copyright).
- Single-pass FFmpeg base render; frame-aligned ranges; add a regression check per fixed bug.

**Style #1 target:** talking-head founder/educational short — bold word-by-word captions + silence-removal cuts + keyword-triggered b-roll + occasional PIP. Dev against `IMG_6018`; validate against 2–3 other references of the same archetype.

**Languages:** English + Uzbek first (see Engine spec §7). Build the Uzbek+English benchmark set in Phase 0.

---

## Phase 0 — Foundation: unify, de-risk, clear licensing  *(reuse-preserving)*

**Goal:** one clean, authoritative, reference-agnostic skeleton with no legal blockers and a way to measure language quality.

- **0.1 — Replace non-commercial alignment.** `L` 🚨 — swap MMS → **WhisperX (BSD-2) + `lucio/xls-r-uzbek-cv8` (Apache)** for Uzbek, default wav2vec2 for English. One fix clears both the MMS license risk and the Uzbek aligner gap.
- **0.2 — Quarantine dead/contradictory code.** `M` — remove `segmentRenderer.ts` (violates single-pass), `referencePass1-3`, orphaned `src/lib/verification/*`, `speedRampPlanner`/`renderDescriptions`, superseded Remotion components; mark `beatDetector.ts` Phase-3 (replace with `beat-this`).
- **0.3 — Declare the authoritative pipeline + module map.** `S` — product API (`/api/clone-style`) is the spine; commit `docs/pipeline-map.md` reflecting the Style/Content separation architecture.
- **0.4 — De-hardcode the reference.** `L` — remove pinned `IMG_6018`/`reference-ground-truth.json` hand-authoring; everything derives from the uploaded reference.
- **0.5 — Uzbek+English benchmark set.** `M` — small real-footage set with hand-checked word timings; harness to score ElevenLabs Scribe vs Azure vs self-host WhisperX on accuracy + boundary precision.
- **0.6 — Update the regression suite** for the unified pipeline + new aligner. `S`

**Gate:** clean build, green regression, no non-commercial deps, pipeline runs end-to-end on two different references; benchmark numbers recorded for both languages.

---

## Phase 1 — Reference Analysis Engine + StyleProfile  *(the heart / the moat)*

**Goal:** decode any reference into the structured `StyleProfile` (Engine spec §3) — the differentiator.

- **1.1 — StyleProfile schema + types.** `M` — implement `src/lib/types/styleProfile.ts` to the v1.0 schema (normalized coords, all 8 layers).
- **1.2 — Deterministic `[D]` extractors.** `XL`
  - Pacing: PySceneDetect `AdaptiveDetector` + **TransNetV2** → ASL/CPM/shot-length distribution; `beat-this` grid + cut-to-beat alignment.
  - Layout: reuse the CV engine (`coordinate-measurer.ts`) → normalized region bboxes, z-order, face detect.
  - Captions: **PaddleOCR** → color/stroke/box/size/position/words-per-line/casing + cross-frame color-flip for karaoke timing.
  - Transitions: cut times, dissolve duration, optical-flow direction, J/L via A/V offset.
  - Color: temp/tint/contrast/saturation/lift-gamma-gain/curves/k-means palette.
- **1.3 — VLM `[V]`/`[H]` labeling.** `L` — Gemini 2.5 Flash over the CV-derived timeline + sampled keyframes: region roles, transition/animation/graphic types, hook/structure, look name. **Never timing.**
- **1.4 — Motion-graphics + audio extraction (v1).** `L` — motion-graphics elements (bbox/type/animation); audio analyze stack (Demucs → PANNs+librosa SFX onsets, beat grid, energy curve) per Engine §6.
- **1.5 — StyleProfile as a saved, versioned asset.** `M` — persist, version, and make it reusable (foundation for the future style library).
- **1.6 — Tests** — schema validation; deterministic extractors are reproducible across runs. `S`

**Gate:** uploading any same-archetype reference yields a complete, reproducible StyleProfile with no manual editing; spot-checks confirm the `[D]` layers are accurate.

---

## Phase 2 — Content pipeline + Composer + Style #1 perfected

**Goal:** word-safe creator-footage pipeline + apply StyleProfile + great captions, tuned until one archetype is excellent; the Style-Fidelity loop is live.

- **2.1 — Content Analyzer.** `L` — transcription (ElevenLabs Scribe / WhisperX) → `ContentPlan` with high-precision per-word (+char) timestamps, keywords/topics per segment, and what each b-roll clip shows.
- **2.2 — Word-safe trim engine.** `M` — port `trim-validator.mjs`; cut at silence midpoints; anchor to sentence IDs.
- **2.3 — Composer.** `L` — apply StyleProfile → ContentPlan → `EditingPlan` (layout, pacing, transitions, caption styling, color). Keep `narrative-analyzer.ts` for keyword→b-roll matching.
- **2.4 — Caption rendering (Remotion).** `L` — revive Remotion as the caption compositor (`@remotion/captions`), styled from StyleProfile params; FFmpeg base video + Remotion caption overlay. Char-level animations via Scribe timing.
- **2.5 — Style-Fidelity Scorer + closed loop.** `L` — implement the per-layer score (Engine §5); wire render → score → auto-tune worst layer → re-render → READY at composite ≥ target AND hard gates pass (word completeness, crop safety, no black frames). Surface per-layer breakdown.
- **2.6 — Tune on Style #1.** `L` — iterate to target fidelity across `IMG_6018` + 2–3 other same-archetype references.

**Gate:** a same-archetype reference + raw footage produces a READY output at composite fidelity ≥ target; a broken trim FAILs the gate instead of shipping.

---

## Phase 3 — Resource-gap storyboard, audio, generative, generalize

**Goal:** the resource flow, legal audio reproduction, the generative "wow", and proof of generality.

- **3.1 — Resource Planner + storyboard.** `L` — from ContentPlan + StyleProfile, produce a shot/resource list (needed b-roll/graphics/SFX/music per segment) → match to uploads → **storyboard UI with gaps highlighted** → prompt user to upload or AI-generate.
- **3.2 — Legal audio reproduction.** `L` — characterize → match from licensed library (Storyblocks API) or generate (ElevenLabs Music+SFX / Mubert); place SFX at detected timestamps; similarity guardrail. (Never copy the reference's track/SFX.)
- **3.3 — Generative b-roll fallback.** `XL` — **Veo 3.1** primary; Runway Aleph 2 / Luma Modify (video-to-video style transfer); Kling/Hailuo via fal.ai (cost hedge). Async job + webhook; triggered only on a real gap.
- **3.4 — Motion-graphics templates.** `L` — Gemini emits a **Zod-typed `inputProps`** spec driving parameterized Remotion templates (safer than per-render React).
- **3.5 — Generalization test.** `M` — run 3+ distinct references with **zero code changes**; measure fidelity; fix generality gaps. The real test of the one-style-at-a-time strategy.

**Gate:** a brand-new reference style works without code; gaps are filled (uploaded or generated) and the output passes fidelity + correctness gates.

---

## Phase 4 — Scale, product & the style library

**Goal:** production throughput and a sellable platform.

- **4.1 — Remotion Lambda render** (chunked, distributed). `L`
- **4.2 — Job queue + webhooks; remove the single-job mutex; concurrency.** `L`
- **4.3 — Reversible, transcript-anchored edit UX** + confidence surfacing (trust). `XL`
- **4.4 — StyleProfile library / marketplace** — browse, apply, share/sell decoded styles (the network-effect play). `XL`
- **4.5 — Pricing/metering** ($29–39 Pro band, credits, watermarked free tier) + auth/billing + per-video cost telemetry. `L`

**Gate:** concurrent users get gated outputs in minutes at a known per-video cost, can correct edits, and can apply library styles.

---

## Cross-cutting (every phase)
- Keep the regression suite green; add a check per fixed bug.
- Track per-video API cost (transcription, Gemini, generative, audio) as features land.
- Review every change against the invariants — especially "no hardcoded style" and "style ≠ content".
- Concentrate QA on the `[H]` (CV-proposes / VLM-labels) layers — that's where reproduction error lives.
