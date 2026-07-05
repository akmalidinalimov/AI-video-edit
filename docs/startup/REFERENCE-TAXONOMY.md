# Reference-Video Taxonomy, Stress-Test Catalog & Self-Learning Knowledge Base

**Status:** design of record · 2026-07-02 · grounded in the shipped decode engine
(`src/lib/analysis/reference-decode.ts` schemaVersion 2, `layout-regions.ts`,
`layout-archetypes.ts`, `.knowledge/layout-archetypes.json`) and milestone
`docs/UNIVERSAL-1-MILESTONE.md`.

**Purpose.** This is the definitive map of the reference-video space StyleClone must
decode: (1) the taxonomy of reference types with honest per-type decode difficulty
against the *current* engine, (2) the adversarial stress-test catalog, and (3) the
self-learning knowledge-base design that turns 50–100 role videos into calibrated
decode + render recipes. It is simultaneously the engineering roadmap and the
evidence-of-depth document for investors: we know exactly how large the space is,
exactly where we stand in it, and exactly how the system learns the rest.

---

## Where the current engine honestly stands

| Capability | Status | Evidence |
|---|---|---|
| 2-region top/bottom split (decode + render + closed loop) | ✅ shipped | R1: 98.1% closed-loop style score |
| Multi-region stack (3–5 bands) decode | ✅ decode (render in progress) | R2: 4-layer stack decoded via unified path (VLM bands + CV seam-snap) |
| PIP-over-fullscreen decode (rounded-rect bubble, time-varying background) | ✅ decode (render in progress) | R3: structure correct; PIP geometry approximate; contentTimeline captured |
| Fullscreen A-roll / B-roll-only classification | ✅ | CV core types `fullscreen` / `broll_only` |
| Per-region content timeline (B-roll → diagram → screen-rec) | ✅ decode | `BandContentWindow[]` in `layout-regions.ts` |
| Structure-changing-over-time layouts | ⚠️ schema exists (`structureTimeline`), unproven end-to-end | fraction-time guard shipped; no confirmed exemplar |
| Everything else in this taxonomy | ❌ gap | that is what this document maps |

Difficulty legend used throughout:
**E** = easy (current engine decodes today or with trivial config) ·
**M** = medium (existing extractors + a new archetype signature + render recipe) ·
**H** = hard (new extractor or renderer subsystem required) ·
**F** = frontier (research-grade; may ship as decode-and-degrade or refuse-with-reason).

User-input legend: **A** = user A-roll (talking-head footage) · **B** = user B-roll
(or generated via the B-roll factory) · **S** = screen/app assets · **V** = voiceover
only · **X** = extra assets (logos, product shots, slides, chat mock-ups).

---

# Part 1 — The Taxonomy

The space is a combination of seven dimensions. Rather than padding a cross-product
(7 layout classes × 6 A-roll modes × 9 content types × 7 caption styles × … =
thousands), the taxonomy lists the **~70 combinations that actually occur in the
wild** as primary entries (1.1–1.8), then treats captions, graphics, format, and
pacing as **modifier axes** (1.9–1.12) that compose with any primary entry. An
archetype in the knowledge base = one primary entry + its measured modifiers.

## 1.1 Fullscreen A-roll family

| ID | Name | Defining signals the decoder must measure | Diff | User inputs |
|---|---|---|---|---|
| FS-01 | Plain fullscreen talking head | single persistent face region ≈ full frame; no seams; caption band | **E** ✅ | A |
| FS-02 | Fullscreen + zoom-punch cuts | same, plus per-shot scale jumps (motion class `push_in`/scale steps at cut times) | **M** | A |
| FS-03 | Fullscreen + jump-cut rhythm | shot boundaries with no scene change (same framing, temporal discontinuity); high cut frequency | **M** | A |
| FS-04 | Fullscreen multi-speaker (alternating) | 2+ distinct persistent faces alternating full-frame; speaker-change boundaries | **H** | A×2 |
| FS-05 | Interview with cutaways | dominant fullscreen face + interleaved full-frame B-roll shots (face absent windows) | **M** | A + B |
| FS-06 | Green-screen cutout speaker over graphics | face region with alpha-like hard edge over synthetic background; background content class ≠ camera footage | **H** | A + X |
| FS-07 | Fullscreen with periodic full-frame takeover inserts | base fullscreen A-roll; short windows where a graphic/meme/screen-rec replaces the whole frame | **M** (uses `structureTimeline`) | A + B/X |

