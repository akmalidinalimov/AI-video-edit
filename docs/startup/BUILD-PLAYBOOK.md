# StyleClone — Build Playbook

**Status:** v1 · 2026-07-02 · Companion to `docs/startup/PLATFORM-SPEC.md`
**Purpose:** the step-by-step workflow from TODAY's state (engine mid-UNIVERSAL-1) to an
investor demo to a first-10-users beta — when to start, when to stop, how to test, at what
level, and how to slice work into ≤1-day tasks.

**Starting point (honest):** R1 decodes + renders end-to-end at 98.1% closed loop; R2 decodes
(multi-region) but has no N-region renderer; R3 decode lacks the time dimension and exact PIP
geometry. The route is a prototype: in-request SSE, a boolean concurrency guard, no auth, no
queue, shared `sp-temp` artifact dir, path-keyed (not hash-keyed) caches. The N-region render
architecture is already decided and spike-verified (FFmpeg filtergraph + sharp alpha-mask PIP;
Remotion for static assets only).

---

## 0. Operating rules (apply to every milestone)

1. **Task size:** every task ≤1 day. If it isn't, split it until it is.
2. **Owner types:** `engine` (decode/render/metrics), `frontend` (Next.js UI), `infra`
   (queue/storage/db/deploy). One owner-type per task; cross-cutting tasks are two tasks.
3. **Gate before "done":** each milestone has a definition-of-done (DoD) gate and produces a
   **demo artifact** — something you can show, not a claim.
4. **No commit without** `node scripts/test-regression.mjs` passing (and `--full` after render
   changes). When a bug is fixed, a check that would catch its return is added to the suite —
   this is already house law (AGENTS.md); the playbook just extends it to platform code.
5. **Credit discipline:** decode/render iterations reuse cached blueprints + the existing
   generated clips + raw footage; B-roll generation stays OFF until M6.
6. **Human watch-test is a real gate, not a formality:** no style ships (as demo or preset)
   until someone watches the render next to the reference and signs off.

---

## 1. The testing pyramid (codified from what the repo already does)

Cheapest and most deterministic at the bottom; run bottom-to-top; a layer only runs if the layer
below is green. This discipline exists in the repo — this section makes it the official contract.

| Level | What | Existing harness | When it runs |
|---|---|---|---|
| **L1 — Deterministic CV tests** | pure-function geometry: band snapping, region math, mask generation, crop rules, plan structure | `scripts/test-regression.mjs` (8 structural checks, ~2s); `test-region-decode.ts`, `test-unified-decode.ts` | every commit |
| **L2 — Metric unit tests** | scoring math: DecodedField comparison, style-compare dimensions, decode self-consistency scoring | `scripts/score-reference-decode.ts`, `test-style-compare.ts`, `test-style-profile.ts` | every commit |
| **L3 — Decode gates per archetype** | run the unified decode on R1/R2/R3 fixtures; assert layoutClass, region count/roles, pacing within tolerance; `uncertain` flags where expected | `test-unified-decode.ts` + cached fixtures; UNIVERSAL-1 decode gate | every engine PR touching analysis |
| **L4 — Render structural checks** | rendered output obeys hard rules: audio continuity, no black frames, duration, frame-aligned contiguous enables, single-pass | `test-regression.mjs --full` (3 render checks, ~30–60s) | every render-path change |
| **L5 — Closed-loop style score** | decode(reference) vs decode(output), per-dimension; thresholds: R1 ≥98%, R2/R3 ≥90% (UNIVERSAL-1 bars) | `verifyRender` via the route; `compare-to-reference.mjs` / `compare-style.ts` | per milestone gate + before any demo |
| **L6 — Human watch-test** | side-by-side reference vs render; the watch-before-ship gate | checklist in `docs/editing-craft.md` discipline | milestone gates, preset publication |

Platform code gets its own lower layers: API/queue unit tests (job state machine, quota logic)
sit at L1-equivalent; an e2e "upload → decode → render → download" smoke test (Playwright +
a tiny fixture reel) sits between L4 and L5 and runs in CI nightly.

---

## 2. Milestones

Timeline: 7 milestones × 1–2 weeks ≈ 10–12 weeks from today to first-10-users beta.
M1–M2 = finish the engine's UNIVERSAL-1. M3 = investor demo. M4–M7 = platform to beta.

---

### M1 (week 1–2) — UNIVERSAL-1 Wave 2: N-region renderer (R2 renders)

**Goal:** the decoded 4-layer stack (R2) renders end-to-end through the real route with the
user's footage — the engine goes from "one style" to "a family of styles."

