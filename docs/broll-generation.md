# B-roll Generation Knowledge Base (Kling 3.0 / Seedance 2.0)

> **This file is the PRIMARY SOURCE OF TRUTH for B-roll generation.** The director
> system prompt (`src/lib/broll/brollGenerationPrompt.ts`) references these rules.
> Every generation request MUST be processed through this KB — never generate from
> aesthetic writing alone. Prompts must be physically renderable, temporally coherent,
> cinematographically structured, motion-aware, and continuity-safe.

It adapts a general "Kling 3.0 Cinematic Director" methodology to **our specific job**:
short B-roll clips that sit BEHIND a circular talking-head PIP in a vertical reel, cut
to the speaker's narration. The four house rules below override anything generic.

---

## 0. THE FOUR HOUSE RULES (non-negotiable, our pipeline)

1. **No fabricated UIs or readable text.** Generation models cannot render legible
   text — they invent gibberish. In reel 1, every clip we asked to show a phone/app
   screen came back with garbled labels; the real-world clips (a creative team, a
   product on a set) were clean. So: **generate real-world scenes only.** When a concept
   implies a screen, app, feed, link, or text, **REFRAME it into a real-world visual
   metaphor** that needs no readable text (see §6). For a genuine app demo, use a REAL
   screen recording from the catalog — never a generated fake UI.

2. **Single-shot BEATS, assembled by us.** A segment longer than ~3s is decomposed into
   ordered **beats** (~2.5–3.5s each, ONE clean scene per beat). Each beat is generated
   as a **single, uninterrupted shot**. OUR renderer concatenates the beats in order
   (`scripts/multi-aroll-stage3-4.mjs`), giving perfect shot order and clean hard cuts
   every time. **Do NOT rely on the model's internal multi-shot** — it produces wrong
   order and messy seams. The director's "multishot intelligence" lives in deciding the
   beat *shot-list* (how many beats, what each shows, how they connect), not in asking
   the model to cut.

3. **Text-free, PIP-aware framing.** Every prompt forbids on-screen text, captions,
   logos, watermarks, and UI overlays. Reserve **clean negative space in the TOP-RIGHT**
   (the circle PIP lives there) and keep the subject **centered and in the lower two-
   thirds** of the vertical 9:16 frame.

4. **Model routing.** Pick the model per beat:
   - **Seedance 2.0** — product/identity, e-commerce hero shots, anything image-driven
     (`start_image`/`end_image`), consistent SKU across beats. Strong identity hold.
   - **Kling 3.0 (pro)** — human motion, hands, lifestyle, dynamic real-world action.
   - Optional **image-to-video**: generate a clean still first, then animate it (gives
     compositional control and lets you reserve the top-right for the PIP).

---

## 1. Output target & defaults

- **Aspect:** `9:16` (vertical). **Resolution/quality:** Kling `mode:"pro"`; Seedance
  `resolution:"1080p"`. **Audio:** off (`sound:"off"` / no `generate_audio`).
- **Beat duration:** 2.5–3.5s each; a segment's beats sum to ≥ the segment's needed
  duration (the renderer trims each beat to its exact sub-duration via `tpad`+`trim`).
- **Preset notice:** if `generate_video` returns a preset-recommendation notice, retry
  with `params.declined_preset_id:<id>` to generate literally.
- **Cost:** Kling 3.0 pro ≈ 10–17 credits / clip; preflight with `get_cost:true`.

---

## 2. Single-shot vs. beats — the decision

Use a **SINGLE beat** when: the segment is ≤ ~3.5s, the action is one simple moment, the
emotion is singular, the environment is static, and uninterrupted motion reads best.

Use **MULTIPLE beats** when: the segment is longer, there is narrative progression
(setup → payoff), emotional beats evolve, or a perspective change helps. Then plan 2–3
beats, each a clean single shot, in narrative order.

Prefer fewer beats when a longer moment can succeed as one continuous shot — avoid
music-video over-cutting. Never exceed ~1 beat per ~2.5s.

