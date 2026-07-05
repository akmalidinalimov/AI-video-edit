# B-roll Generation Prompts — Kling 3.0 (AI CREATORS Uzbek course ad)

> Purpose: fill the B-roll gaps the real award-ceremony footage can't cover, for a
> vertical (9:16) Uzbek-language talking-head ad. These prompts cost credits — they
> are written to be accurate, renderable, and to blend with the real event footage
> (warm, documentary, Central Asian / Uzbek people, grounded not glossy).

## Model & best-practices confirmed

- **Model: Kling 3.0.** Best-practices confirmed via web search on **2026-06-29**
  (klingaio.com, blog.fal.ai, glif.app, atlabs.ai, artlist.io guides, all dated 2026).
- Conventions applied (sources at bottom):
  - Prompt like a **director**, not a keyword list. Order: **Scene → Characters →
    Action → Camera → Lighting/Style.** (Kling thinks in shots, not tags.)
  - Keep prompts **~20–50 words** — most stable adherence. English yields best
    adherence to cinematic camera terms even for non-English scenes.
  - Use **concrete camera verbs**: slow push-in, dolly push, tracking shot, rack
    focus, shoulder-cam drift. Avoid "camera moves / cool angle / dynamic".
  - **Negative prompts: 5–8 targeted terms only.** Overloading (~30 terms) stiffens
    motion. Add explicit "no camera drift / no facial warping" to tame Kling's
    tendency to over-move.
  - Kling is **motion-first** and understands physics/time — always specify the
    action AND how the camera behaves over time.
- Project constraints carried into every clip: **9:16, 1080p, 3–5s**; keep the key
  subject/action in the **central vertical third** (clip may be cropped to a central
  horizontal band per `docs/cropping-rules.md`); no reliance on legible on-screen
  text (imply screens with glow/abstract UI).

---

## Clip 1 — "Learning AI in the right system" (serves s2)

**Beat:** s2 — "they learned AI earlier and in the RIGHT system." We need someone
actually LEARNING/USING AI: focused, making progress on an online-course / AI-chat
interface. This is the visual proof of *method*, which the event photos lack.

**Renderable text:** A young Uzbek woman (late 20s, smart-casual, hair tied back)
sits at a laptop in a bright modern home office. She watches an online lesson, eyes
moving across the screen, then nods slightly and types — a small "I get it" moment.
The laptop screen glows with soft blue-white light and abstract chat-bubble UI (no
readable text). Warm daylight from a window beside her. Calm, focused, hopeful.

**Kling 3.0 prompt:**
> A focused young Uzbek woman in smart-casual clothes sits at a glowing laptop in a
> bright modern home office, eyes scanning an online lesson, then she nods and types
> with quiet confidence. Slow dolly push-in toward her face. Soft warm window
> daylight, blurred blue UI glow on screen, no readable text. Authentic documentary
> realism, natural skin texture, shallow depth of field.

**Negative prompt:**
> readable on-screen text, garbled letters, warped face, extra fingers, distorted
> hands, plastic skin, watermark, camera drift, motion blur

**Params:** 9:16 · 1080p · **4s** · motion strength low–medium; single slow push-in
only (no handheld). Keep face in central vertical third.

---

## Clip 2 — "Earning income in Uzbekistan in 2026" (serves s4)

**Beat:** s4 — "learn to earn income in Uzbekistan in 2026." We need the RESULT:
someone earning from the skill, seeing a payment/earnings cue, quietly proud. The
event footage shows certificates, not income — this closes the loop.

**Renderable text:** A young Uzbek man (early-to-mid 20s, neat casual shirt) works
at a laptop in a tidy modern apartment with a city window behind him. His phone on
the desk lights up with a soft green payment-notification glow (no readable
numbers/text). He glances at it, then breaks into a small, genuine, satisfied smile
and exhales. Warm late-afternoon light. Grounded, real, optimistic — not flashy.

**Kling 3.0 prompt:**
> A young Uzbek man in a neat casual shirt works at a laptop in a tidy modern
> apartment, a city window behind him. His phone glows with a soft green
> notification; he glances at it and smiles a small genuine proud smile, then
> exhales. Slow push-in with a gentle settle. Warm late-afternoon light, shallow
> depth of field. Authentic documentary realism, natural skin texture, no readable
> text.

**Negative prompt:**
> readable text, garbled numbers, currency symbols, warped face, extra fingers,
> distorted hands, plastic skin, watermark, jittery camera

**Params:** 9:16 · 1080p · **4s** · motion strength low–medium; one push-in that
settles as he smiles. Keep his face/phone in central vertical third.

---

## Clip 3 — "Ordinary people, not programmers" (serves s0/s1)

**Beat:** s0/s1 — "ordinary people, not programmers/IT/engineers." We need a
clearly NON-techie person confidently using AI at home, to prove "this is for normal
people too." The event photos read as winners; this reads as relatable everyman.

**Renderable text:** A friendly middle-aged Uzbek man (45–55, casual sweater, slight
grey at the temples) sits at his kitchen table at home, holding a smartphone in both
hands. He speaks a short voice command to an AI assistant on the phone (a soft glow
pulses on screen, no readable UI), then looks up and chuckles, pleasantly surprised
it worked. Homely kitchen, warm domestic light. Warm, approachable, real.