| # | Task (≤1 day each) | Owner |
|---|---|---|
| 1.1 | Filtergraph builder: N-region scale+overlay from `DecodedRegion[]` (rects, zIndex) — extend `plan-renderer` | engine |
| 1.2 | Per-region content feeders: map plan slots → montage feeder per content region (reuse montage pass) | engine |
| 1.3 | Header/title band: render once via existing mg-render path → static PNG/short clip input to the composite | engine |
| 1.4 | sharp alpha-mask generator (rounded-rect, `cornerRadiusFrac`) + `alphamerge` wiring for inset regions | engine |
| 1.5 | Plan builder: emit N-region plans when `layoutClass === "multi_region_stack"` (guard: 2-region path unchanged) | engine |
| 1.6 | L1/L4 checks: add N-region structural checks to `test-regression.mjs` (region count in plan, contiguous enables per region, audio map untouched) | engine |
| 1.7 | R2 end-to-end run through `/api/clone-style` with cached decode + raw footage | engine |
| 1.8 | Closed-loop score on R2 output; fix top structural deltas (1 day timeboxed; iterate in M2 if short) | engine |

**Test level:** L1 (new checks) → L4 (`--full`) → L5 on R2 → L6 watch-test.
**DoD gate:** R2 renders without manual intervention; regression suite green; R2 closed loop ≥90% [D]-tier; watch-test signed.
**Demo artifact:** R2 side-by-side video (reference | render) + score screenshot.

---

### M2 (week 2–3) — UNIVERSAL-1 Wave 3: R3 (PIP + time dimension) + reliability gate

**Goal:** all 3 acceptance styles decode AND render; UNIVERSAL-1 closed.

| # | Task | Owner |
|---|---|---|
| 2.1 | R3 decode: time-varying background — consume `contentTimeline`/`structureTimeline` into the decode's region timelines | engine |
| 2.2 | R3 decode: PIP geometry refinement (CV snap of the VLM bubble rect: edges + corner radius) | engine |
| 2.3 | R3 render: persistent PIP inset over switching fullscreen background (mask from 1.4; background = feeder track) | engine |
| 2.4 | L3 decode-gate fixtures for R1/R2/R3: assert layoutClass, regions, pacing tolerances in `test-unified-decode.ts`, runnable offline from cache | engine |
| 2.5 | Closed-loop scores on all 3; UNIVERSAL-1 gate table filled in the milestone doc | engine |
| 2.6 | Reliability pass: 3 back-to-back full-route runs per style, zero manual intervention; kill any flake found | engine |
| 2.7 | Confirm no CC-BY-NC dependency in live path (MMS only offline; document the Scribe fallback wiring) | engine |

**Test level:** L3 (new gates) → L4 → L5 all three → L6.
**DoD gate:** UNIVERSAL-1's four gates (decode, render, closed-loop ≥90/90/98, reliability) all pass — the milestone doc's own success criteria.
**Demo artifact:** 3× side-by-side reels + a one-slide score table. **This is the core of the investor demo.**

---

### M3 (week 4) — Investor demo package + minimal demo UI

