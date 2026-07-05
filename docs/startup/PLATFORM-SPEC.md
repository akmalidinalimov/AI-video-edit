# StyleClone — Platform Specification

**Status:** Draft v1 · 2026-07-02 · Owner: StyleClone core
**Scope:** the PLATFORM (product + system), built around the engine that exists today in this repo.
**Companion doc:** `docs/startup/BUILD-PLAYBOOK.md` (how we build it, milestone by milestone).

---

## 1. Product overview

### One line

Creators upload a **reference video** (the style they want) plus their **raw footage** — StyleClone
decodes the reference's editing style and re-renders the raw footage in that style, in minutes.

### The core insight

Creators cannot *describe* an editing style in words — "punchy cuts, split layout, bold captions"
under-specifies everything that matters (divider position, PIP geometry, cut cadence, caption
animation, B-roll rhythm). But every creator can *point at a video and say "like that."*

The reference video **is the prompt.** StyleClone's differentiator is that it treats the reference
as a measurable specification:

- **Decode** — a deterministic-first pipeline (computer vision owns geometry; a VLM owns only
  semantics) turns the reference into a canonical, content-free `ReferenceDecode`: layout regions,
  pacing, transitions, motion, caption style, overlays, look.
- **Render** — the same decode drives a single-pass FFmpeg composite of the user's footage into
  that layout, with generated or supplied B-roll, burned captions, and motion graphics.
- **Measure** — a closed loop: decode the *output* and compare it field-by-field against the
  decode of the *reference*. Style match is a number, not a vibe (98.1% on the flagship style
  today).

No competitor ships a falsifiable "how close is this to the reference" score. That closed loop is
both the quality engine and the trust-building product surface ("Style Score: 94%").

### Who it's for

| Segment | Job to be done | Willingness to pay |
|---|---|---|
| Solo short-form creators (IG/TikTok/Shorts) | "Make my raw talking-head clips look like <creator X>'s edits" | $15–40/mo |
| Course creators / educators (incl. Uzbek/RU markets) | Consistent branded lesson-promo edits at volume | $40–100/mo |
| Agencies / SMM teams | One reference per client brand → dozens of edits/month | $200+/mo, seats |

---

## 2. User journeys

### 2.1 First-time creator (the golden path)

**Screen 1 — Landing / New Project.**
Two entry tiles: **"Clone a reference"** (upload/paste a video) and **"Pick a style"** (preset
library — §2.4). CTA copy sells the insight: *"Don't describe the edit. Show it."*

**Screen 2 — Upload reference.**
Drag-drop or URL. Client-side checks: duration (15s–3min for MVP), 9:16 or croppable, file size.
Copyright/consent checkbox (§6.3). Upload → decode job enqueued → live progress ("Extracting
frames… Measuring layout… Reading captions…" — these map 1:1 to the real decode stages, which
already emit SSE progress events).

**Screen 3 — Decode Preview. THE trust moment.**
This screen is the product. We show the user *what we understood*, visually, before asking for
anything else:

- **Layout panel** — the reference's first frame with the decoded regions drawn over it
  (header band, B-roll window, screen-rec strip, A-roll band / PIP bubble), each labeled with its
  role. Data source: `ReferenceDecode.layout.regions` (`DecodedRegion[]`: role, rect fractions,
  shape, zIndex, persistent, contentTimeline).
- **Timeline strip** — shot boundaries and, where the layout varies, the per-segment layout
  timeline. Data: `pacing.shotBoundaries`, region `contentTimeline`s.
- **Pacing card** — "Cuts every ~2.9s (fast)". Data: `pacing.avgShotSec`, `cutFrequency`.
- **Captions card** — present/absent, position band, style, animation. Data: `captions.*`
  (position is CV-measured; style/animation are VLM-decoded).
- **Look card** — style keywords, transitions, motion. Data: `look`, `transitions`, `motion`.
- **Confidence surfacing** — every decoded field already carries
  `{ value, source, confidence, uncertain }`. Fields flagged `uncertain` (CV-vs-VLM
  cross-check disagreement — this flag exists in code) render with a "check this" badge.

**User correction UI:** drag region edges, relabel a region's role, toggle captions, adjust the
divider. Corrections write back into the decode as `source: "human", confidence: 1.0` fields —
which also feeds the archetype self-learning loop (the engine already gates auto-learn on
cross-check agreement and flags novel layouts for human confirmation; this screen IS that human
confirmation, productized).

Gate: user taps **"Yes, that's the style"** → decode is locked for this project.