## 1.2 Two-region split family (the shipped core)

| ID | Name | Defining signals | Diff | User inputs |
|---|---|---|---|---|
| SP-01 | Top/bottom split, A-roll bottom, ~1:1 B-roll top | horizontal seam (divider fraction 0.5–0.62); face below; B-roll aspect 0.85–1.2 | **E** ✅ (R1, 98.1%) | A + B |
| SP-02 | Top/bottom split, A-roll top | seam 0.38–0.5; face above | **E** (archetype exists, 0 exemplars) | A + B |
| SP-03 | Top/bottom split, extreme ratio (thin A-roll band ≤ 30%) | divider outside current calibrated ranges; face band compressed | **M** (range recalibration) | A + B |
| SP-04 | Top/bottom split with screen-recording (not B-roll) top | seam + top region content class = screen_recording (UI edges, static chrome, scroll motion) | **M** | A + S |
| SP-05 | Side-by-side vertical split (left/right) | vertical seam; two half-width regions; `side_by_side` layoutClass exists in VLM vocab, no CV seam detector for vertical | **H** | A + B |
| SP-06 | Podcast 2-cam split (two faces, top/bottom or side/side) | two persistent face regions; active-speaker alternation optional | **H** | A×2 |
| SP-07 | Split with animated/sliding divider | seam position drifts or snaps over time | **H** | A + B |
| SP-08 | Reaction split (A-roll reacting to embedded phone-shaped clip) | one region is a device-framed inset (bezel/rounded rect inside the region) | **M** | A + B |

## 1.3 PIP family

| ID | Name | Defining signals | Diff | User inputs |
|---|---|---|---|---|
| PIP-01 | Rounded-rect PIP speaker, centered, over changing background | persistent non-full-width aroll region (w 0.4–0.95), rounded corners; background contentTimeline | **M→E** ✅ decode (R3); render in progress (alphamerge mask path) | A + B/S |
| PIP-02 | Circle PIP, corner, over screen recording | small circular face bubble (needs circle detection — CV core has none; VLM proposes, CV cannot yet refine) | **M** | A + S |
| PIP-03 | Circle PIP over fullscreen B-roll montage | as PIP-02 with B-roll background + faster cuts | **M** | A + B |
| PIP-04 | Moving PIP (bubble relocates per section) | PIP rect changes at sentence/section boundaries; needs per-segment PIP tracking | **H** | A + B/S |
| PIP-05 | Growing/shrinking PIP (emphasis scaling) | PIP w/h varies smoothly or in steps | **H** | A + B/S |
| PIP-06 | PIP appearing/disappearing (A-roll ↔ VO alternation) | persistent background; aroll region present only in windows (`structureTimeline`) | **M** | A + B/S |
| PIP-07 | Double PIP (two speakers as bubbles over shared content) | two non-full-width persistent face regions | **F** | A×2 + S |
| PIP-08 | PIP with decorated frame (border, glow, name tag) | PIP rect + attached overlay graphic; overlay/content separation | **M** | A + B/S + X |

## 1.4 Multi-region stack family (3–5 bands)

| ID | Name | Defining signals | Diff | User inputs |
|---|---|---|---|---|
| ST-01 | 4-layer Grok stack: title + B-roll window + screen-rec strip + A-roll band | 3–5 contiguous horizontal bands; thin-strip detection; band persistence flags | **E→M** ✅ decode (R2); N-region FFmpeg renderer in progress | A + B + S + X(title) |
| ST-02 | 3-band: title + content + A-roll | as ST-01 minus the strip | **M** (same renderer) | A + B + X |
| ST-03 | 3-band: A-roll top + two stacked content windows | aroll band position = top | **M** | A + B×2 |
| ST-04 | Stack with persistent header AND footer (branding bands) | first & last bands persistent, static; middle bands changing | **M** | A + B + X |
| ST-05 | Stack where one band is a live chat/DM mock-up | band content class = chat UI (bubbles, avatars, type-on) | **H** (new content class + MG component) | A + X |
| ST-06 | Stack with an app-UI strip that scrolls | strip band with continuous vertical motion (scroll capture) | **H** | A + S |
| ST-07 | 5-band dense stack (title + 2 content + strip + A-roll) | band count at signature upper bound; seams < 15% height each | **H** | A + B + S + X |
| ST-08 | Stack whose band CONTENTS swap roles mid-video | contentTimeline per band with class switches; band rects stable | **M** (decode ✅ schema; render needs per-window feeders) | A + B + S |