---

## 3. The 8-point shot methodology (every beat fills these)

1. **Subject** — who/what is on screen (concrete, described).
2. **Action** — one clear physical behavior (avoid stacking simultaneous actions).
3. **Environment** — where it happens (readable, uncluttered).
4. **Camera** — framing + ONE motivated movement (see §4).
5. **Lighting** — realistic cinematic lighting (warm key, soft shadows, etc.).
6. **Emotion** — the readable emotional state/mood.
7. **Motion logic** — how movement evolves naturally (inertia, weight, breath).
8. **Continuity** — how it connects to adjacent beats (see §5).

---

## 4. Camera language (intentional, operable, stable)

Use professional, physically-operable moves, ONE per beat:
handheld close-up · slow dolly-in / push-in · low-angle tracking · over-the-shoulder ·
shoulder-level tracking · macro insert · top-down · gimbal follow · slow orbit.

Combine sensibly ("low-angle handheld close-up tracking beside the subject"). Camera
motion must serve emotion/narrative. **Avoid** impossible moves (drone→macro in one shot),
teleporting/contradictory framing, or random motion.

---

## 5. Continuity engine (across OUR assembled beats)

Because we hard-cut beats together, the model never sees the other beats — so the BEAT
PLAN must enforce continuity by description. Across a segment's beats keep consistent:
character appearance & wardrobe · lighting direction & color · environment/layout ·
emotional through-line · object placement · **screen direction** (don't mirror left/right
between beats) · motion flow (end one beat where the next can pick up). Each beat carries a
short `continuityNote` describing what it inherits from the previous beat.

---

## 6. Reframing screen/app/text concepts → real-world (the #1 quality lever)

When the narration talks about phones, apps, scrolling, links, forms, posts, or text,
DO NOT render the screen. Translate the *meaning* into a real-world image:

| Speech concept | ❌ Avoid (gibberish risk) | ✅ Generate instead |
|---|---|---|
| "product photos must grab attention" | scrolling an app feed of product photos | a dull, flat product on a plain table → the SAME product beautifully styled, lit, and glossy on a vibrant set |
| "AI makes your content / our students create it" | an editing app UI | a creative team in a bright studio arranging vivid prints, shooting product, designing on a clean desk |
| "send us your product photos" | an upload screen | hands placing a product into a softbox / a photographer framing the product |
| "trends / viral content" | a trends dashboard | a wall of vivid printed thumbnails, a hand pinning a standout one |
| "link in profile / fill the form / contact us" | tapping a link, a sign-up form | a person warmly holding a phone toward camera with an inviting gesture (screen out of focus), or a confident "reach out" hand gesture / a welcoming handshake |

If a screen genuinely must appear, keep it **out of focus / not the subject** (bokeh,
turned away, glare) so no text is legible — or use a real screen recording instead.

---

## 7. Realism, motion & anti-failure

Movement obeys believable physics: natural weight shifts, blinks, breath, eye-focus
consistency, fabric/hair motion, atmospheric depth. **Avoid** robotic/floating motion,
over-animated faces, impossible mechanics.

Proactively reduce model failures (facial distortion, anatomy/object morphing, identity
drift, warping, background chaos) by: simplifying overloaded actions, reducing simultaneous
motion, keeping ONE clear subject + ONE action + ONE camera move per beat, and keeping the
environment readable. If a beat is getting complex, split it into two simpler beats.

---

## 8. Prompt anatomy (what each beat's `prompt` string contains)

A single flowing paragraph, in this order, NO line items, NO screenplay formatting:

> `Vertical 9:16 cinematic [marketing] b-roll, photorealistic, [lens/DoF]. [SUBJECT]
> [ACTION] in [ENVIRONMENT]. [CAMERA move]. [LIGHTING], [emotion/mood], [color grade].
> Subject centered in the lower two-thirds, clean negative space in the top-right. No
> on-screen text, no captions, no logos, no watermarks, no UI.`