**Screen 4 — Upload raw assets.**
Requirements are **derived from the locked decode**, not generic:

- A-roll: always required ("your talking-head footage — one or more clips; we'll order them by
  narrative" — multi-A-roll ordering exists in `prepareContent`).
- B-roll: the decode's cadence + duration imply a need: *"This style cuts B-roll every ~3s over
  64s → you need ~8 B-roll clips. Upload yours, or we'll generate them."* Per-clip: upload slot,
  "generate for me" toggle (B-roll factory: planner → prompt engine → generation → critics), or
  "reuse from my library."
- Images/screen recordings: only requested when the decode found a `screen_recording` or
  `diagram_graphic` region/content-window (R2/R3-class styles).

**Screen 5 — Render queue.**
Job card with phase progress (the six engine phases map directly: analyzing reference → template →
preparing content → building plan → rendering → verifying). Estimated time, cancel button, email/
Telegram notify on completion. Free tier renders queue behind paid.

**Screen 6 — Result + Style Score + tweak loop.**
- Player with the rendered video; reference side-by-side toggle.
- **Style Score badge** — the closed-loop verification result already returned on the engine's
  `complete` event (`verification.overall`, per-dimension scores, segments analyzed).
- Tweak loop (each action re-renders only what's needed):
  - **Swap a B-roll clip** for a given slot (re-render composite; decode cached).
  - **Regenerate a B-roll clip** (B-roll factory re-run for one slot).
  - **Edit captions** (text fix, style override) → caption re-burn only (captions are a separate
    burn pass in `renderVideo` today, so this is cheap).
  - **Regenerate all** with a different seed/plan.
- Feedback: 👍/👎 + "what's off?" — stored against the decode + render for engine improvement.

**Screen 7 — Export / share.**
Download MP4 (1080×1920 H.264), share link, "save this style to my library" (becomes a private
preset), post-to-platform integrations later.

### 2.2 Returning creator

Dashboard → projects grid + **"My styles"** (locked decodes from past projects). New video with a
saved style skips Screens 2–3 entirely: pick style → upload raw → render. This is the retention
loop: the *decode* is the durable asset, not the render. Reference decodes are already cached per
video (blueprint, layout_regions, layout_semantics all cached via `analysisCache` keyed on the
reference path/hash), so this flow is near-free on the analysis side.

### 2.3 Agency

- Workspaces with seats; client folders.
- One decode per client brand, shared across the team as a **team preset**.
- Batch mode: upload N raw A-rolls against one style → N queued renders.
- Approval flow: renders start "in review," a client-shareable preview link, then export.
- Priority queue + higher concurrency as the plan differentiator.

### 2.4 The PRESET path (no reference in hand)

Curated style library — "Podcast split," "Tech-news 4-stack," "Founder PIP" — with preview reels.
**Presets ARE saved `ReferenceDecode` objects.** Same schema, same render pipeline; the only
difference is the decode step is skipped. This is deliberate architecture, not a second system:

- Seeds: our own decoded references (R1/R2/R3 archetypes ship as the first three presets).
- Growth: users publishing their saved styles (opt-in, moderated) → community library.
- The archetype library (`layout-archetypes.ts` match + confirmation memory) is the taxonomy
  behind preset categorization.

Preset flow = Screen 1 → style gallery → Screen 4 onward. The Decode Preview screen doubles as
the preset detail page (same component, decode already trusted).

---

## 3. System architecture

```
┌─────────────┐   HTTPS    ┌──────────────┐   enqueue   ┌────────────────────┐
│ Next.js app │──────────►│  API layer    │────────────►│  Job queue (Redis/  │
│ (web, SSR)  │◄──────────│  (Next API +  │             │  BullMQ or SQS)     │
│  progress   │  WS/SSE    │  auth, quota) │             └─────────┬──────────┘
└─────────────┘            └──────┬───────┘                        │
                                  │ signed URLs                    ▼
                     ┌────────────▼──────────┐        ┌────────────────────────┐
                     │ Object storage (S3-   │◄──────►│ Worker fleet            │
                     │ compatible: uploads/  │        │  • decode workers       │
                     │ artifacts/renders)    │        │  • render workers       │
                     └───────────────────────┘        │  (FFmpeg + Python CV +  │
                                  ▲                   │   Remotion assets +     │
                     ┌────────────┴──────────┐        │   Gemini/Kling clients) │
                     │ Postgres (users,      │◄──────►└────────────────────────┘
                     │ projects, decodes,    │                 │ progress events
                     │ renders, presets)     │◄────────────────┘ (pub/sub → WS)
                     └───────────────────────┘
```

### 3.1 Frontend

Next.js (App Router — already the repo's stack), TypeScript, Tailwind. Key surfaces: upload with
resumable multipart, Decode Preview (canvas overlay editor over a video frame), render queue,
result player with side-by-side compare. i18n from day one (§6.5). Progress via WebSocket or
polling backed by the job store — **not** a request-scoped SSE stream.

### 3.2 API layer

Next API routes (or a thin Fastify service later) doing only fast work: auth, validation, quota
checks, presigned upload URLs, job creation, job status reads. **No video work in the request
path.**

### 3.3 The async job model (the core platform-new piece)

What exists today is prototype-grade by design and the code says so: `POST /api/clone-style`
runs the entire pipeline inside one HTTP request's `ReadableStream` with SSE progress, a
10-minute `maxDuration`, and a module-level `let isRendering = false` boolean as the concurrency
guard (one render per process, 503 otherwise). That is correct for a single-machine demo and
wrong for a product: a dropped connection kills the render, no retries, no horizontal scale.

Target model:

- **Job types:** `decode`, `render`, `caption_reburn`, `broll_generate`, `verify`. The existing
  route already decomposes into exactly these phase modules
  (`analyze-reference` → `build-template` → `prepare-content` → `build-plan` → `render-video` →
  `verify-output`, all threading one mutable `PipelineCtx`), so the worker refactor is: persist
  `PipelineCtx` fields as job artifacts, replace `ctx.sendSSE(event)` with
  `emitProgress(jobId, event)` — the `SSEEvent` shape (phase, progress, message, verification,
  styleProfile) becomes the progress-event schema unchanged.
- **Statuses:** `queued → running → succeeded | failed | canceled`, with `attempt` count and
  per-phase checkpoints (a failed render retries from the last completed phase because phase
  outputs are files in the job's artifact dir — `sp-temp` today).
- **Retries:** 2 automatic retries on transient failure (Gemini 5xx, FFmpeg spawn) — the engine
  already has `withRetry` for Gemini calls; the queue adds job-level retry. Poison jobs → dead
  letter + user-facing "we're on it."
- **Progress events:** workers publish to Redis pub/sub; API fans out over WebSocket; events also
  persisted so a page refresh replays the current state.
- **Concurrency:** per-worker 1 render at a time (FFmpeg saturates a box); scale = more workers.
  Per-user and per-plan concurrency limits at enqueue time (replacing the boolean).
- **Idempotency:** jobs keyed by (project, input-hash, params) — a double-click doesn't double-
  render; matches the engine's existing hash-keyed analysis caching philosophy.

### 3.4 Storage

S3-compatible (Cloudflare R2 first — zero egress fees matter for video):

- `uploads/` — user originals (reference, A-roll, B-roll), presigned multipart upload.
- `artifacts/` — per-job intermediates: `reference-decode.json`, `layout-analysis.json`,
  `style-profile-2.0.json`, `dynamic-plan.json`, extracted frames, generated B-roll, masks.
  (Today these live in `public/exports/sp-temp/` — a single shared temp dir, another prototype
  artifact; per-job dirs fix the "two renders clobber each other" hazard.)
- `renders/` — outputs, lifecycle-ruled (e.g. free tier: 30 days).
- Decode cache keyed by **content hash** of the reference (the engine caches per path today;
  hashing makes it dedupe across users — two users uploading the same viral reference share one
  decode, which is also a moderation signal, §6.3).

### 3.5 Decode + render engines as worker services

The engine is the six phase modules plus their libraries, packaged into a worker image:

- **Decode worker:** frame extraction (FFmpeg), Gemini consolidated analysis, deterministic CV
  layout analyzer (Python — `layout_analyzer.py` et al.), VLM region decomposition
  (`layout-regions.ts`), semantics pass, archetype match, `buildReferenceDecode`. CPU-bound +
  external-API-bound; no GPU required.
- **Render worker:** YuNet face detection/crop, montage feeder pass, single-pass FFmpeg composite
  (`enable='between(t,...)'` switching, `-map 1:a` continuous audio — hard rules enforced by the
  regression suite), Remotion for static/short styled assets only (header bands, MG components,
  captions) per the spiked UNIVERSAL-1 Wave-2 decision: Remotion full-timeline compositing was
  measured at 10.25× realtime and rejected; FFmpeg remains the timeline compositor, rounded-rect
  PIP via sharp-generated alpha mask + `alphamerge`.
- **B-roll generation worker:** planner → prompt engine → Kling/Veo generation → prompt-critic +
  video-critic loop. External-API-bound; isolate because it's the slowest and most expensive step
  and it's optional (user-supplied B-roll skips it).

### 3.6 Caching layers

| Layer | Key | Exists today? |
|---|---|---|
| Reference blueprint / regions / semantics / decode | reference video (path today → content hash) | ✅ `analysisCache` (`withCache`/`getCached`/`setCache`) |
| A-roll transcription + alignment | A-roll clip | ✅ `withCache` in `prepareContent` |
| CV corrections flag on blueprint | blueprint | ✅ (`cvCorrected`, `arollBandCorrectedV2` flags) |
| Generated B-roll clips | (prompt, model, params) | partial (cache read-back merge in `buildPlan`) |
| Archetype exemplar memory | archetype id | ✅ `recordConfirmation`, cross-check-gated |
| CDN for renders/previews | URL | platform-new |

### 3.7 Compute + cost per render

- **CPU:** FFmpeg composite of a ~60–90s 1080×1920 reel: minutes-scale on an 8-vCPU box
  (single-pass filtergraph; montage feeders precomposed). Decode CV + frame extraction:
  1–3 min. **No GPU needed** for decode/render; GPU only if we later self-host generation or
  Whisper-class alignment at scale.
- **External API cost drivers per render (estimates to validate in beta):**
  - Gemini (decode: consolidated video analysis + regions + semantics; plan: narrative/keywords;
    verify: closed-loop scoring): ~$0.10–0.40 per *new* reference, ≈$0.05–0.15 per render with a
    cached decode.
  - B-roll generation (Kling): ~$0.15–0.35 per 5s clip → ~8 clips ≈ **$1.20–2.80** — the dominant
    cost, and zero when the user supplies B-roll. This is why "upload yours or we generate"
    is also a margin lever.
  - Compute: ~$0.05–0.15 of worker time per render.
- **Unit economics target:** render with user B-roll ≈ $0.20–0.50 COGS; with generated B-roll
  ≈ $1.50–3.50 → generated B-roll is metered (credits), style-clone renders are near-flat-rate.

---

## 4. Data model

Postgres. Fractions/JSON mirror the engine's existing artifact schemas so workers read/write the
same shapes they produce today.

```
users(id, email, name, locale, plan, created_at)
workspaces(id, name, owner_id, plan)            -- agency tier
memberships(user_id, workspace_id, role)

projects(id, workspace_id, owner_id, title, status, created_at)

references(
  id, project_id NULLABLE,                      -- null = library-only style
  storage_key, content_hash UNIQUE,             -- dedupe + shared decode cache
  duration_s, dims, fps,
  decode JSONB,                                 -- the canonical ReferenceDecode (schemaVersion 2,
                                                --   every field a DecodedField{value,source,confidence})
  archetype_id, decode_status, decode_score,    -- self-consistency [D]-tier score
  human_corrections JSONB,                      -- Screen-3 edits (source:"human")
  moderation_status, consent_attested BOOLEAN
)

assets(id, project_id, kind ENUM(aroll,broll,image,screen_rec,generated_broll),
       storage_key, duration_s, dims, order_index, source ENUM(upload,generated,library),
       generation_meta JSONB)                   -- prompt, model, critic scores

renders(id, project_id, reference_id, status, attempt,
        params JSONB,                           -- seed, skip flags, caption overrides
        plan_artifact_key,                      -- dynamic-plan.json
        output_key, duration_s,
        style_score NUMERIC, score_dimensions JSONB,   -- closed-loop verification payload
        phase, progress, error, created_at, finished_at)

jobs(id, type ENUM(decode,render,broll_generate,caption_reburn,verify),
     ref_table, ref_id, status, attempt, checkpoint_phase,
     queued_at, started_at, finished_at, worker_id, error)

style_presets(id, reference_id, owner_scope ENUM(system,workspace,user,public),
              title, description, preview_render_key, category, archetype_id,
              install_count, published_at, moderation_status)

feedback(id, render_id, user_id, rating, tags TEXT[], comment, created_at)

usage_ledger(id, workspace_id, kind ENUM(render,broll_clip,decode), cost_credits, job_id, at)
```

Key relationships: a **preset is a row in `style_presets` pointing at a `references` row whose
decode is trusted** — one pipeline, as promised in §2.4. `feedback` joins to `renders` and thus to
the decode → the training set for engine improvement.

---

## 5. The engine — what exists vs what's platform-new

### Exists today (grounded in code read for this spec)

- **Full pipeline behind one endpoint** — `src/app/api/clone-style/route.ts`, decomposed
  (Wave 0.5) into six phase modules under `src/lib/pipeline/route-phases/` sharing a typed
  `PipelineCtx`; multi-A-roll (narrative-ordered) and multi-B-roll inputs; SSE progress.
- **Canonical Reference Decode** — `src/lib/analysis/reference-decode.ts`: schemaVersion-2
  `ReferenceDecode`, every field a `DecodedField{value, source, confidence, method, uncertain}`;
  deterministic-CV-first ownership (CV owns geometry/pacing/transitions/motion/caption position;
  VLM owns only semantics); N-region-capable `DecodedRegion[]` with roles, shapes
  (rect/rounded_rect/circle), zIndex, persistence, and per-region content timelines.
- **Multi-region decode** — `src/lib/analysis/layout-regions.ts`: VLM band decomposition
  (header/broll/screen-rec/aroll/pip_inset…) with content timelines and a structure timeline;
  unified with CV via `unifyLayoutClass`/`buildDecodedRegions`/`classesAgree` cross-check.
- **Deterministic CV stack** — layout analyzer (Python), CV coordinate correction, YuNet
  face-anchored A-roll bands, screenshot coordinate extraction — all wired into
  `analyze-reference.ts` with non-blocking fallbacks.
- **Archetype memory with gated self-learning** — auto-confirm only when CV and VLM independently
  agree (`classesAgree`), match ≥0.85, confidence ≥0.7; novel/uncertain layouts flagged for human
  confirmation. (The Decode Preview screen productizes that flag.)
- **Closed-loop verification** — `verify-output.ts` → `verifyRender`: decode the output, compare
  6 structural dimensions vs the reference, return overall + per-dimension scores on the
  `complete` event. **R1 = 98.1%** closed loop (UNIVERSAL-1 milestone doc).
- **Render discipline** — single-pass FFmpeg (never concat), continuous audio map, sentence-
  boundary layout switches, frame-aligned contiguous enables — enforced by
  `scripts/test-regression.mjs` (8 structural checks, +3 render checks with `--full`).
- **Caching** — blueprint/regions/semantics/decode/transcription cached per input; repeat runs
  skip Gemini and CV.
- **B-roll subsystem** — cadence planner, B-roll planner + prompt engine + diversity, creative
  director, style classifier, critic loop (spec'd in `docs/broll-factory-spec.md`).
- **In progress (UNIVERSAL-1):** N-region render (R2 4-stack, R3 PIP-over-fullscreen) via the
  spike-validated architecture — FFmpeg filtergraph per-region overlays + sharp alpha-mask
  rounded-rect PIP; Remotion for static assets only. R1 renders end-to-end today; R2 decodes but
  has no N-region renderer yet; R3 decode lacks the time dimension and exact PIP geometry.

### Platform-new (does not exist yet, in dependency order)

1. Auth, users, workspaces, plans/quotas — **nothing exists** (no auth on any route).
2. Durable job queue + worker packaging + progress pub/sub (replaces in-request SSE and the
   `isRendering` boolean).
3. Object storage + per-job artifact isolation (replaces `public/uploads` + shared `sp-temp`).
4. Postgres data model (§4) — today's "database" is JSON files and the analysis cache.
5. Product UI: upload, **Decode Preview with correction**, asset requirements, queue, result +
   tweak loop, preset library. (Explicitly a non-goal of the current engine milestone.)
6. Human-corrections write-back into the decode (`source:"human"`) and into archetype learning.
7. Moderation/copyright pipeline, billing/credits ledger, i18n.

---

## 6. Non-functional requirements

### 6.1 Performance targets

| Metric | Target (beta) | Notes |
|---|---|---|
| Decode, new reference (≤90s reel) | ≤ 4 min p50, 8 min p95 | Gemini upload+processing dominates |
| Decode, cached/preset | ≤ 5 s | cache hit path exists |
| Render, user B-roll | ≤ 6 min p50 | FFmpeg single pass + captions burn |
| Render incl. generated B-roll | ≤ 15 min p50 | generation is the tail; parallelize clips |
| Caption re-burn (tweak loop) | ≤ 90 s | separate pass already |
| Queue wait, paid | ≤ 2 min p95 | autoscale workers on queue depth |

### 6.2 Concurrency & reliability

- Beta: 3–5 render workers ≈ 30–60 renders/hr; scale linearly.
- Job success rate ≥ 97% after retries; every failure user-visible with a retry button.
- Graceful degradation mirrors the engine's existing non-blocking philosophy (CV failure →
  fallback estimates; semantics failure → captions default) — a render should degrade, not die.

### 6.3 Moderation & copyright of uploaded references (real risk — addressed)

Cloning a style from someone else's video is legally gray (style is generally not copyrightable;
the uploaded reference copy itself is our exposure). Policy:

- **We never republish the reference.** It is analysis input only; the stored artifact of value
  is the content-free decode (layout fractions, pacing numbers, caption style — no footage, no
  transcript text in presets).
- Upload-time attestation ("I have the right to analyze this video") + ToS ban on cloning
  identity/likeness or deceptive impersonation.
- Automated screening on upload: CSAM hash-matching (mandatory), NSFW/violence classifier on
  sampled frames, block-list of known-litigious catalogs. Content-hash dedupe (§3.4) flags
  "many users uploading the same third-party video" for review before it can become a public preset.
- **Public preset publication is human-moderated**; system presets only from licensed/owned refs.
- DMCA-style takedown path for references; delete reference media after decode by default
  (retain only with user opt-in "keep for re-decode"), which shrinks both risk and storage cost.

### 6.4 Privacy & security

Uploaded footage is private by default; presigned, expiring URLs; per-workspace isolation; face
data (YuNet crops) is transient job artifact, never a stored biometric template; deletion =
storage purge + decode row tombstone. Gemini/Kling calls: no training on customer data (API
terms), documented in the privacy policy. Encrypt at rest (bucket-level) + TLS.

### 6.5 i18n

UI in **Uzbek, Russian, English** at launch (founder's market advantage; the ai-creators
audience is UZ/RU). The engine is already language-agnostic where it matters: transcription/
alignment handles Uzbek (MMS forced alignment decision — commercial path via ElevenLabs Scribe,
no CC-BY-NC dependency in the live path per the UNIVERSAL-1 reliability gate). Caption rendering
must ship with full Cyrillic + Uzbek Latin glyph coverage in every caption font.

### 6.6 Observability

Per-job structured logs (the engine already logs a decode summary table), phase timings, style-
score distribution dashboards, cost-per-render tracking from day one (the `usage_ledger` feeds it).

---

## 7. Feature cut: MVP vs V1 vs V2

| Feature | MVP (investor demo → first 10 users) | V1 (paid beta) | V2 (growth) |
|---|---|---|---|
| Reference upload + decode | ✅ 3 archetypes (R1/R2/R3), file upload | arbitrary references (UNIVERSAL-2), URL import | auto style suggestions from a creator's channel |
| Decode Preview (trust moment) | ✅ read-only visualization + confirm | ✅ full correction UI, write-back to decode | correction feeds archetype learning at scale |
| Presets | ✅ 3 system presets (= R1/R2/R3 decodes) | private "My styles" saved decodes | public/community preset marketplace |
| Raw assets | A-roll (multi) + B-roll upload | derived requirements UI; image/screen-rec slots | asset library, brand kits |
| B-roll generation | off (user-supplied only — cost + speed) | ✅ metered, critic-gated | style-matched generation from decode look |
| Job model | minimal: DB-backed queue, 1–2 workers, polling progress | ✅ full: retries, checkpoints, WS progress, autoscale | multi-region workers |
| Style Score | ✅ shown on result (exists in engine) | per-dimension breakdown + "improve" hints | score-guided auto-retry loop |
| Tweak loop | regenerate-all only | ✅ swap clip, caption edit (cheap re-burn) | timeline-level manual overrides |
| Auth/billing | magic-link auth, manual invites, no billing | ✅ Stripe/Payme, credits for generation | agency workspaces, seats, approval flow |
| Captions | ✅ decoded style, burn pass (exists) | edit text/style in tweak loop | multi-language caption translation |
| Moderation | attestation + manual review (10 users) | ✅ automated screening + hash dedupe | trusted-publisher program |
| i18n | EN UI | ✅ UZ/RU/EN | more locales |
| Export | MP4 download | share links, watermark on free tier | direct publish to IG/TikTok/YT |

**MVP definition of viable:** one stranger uploads a reference in one of the 3 archetype families
plus their own footage, corrects nothing or one region, and gets a ≥90% style-score render they
actually post. Everything else is sequenced in `BUILD-PLAYBOOK.md`.
