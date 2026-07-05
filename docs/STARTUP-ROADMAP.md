# StyleClone — Startup Roadmap & Technical Strategy

*Compiled 2026-06-21 from a deep repo audit + 5 verified web-research passes (Remotion/render, AI motion-graphics & generative video, video-analysis APIs, captions/transcription, competitors). Prices/specs carry sources; verify before contracting — this space moves monthly.*

---

## 1. The opportunity (validated)

**Your exact concept — upload a pro reference video + your raw footage → the tool re-edits YOUR footage to match the reference's edit DNA (cut rhythm, caption style, b-roll cadence, transitions, pacing) — does not exist at production quality today.** Triangulated across 12+ tools:

- **Every incumbent does something else:** OpusClip/Submagic/Klap/Vizard = long→clips + presets; Captions/Descript = prompt/preset edit styles; CapCut = pre-made templates + image-only "style transfer". **None ingest a reference *edit* and replicate it.**
- **Closest live = Mimics** (mimics.today) — but it **regenerates a new AI script + AI voiceover** instead of keeping your content, and matches pacing in only 3 coarse buckets.
- **The two credible funded teams have it as roadmap, not shipped:** Mosaic (YC W25) publicly says "soon… plan to incorporate style transfer [from] a video from the channel you enjoy + your raw footage"; Ponder AI is waitlist-only.
- **Academic precedent exists, never productized** (Google CVPR-W 2021, only 4 visual axes — no cut rhythm/captions/transitions).

**Strategic conclusion:** real open whitespace; **first to ship full-fidelity reference cloning wins.** Your moat is two-fold and must be defended in the MVP:
1. **Edit the creator's OWN footage and content — never regenerate script/voice** (Mimics' fatal weakness = your differentiator).
2. **A richer style signature than coarse pacing** — cut rhythm + caption vocabulary + transition set + b-roll cadence + layout + color.

Market anchors: AI-in-video-editing $0.9B (2023) → $4.4B by 2033 (17% CAGR); pricing norm **$29–39/mo Pro band**, credit-metered, near-universal watermarked free tier.

---

## 2. Where the codebase is today

Full detail in the audit; the load-bearing facts:

- **It's an FFmpeg product** — `renderMedia()`/`bundle()` are never called; the Remotion tree (`src/remotion/*`) is preview-only/vestigial.
- **Two disconnected pipelines:**
  - **Pipeline A — product** (`src/app/api/clone-style/route.ts` + `src/lib/pipeline/*`): smooth UX, content-aware b-roll matching, **but uses raw Gemini word timestamps** (300–1000ms drift) and only a lenient, non-blocking Gemini QA score.
  - **Pipeline B — scripts** (`scripts/aroll-pipeline.mjs`, `multi-aroll-closed-loop.mjs`): rigorous — MMS forced alignment, deterministic word-completeness, boundary-guard, YuNet crop safety, auto-tune until READY — **but hardcoded to test footage** and no real b-roll matching.
- **Strong, keep:** the CV measurement engine (`coordinate-measurer.ts`, `cv-correction.ts`), single-pass FFmpeg renderer (`plan-renderer.ts`), the closed-loop QA philosophy, the regression suite, content-aware b-roll matching (`narrative-analyzer.ts`), and the encoded domain knowledge in `docs/`.

**The research validates your core instinct:** the right architecture for style extraction is exactly your "measure with CV, classify with Gemini" split. You don't pivot — you *extend and unify*.

---

## 3. 🚨 Urgent finding: a commercial-licensing landmine

**Meta's MMS forced-alignment bundled weights are CC-BY-NC 4.0 (non-commercial).** Pipeline B's word-precise timing depends on them. **You cannot ship this commercially.** Replace with:
- **WhisperX** (BSD-2, actively maintained, CPU-capable, word-level via wav2vec2) — recommended, or
- **Montreal Forced Aligner** (MIT, research-grade, heavier).

This is the highest-priority fix and it touches your crown-jewel correctness path.

---

## 4. Resolved architecture decisions

