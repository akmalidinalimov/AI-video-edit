# StyleClone TOOLS — Max-Capability Stack (researched 2026-07-02)

Premise: **cost is not a constraint** — pick the most capable option per component, but
**every pick must be commercial-license-safe** (we were burned once by CC-BY-NC model
weights — MMS forced alignment). License red flags are marked **⚠ LICENSE**.

Verdict legend: **UPGRADE NOW** (before investor demo) · **POST-DEMO** · **KEEP**.

---

## Summary table

| # | Component | Current (repo) | Top-tier pick | Price (order of magnitude) | License safety | Verdict |
|---|-----------|----------------|---------------|-----------------------------|----------------|---------|
| 1 | Video-understanding VLM | Gemini 2.5 Flash | **Gemini 3 Pro** (+ TwelveLabs Pegasus for temporal grounding) | Gemini 3 Pro $2/M in, $12/M out; Pegasus index $0.042/min | API output usable commercially | **UPGRADE NOW** |
| 2 | Shot/transition detection | PySceneDetect + OpenCV | **TransNetV2** (or AutoShot ensemble) | Free, GPU inference | MIT ✅ | **UPGRADE NOW** |
| 3 | OCR / caption extraction | Gemini regions (VLM) | **PaddleOCR 3.0 (PP-OCRv5)** local + Google Cloud Vision as accuracy fallback | Free / ~$1.50 per 1k images | Apache-2.0 ✅ / cloud ToS ✅ | POST-DEMO |
| 4 | STT + word timestamps (Uzbek) | stable-ts + Whisper; MMS verified but **⚠ CC-BY-NC** | **ElevenLabs Scribe v2** (AssemblyAI Universal as 2nd) | $0.22/hr (Scribe); $0.27/hr (AssemblyAI) | Commercial ✅ (both) | **UPGRADE NOW** |
| 5 | B-roll / video generation | Kling 3.0 via Higgsfield | **Veo 3.1 (Vertex AI)** for hero shots; keep Kling 3.0 for volume | Veo 3.1 ~$0.10–0.40/s; Kling ~$0.09–0.14/s | Paid tiers grant commercial use ✅ (verify Higgsfield likeness clause) | POST-DEMO (mixed fleet) |
| 6 | TTS / voice | none | **ElevenLabs Eleven v3** (74 langs incl. Uzbek) | Creator/Pro $22–99/mo, commercial incl. | ✅ paid tiers | POST-DEMO |
| 7 | Motion graphics / captions | Remotion + GSAP | **Keep Remotion** (+ HyperFrames as agent-authoring layer) | Remotion company license $25/seat/mo or $0.01/render | Remotion source-available, **paid company license required** ✅ if paid; HyperFrames Apache-2.0 ✅ | **KEEP** (license up) |
| 8 | Compositing / render infra | FFmpeg local | FFmpeg local now → **Remotion Lambda** at scale | Lambda ~cents/render + $0.01/render license | FFmpeg LGPL/GPL builds — use LGPL build or CLI-invoke ✅ | KEEP → POST-DEMO |
| 9 | Music / SFX | none | **Epidemic Sound Partner API** (licensed) + ElevenLabs SFX; **avoid Suno/Udio as sole source** | Epidemic commercial $49/mo (API = partner deal) | Licensed library ✅; **⚠ AI-music copyright unresolved** | POST-DEMO |
| 10 | Upload / storage / streaming | local disk | **Cloudflare R2 + Mux** (playback+analytics) | R2 zero egress; Mux ~$0.0075/min encode | ✅ | POST-DEMO |
| 11 | Job queue / workers | none (scripts) | **Trigger.dev** (Temporal if you outgrow it) | usage-based; self-host option | Apache-2.0 core ✅ | POST-DEMO |
| 12 | Copyright / moderation | none | **ACRCloud** (audio fingerprint) + Hive/Google Video Intelligence (visual) | volume-tiered API | ✅ | POST-DEMO |

---

## 1. Video-understanding VLM