## 1.5 Grid / collage family

| ID | Name | Defining signals | Diff | User inputs |
|---|---|---|---|---|
| GR-01 | 2×2 grid (4 windows, one is A-roll) | two seams (1 horizontal + 1 vertical); 4 rects | **H** (no vertical seam detection; renderer is a filtergraph extension) | A + B×3 |
| GR-02 | 3-up collage (1 large + 2 small) | mixed-size rects, non-band geometry | **H** | A + B×2 |
| GR-03 | Before/after comparison grid | 2 windows with synchronized content + labels | **H** | B×2 + V |
| GR-04 | Grid that collapses to fullscreen for the payoff | structureTimeline: grid → single | **F** | A + B |

## 1.6 Layout-changing-over-time family (the time dimension)

| ID | Name | Defining signals | Diff | User inputs |
|---|---|---|---|---|
| TC-01 | Split → fullscreen → split (section-based) | structureTimeline with 2–3 sustained windows, seam appears/disappears | **M** (schema ✅, unproven; render = per-window filtergraph switching, the shipped `enable=between(t,…)` discipline) | A + B |
| TC-02 | Fullscreen hook (0–3s) then persistent split | short first window; hook detection | **M** | A + B |
| TC-03 | "0–15s split, 15–20s fullscreen, 20–30s circle PIP" (the stated product vision) | per-segment timeline labeling; each window matched to its own archetype | **H** — the KB per-segment design in Part 3 exists to make this learnable | A + B |
| TC-04 | Accelerating structure (layout switches speed up toward CTA) | window durations trend down; pacing curve | **H** | A + B |
| TC-05 | Layout switch synchronized to beat/music | window boundaries align to audio onsets, not sentences | **F** (audio-style is UNIVERSAL-1 non-goal) | A + B |
| TC-06 | One-off takeover moment (5s full-frame graphic inside a stable layout) | brief structure exception; must NOT be misread as a structure change (current guard: sustained-stretch rule in the VLM prompt) | **M** | A + B + X |

## 1.7 No-face / VO / montage family

| ID | Name | Defining signals | Diff | User inputs |
|---|---|---|---|---|
| VO-01 | B-roll montage with voiceover | no persistent face (`broll_only` ✅ classified); VO pacing drives cuts | **M** (decode E; render needs VO-driven B-roll plan — planner exists) | V + B |
| VO-02 | Music-only montage, NO speech at all | no speech track; cuts locked to music energy; captions absent or lyric-style | **F** (whole pipeline assumes a transcript spine) | B + music |
| VO-03 | Screen-recording tutorial with VO | single screen-rec region full frame; cursor/zoom emphasis | **M** | S + V |
| VO-04 | Slideshow / carousel-style reel (static images, hard cuts, text-forward) | shots are stills (zero intra-shot motion); text density high | **M** | X + V |
| VO-05 | Kinetic-typography reel (text IS the content) | no footage regions; animated text fills frame | **H** (pure MG render; decode = caption analyzer doing double duty) | V |
| VO-06 | Product-shot ad (product on seamless background, spec callouts) | product content class; annotation overlays | **H** | X + V |
| VO-07 | Game-capture reel with VO/facecam | game content class (HUD detection); optional PIP facecam → PIP-02 | **H** | S(+A) + V |

## 1.8 A-roll presence modes (cross-cutting; combine with any layout above)