Keep it grounded and renderable — not poetic, not dense, no contradictions. One subject,
one action, one camera move.

---

## 9. The generate → verify → regen loop (closed loop)

1. **Plan** beats per segment (`scripts/multi-aroll-broll-generate.mjs --plan` →
   `broll-gen-manifest.json`).
2. **Generate** each beat via MCP `generate_video` (routed model, 9:16, pro/1080p, sound
   off, decline preset).
3. **Ingest + gate** (`--ingest`): download to `public/uploads/gen/<segId>_<order>.mp4`,
   then run BOTH gates on each beat:
   - **Cleanliness / text-artifact gate** — reject any clip with readable or gibberish
     on-screen text, UI, captions, or watermark (the gibberish guard). FAIL → regen with a
     reframed (more real-world, less screen) prompt.
   - **Relevance gate** — 3-frame × 3-vote Gemini average vs. the speech (advisory; an
     explicit user creative choice can override).
4. **Assemble + render** — write ordered `beats[]` into `broll-plan.json`; the renderer
   concatenates them frame-exact behind the PIP.
5. **Verify the reel** — `test-regression.mjs` (14/14) + `multi-aroll-verify.mjs` (A-roll
   gates must stay green — no regression).

---

## 11. Content-type awareness & the strategy architecture

The system is CONTEXT-AWARE: it first detects what a segment is about, then routes to a
strategy that fits. The pieces live in `scripts/lib/broll/` and depend only on a stable
**contract** (`contract.mjs`) so a strategy can be improved in isolation — the orchestrator,
gates, renderer, and A-roll pipeline never change.

- **Classifier** (`classifier.mjs`) → `{ contentType: product | service | tutorial | lifestyle
  | social_proof | other, productSpecificity: specific | generic | none, entities[] }`,
  grounded by the segment's `role` + `semanticTags` + speech.
- **Routing** (`registry.mjs`): **product depiction is cross-cutting** — if products are the
  visual subject (`specific` or `generic`), use the PRODUCT strategy EVEN inside a
  service/other pitch (the user wants products shown when products are mentioned). Otherwise
  route by `contentType`. Unmapped types → `default`.
- **Strategies** (`strategies/*.mjs`), each `plan(segment, classification) → beats[]`:
  `product` (full), `default` (real-world reframe), and `service`/`tutorial`/`lifestyle`
  stubs that delegate to `default` (flesh out later by editing ONE file). `tutorial` is the
  home for future non-generated kinds (`image_sequence` storyboard-highlight, `screen_recording`).
- **Contract** `Beat.kind` ∈ `generated | image_sequence | screen_recording | stock` — only
  `generated` is implemented; the others are declared so new styles slot in without changing
  the renderer/gates.

## 12. Product depiction — VARIETY vs IDENTITY

The PRODUCT strategy (`strategies/product.mjs`) picks a mode from `productSpecificity`:

- **Generic mention (no specific product named) → VARIETY:** each beat shows a DIFFERENT
  product/category (e.g. footwear → skincare → a handbag), each a clean attention-grabbing
  hero shot, representing "any product". Be creative and varied — never repeat one product.
  The dull-vs-styled contrast may span the variety. Route hero shots to Seedance 2.0, in-use
  moments to Kling 3.0; keep a consistent premium grade so the variety still feels like one brand.
- **Specific product/type named → IDENTITY + creative scene variation:** hold the SAME product
  consistent across beats (carry an explicit physical description in every prompt; Seedance
  identity hold), but vary the SCENES/lighting/angles/usage — not a static repeat.

---

## 10. Hard "never" list

- Never ask the model to render readable text / a real UI / a legible app screen.
- Never rely on the model's internal multi-shot for order or seams — assemble beats yourself.
- Never stack multiple simultaneous actions or camera moves in one beat.
- Never let a beat's duration drift the timeline — the renderer forces exact sub-durations.
- Never present a reel whose A-roll gates regressed, regardless of B-roll changes.