- **Current:** Gemini 2.5 Flash for semantics/regions.
- **Top-tier:** **Gemini 3 Pro** — flagship multimodal, native video input (258 tokens/s of video),
  1M context, leading Video-MMMU scores; $2/M input, $12/M output (doubled beyond long-context
  threshold) ([Google pricing](https://ai.google.dev/gemini-api/docs/pricing),
  [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/gemini-3),
  [video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)).
- **Temporal-grounding specialist:** **TwelveLabs Pegasus 1.2 + Marengo 3.0** — video-first models
  built for timestamped event grounding ("when does X happen"), exactly the weak spot Gemini showed
  in your timing-engine tests (0.5–2.2 s late). Pricing: indexing $0.042/min, input $0.021/min,
  output $0.0075/1k tok ([TwelveLabs pricing](https://www.twelvelabs.io/pricing),
  [models](https://www.twelvelabs.io/product/models-overview),
  [Marengo 3.0 launch, Dec 2025](https://www.hpcwire.com/aiwire/2025/12/01/twelvelabs-launches-marengo-3-0-video-understanding-model-on-twelvelabs-and-amazon-bedrock/)).
  Also on AWS Bedrock (enterprise-friendly terms).
- **GPT-5 vision:** no native video ingestion — frame-sampling only; worse fit for temporal style
  decode. **Qwen3-VL:** strongest open-weights video VLM, Apache-2.0 ✅ — the credible free/local
  alternative if you ever need on-prem decode (verify the specific checkpoint's license; some Qwen
  releases used the Qwen license, not Apache).
- **Verdict:** **UPGRADE NOW** — swap 2.5 Flash → Gemini 3 Pro for the Reference Decode (directly
  attacks the 73.4% style-reproduction ceiling); add Pegasus where timestamp grounding matters.

## 2. Shot / transition detection

- **Current:** PySceneDetect (histogram heuristic).
- **Benchmarks:** on the AutoShot short-video benchmark, PySceneDetect F1 < 0.6 and "can hardly
  handle gradual transitions"; TransNetV2 and AutoShot reach ~0.75–0.82 F1, AutoShot +4.2% F1 over
  TransNetV2, though TransNetV2 is better on hard gradual transitions
  ([AutoShot paper](https://arxiv.org/pdf/2304.06116),
  [OmniShotCut 2026](https://arxiv.org/html/2604.24762)).
  Reels are exactly the fast-cut, whip/zoom-transition regime where PySceneDetect fails —
  this is a measured accuracy hole in the layout analyzer.
- **License:** TransNetV2 = **MIT** ✅ ([repo](https://github.com/soCzech/TransNetV2)). AutoShot is
  research code — **check its repo license before shipping**.
- **Verdict:** **UPGRADE NOW.** Free, MIT, one-file inference, immediate decode-accuracy win.
  Keep PySceneDetect as CPU fallback.

## 3. OCR / caption extraction

- **Top open:** **PaddleOCR 3.0 / PP-OCRv5** — best open-source accuracy/speed/memory trade-off,
  Apache-2.0, free, multilingual
  ([comparison](https://www.marktechpost.com/2025/11/02/comparing-the-top-6-ocr-optical-character-recognition-models-systems-in-2025/),
  [non-LLM OCR analysis](https://intuitionlabs.ai/articles/non-llm-ocr-technologies)).
- **Top cloud:** Google Cloud Vision still tops raw text-extraction benchmarks (e.g., 87.8% STROIE)
  — use as fallback for stylized caption fonts.
- **Note:** with Gemini 3 Pro doing region/semantic decode anyway, dedicated OCR is a precision
  layer for caption timing/styling extraction, not a replacement.
- **Verdict:** POST-DEMO. Add PaddleOCR for per-frame caption text+bbox; keeps cost at zero.

## 4. Speech-to-text + word timestamps (Uzbek — verified)

- **⚠ LICENSE (known burn):** MMS forced alignment weights are **CC-BY-NC** — cannot ship
  commercially. Must be replaced before any paid usage.
- **ElevenLabs Scribe v2** — **Uzbek explicitly supported** ("Good" tier, 10–25% WER), word- and
  character-level timestamps, diarization; **$0.22/hr**
  ([Uzbek page](https://elevenlabs.io/speech-to-text/uzbek),
  [Scribe v2](https://elevenlabs.io/blog/introducing-scribe-v2),
  [API pricing](https://elevenlabs.io/pricing/api)). This was already your identified
  commercial-safe fallback — at cost-no-object it becomes the primary.
- **AssemblyAI Universal** — **Uzbek listed** among 99 languages, word timestamps, flat $0.27/hr
  ([supported languages](https://www.assemblyai.com/docs/supported-languages),
  [99-language announcement](https://www.assemblyai.com/blog/99-languages)). Good A/B second source.
- **Deepgram** — ~30+ languages, **no Uzbek** ([docs](https://developers.deepgram.com/docs/models-languages-overview)). Out.
- **Whisper large-v3 (MIT)** — free/local alternative; Uzbek WER is mediocre and word timestamps
  need stable-ts/WhisperX post-processing; fine as offline fallback only.
- **Verdict:** **UPGRADE NOW** — wire Scribe v2 into the clone-style route; benchmark vs your MMS
  ground truth, then delete the MMS dependency.

## 5. AI B-roll / video generation (incl. image-to-video)

Per-second API pricing (converging sources, Apr–Jul 2026:
[buildmvpfast pricing table](https://www.buildmvpfast.com/api-costs/ai-video),
[modelslab comparison](https://modelslab.com/blog/api/veo-3-1-vs-kling-3-sora-2-ai-video-api-cost-2026),
[veo3ai pricing guide](https://www.veo3ai.io/blog/veo-3-1-pricing-plans)):

| Model | ~$/sec | Strengths | Commercial rights |
|---|---|---|---|
| **Veo 3.1** (Vertex) | Fast ~$0.10–0.15; Standard ~$0.40 w/ audio; Lite ~$0.05 | native audio, 4K, best API maturity, i2v (product shots) | ✅ Google API permits commercial use (preview terms apply) |
| **Kling 3.0** | ~$0.09–0.14 | cost/quality leader for social B-roll, strong i2v | ✅ paid tiers, watermark-free; **⚠ broad content license back to Kuaishou incl. training** ([terms guide](https://www.glbgpt.com/hub/can-i-use-kling-ai-for-commercial-use/)) |
| Sora 2 / Pro | $0.10 / $0.30–0.50 | cinematic quality leader | ✅ via paid ChatGPT/API |
| Runway Gen-4.5 | ~$0.15 | best creative controls (motion brush, references) | ✅ all paid tiers |
| Pika | cheap | consumer-grade; not top-tier | ✅ paid |

- **Higgsfield platform:** paid plans = full ownership of outputs; **⚠ recognizable-human-likeness
  in paid ads is restricted** — check before using AI faces in client ads
  ([Higgsfield FAQ](https://flowith.io/blog/higgsfield-2-0-faq-video-length-skin-rendering-commercial-rights/)).
- **Verdict:** POST-DEMO **mixed fleet**: keep Kling 3.0 (already wired, critics tuned to it) for
  volume; add **Veo 3.1 Standard** for hero/product i2v shots where audio-sync and 4K matter. The
  B-roll factory's prompt-critic/video-critic loop is model-agnostic — route by shot importance.

## 6. TTS / voice (Uzbek)

- **ElevenLabs Eleven v3** — most expressive TTS, 74 languages **including Uzbek**, audio tags for
  emotion; commercial use on Creator+ ($22+/mo)
  ([Eleven v3](https://elevenlabs.io/blog/eleven-v3), [models](https://elevenlabs.io/docs/overview/models)).
  Verify Uzbek voice quality by ear before demoing — "supported" ≠ "native-sounding"; no published
  Uzbek TTS quality metric found (gap).
- Free/local alternative: Kokoro (Apache-2.0, bundled in HyperFrames) — **no Uzbek**; XTTS-v2 is
  **⚠ Coqui non-commercial license**. No credible free Uzbek TTS found.
- **Verdict:** POST-DEMO (only needed if you add VO features).

## 7. Motion graphics / captions rendering

- **Answer to "how do free tools fit vs paid":** Remotion + GSAP is already the professional-grade
  answer — Remotion is the render engine (React → deterministic frames), GSAP (now 100% free incl.
  all plugins since the Webflow acquisition) is the animation math inside it. Paid SaaS
  (Creatomate $41–249/mo, Shotstack, JSON2Video) are *template* renderers — strictly less
  expressive than your MGCS typed-component system; they'd be a downgrade.
- **⚠ LICENSE:** Remotion is **not** free for companies — Automators tier **$0.01/render, $100/mo
  minimum** or $25/seat Creator; enterprise $500/mo min
  ([license](https://www.remotion.dev/docs/license), [pricing](https://www.remotion.pro/license)).
  Budget this; using it commercially unlicensed is the same class of mistake as MMS.
- **"Hyperframes-class" tooling:** **HeyGen HyperFrames** (Apr 2026, **Apache-2.0** ✅) — HTML/CSS/JS
  → deterministic MP4, built for AI agents (Claude Code skills), with Whisper word-timestamp caption
  sync and Kokoro TTS built in ([repo](https://github.com/heygen-com/hyperframes),
  [vs Remotion](https://cutback.video/blog/hyperframes-vs-remotion-vs-selects)). It is the
  free/agent-native alternative to Remotion; philosophy matches your "professor" self-learning
  engine (agents author compositions). Worth a spike — but Remotion's ecosystem + your existing
  MGCS investment wins today.
- **Nexrender/After Effects** (free OSS core; cloud from €99/mo): only if you need designer-authored
  AE templates; adds a Windows/AE render fleet — poor fit for a code-first pipeline.
- **Verdict:** **KEEP Remotion + GSAP**; buy the proper Remotion company license; evaluate
  HyperFrames post-demo as the agent-authoring layer.

## 8. Compositing / render infra

- **Current:** FFmpeg local — correct for now (fast iteration, zero cost). Use an **LGPL build or
  CLI invocation** (you do) — no license issue ✅.
- **At scale:** **Remotion Lambda** — distributed rendering on your AWS, seconds-fast, cost =
  AWS compute (cents per 60s render) + $0.01/render license
  ([cost example](https://www.remotion.dev/docs/lambda/cost-example)). Beats Shotstack/Creatomate
  because your compositions are already Remotion code; SaaS APIs would force template lock-in.
- **Verdict:** KEEP now → Remotion Lambda POST-DEMO when concurrent users exist.

## 9. Music / SFX

- **⚠ LICENSE (loud):** purely AI-generated music (Suno/Udio) is **not copyright-safe**: no
  copyright vests in fully-AI output, Suno's own ToS disclaims it, and the model landscape is
  churning post-Warner settlement (v5.x models to be deprecated in 2026)
  ([Suno rights](https://help.suno.com/en/categories/550145),
  [2026 legal guide](https://terms.law/ai-output-rights/suno/)). Do **not** make generative music
  the platform's default soundtrack source for client deliverables.
- **Top-tier safe pick:** **Epidemic Sound Partner API** — programmatic catalog access built
  exactly for generative-video platforms (auto-soundtrack to pacing), clean worldwide commercial
  license ([developer/partner API](https://www.epidemicsound.com/business/developers/),
  [docs](https://developers.epidemicsite.com/docs/)). Artlist Max Business is the alternative.
- **SFX:** ElevenLabs SFX generation is fine (short, non-musical, paid-tier commercial rights).
- **Verdict:** POST-DEMO (demo can use a manually licensed track).

## 10. Upload / storage / streaming

- **Storage:** **Cloudflare R2** — S3-compatible, **zero egress fees** — ideal for a pipeline that
  moves large video between workers and gen-APIs.
- **Playback:** **Mux** — per-second billing, resolution-based delivery pricing, best-in-class QoE
  analytics; ~$0.0075/min encode, $0.003/min storage, $0.0008–0.0048/min delivery
  ([Mux vs Stream](https://www.mux.com/compare/cloudflare-stream),
  [2026 pricing comparison](https://www.buildmvpfast.com/api-costs/video)). Cloudflare Stream
  ($1/1k min stored, $5/1k min delivered) is simpler/cheaper at small scale but charges 720p like
  4K; Mux's analytics matter for a creator product.
- **Verdict:** POST-DEMO (R2 first — trivial; Mux when users watch in-app).

## 11. Job queue / workers

- **Top pick:** **Trigger.dev** — durable, checkpoint-resume, **no execution time limit**, plain
  TypeScript (no Temporal determinism constraints), ffmpeg/system packages supported — explicitly
  the best fit for long video jobs
  ([vs Temporal](https://trigger.dev/vs/temporal), [vs BullMQ](https://trigger.dev/vs/bullmq),
  [2026 comparison](https://www.buildmvpfast.com/blog/inngest-vs-trigger-dev-vs-bullmq-background-jobs-nextjs-2026)).
  Temporal = the enterprise-grade ceiling if orchestration complexity explodes; Inngest's
  step/HTTP-timeout model is a poor fit for unbroken long renders; BullMQ = cheap but you run
  Redis+workers yourself.
- **Verdict:** POST-DEMO — the demo runs as scripts; productization starts here.

## 12. Copyright / content moderation (uploaded references)

- **Audio fingerprinting:** **ACRCloud** — 150M-track reference DB, developer-friendly volume-tiered
  API (10k/100k/1M request packages) ([ACRCloud](https://www.acrcloud.com/music-recognition/),
  [TechCrunch profile](https://techcrunch.com/2020/08/12/acrcloud-profile/)). **Audible Magic** is
  the enterprise/industry-standard alternative (99.99% ID rate, all major labels) but
  sales-led pricing — choose it when platforms/labels demand it.
- **Visual/NSFW moderation:** Hive Moderation API or Google Video Intelligence explicit-content
  detection on upload.
- **Important framing:** analyzing a reference reel's *style* is likely fine; **re-using its music
  or footage in output is not** — fingerprint uploads and never copy reference audio into renders.
- **Verdict:** POST-DEMO (required before public launch, not before investor demo).

---

## (a) Max-capability stack, one line per layer

Gemini 3 Pro (+TwelveLabs Pegasus for timestamps) · TransNetV2 (MIT) · PaddleOCR 3.0 ·
ElevenLabs Scribe v2 (Uzbek ✅) · Veo 3.1 + Kling 3.0 mixed fleet · ElevenLabs v3 TTS ·
Remotion+GSAP (licensed) with HyperFrames watch · FFmpeg → Remotion Lambda ·
Epidemic Sound Partner API · R2 + Mux · Trigger.dev · ACRCloud + Hive.

## (b) Estimated per-render COGS — 60 s reel, top-tier choices

| Item | Assumption | Cost |
|---|---|---|
| VLM decode (Gemini 3 Pro) | ~3 min video in (ref+raw), ~46k video tokens + text out | ~$0.15–0.40 |
| TwelveLabs Pegasus grounding | 3 min index+query | ~$0.20 |
| STT (Scribe v2) | 2 min audio | ~$0.01 |
| B-roll generation | 5 clips × 8 s: 1× Veo 3.1 Standard ($0.40/s) + 4× Kling 3.0 (~$0.50/clip), incl. ~1.5× critic-loop retries | ~$6–9 |
| Render (Remotion Lambda + license) | 60 s 1080p | ~$0.05–0.15 |
| Music (Epidemic, amortized) | subscription / renders | ~$0.05 |
| Storage/delivery (R2+Mux) | | ~$0.02 |
| **Total** | | **≈ $7–10 per reel** (all-Veo-Standard worst case ≈ $18–25) |

B-roll generation is 85–90% of COGS — routing logic (which shots deserve Veo) is the main
cost lever, not any other component.

## (c) Top 3 quality-per-effort upgrades for the investor demo

1. **Gemini 2.5 Flash → Gemini 3 Pro for Reference Decode** — model-string + prompt-tuning change;
   directly targets the 73.4% style-reproduction score, your headline demo metric.
2. **PySceneDetect → TransNetV2** — MIT, free, drop-in; fixes measured failure on gradual/stylized
   transitions, which is the heart of "clone the editing style."
3. **MMS → ElevenLabs Scribe v2 for word timestamps** — removes the **CC-BY-NC legal blocker**
   (uninvestable-diligence risk) while giving verified Uzbek support at $0.22/hr; small wiring job
   since the fallback was already scoped.

---

## Confidence & gaps

- High confidence: Uzbek support (Scribe/AssemblyAI/no-Deepgram), TransNetV2 MIT + benchmark gap,
  Remotion licensing, Suno copyright risk, TwelveLabs pricing.
- Medium: exact Veo 3.1/Kling per-second rates (third-party aggregators broadly agree; confirm on
  Vertex AI console before budgeting), Higgsfield API-tier ownership terms (read the current ToS).
- Unverified: Eleven v3 Uzbek *quality* (no published metric — ear-test it); AutoShot repo license;
  Epidemic Partner API pricing (sales-led).