| ID | Mode | Defining signals | Diff | Inputs |
|---|---|---|---|---|
| AR-01 | Single speaker, continuous | one face identity throughout | **E** ✅ | A |
| AR-02 | Single speaker, multiple takes/outfits | same identity, appearance shifts at cuts | **M** | A×n |
| AR-03 | Two speakers, turn-taking | face identity alternates; per-speaker crop rules (1:1 square rule per `docs/cropping-rules.md`) | **H** | A×2 |
| AR-04 | Speaker + guest remote (call recording) | one region is a call-UI capture | **H** | A + S |
| AR-05 | Overlapping speakers (podcast crosstalk) | simultaneous speech; diarization required | **F** | A×2 |
| AR-06 | No on-screen speaker (VO family §1.7) | arollBandIndex = -1 ✅ in schema | **E** decode | V |

## 1.9 Modifier axis: caption style

| ID | Style | Defining signals | Diff |
|---|---|---|---|
| CAP-00 | None | no burned-in text band | **E** ✅ |
| CAP-01 | Word-pop (one word/beat, scale-in) | word-rate text change; single-word width | **E** ✅ (shipped caption pass; MMS word times) |
| CAP-02 | Karaoke highlight (line shown, active word colored) | stable line + moving highlight | **M** |
| CAP-03 | Line-by-line (sentence blocks) | text changes at sentence rate | **E** |
| CAP-04 | Multi-position captions (position changes per section) | caption band fraction varies over time | **M** |
| CAP-05 | Emoji-laden / decorated captions | non-text glyph density in caption band | **M** |
| CAP-06 | Dual-language stacked (e.g. Uzbek + English) | two simultaneous text bands, distinct scripts | **H** |
| CAP-07 | RTL / CJK scripts | text direction + font shaping in render; decode is script ID | **M** decode / **H** render |
| CAP-08 | Caption-as-title hybrid (giant hook text, then normal captions) | first-window oversized text ≠ caption band | **M** |

## 1.10 Modifier axis: graphics & animation

| ID | Element | Defining signals | Diff |
|---|---|---|---|
| GFX-00 | None | — | **E** |
| GFX-01 | Lower-thirds (name/handle plate) | persistent small overlay, text+shape, corner/lower band | **M** (MG component library exists — MGCS) |
| GFX-02 | Arrows / circles / scribble annotations | transient drawn shapes over content regions | **H** (decode: overlay vs content; render: MGCS annotate variants) |
| GFX-03 | Stat counters / number tickers | numeral region with per-frame change | **M** (MGCS data-viz exists) |
| GFX-04 | Progress bars (video progress or step progress) | thin persistent bar with monotonic fill | **M** |
| GFX-05 | Meme inserts / reaction images | brief full- or part-frame static image pops | **M** |
| GFX-06 | Zoom-punch emphasis | scale steps at emphasis words | **M** (motion distribution already measured) |
| GFX-07 | Speed ramps | intra-shot playback-rate change (optical-flow rate anomaly) | **H** |
| GFX-08 | Freeze frames | zero-motion window inside a shot with continuing audio | **M** |
| GFX-09 | Transition packs (whip, glitch, luma wipe) | non-cut transition classes beyond crossfade | **H** (transition distribution field exists; class vocab must grow) |
| GFX-10 | Screen-shake / impact frames | 2–6 frame jitter bursts at beats | **H** |

## 1.11 Modifier axis: platform format

