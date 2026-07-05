# Reference Analysis Engine — Spec (the heart of StyleClone)

*The engine that decodes a professionally-edited 9:16 reference into a structured **StyleProfile** detailed enough to reproduce the STYLE (never the content) at 95%+ fidelity. Compiled 2026-06-21 from professional editing/motion/audio decomposition research + the StyleClone audit. Companion to `STARTUP-ROADMAP.md` and `BUILD-PLAN.md`.*

> **▶ How graphics are produced from this profile, and how the engine improves with every reference it studies, is specified in [`MOTION-GRAPHICS-AND-LEARNING-SPEC.md`](MOTION-GRAPHICS-AND-LEARNING-SPEC.md) (v2).** The `motion_graphics` layer below feeds the typed, variant, specialist-authored component registry defined there.

---

## 0. v1.1 — corrected priorities + intake harness + extraction frontier (2026-06-22)

*From a code-level adversarial review + a 6-specialist tool audit. Read this before extending the schema below.*

### 0.1 Prerequisites (don't extend the schema until these are true)
The schema below is sound but currently has **no producer/consumer in the running product** (the live pipeline uses `VisualBlueprint`, not this). Before adding any field:
1. **Collapse to ONE StyleProfile and wire the live pipeline to it** (master spec B1).
2. **Co-design every field with the Composer's expressive ceiling** — never measure what the renderer can't apply (don't store a fitted easing curve if the renderer only emits linear/ease-out/spring). *Fidelity = the weaker of {measure, reproduce}.*
3. **Word times = forced alignment, in-product, incl. Uzbek** (B2 — currently violated; Uzbek aligner broken).
4. **Evaluate output-vs-REFERENCE, not output-vs-profile** (B3 — a faithfully reproduced mis-read scores 100% while looking wrong).

### 0.2 Measurement discipline (enforce per field)
- Tag every field `[D]/[V]/[H]`; the VLM labels among measured params, never invents timing/positions.
- **Multi-frame median** every `[D]` color/geometry read (anti-alias + compression make single-frame noisy); read at the settled (post-animation) state.
- **Build the Uzbek+English benchmark** (caption-OCR + audio-alignment) before committing any model — no vendor publishes Uzbek accuracy.

### 0.3 Frame-sampling intake harness (reuse, don't rebuild)
The `claude-watch` / `claude-video` family (MIT) already solves the intake plumbing — lift it:
- **Duration-aware frame budget** + hard caps (never dump every frame to the VLM).
- **Scene-change frame selection** (`select=gt(scene,…)`) — doubles as a transition-candidate detector.
- **0-10s "hook microscope"** (dense ~2 fps + word-level transcript on the opening) — exactly the granularity short-form hook analysis needs.
- **Sub-agent token isolation** (decode frames in a child context, return only structured text) — ~90% context cut; the right cost architecture for dense per-frame decode.
Keep our **structured layered decode** (the schema below) + CV+Gemini as the moat; these tools are Q&A, not decode-to-spec.

### 0.4 Best-in-class extraction stack (quality-first; verify versions at procurement)
- **VLM labels + narrative:** Gemini (Flash bulk / Pro narrative) — native audio+visual.
- **Masks / regions / element tracking:** SAM-line concept-seg + masklet tracking (SAM/Apache license — verify) + OpenCV geometry.
- **Caption OCR:** Google Cloud Vision (dual-script Uzbek) for geometry + Gemini for labels; font = **style-class first**, never exact-font guesses (repo Rule 10).
- **Transitions/pacing:** TransNetV2 (MIT, soft logits → dissolve duration) + SEA-RAFT (BSD-3, flow → whip/zoom + speed-ramps) + beat-this (MIT, beat+downbeat).
- **Audio:** Demucs (MIT) or AudioShake DME (paid, true SFX/ambience split) + PANNs (Apache) + LAION-CLAP (CC0).
- **AVOID in shipped path:** CoTracker3 (CC-BY-NC), Depth-Anything-V2-Giant (CC-BY-NC), YOLO-World/YOLOE (AGPL), Essentia/madmom *models* (CC-NC), MMS_FA (CC-BY-NC), MusicGen/Suno/Udio.

### 0.5 The extraction frontier (Phase 4 — post-demo; scope to Composer support)
Each is an independent `[D]/[H]` extractor with its own reproducibility test:
1. **Spatial:** general masked-region tracker → mask shape/corner-radius/ring/feather + per-frame bbox trajectory (PIP over time); **blur-mask** (Laplacian variance); **arrow target** ("points-at-X", not just bbox); z-order from occlusion edges; persistent-element (logo) by temporal persistence. *Generalizes off the hard-coded subject (`pip-locator.ts` currently prompts for "hijab/glasses").*
2. **Temporal:** measured transition signatures (replace the pure-VLM type guess); **speed-ramp / `time_remap`** field+detector; motion-graphics element tracking → measured transform keyframes; **easing-curve fit** (overshoot/settle) → `anim_personality` — *only if the renderer consumes it.*
3. **Captions:** frame-diff caption-animation **timing** (don't VLM-guess); split `font_class`/`font_confidence`/`matched_local_font`; caption-vs-title-vs-content **role** classifier.
4. **Audio:** **ducking-CURVE** (depth/attack/release from MX-vs-DX stems) not a boolean; SFX **function + sync-target** + onset tolerance; split `music_fingerprint` (denylist-only) vs `music_descriptor` (act-on); LUFS+dBTP+LRA+VO/music ratio; reproduction guardrail as a hard gate.
5. **Narrative:** replace flat `narrative` with a content-free **`story_spine`** (time-ranged beats, normalized `t_norm` 0-1) + per-beat **`modality_alignment`** (how VO+text+visual+SFX sync = "story conveyance"), via Gemini Pro forced schema on deterministic boundaries; quantified hook (first-3s word count, open-loop→payoff link); retention curve + re-hook cadence; typed CTA; **per-beat B-roll role/type** — incl. `ui_demo`/`screen_recording` vs `literal_illustration`/`metaphor`/`establishing` — so the **Context-Aware Resource Planner** (master spec §7.1) knows whether to CAPTURE a real UI (`reel-capture` + Remotion annotation) or GENERATE a concept (Seedance 2.0). Detecting that the reference *uses* context-specific UI/tutorial B-roll is itself a high-value style signal.

*Production tools that **consume** this profile (Veo 3.1 B-roll, Nano Banana Pro stills, Veo masked editing, Gemini Omni watch-list) live in the master-spec stack — the engine only **reads** the reference.*

---

## 1. Architecture — Style is separated from Content (enforced)

Four artifacts, one rule: **the StyleProfile never carries the reference's words or clips.**

```
Reference video ──▶ [Reference Analysis Engine] ──▶ StyleProfile   (style DNA, content-agnostic, saveable/shareable)
Creator footage ──▶ [Content Analyzer]          ──▶ ContentPlan    (transcript + word-times + what footage shows)
StyleProfile + ContentPlan ──▶ [Resource Planner] ──▶ Storyboard + ResourceList (gaps flagged → AI-generate)
StyleProfile + ContentPlan + Resources ──▶ [Composer] ──▶ EditingPlan ──▶ Render (FFmpeg base + Remotion compositor)
Render vs StyleProfile ──▶ [Style-Fidelity Scorer] ──▶ score per layer ──▶ closed-loop gate (READY when ≥ target)
```

- **StyleProfile** is a versioned, reusable asset — the basis for a future style **library/marketplace** (pick "the Hormozi style", one click).
- **The "95%+" target is a computed Style-Fidelity Score (§5)**, not a vibe. It drives the closed loop and is the ship gate.

---

## 2. Canonical layers (how pros decompose a video)

Every serious "edit-as-data" model (OTIO, EDL/CMX3600, AE/Nuke compositing, Lottie, audio-post stems) converges on the same skeleton, which the StyleProfile mirrors: **time model → asset table → tracks/timeline → per-element style props → metadata.** The eight style layers we decode:

1. Pacing / editorial rhythm 2. Layout & coordinate system 3. Captions / text 4. Transitions 5. Motion graphics / animated elements 6. Color grade 7. Audio bed 8. Narrative / storytelling.

**Measurement discipline (carry-over from the existing CV engine, validated by research):**
- **`[D]` deterministic** (CV/DSP): the numbers — cut times, ASL, positions, colors, caption geometry, beat grid. Frame-accurate, free, reproducible.
- **`[V]` VLM/LLM** (Gemini 2.5 Flash): the labels — transition *type*, animation *type*, hook *type*, "look" name. **Never timing.**
- **`[H]` hybrid:** CV proposes (bbox, cut, color), VLM classifies. **Reproduction error concentrates in `[H]` — invest QA there.**
- Rule of thumb for 95%+: the *measurable* layers (pacing, color, caption typography, layout geometry, transition timing) carry most of the perceived style — nail these numerically; the VLM only selects among measured parameters.

---

## 3. The StyleProfile schema (v1.0)

Coordinates are **normalized [0,1], origin top-left, +Y down** (resolution-independent, matches AE/screen). Caption styles map 1:1 to **ASS** for export; motion graphics mirror **Lottie** transform+keyframe graph; timeline mirrors **OTIO**.

```jsonc
{
  "schema_version": "style-profile/1.0",
  "reference_meta": { "duration_s":0, "fps":30, "resolution":[1080,1920], "aspect_ratio":"9:16",
    "platform_target":"tiktok|reels|shorts|generic", "loudness_lufs":-14.0 },

  "pacing": {                                  // [D] from PySceneDetect/TransNetV2 + audio onset
    "shot_count":0, "asl_s":0, "cuts_per_minute":0,
    "shot_len_distribution":{ "p10":0,"median":0,"p90":0,"stdev":0 },
    "shot_lengths_s":[],                       // ordered = the rhythm fingerprint
    "rhythm":{ "beat_synced":false, "cut_to_beat_alignment_pct":0, "tempo_bpm":null,
               "accelerando":"steady|accelerating|decelerating" },
    "pacing_class":"slow|moderate|fast|frantic" },   // ASL bins: >6s slow, 2-6 mod, <2 fast

  "layout": {
    "coordinate_system":"normalized_0_1",
    "safe_zones":{ "model":"per_platform", "top_norm":0.068,"bottom_norm":0.20,"left_norm":0.055,"right_norm":0.055 },
    // NOTE: safe-zone px are creator-consensus, NOT official — keep configurable per platform.
    "anchor_grid":"9_point",                   // numpad 1-9, like ASS \an
    "regions":[ { "role":"talking_head|broll|split_screen|pip|fullscreen_text|screen_recording",
      "bbox_norm":[0,0,0,0], "anchor":"center", "z_order":1, "active_time_ranges":[[0,0]],
      "subject_framing":"ECU|CU|MCU|MS|WS|EWS" } ],   // [H] CV box, VLM role+framing
    "layout_pattern":"single_th|th_with_broll_overlay|pip_screencast|split_screen|broll_only|text_only" },

  "captions": {                                // typography mostly [D] (OCR+pixel); font family & animation [V]
    "present":true, "render_mode":"word_by_word|line_by_line|chunk|full_sentence",
    "animation":{ "type":"karaoke_highlight|pop|bounce|typewriter|fade|slide|stroke_flash|highlight_sweep|none",
      "per_word_emphasis":"color_swap|scale|highlight_box|bold|underline|none",
      "easing":"ease_out|bounce|spring|linear|steps", "active_word_color":"#RRGGBB", "in_duration_ms":120 },
    "typography":{ "font_family":"", "font_weight":700, "font_size_pt":22,
      "casing":"uppercase|titlecase|sentence|lowercase", "fill_color":"#RRGGBB",
      "stroke":{ "color":"#000000","width_px":4 }, "background_box":{ "enabled":true,"color":"#000000","opacity":0.75 },
      "shadow":{ "color":"#000000","dx":2,"dy":2,"blur":4 } },
    "layout":{ "position_norm":[0.5,0.78], "alignment":2, "max_words_per_line":4, "max_lines":2 },
    "timing":{ "chunk_dwell_ms":2500, "sync":"word_level|phrase_level|none", "reading_speed_wpm":190 } },

  "transitions":[ { "at_s":0,                  // cut time [D]; type [V/H]
    "type":"hard_cut|jump_cut|j_cut|l_cut|match_cut|smash_cut|cutaway|cross_dissolve|fade_in|fade_out|fade_to_black|wipe|whip_pan|zoom_punch_in|iris|morph",
    "duration_frames":0, "direction":"left|right|up|down|in|out|null",
    "audio_lead_lag":"none|j_audio_leads|l_audio_trails" } ],
  "transition_profile":{ "hard_cut_pct":0, "dominant_transitions":["hard_cut","zoom_punch_in"] },

  "motion_graphics":{
    "elements":[ { "graphic_type":"lower_third|callout|arrow|highlight_circle|progress_bar|countdown|emoji|sticker|gif|shape_highlight|kinetic_typography|logo|data_viz",
      "bbox_norm":[0,0,0,0], "z_order":2, "time_range":[0,0], "color":"#RRGGBB",
      "animation":{ "enter":{ "type":"fade|slide|scale|wipe|fly_in|grow|none","easing":"ease_out","duration_ms":300 },
        "emphasis":{ "type":"pulse|spin|bounce|shake|color_flash|none","loop":false },
        "exit":{ "type":"fade|slide|scale|wipe|fly_out|shrink|none","easing":"ease_in","duration_ms":300 },
        "motion_path":{ "type":"none|line|arc|custom","points_norm":[] } } } ],
    "easing_vocabulary_default":"ease_out",    // linear|ease_in|ease_out|ease_in_out|back|elastic|bounce|spring|steps
    "anim_personality":"snappy|smooth|bouncy|mechanical" },

  "color":{                                    // [D] histogram/3D-cube; "look" name [V]
    "wb_temperature":0, "wb_tint":0, "contrast":1.0, "saturation":1.0, "vibrance":0.0,
    "lift_gamma_gain":{ "lift":[0,0,0],"gamma":[1,1,1],"gain":[1,1,1],"offset":[0,0,0] },
    "tonal_curve_summary":{ "black_point":0,"white_point":255,"midpoint_gamma":1.0 },
    "dominant_palette":["#RRGGBB"],
    "look_name":"neutral|teal_orange|warm|cool|vintage_film|high_contrast_cinematic|flat_log|bw",
    "lut_estimated":false, "skin_tone_protection":true },

  "audio":{                                    // analyze on separated stems; reproduce LEGALLY (see §6)
    "stems":[ { "role":"DX|RT|AMB|SFX|FLY|MX","present":true,"rel_level_db":0,"time_ranges":[[0,0]] } ],
    "music":{ "present":true,"tempo_bpm":0,"ducking":true,"genre":"lofi|edm|trap|cinematic|none",
              "mood":"", "energy_curve":[] },
    "sfx_events":[ { "type":"whoosh|ding|impact|whip|riser|transition|generic","at_s":0,"confidence":0 } ],
    "sfx_density_per_min":0, "voiceover_present":true },

  "narrative":{                                // almost entirely [V]
    "hook":{ "present":true,"type":"bold_statement|question|pattern_interrupt|proof_first|curiosity_gap",
      "duration_s":2.5,"modality":["text_overlay","spoken","visual_interrupt"] },
    "structure":"hook→body→cta|listicle|story_arc|tutorial|reaction",
    "retention_tactics":["open_loop","fast_cuts","broll_cover","text_emphasis","progress_indicator"],
    "broll_role":"literal_illustration|metaphor|cover_jumpcut|establishing|none", "cta_present":true }
}
```

---

## 4. Extraction stack (what tool measures each layer)

| Layer | Deterministic `[D]` | VLM `[V]` |
|---|---|---|
| Pacing | PySceneDetect `AdaptiveDetector` + **TransNetV2** (dissolves); ASL/CPM/distribution; beat-sync via `beat-this` cross-corr | pacing "feel" |
| Layout | bbox + face detect (YuNet) + z-order → normalized; reuse existing CV engine | region role, shot framing, layout pattern |
| Captions | scene-text/OCR (**PaddleOCR**): color, stroke, box, size, position, words/line, casing; word sync via forced alignment | font family, animation type, per-word emphasis |
| Transitions | cut times; dissolve duration; optical-flow direction (whip/zoom); J/L via A/V offset | transition type |
| Motion graphics | element bbox, color, time range, z-order | graphic type, animation category, easing personality |
| Color | temp/tint, contrast, saturation, lift/gamma/gain, curves, k-means palette, 3D-LUT fit | look name, LUT identity |
| Audio | Demucs stems → PANNs+librosa SFX onsets, `beat-this` grid, energy curve, ducking | stem role, genre/mood |
| Narrative | hook/CTA timing boundaries | hook type, structure, retention tactics, b-roll role |

---

## 5. Style-Fidelity Score (makes "95%" real)

Per-layer similarity of the **rendered output** vs the **StyleProfile** (NOT vs the reference's content), weighted into one number. Drives the closed loop; ship gate = composite ≥ target (start 0.90, raise toward 0.95).

| Layer | Metric (output vs profile) | Suggested weight |
|---|---|---|
| Layout | region position/size IoU | 0.20 |
| Captions | style-param match (font/size/color/position/animation) | 0.20 |
| Pacing | ASL delta + shot-length-distribution distance + cut-to-beat alignment | 0.15 |
| Color | mean ΔE / histogram distance | 0.15 |
| Transitions | type-match rate + timing tolerance | 0.10 |
| Motion graphics | presence/type/animation match | 0.10 |
| Audio | SFX-density + music energy-curve + ducking match | 0.10 |

Closed loop: render → score → auto-tune the worst layer → re-render → READY only when composite ≥ target AND the hard correctness gates pass (word completeness 100%, crop head-safety, no black frames). Surface the per-layer breakdown to the user (trust + a great side-by-side demo).

---

## 6. Audio: analyze richly, reproduce LEGALLY

**Analyze** (license-clean stack — all MIT/Apache/ISC): Demucs `htdemucs_ft` separation → inaSpeechSegmenter (music-present timeline) → **PANNs `Cnn14_DecisionLevelMax`** (~10ms class probs) ∩ **librosa `onset_detect(backtrack=True)`** for sample-accurate SFX onsets (risers have no class → energy-envelope slope) → **`beat-this`** beat/downbeat grid + librosa energy curve. Optionally fingerprint (AudD) only to **log/denylist** what the music is — never to copy.

**Reproduce (the architecture-defining rule):** copyright protects the *specific expression* (this recording, this melody, this recorded SFX) but **NOT the idea/style** (genre, tempo, mood, energy, instrumentation). So: **characterize the style → then license-or-generate the actual sound; never reproduce the identified exact track/SFX.**
- Match from licensed libraries via API (**Storyblocks** — audio+SFX, transparent API; Epidemic/Artlist/Soundstripe) filtered by genre/mood/BPM/key, OR
- Generate (**ElevenLabs Music + SFX**, **Mubert** with end-user sublicensing, Stable Audio) prompted from the style profile.
- **Guardrail:** run generated/selected music back through fingerprint + melodic-similarity; reject anything recognizably close to a specific source.
- **Avoid (non-commercial traps):** Essentia *models* (CC-NC), madmom *models* (CC-NC), Meta MusicGen/AudioGen weights (CC-BY-NC), Suno/Udio (no safe API). *Not legal advice — have IP counsel review before launch.*

---

## 7. Language & transcription (Uzbek + English first)

Per-word (and per-character) timestamps are required — b-roll/caption decisions depend on exactly which word is spoken when.
- **English:** WhisperX (BSD-2) default wav2vec2, or ElevenLabs Scribe.
- **Uzbek (primary, managed):** **ElevenLabs Scribe v2** — only API with **word *and* character** timestamps, Uzbek supported, commercial (~$0.22/hr). Char-level unlocks per-letter caption animations.
- **Uzbek (fallback):** Azure Speech `uz-UZ` (word timestamps via language-independent flag).
- **Uzbek (precision core, commercially clean, self-host):** **WhisperX + `lucio/xls-r-uzbek-cv8` (Apache-2.0)** as `--align_model`; fine-tunable on our own data later. **This also replaces the non-commercial MMS aligner** currently in the repo (one fix, two problems).
- ⚠️ No vendor publishes Uzbek accuracy → **build a small Uzbek+English benchmark set from real footage in week 1** and measure before committing.

---

## 8. Prior art to mirror (don't reinvent the data model)
- **OTIO** for the timeline backbone (Timeline→Stack→Track→Clip/Gap/Transition; per-object metadata for our extensions; EDL/FCPXML adapters).
- **Lottie JSON** for the motion-graphics + caption-animation model (layer types, transform a/p/s/r/o, bezier-eased keyframes).
- **ASS** as the expressive caption-style export target (23 style fields + `\k` karaoke + `\t`/`\move`/`\fad`).
- **Leake et al., Computational Video Editing (SIGGRAPH 2017)** — editing *style* as composable idioms (HMM over framing/sentiment); the model for making our `narrative`/`pacing` rules composable, not flat.