| Layer | Decision | Rationale (sources) |
|---|---|---|
| **Style extraction** | **Layered: deterministic CV for the frame-accurate signature; Gemini 2.5 Flash for semantic description only — never for timing.** PySceneDetect `AdaptiveDetector` + **TransNetV2** (dissolves) for cuts; optical flow for zoom/pan; **Light-ASD** for a-roll/b-roll; **PaddleOCR** for caption geometry; per-shot color stats. | Gemini samples at **1 fps**, returns **MM:SS** timestamps, drifts on long inputs — physically can't localize a cut to frame. CV is frame-exact, deterministic, free. (ai.google.dev/gemini-api/docs/video-understanding) Matches the repo's existing philosophy. |
| **Transcription + word-safe trims** | **Gladia** (ms word times + *free* diarization, 156 langs, ~$0.20/hr) **or AssemblyAI** ($0.15/hr, best proper-noun accuracy). Optional **WhisperX** refinement near cut points. Cut at the **silence midpoint between words**, never inside a word span. | Both give word timing + speakers in one call. Replaces non-commercial MMS. (assemblyai.com/pricing, gladia.io/pricing) |
| **Creative compositor (final styled render)** | **Remotion** as the compositor; **keep FFmpeg for ingest/normalize/probe + simple ops.** Hybrid. | Remotion *runs on top of FFmpeg*; first-class animated captions (`@remotion/captions` → `createTikTokStyleCaptions`), springy transitions, motion graphics — exactly the gaps. The repo already has a Remotion tree to revive (low switching cost). Clean LLM→render seam via **Zod-typed `inputProps`**. License = **Automators $0.01/render, $100/mo min (10k renders), no per-dev seats** — trivial at scale. (remotion.pro/license) **Hyperframes (HeyGen, Apache-2.0, free)** is the open-source hedge if license/cost ever bites — same HTML→MP4 model. |
| **Captions** | **Build your own renderer** (Remotion), styled from extracted reference params (font, highlight color, position, animation type). | No caption SaaS (Submagic/VEED/etc.) emits editable styled caption data, so none can reproduce an *arbitrary* reference style. |
| **B-roll** | **Phase A:** match the creator's own b-roll (keep `narrative-analyzer.ts`; add Twelve Labs/embeddings for semantic search at scale). **Phase B (the "+AI" ambition):** generative fallback when footage is missing — **Veo 3.1** primary ($0.05/sec Lite, native 9:16+audio), **Runway Aleph 2 / Luma Modify** for video-to-video style transfer, **Kling/Hailuo via fal.ai** as cost hedge. | Avoid **Sora 2** (API deprecating Sep 2026) and **Pika** (no first-party API). Build on **Veo 3.1** only (Veo 2/3 shut down Jun 30 2026). |
| **Render scale** | **Remotion Lambda** (chunked, ~$0.017 per 1-min 1080p, 15-min cap — fine for short-form). All generative APIs are async → **job queue + webhooks**, not real-time. | (remotion.dev/docs/lambda/cost-example) |

---

## 5. The build plan (grounded in current state)

### Phase 0 — Foundation & de-risk
- **Replace MMS → WhisperX** (license fix; urgent).
- **Quarantine dead/contradictory code:** the concat renderer `segmentRenderer.ts` (violates the single-pass rule), dead Remotion components, `referencePass1-3`, the orphaned `src/lib/verification/*` stack. Declare **one** authoritative pipeline.
- **De-hardcode the reference:** remove pinned `IMG_6018`/`reference-ground-truth.json` hand-authoring; derive everything from the uploaded reference.

### Phase 1 — The correctness moat (unified spine)
- Unify on the product API path. **Wire into `/api/clone-style`:** word-safe trims (Gladia/AssemblyAI + WhisperX) + deterministic word-completeness + boundary-guard re-transcription + the CV closed-loop QA — **as a blocking gate** (no silent ships). This makes the product trustworthy and is your real defensibility.

### Phase 2 — Style signature + captions (the wedge)
- Build the **auto-derived style-profile schema**: cut rhythm (ASL/CPM + full shot-length distribution), transitions (PySceneDetect + TransNetV2), layout (CV + face count), a/b-roll (Light-ASD), caption style (PaddleOCR params), color (per-shot stats → optional LUT).
- **Revive Remotion** as compositor; ship **burned-in animated captions** styled from the reference.

### Phase 3 — AI motion graphics + generative b-roll (the wow)
- Motion-graphics templates in Remotion driven by a **Gemini-produced Zod style spec** (`inputProps`).
- Generative b-roll fallback: Veo 3.1 primary; Runway Aleph 2 / Luma Modify for style transfer; Kling/Hailuo via fal.ai.

### Phase 4 — Scale & product
- Render on Lambda; job queue + webhooks; concurrency beyond the single-job mutex.
- **Transcript-anchored, reversible edit UX** (Descript's lesson — opaque frame edits don't earn trust).
- Pricing: $29–39/mo Pro band, credit-metered, watermarked free tier.

---

## 6. Top risks to manage

1. **Cut-point prediction has no ground truth** — deciding *where* to cut raw footage is taste, not a solved problem; validate via human preference, surface AI confidence as a hint, never a promise.
2. **Style ≠ disentangled from content** — a pacing signature from genre A won't cleanly transfer to genre B; scope the MVP to a content niche first.
3. **B-roll availability** — the matching asset often isn't in the creator's footage; the generative fallback (Phase 3) is what closes this.
4. **Caption accuracy is the visible quality floor** — every error is burned-in; this is why Phase 2 leads with captions.
5. **Generative-API latency** is tens of seconds to minutes — design async from day one.

---

## 7. Immediate next step (recommended)

**Start Phase 0:** swap MMS→WhisperX, quarantine dead code, and de-hardcode the reference — the foundation everything else builds on, and it clears the licensing blocker. Then Phase 1 (the word-safe unified spine).
