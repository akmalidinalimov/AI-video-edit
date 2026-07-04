# Scene-Level Self-Learning Knowledge Base — Design Spec

**Date:** 2026-07-04 · **Status:** approved design (brainstormed + user-confirmed decisions)
**Owner:** StyleClone engine · **Depends on:** UNIVERSAL-1 unified decode (landed), N-region renderer (landed)

## 1. Goal

A reference video is a SEQUENCE of timed scene-components (e.g. 0–3s split → 3–4s 3-layer
stack → 4–9s fullscreen B-roll → 9–14s circle PIP). Today the engine learns one label per
video. This design makes the engine learn **per scene**, across many references, into a
library that carries **proven decode + render recipes** — so a newly uploaded reference is
matched scene-by-scene and known scenes reproduce instantly at verified accuracy.

**User-confirmed decisions:**
- KB unit = **hybrid**: parametric FAMILIES + verified EXEMPLARS (with recipes + scores).
- Learning loop = **auto-learn gated by closed-loop score** (≥95 [D]); novel families
  require human confirmation (existing policy).
- Corpus = founder-collected reels dropped into a folder; batch learning CLI.

## 2. Architecture decision (Approach C — two-phase, no big-bang restructure)

Build the KB now behind a clean **`SceneKB` interface**; file-backed store today, swapped to
Postgres at platform milestone M4 (BUILD-PLAYBOOK) without touching the engine. **Restructure
verdict: none needed** — the route-phases decomposition + unified decode already provide the
seams. New capability = 4 additions, no rewrites:

```
reference video
   │
   ▼
[1] SCENE SEGMENTATION (new)          src/lib/analysis/scene-segmenter.ts
   fuse: VLM structureTimeline + shot boundaries + content-class switches
   → SceneWindow[] { t0, t1, layoutWindow }
   │
   ▼
[2] PER-SCENE DECODE (exists)          unified decode per window (layoutClass, regions,
   pacing, captions, motion — reuse; scoped to the window's time range)
   │
   ▼
[3] SceneKB MATCH (new)                src/lib/knowledge/scene-kb.ts
   family classify (VLM+CV cross-check, exists) → nearest-exemplar retrieval
   → KNOWN (recipe injected) | FAMILY-NEW (measure fresh) | NOVEL (human queue)
   │
   ▼
[4] PLAN/RENDER (exists)               recipes select template/render path + parameters
   │
   ▼
[5] LEARN (new, score-gated)           closed-loop score ≥95 [D] AND detectors agreed
   → addExemplar (dedup by referenceHash+window)
```

## 3. Components

### 3.1 `scene-segmenter.ts` (new)
- Input: unified decode artifacts (structureTimeline, shot boundaries, contentTimeline).
- Output: `SceneWindow[]` — maximal spans of stable layout structure; content-class switches
  inside a persistent structure do NOT split a scene (they're an attribute of it).
- `DecodedScene` = a SceneWindow + its window-scoped decode fields (layoutClass, regions,
  pacing, captions, motion) — the unit SceneKB matches and learns.
- Edge rules: min scene 0.8s (absorb shorter into neighbor); windows contiguous over [0, dur].
- Gate test: R1 → 1 window (split); R2 → windows per its structureTimeline (~3);
  R3 → 1 structural window with a multi-class contentTimeline.

### 3.2 `scene-kb.ts` + store (new)
Interface (backend-swappable):
```ts
interface SceneKB {
  matchScene(scene: DecodedScene): SceneMatch;      // {kind: known|family_new|novel, family, exemplar?, distance}
  getRecipe(family: string, exemplarId?: string): FamilyRecipe;   // decode + render recipe
  learnExemplar(e: ExemplarCandidate): LearnResult; // score-gated, deduped
  proposeFamily(scene: DecodedScene): FamilyProposal; // → human queue
  coverageReport(): CoverageStats;                  // % KNOWN across corpus; per-family stats
}
```
Store v1: `.knowledge/scene-kb/` — `families.json` (curated ~10–20; each: id, signature,
decodeRecipe {extractors, thresholds}, renderRecipe {templatePath, compositor, paramMap})
+ `exemplars/<family>/<hash>.json` (fractional geometry, pacing, captions, motion,
referenceHash, window, renderParams, closedLoopScore, provenance, createdAt).
**Measurements only — never footage** (copyright-safe by construction). Matching: family
filter → weighted nearest-exemplar distance (geometry 0.5, pacing 0.25, captions 0.15,
motion 0.10); KNOWN threshold distance ≤ 0.12 (calibrate on corpus).

### 3.3 Batch learning CLI (new): `scripts/learn-corpus.ts`
Walks a folder of reels: segment → decode (cached) → match → report per reel
(`known/family_new/novel` per scene) → learn what passes gates → append to corpus report.
Novel families → review queue file for human confirmation. Re-runnable (idempotent by hash).

### 3.4 Integrations (small edits to existing code)
- `analyze-reference.ts`: after unified decode → segment + match; attach `ctx.sceneMatches`;
  log the scene table (family + known/new + distance).
- `build-plan.ts` / N-region path: when a scene is KNOWN, inject exemplar render params.
- After `verify-output` closed-loop scoring: call `learnExemplar` per scene (score-gated).
- Decode-preview (platform, later): scene-timeline strip with ✓known(score)/new/novel chips.

## 4. Learning-loop safety (extends the proven poisoning defenses)
- **Windowed scoring (required new capability):** the closed loop today scores whole videos;
  per-scene learning requires scoring a scene's TIME WINDOW — `compareDecodedStyle` runs on
  window-scoped decodes of reference vs output (same fields, window-cropped). This windowed
  variant is part of this build, not an assumption.
- Admission gates: windowed closed-loop [D] score ≥ 95 AND CV/VLM class agreement AND dedup
  (referenceHash, window). Novel families never auto-admitted.
- Every exemplar carries provenance (source hash, date, score, engine version).
- Coverage report is a regression layer: library coverage on the fixed test corpus must
  never decrease (guards against bad migrations/pruning).

## 5. Security / compliance
- Store measurements, not footage; reference files delete-after-decode by default
  (PLATFORM-SPEC policy). No PII in exemplars. Store is content-hash keyed.

## 6. Testing
- Unit (pure, no video): segmenter window math; KB match/dedup/threshold; recipe lookup.
- Gate tests with known truth: R1/R2/R3 segmentation + match outcomes.
- Corpus regression: coverage never decreases; learn is idempotent.
- Existing closed-loop remains the ground-truth accuracy gate.

## 7. Competitive rationale
The library is the compounding moat: verified scene-recipes each carrying a measured
accuracy score — data + falsifiable metric, accumulated. Coverage % is the investor metric.
Directly enables the preset store (presets = curated exemplars).

## 8. Out of scope (this spec)
Postgres store (M4), the curation UI, audio/SFX components, cross-user KB sharing.