| ID | Format | Defining signals | Diff |
|---|---|---|---|
| FMT-01 | 9:16 reel | aspect ✅ (`aspectLabel`) | **E** ✅ (the whole engine's home turf) |
| FMT-02 | 1:1 | aspect ✅; all band fractions re-based | **M** (calibrations are 9:16-trained) |
| FMT-03 | 16:9 YouTube | horizontal grammar (side-by-side dominates stacks) | **H** |
| FMT-04 | 4:5 | aspect ✅; near-9:16 grammar | **M** |
| FMT-05 | Cross-format reference→output (decode 16:9, render 9:16) | style transfer across aspect = re-layout, not re-scale | **F** |

## 1.12 Modifier axis: pacing class

| ID | Class | Defining signals | Diff |
|---|---|---|---|
| PC-01 | Fast (< 1.2s avg shot) | avgShotSec ✅ measured | **E** decode; render must keep B-roll plan cadence honest |
| PC-02 | Moderate (1.2–3s) | ✅ | **E** |
| PC-03 | Slow / cinematic (> 3s, motion-heavy shots) | ✅ + motion distribution | **E** decode / **M** render (long AI B-roll clips cost more) |
| PC-04 | Accelerating (hook slow → CTA fast) | shot-length trend over time (needs windowed pacing, not one global mean) | **M** (new derived field over existing shotBoundaries) |

**Taxonomy count: 72 primary + modifier entries.** Coverage today (honest): 7 entries
E-and-shipped, ~10 E-decode, ~28 M, ~20 H, ~7 F. The KB in Part 3 is the mechanism
that moves entries left (F→H→M→E) with evidence.

---

# Part 2 — Stress-Test Catalog

Adversarial "what happens when…" scenarios. Three sanctioned behaviors:
**HANDLE** (decode + render correctly), **DEGRADE** (decode what's measurable, render
the nearest supported archetype, tell the user what was dropped),
**REFUSE** (stop with a specific reason before spending credits). Silent wrong output
is never acceptable — that is the whole point of the DecodedField confidence +
`uncertain` flag design.

Harness key: **R** = `scripts/test-regression.mjs` (8 structural checks) ·
**D** = decode self-consistency tier (`decode-accuracy.ts` [D]) ·
**CL** = closed-loop style score (decode(ref) vs decode(output)) ·
**G** = a gate that does not exist yet (named where so).

| # | Scenario | Expected behavior | Caught by |
|---|---|---|---|
| S-01 | Mid-video layout switch (TC-01) | HANDLE via `structureTimeline`; render switches at sentence-snapped boundaries | D + CL per-window (**G: windowed CL scoring**) |
| S-02 | Brief 2s takeover misread as structure change | HANDLE: sustained-stretch rule keeps one structure; takeover becomes an overlay/insert | D (band-count stability check) |
| S-03 | Animation/graphic interrupting A-roll mid-sentence | HANDLE: overlay classified as graphic, never cuts words (word-completeness gate) | R (word check + boundary guard) |
| S-04 | Reference with copyrighted music | HANDLE decode (audio style is out of scope); output uses user/licensed audio; never copy the track | policy check in route (**G: audio-provenance assert**) |
| S-05 | Reference longer than user footage | DEGRADE: compress style proportionally (pacing + section structure preserved, duration scaled) with explicit notice; REFUSE below a floor (e.g. user A-roll < 40% of ref) | route preflight (**G: duration-budget gate**) |
| S-06 | User footage shorter than a required region's screen life | DEGRADE: loop/segment-reuse policy from B-roll planner; flag reuse count | B-roll plan diversity check |
| S-07 | No B-roll supplied at all | HANDLE: B-roll factory generates per the planner (`broll-plan.json`); credit estimate shown first | planner + critic loop |
| S-08 | Watermarked reference (TikTok logo drifting) | HANDLE decode: watermark must not become a decoded overlay/region | D (**G: watermark suppressor test frame set**) |
| S-09 | 4K reference vs 720p user footage | HANDLE: all geometry is fractional (0..1) by design; render upscale policy stated | R (dims assert) + CL |
| S-10 | Very low-res / heavily compressed reference | DEGRADE: seam/face confidence drops → fields flagged `uncertain`, human confirm | D confidence floor |
| S-11 | Reference itself AI-generated (fake face, odd physics) | HANDLE: style decode doesn't care about content provenance; face detector may need threshold slack | D |
| S-12 | Captions in RTL / CJK / Uzbek | HANDLE decode (position CV-owned; script ID VLM-owned); render needs shaping fonts — DEGRADE to supported font with notice | caption render snapshot test (**G**) |
| S-13 | Multiple people talking over each other | REFUSE (today): AR-05 is frontier; specific reason "overlapping speakers not yet supported" | route preflight diarization check (**G**) |
| S-14 | Reference with strong LUT/color grade | DEGRADE: grade captured as style keywords only; no LUT transfer yet; stated in output notes | style.keywords presence (D) |
| S-15 | Jump-cut-only style (no B-roll, no layout) | HANDLE: FS-03 = pacing + motion clone on user A-roll | CL pacing fields |
| S-16 | Reference that is actually a slideshow (VO-04) | HANDLE decode (`broll_only` + zero intra-shot motion); render = stills path | D motion distribution |
| S-17 | Vertical video letterboxed inside a horizontal file | HANDLE: detect pillarbox, crop to active area BEFORE decode (else every fraction is wrong) | **G: active-area preflight test** |
| S-18 | Reference is a screen recording OF a reel (UI chrome around it) | Same as S-17 — active-area extraction; REFUSE if active area < 50% of frame | same **G** |
| S-19 | VLM returns duration-fractions instead of seconds | HANDLE: shipped guard drops ≤1.5s timelines rather than mislead (observed on R2) | unit test on `coerceContentTimeline` ✅ exists in code |
| S-20 | VLM band index stale after sort/filter | HANDLE: shipped fix — role lookup, never the raw index | R (audit-fix regression) ✅ |
| S-21 | Gemini API down / no key | HANDLE: `analyzeLayoutRegions` returns null (non-blocking); CV-only decode proceeds for 2-region classes; N-region classes → REFUSE with reason | D source-coverage report |
| S-22 | CV and VLM disagree on layout class | HANDLE: `uncertain` flag set → human-confirm path (the declared autonomy policy) | D disagreement check ✅ schema |
| S-23 | Reference with zero cuts (one continuous shot, 60s) | HANDLE: pacing decode valid (shotCount 1); render must not invent cuts | CL pacing |
| S-24 | 200 cuts in 30s (hyper-edit) | DEGRADE: floor on renderable cadence (frame-alignment rule); state the delta | R frame-alignment + CL |
| S-25 | Reference in a language the transcript pipeline can't align | DEGRADE: layout/pacing clone fine; caption timing falls back to line-level; MMS language coverage stated | aroll-pipeline gates |
| S-26 | User A-roll is landscape but layout needs a 1:1 square crop with the face at frame edge | HANDLE: cropping-rules gate (head-safety every sampled frame) or REFUSE "reframe your footage" | R crop head-safety ✅ |
| S-27 | Reference where the "B-roll window" is actually a still image with Ken Burns | HANDLE: motion class pan/push_in on a single shot → render Ken Burns on a still | CL motion fields |
| S-28 | Two references supplied ("blend these styles") | REFUSE (v1): one reference per decode; blending is undefined and unmeasurable against CL | route preflight |
| S-29 | Reference is 3 minutes long (not short-form) | DEGRADE: decode first 90s + warn; or REFUSE above hard cap (VLM upload cost + fraction-time risk grows) | route preflight (**G: duration cap**) |
| S-30 | Same reference re-submitted | HANDLE: exemplar dedup by source (shipped in `recordConfirmation`) prevents KB skew; decode cache hit | KB dedup ✅ + cache test |

**Roadmap note:** the recurring gate gaps (windowed CL scoring, active-area preflight,
duration budget, caption render snapshots, audio-provenance assert) are the test-harness
work items — five new checks, each of which follows the existing regression-suite
pattern of "when a bug is found, add the check that would have caught it."

---

# Part 3 — The Self-Learning Knowledge Base ("train the app on 50+ role videos")

## 3.1 What exists today (accurately, from the code)

The seed is real and shipped:

- **Library**: `.knowledge/layout-archetypes.json` — 7 archetypes, each with a
  `signature` (categorical + numeric ranges: type/layoutClass, arollSide,
  dividerRange, brollAspectRange, and v2 fields bandCountRange, arollBandPosition,
  pipWidthRange, requiresPersistentPip), `confirmedCount`, and `exemplars`.
  `noveltyThreshold: 0.6`.
- **Matcher** (`layout-archetypes.ts`): `scoreAgainst()` computes a weighted
  distance of a measured layout to each signature (class equality carries the
  heaviest weight; numeric ranges score by normalized out-of-range distance).
  v2 N-region signatures score only against the unified `{layoutClass, regions}`
  view; legacy 2-region signatures never match N-region inputs and vice versa.
  `matchArchetype()` returns best + full ranked list + `novel` flag when the best
  score < threshold.
- **Learning loop primitives**: `recordConfirmation(id, layout, source)` appends an
  exemplar (deduped by source) and calls `recenter()`, which re-centers the numeric
  ranges around accumulated exemplars (min-padded min/max). `proposeNovelArchetype()`
  drafts a new entry from an unmatched layout for a human to name/approve;
  `addArchetype()` appends it. Autonomy policy encoded in the module header:
  **auto on known archetypes, human-confirm novel patterns.**

Current state: one exemplar total (R1). Everything below extends this skeleton —
same file family, same confirm-then-recenter flow — it does not replace it.

## 3.2 The full knowledge-base schema (v2 of `.knowledge/`)

One directory per concern, keeping `.knowledge/` the single home of learned things:

```
.knowledge/
  layout-archetypes.json        # today's file → grows the fields below
  archetypes/<id>/
    exemplars.jsonl             # one line per confirmed reference (full measured vector)
    failures.jsonl              # decode/render failures attributed to this archetype
  corpus/index.json             # the training corpus manifest (see 3.4)
```

Per-archetype record (superset of today's):

| Field | Content | Source |
|---|---|---|
| `signature` | today's categorical + numeric ranges, **plus** modifier priors (caption style distribution, pacing class, format) | recenter() over exemplars |
| `exemplars` | per reference: measured vector (all DecodedField values + confidences), source file hash, license tag, confirm date, confirmer | recordConfirmation (extended) |
| `decodeRecipe` | which extractors run and in what order for this class (e.g. PIP-01: VLM bands → CV seam-snap → PIP-rect pixel refine → contentTimeline), plus per-extractor thresholds calibrated for the class | engineering + calibration loop |
| `renderRecipe` | which compositing path (2-region FFmpeg split ✅ / N-region filtergraph / alphamerge PIP mask / stills path), which MGCS components, feeder-track plan | engineering, validated by CL |
| `confidenceStats` | per-field decode accuracy over exemplars (mean, p10), CL score distribution, sample count | accuracy gate runs |
| `failureLog` | structured entries: {stage, field, expected, got, referenceHash, fix} — feeds "add the regression check" | pipeline runs |
| `gates` | the per-archetype acceptance bars (R1-style: CL ≥ 98% mature, ≥ 90% new — exactly the UNIVERSAL-1 tiering) | milestone policy |

**Why decode recipes are per-archetype:** the R2/R3 experience proved it — the
2-region CV core misreads a 4-layer stack as fullscreen; the VLM proposes structure
the CV then measures. Which extractor is authoritative *depends on the class*, and
the DecodedField `source`/`method` provenance fields already exist to record it.

## 3.3 Per-segment timeline labeling (the "0–15s split, 15–20s fullscreen, 20–30s circle PIP" vision)

The unit of learning becomes the **(archetype, window)** pair, not the whole video:

1. Decode emits `structureTimeline` windows (schema shipped in `layout-regions.ts`).
2. **Each window is matched independently** against the archetype library — a
   layout-changing reference is a *sequence of known archetypes*, not one novel one.
   This is a small change to `matchArchetype` (map over windows) with outsized
   coverage effect: TC-01/02/03 stop being novel classes and become compositions.
3. The KB additionally learns **transition grammar**: a first-order table of
   (from-archetype → to-archetype, boundary trigger: sentence / section / beat,
   typical window durations). That table is itself investor-legible evidence:
   "we know that 62% of split-family reels open with a ≤3s fullscreen hook."
4. Confirmation UI shows the human a filmstrip per window: "0–15s → split_aroll_bottom
   (0.91), 15–20s → fullscreen_aroll (0.88), 20–30s → circle_pip (0.55 **NOVEL — confirm?**)".
   Confirming records one exemplar per window (source = fileHash#window).

## 3.4 The training loop (batch, human-in-the-loop, calibrating)

```
corpus/index.json ──► batch decode ──► per-window archetype match
                                   ├─ known (score ≥ 0.6): auto-confirm queue → recordConfirmation → recenter
                                   ├─ novel: proposeNovelArchetype → human names/approves → addArchetype
                                   └─ uncertain (CV/VLM disagree): human adjudicates → failureLog if a bug
        ▲                                                     │
        └── calibration report per archetype ◄────────────────┘
            (range drift, confidence trend, decode-accuracy [D], CL when rendered)
```

- **Batch decode** is the existing decode path run headless over the corpus — one
  Gemini Flash call per reference (bounded cost), CV free.
- **Threshold calibration per archetype**: `recenter()` already re-centers ranges;
  v2 extends it to (a) per-extractor thresholds in `decodeRecipe` (e.g. seam-contrast
  floor per class), and (b) `noveltyThreshold` *per archetype* instead of one global
  0.6 — mature archetypes (many exemplars, tight ranges) earn a higher bar; new ones
  stay permissive.
- **Graduation rule** (moves taxonomy entries E-ward with evidence): an archetype is
  *demo-grade* at ≥ 3 exemplars + CL ≥ 90% on one render (the R2/R3 bar), and
  *production-grade* at ≥ 10 exemplars + CL ≥ 98% + zero open failureLog entries
  (the R1 bar). These are the same numbers as UNIVERSAL-1's gates — the KB just
  applies them per archetype instead of per milestone.
- **Failure feedback**: every failureLog entry must end in either a code fix + a new
  regression check (the AGENTS.md rule) or a signature/recipe adjustment. The log is
  the queue.

## 3.5 Dataset plan — 50–100 diverse reference reels, legally

| Tranche | Size | Sourcing | License posture |
|---|---|---|---|
| Own-produced | 15–20 | Recreate each major taxonomy family in-house (we control A-roll + assets; also yields ground-truth layout labels by construction — we KNOW the divider is 0.56 because we rendered it) | full rights; the only tranche usable in public demos |
| Creator-submitted | 25–40 | Early-access creators submit their own reels for style-training in exchange for access; explicit written grant for analysis + internal testing | signed grant, revocable; analysis-only |
| Licensed / commissioned | 10–20 | Commission editors on Fiverr/Upwork to produce reels in named styles (deliverable = file + full rights), covering H/F families we can't self-produce (2-cam podcast, game capture) | work-for-hire |
| Public analysis-only | 10–20 | Public reels decoded for *measurements only* (numbers into the KB, no frames stored beyond the decode run, no redistribution, no rendering of their content) | facts-not-footage posture; excluded from demos; counsel-reviewed before use |

Coverage rule: every **E/M taxonomy family gets ≥ 3 corpus entries**, every targeted
H family ≥ 2, spread across the four modifier axes (at least: 2 non-Latin caption
sets, 2 non-9:16 formats, all 4 pacing classes). The corpus manifest records per
entry: file hash, source tranche, license tag, taxonomy IDs, and (for own-produced)
ground-truth layout.

## 3.6 Metrics — per-archetype gates, same discipline as R1/R2/R3

| Metric | Definition | Gate |
|---|---|---|
| Decode accuracy [D] | per-field self-consistency of the DecodedField vector (existing decode-accuracy tier) | ≥ 95% per archetype before render work starts |
| Closed-loop style score [CL] | decode(reference) vs decode(output) over the [D] tier — the falsifiable metric already in use | ≥ 90% demo-grade, ≥ 98% production-grade |
| Windowed CL | CL computed per structureTimeline window (new — stress-test gap S-01) | every window ≥ its archetype's gate |
| Novelty precision | of decodes flagged novel, fraction a human agrees are genuinely new | ≥ 70% (below = threshold too tight) |
| Auto-confirm safety | of auto-confirmed matches, fraction a spot-check human would also confirm | ≥ 98% (this is what earns autonomy) |
| Reliability | full route completes unattended (UNIVERSAL-1 gate 4) | 100% on the archetype's corpus entries |

**The compounding claim, in one sentence:** every confirmed reference makes the
matcher's ranges tighter, the thresholds better calibrated, and the novel-flagging
more precise — so decode quality is a function of corpus size, which is a moat that
grows with usage, not with headcount.

---

## Appendix — file map (where each mechanism lives)

| Mechanism | File |
|---|---|
| Canonical decode object (DecodedField, DecodedRegion, layoutClass) | `src/lib/analysis/reference-decode.ts` |
| VLM band decomposition + contentTimeline + structureTimeline | `src/lib/analysis/layout-regions.ts` |
| Archetype library + matcher + confirm/recenter/propose loop | `src/lib/analysis/layout-archetypes.ts`, `.knowledge/layout-archetypes.json` |
| Deterministic CV core (2-region, seams, shots, motion) | `scripts/python/layout_analyzer.py` |
| Milestone gates (R1/R2/R3, CL bars, FFmpeg-compositor decision) | `docs/UNIVERSAL-1-MILESTONE.md` |
| Structural regression harness | `scripts/test-regression.mjs` |