**Goal:** a stranger-proof demo: founder (or investor's own clip) through the pipeline live.

| # | Task | Owner |
|---|---|---|
| 3.1 | Demo page: reference picker (3 styles), A-roll/B-roll upload, progress bar off existing SSE, result player | frontend |
| 3.2 | Decode Preview v0 (read-only): draw `reference-decode.json` regions over a reference frame + pacing/captions cards | frontend |
| 3.3 | Style Score display from the `complete` event's `verification` payload | frontend |
| 3.4 | Demo hardening: friendly errors, input validation (duration/aspect), busy-state UX for the concurrency guard | frontend |
| 3.5 | Dry-run script: 2 full rehearsals with a NEW A-roll (not the dev fixtures); fix what breaks | engine |
| 3.6 | Pitch assets: 90s product video of the flow (reuse reelstack), one-pager from PLATFORM-SPEC §1 | frontend |

**Test level:** e2e smoke (manual, scripted rehearsal) + L5 on rehearsal outputs.
**DoD gate:** cold-start demo on a clean machine profile completes in <10 min live, twice in a row.
**Demo artifact:** the live demo itself + recorded backup video.

**Note:** M3 is deliberately thin UI on prototype plumbing — the SSE route and boolean guard are
acceptable HERE and nowhere past M4.

---

### M4 (week 5–6) — Platform foundation: jobs, storage, auth

**Goal:** replace the three prototype liabilities (in-request SSE, `isRendering` boolean, shared
`sp-temp`) with production primitives. No new product features.

| # | Task | Owner |
|---|---|---|
| 4.1 | Postgres + schema (SPEC §4: users/projects/references/assets/renders/jobs) via Prisma/Drizzle migrations | infra |
| 4.2 | Object storage (R2/S3): presigned multipart upload API; move `public/uploads` reads to storage keys | infra |
| 4.3 | Queue (BullMQ/Redis): job types, statuses, retries, dead-letter; per-user concurrency replaces the boolean | infra |
| 4.4 | Worker packaging: run the six phase modules out-of-process; `PipelineCtx` phase outputs → per-job artifact dir (kills shared `sp-temp`) | engine |
| 4.5 | Progress: `sendSSE` → `emitProgress(jobId, …)` (same `SSEEvent` schema) → persisted events + polling endpoint; WS later | infra |
| 4.6 | Checkpoint resume: retry restarts from last completed phase using persisted artifacts | engine |
| 4.7 | Cache keys path → content hash (dedupe decodes across users) | engine |
| 4.8 | Auth: magic-link (Auth.js), projects scoped to user; every API route authed | infra |
| 4.9 | Job-model unit tests (state machine, idempotency key, quota) + CI pipeline running L1/L2 on every push | infra |

**Test level:** platform unit tests + L1–L4 must stay green through the refactor (the regression
suite is the safety net for 4.4) + one e2e job-flow test (enqueue → worker → artifact → status).
**DoD gate:** two renders run CONCURRENTLY on two workers; kill a worker mid-render → job retries
from checkpoint and completes; zero regression-suite failures.
**Demo artifact:** screencast of two simultaneous renders + a mid-flight worker kill recovering.

---

### M5 (week 7–8) — Product UI v1: the golden path

**Goal:** the SPEC §2.1 journey, screens 1–7, on the M4 plumbing.

| # | Task | Owner |
|---|---|---|
| 5.1 | Project dashboard + new-project flow (clone-a-reference and preset tiles) | frontend |
| 5.2 | Reference upload (resumable) + decode job + live decode progress | frontend |
| 5.3 | Decode Preview v1: region overlay + timeline strip + pacing/captions/look cards + confidence/`uncertain` badges | frontend |
| 5.4 | Correction UI: drag region edges, relabel roles, toggle captions → write `human_corrections`, decode fields become `source:"human"` | frontend |
| 5.5 | Engine: consume human corrections in template/plan build (override decode fields before `buildTemplate`) | engine |
| 5.6 | Asset step: requirements derived from decode (B-roll count from cadence×duration; screen-rec slot when decoded) | frontend |
| 5.7 | Render queue screen + result screen (player, side-by-side, Style Score with per-dimension bars) | frontend |
| 5.8 | Tweak loop v0: caption text/style edit → `caption_reburn` job (cheap re-burn path) + regenerate-all | engine |
| 5.9 | Presets v0: R1/R2/R3 as system presets (`style_presets` rows) → skip decode, same pipeline | frontend |
| 5.10 | e2e Playwright: upload → confirm decode → assets → render → download, on a 20s fixture | infra |

**Test level:** component tests for the overlay editor math (L1-equivalent), e2e smoke nightly,
L5 spot-check that a human-corrected decode renders to a ≥ pre-correction score.
**DoD gate:** a non-founder completes the golden path unassisted on staging (screen-recorded).
**Demo artifact:** that recording — the first "product, not pipeline" proof.

---

### M6 (week 9–10) — Hardening + metering + moderation basics + B-roll generation ON

**Goal:** safe to let strangers in.

| # | Task | Owner |
|---|---|---|
| 6.1 | B-roll generation behind a credit meter (`usage_ledger`); planner→prompts→generate→critics per slot; parallel clip jobs | engine |
| 6.2 | Tweak loop: swap/regenerate a single B-roll slot (partial re-render) | engine |
| 6.3 | Moderation v0: upload attestation, NSFW/CSAM screen on sampled frames, hash-dedupe review flag, delete-reference-after-decode default | infra |
| 6.4 | Quotas + plans scaffolding (free: N renders, watermark; manual upgrades) | infra |
| 6.5 | Observability: phase timings, style-score + cost-per-render dashboards, error alerting | infra |
| 6.6 | Load test: 10 queued renders, 3 workers — queue-wait and p95 targets from SPEC §6.1 | infra |
| 6.7 | i18n pass: UZ/RU/EN strings; Cyrillic + Uzbek Latin caption font verification (golden-render per font) | frontend |
| 6.8 | Failure UX: every failed job → readable reason + retry button | frontend |

**Test level:** L4 golden renders for fonts, load test report, L5 on generated-B-roll renders,
moderation unit tests.
**DoD gate:** load test passes; a render with generated B-roll passes L5+L6; a deliberately
poisoned upload is blocked; cost-per-render measured and within SPEC §3.7 envelope.
**Demo artifact:** dashboard screenshot with 10 real renders + measured unit costs.

---

### M7 (week 11–12) — First-10-users beta

**Goal:** 10 hand-picked creators (ai-creators audience is the natural pool) ship real posts.

| # | Task | Owner |
|---|---|---|
| 7.1 | Onboard 10 users (personal invites, UZ/RU first); concierge channel (Telegram) | founder |
| 7.2 | Feedback capture wired: 👍/👎 + tags on every render → `feedback` table | frontend |
| 7.3 | Watch-test EVERY beta render for week 1 (founder QA); file decode/render bugs against archetypes | engine |
| 7.4 | Weekly triage: fix top-3 issues; each fix adds a regression check (house rule) | engine |
| 7.5 | Novel-layout intake: `uncertain`/novel decodes from real references → human-confirm queue → archetype exemplars (the UNIVERSAL-2 seed) | engine |
| 7.6 | Beta metrics: activation (upload→render), style-score distribution, "did they post it," qualitative willingness-to-pay | founder |

**Test level:** all six layers live; production style-score distribution is now itself a metric.
**DoD gate (beta success criteria):** ≥7/10 complete a render; ≥5/10 post one publicly;
median style score ≥90; ≥3 say they'd pay.
**Demo artifact:** beta report — the seed of the seed-round narrative.

---

## 3. Risk register (top 8)

| # | Risk | Likelihood / Impact | Mitigation |
|---|---|---|---|
| 1 | **Style generalization wall** — real users' references fall outside the 3 archetypes; decode confidence collapses | High / High | M7.5 novel-layout intake + human-confirm loop (gated auto-learn already exists); Decode Preview correction UI turns failures into labeled data; beta pool pre-screened toward supported families; UNIVERSAL-2 scoped from real intake, not guesses |
| 2 | **Decode looks right, render feels wrong** — closed-loop score passes but humans reject the result | Med / High | L6 human watch-test is a hard gate at every milestone; feedback tags tied to score dimensions locate the blind spot; add the missing dimension to the metric when found (the 73.4% → 98.1% R1 history shows the loop works) |
| 3 | **Prototype plumbing leaks into production** — SSE/boolean-guard/sp-temp patterns survive past M4 and cause data loss or clobbered renders under concurrency | Med / High | M4 is a dedicated, feature-frozen milestone; DoD explicitly requires concurrent renders + worker-kill recovery; regression suite guards the engine through the refactor |
| 4 | **Gemini dependency** — quota, latency, price changes, or model deprecation breaks decode/verify | Med / High | Deterministic-CV-first ownership limits VLM blast radius (geometry never depends on Gemini); triple-model fallback already in `analyze-reference.ts`; cached decodes make re-analysis rare; abstract the VLM client so a second provider can slot in |
| 5 | **B-roll generation cost/quality** — $1.5–3.5 COGS per generated-B-roll render kills margin, or critic loop passes weak clips | Med / Med | Generation OFF until M6 and always metered (credits); "upload your own" is the default path; critic gates + per-slot regeneration cap retries; measure real COGS in M6.6 before pricing |
| 6 | **Copyright/moderation incident** — a user clones a litigious catalog's video or uploads abusive content that becomes a public preset | Low / High | SPEC §6.3: attestation, screening, hash-dedupe review flags, delete-reference-after-decode default, human-moderated preset publication, no reference republishing ever |
| 7 | **Render time blows the "minutes" promise** — N-region composites + captions + verification stack up past 15 min p95 | Med / Med | FFmpeg-not-Remotion timeline decision already bought ~10× (spike-verified); phase timings dashboard from M6.5; parallel B-roll clip jobs; checkpoint resume avoids full re-runs; queue-depth autoscaling |
| 8 | **Solo-founder bandwidth** — engine, platform, and beta support compete; milestones slip in parallel | High / Med | Strict one-milestone-at-a-time sequencing; owner-type labels make outsourcing seams explicit (frontend M5 and infra M4 are the first contractor-safe packages); every task ≤1 day so progress is visible and droppable |

---

## 4. When to stop (scope brakes)

- **Stop polishing the engine** the moment M2's gates pass — M3 demo value comes from the 3-style
  table, not a 4th style.
- **Stop platform work** for anything not on the golden path until M7's beta metrics exist.
- **Do not start UNIVERSAL-2** (arbitrary styles) before 10 real novel-layout samples from beta.
- **Do not build billing** beyond a credit ledger until ≥3 beta users say they'd pay.
