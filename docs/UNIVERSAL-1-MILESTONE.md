# Milestone UNIVERSAL-1 — Universal Decode + Render (demo-grade)

**Set:** 2026-07-02 · **Owner:** StyleClone core · **Purpose:** demo to validate the startup.

## Goal (one line)

Any of the 3 uploaded reference styles can be **decoded AND re-rendered end-to-end** with the
user's raw footage, measured by the closed-loop style score — reliably enough to demo.

## The 3 reference styles (the acceptance set)

| # | File | Style | Decode today | Render today |
|---|------|-------|--------------|--------------|
| R1 | `public/uploads/1782174583392_target_2split.mp4` | 2-region top/bottom split (B-roll 1:1 top, A-roll band bottom) | ✅ 98.1% closed loop | ✅ full route |
| R2 | `public/uploads/DownReels_20260701_191828.mp4` | 4-layer stack: header/title + B-roll window + screen-rec strip + A-roll | ✅ multi-region decode (standalone) | ❌ no N-region renderer |
| R3 | `public/uploads/ref3-aipipeline.mp4` | PIP-over-fullscreen: persistent rounded-rect A-roll bubble, time-varying background (B-roll → diagram → screen-rec) | ⚠️ structure right; no time dimension, PIP geometry approximate | ❌ |

## Success criteria (the gates)

1. **Decode gate** — for each of R1/R2/R3: the unified decode (one path, not two) produces the
   correct layout class, regions (pixel-refined), pacing, and per-segment timeline where the
   layout varies. Verified against frames (human-checkable) + the [D]-tier self-consistency.
2. **Render gate** — for each style: the route renders the user's A-roll + B-roll into that
   layout (N-region composite: header band, content windows, PIP inset with rounded corners).
   No credits beyond ~50cr total; reuse the 7 generated clips + raw footage where possible.
3. **Closed-loop gate** — decode(reference) vs decode(output) ≥ **90%** on the [D] tier for
   each style (98%+ remains the bar for R1; R2/R3 are new — 90% is the demo bar).
4. **Reliability gate** — the full route completes without manual intervention on all 3;
   regression suite passes; no CC-BY-NC dependencies in the live path.

## Non-goals (explicitly out of scope for this milestone)

- Product UI / self-serve upload surface.
- Arbitrary unseen styles beyond the 3 (that's UNIVERSAL-2, after the demo).
- Audio/SFX/music style cloning.

## Plan of record

Phase 1: full parallel audit (5 subsystems) → gap map → adversarial gate.
Phase 2: fix in priority order (foundation → decode unification → time dimension → N-region renderer).
Phase 3: end-to-end proof on R1/R2/R3 + closed-loop scores + watch-test.

## Wave-2 architecture decision (spike-verified, 2026-07-02)

The proposed "Remotion composite over FFmpeg feeder tracks" was SPIKED before committing
(`scripts/spike-nregion.ts` + `NRegionSpike` composition): a 4-region 20s multi-video composite
server-rendered at **10.25x realtime** (205s for 20s) — FAILS the <4x feasibility bar (a 67s reel
≈ 11 min per closed-loop iteration). **REVISED architecture:**

- **FFmpeg remains the timeline compositor** (the proven single-pass composite + montage feeders).
- **N-region additions land in the FFmpeg filtergraph:** per-region scale+overlay for content
  windows; **rounded-rect PIP via a sharp-generated alpha-mask PNG + `alphamerge`** (one fast
  filter — no per-pixel geq, no React frame rendering).
- **Remotion renders only static/short assets, once:** the styled header/title band (PNG or short
  clip via the proven mg-render path), MG components (unchanged), captions (unchanged pass).
- Audio: unchanged (`-map` continuous A-roll).

The spike artifacts stay in-repo as the evidence + the seed of a future revisit if Remotion
render perf improves (concurrency tuning got nowhere near 4x on this machine).

## Scene-KB (2026-07-04 plan: docs/superpowers/plans/2026-07-04-scene-kb.md)

Scene-level self-learning KB landed (spec docs/superpowers/specs/2026-07-04-scene-kb-design.md):

- `window-decode.ts` — windowed closed-loop scoring (compareDecodedStyle unchanged; window-isolation proven by unit test).
- `scene-segmenter.ts` — contiguous SceneWindows from the VLM structureTimeline, 0.8s min-scene absorption; R1→1 / R2→per-timeline / R3→1 gate.
- `scene-kb.ts` + `.knowledge/scene-kb/` — 3 render-proven families seeded; weighted nearest-exemplar (geo .5 / pacing .25 / captions .15 / motion .10), KNOWN ≤ 0.12; learn gates: score ≥ 95 + CV/VLM agree + (referenceHash, window) dedup; novel → review queue, never auto-admitted.
- `learn-corpus` CLI — batch match/learn over a reel folder, idempotent, corpus-report.json + review-queue.json.
- Route: analyze-reference matches scenes → ctx.sceneMatches; build-plan injects exemplar renderParams for KNOWN N-region scenes; verify-output learns score-gated after verification.

Coverage % (kb.coverageReport) is the corpus regression layer: it must never decrease on the fixed test corpus.