**Kling 3.0 prompt:**
> A friendly middle-aged Uzbek man in a casual sweater sits at his home kitchen
> table holding a smartphone in both hands, speaks a short command to a glowing AI
> assistant, then looks up and chuckles, pleasantly surprised. Slow handheld-style
> push-in. Warm domestic kitchen light, soft phone glow, no readable screen text.
> Authentic documentary realism, natural skin texture and wrinkles, shallow depth of
> field.

**Negative prompt:**
> readable screen text, garbled letters, warped face, extra fingers, distorted
> hands, plastic skin, over-stylized look, watermark, fast jitter

**Params:** 9:16 · 1080p · **4s** · motion strength low–medium; very gentle
handheld push-in (keeps the "ordinary / real" feel). Face + phone in central third.

---

## Clip 4 (optional hero) — "Our students earning through AI" (strengthens s0)

**Beat:** s0 — "these are our students earning through AI." A stronger opening hero
beat: a relatable Uzbek woman at a laptop in a warm workspace, mid-work, with a quiet
sense of momentum — pairs with the real student photos rather than replacing them.

**Renderable text:** A young Uzbek woman (mid-20s, modern casual, some wearing a
neat hijab in alternate takes) works intently at a laptop in a warm sunlit
co-working / cafe corner with soft bokeh lights behind her. She works confidently,
glances at a second device, and gives a small focused nod. Aspirational but grounded,
documentary feel. Warm golden ambient light.

**Kling 3.0 prompt:**
> A young Uzbek woman in modern casual clothes works confidently at a laptop in a
> warm sunlit co-working corner, soft bokeh lights behind her; she glances at a
> second device and gives a small focused nod. Slow tracking push-in past her
> shoulder. Warm golden ambient light, shallow depth of field. Authentic
> documentary realism, natural skin texture, no readable text.

**Negative prompt:**
> readable text, garbled letters, warped face, extra fingers, distorted hands,
> plastic skin, glossy stock look, watermark, camera drift

**Params:** 9:16 · 1080p · **3s** · motion strength low–medium; a single short
tracking push-in (good as a punchy opener). Keep her in central vertical third.

---

## Set summary

| Clip | Serves | Subject | Core action | Duration |
|------|--------|---------|-------------|----------|
| 1 | s2 (right system) | young woman, home office | learning on AI course, "gets it" | 4s |
| 2 | s4 (earn 2026) | young man, apartment | sees payment glow, proud smile | 4s |
| 3 | s0/s1 (ordinary) | middle-aged man, kitchen | uses AI assistant, chuckles | 4s |
| 4 | s0 (students earn) | young woman, co-working | works confidently, nods | 3s |

Authenticity guardrails across all four: Central Asian / Uzbek faces and homes,
warm natural light, documentary realism (not glossy Western stock), low–medium
motion with a single deliberate camera move, screens implied by glow (never readable
text), key subject in the central vertical third so a horizontal-band crop still works.

---

## Kling 3.0 prompt-writing cheat-sheet (reuse for future B-roll)

- **Direct, don't tag.** Write one flowing director's instruction in the order
  **Scene → Character → Action → Camera → Lighting/Style.** Kling thinks in shots.
- **Keep it ~20–50 words.** Long prompts drift; short ones are stable. Trim adjectives
  before you trim the action or the camera move.
- **Name one concrete camera move** per clip: slow push-in, dolly push, tracking
  shot, rack focus. Never "camera moves / dynamic / cool angle."
- **State the action over time** (Kling is motion-first): what the subject does AND
  how the camera behaves while they do it (push in, settle, hold).
- **Negative prompt = 5–8 targeted terms** of the glitches you actually fear (warped
  face, extra fingers, garbled text, plastic skin, camera drift, jitter). Don't pile
  on 30 — it stiffens motion.
- **Tame over-motion explicitly** with "no camera drift / no jitter / no facial
  warping" — Kling tends to add extra movement in 3–5s.
- **Imply screens with glow, never readable text** — AI garbles UI text, especially
  non-Latin. Use "soft blue/green glow, abstract UI, no readable text."
- **Lock authenticity in words**: "Uzbek / Central Asian," "authentic documentary
  realism," "natural skin texture," "warm natural light," "not glossy stock."
- **Compose for the central third** (subject mid-frame, nothing critical at the
  extreme top/bottom) so the clip survives a horizontal-band crop or fullscreen 9:16.

## Sources

- [Kling 3.0 Prompt Guide: Best Practices & Examples (2026) — klingaio.com](https://klingaio.com/blogs/kling-3-prompt-guide)
- [Kling 3.0 Prompting Guide — blog.fal.ai](https://blog.fal.ai/kling-3-0-prompting-guide/)
- [Kling 3.0 Prompting Guide — glif.app](https://glif.app/use-cases/kling-3-prompting-guide)
- [Kling 3.0 Prompt Guide: The 2026 Formula — glbgpt.com](https://www.glbgpt.com/hub/kling-3-0-prompt-guide-for-better-ai-videos/)
- [Mastering Kling 3.0 — realistic human motion — atlascloud.ai](https://www.atlascloud.ai/blog/guides/mastering-kling-3.0-10-advanced-ai-video-prompts-for-realistic-human-motion)
- [Negative prompts for Kling, Veo, and Wan — artlist.io](https://artlist.io/blog/negative-prompts-ai-video/)
