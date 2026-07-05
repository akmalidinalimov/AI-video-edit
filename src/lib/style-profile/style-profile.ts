/**
 * StyleProfile — the ONE canonical, content-free style DNA for StyleClone (B1).
 *
 * This replaces the three legacy schemas:
 *   - src/lib/types/blueprint.ts          (VisualBlueprint)  → becomes a raw CV MEASUREMENT artifact that POPULATES this
 *   - src/lib/gemini/schemas/styleProfile.ts (Pass1-4 zod)  → folds into the engine that EMITS this
 *   - src/lib/types/styleProfile.ts       (legacy TS type)   → superseded by this zod schema
 *
 * Design rules (see docs/B1-SCHEMA-RECONCILIATION.md):
 *  1. CONTENT-FREE. No transcript words, no clip paths. Coordinates are normalized
 *     [0,1] (resolution-independent) so a profile is reusable across any creator footage.
 *  2. CO-DESIGNED WITH THE RENDER CEILING. Every enum below is constrained to what the
 *     Composer + renderer (FFmpeg base + Remotion overlay) can ACTUALLY apply today.
 *     We never measure what we can't reproduce. Render-target mappings are noted as `→`.
 *  3. The Composer expands StyleProfile + ContentPlan → EditingPlan (the render contract).
 *
 * Fields the engine can detect but the renderer cannot yet apply live to the demo
 * (mask feather, ducking curve, speed-ramps, full story_spine, easing curves) live under
 * `frontier` — optional, post-demo (master spec Phase 4). Keeping them optional means a
 * profile validates today and can be enriched later without a breaking version bump.
 */
import { z } from "zod";

export const STYLE_PROFILE_VERSION = "style-profile/2.0" as const;

/* ── shared primitives ───────────────────────────────────────────────── */
const Norm = z.number().min(0).max(1);
const Hex = z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, "hex color #RRGGBB");
const BBoxNorm = z.tuple([Norm, Norm, Norm, Norm]); // [x, y, w, h] normalized, origin top-left
const Vec2Norm = z.tuple([Norm, Norm]);

/* ── 1. PACING [D] → drives EditingPlan layout-range durations ───────────── */
const Pacing = z.object({
  shot_count: z.number().int().nonnegative(),
  asl_s: z.number().nonnegative(), // average shot length
  cuts_per_minute: z.number().nonnegative(),
  shot_lengths_s: z.array(z.number()).default([]), // ordered = the rhythm fingerprint
  pacing_class: z.enum(["slow", "moderate", "fast", "frantic"]),
});

/* ── 2. LAYOUT [H] → EditingPlan.layoutRanges / VCS layouts ──────────────── */
const ARollStyle = z.object({
  shape: z.enum(["circle", "rectangle"]), // → plan-renderer circle-mask | rect
  bbox_norm: BBoxNorm,
  border: z.object({ color: Hex, width_px: z.number().nonnegative() }).nullable().default(null),
  // renderer supports LINEAR position keyframes only (no spring on PIP):
  motion: z.enum(["static", "linear_reposition"]).default("static"),
});
const LayoutPattern = z.object({
  role: z.enum([
    "talking_head", "broll_overlay", "pip", "fullscreen_broll",
    "fullscreen_text", "split_screen", "screen_recording",
  ]),
  aroll: ARollStyle.nullable().default(null),
  broll: z.object({ bbox_norm: BBoxNorm, is_background: z.boolean() }).nullable().default(null),
  weight: Norm, // share of total duration this layout occupies (0..1)
});
const Layout = z.object({
  patterns: z.array(LayoutPattern).min(1),
  // renderer changes layout only at sentence boundaries, hard-cut:
  layout_change: z.literal("sentence_boundary").default("sentence_boundary"),
});

/* ── 3. CAPTIONS [D typography + V animation] → timeline.ts CaptionStyle ──── */
const Captions = z.object({
  present: z.boolean(),
  render_mode: z.enum(["word_by_word", "line_by_line", "chunk", "full_sentence"]),
  animation: z.enum(["word_karaoke", "none"]).default("word_karaoke"), // ceiling: karaoke only
  position_norm: Vec2Norm,
  text_align: z.enum(["center", "left", "right"]).default("center"), // → CaptionStyle.textAlign
  text_transform: z.enum(["none", "uppercase"]).default("none"), // → CaptionStyle.textTransform
  font_class: z.enum(["sans", "serif", "display", "rounded", "script", "mono"]).default("sans"),
  font_weight: z.enum(["normal", "bold"]).default("bold"), // → CaptionStyle.fontWeight (ceiling: only these two)
  font_size_norm: Norm, // fraction of canvas height; Composer → CaptionStyle.fontSize(px)
  fill_color: Hex, // → CaptionStyle.color
  highlight_color: Hex, // → CaptionStyle.highlightColor (active word)
  background_color: Hex.nullable().default(null), // → CaptionStyle.backgroundColor (box)
  padding_px: z.number().nonnegative().default(0),
  border_radius_px: z.number().nonnegative().default(0),
  max_words_per_line: z.number().int().positive().default(4),
});

/* ── 4. TRANSITIONS [D timing + V type] → TransitionWrapper enum ──────────── */
const Transitions = z.object({
  // ceiling: only these render; easing is fixed (ease-out-cubic) so it is NOT a field
  dominant: z
    .array(z.enum(["hard_cut", "fade", "dissolve", "slide_left", "slide_right", "slide_up", "zoom"]))
    .default(["hard_cut"]),
  hard_cut_pct: Norm.default(1),
  default_duration_frames: z.number().int().nonnegative().default(0),
});

/* ── 5. MOTION GRAPHICS [H] → src/remotion/motion registry (MGCS) ─────────── */
const MotionGraphics = z.object({
  uses: z.boolean().default(false),
  elements: z
    .array(
      z.object({
        component_id: z.string(), // registry id, e.g. "data-viz/bar-chart" | "caption/kinetic" | "lower-third/standard"
        style_variant: z
          .enum(["glass", "dark", "paper", "warm", "forbidden", "profile"])
          .default("profile"),
        placement_norm: BBoxNorm,
      }),
    )
    .default([]),
  anim_personality: z.enum(["snappy", "smooth", "bouncy", "mechanical"]).default("smooth"),
});

/* ── 6. COLOR [D] → ColorGrade (global, CSS-filter ceiling) ──────────────── */
const Color = z.object({
  brightness: z.number().positive().default(1),
  saturation: z.number().nonnegative().default(1),
  contrast: z.number().positive().default(1),
  temperature: z.enum(["warm", "neutral", "cool"]).default("neutral"),
  dominant_palette: z.array(Hex).max(8).default([]),
  look_name: z.string().default("neutral"),
});

/* ── 7. AUDIO [D analyze / V label] → AudioMixer + SFXLayer ───────────────── */
const Audio = z.object({
  music: z.object({
    present: z.boolean(),
    genre: z.string().default(""),
    mood: z.string().default(""),
    tempo_bpm: z.number().nullable().default(null),
    energy: z.enum(["low", "medium", "high"]).default("medium"),
  }),
  ducking: z.object({ enabled: z.boolean(), depth_db: z.number().nullable().default(null) }),
  sfx: z.object({
    density_per_min: z.number().nonnegative().default(0),
    // renderer SFX library ids (SFXLayer.tsx fixed set):
    palette: z
      .array(z.enum(["whoosh_soft", "whoosh_hard", "pop", "ding", "click", "swoosh", "rise"]))
      .default([]),
  }),
});

/* ── 8. NARRATIVE [V] — content-free; lightweight in v1, expands in frontier ─ */
const Narrative = z.object({
  structure_class: z
    .enum(["hook_body_cta", "listicle", "story_arc", "tutorial", "reaction", "explainer"])
    .default("hook_body_cta"),
  hook_type: z
    .enum([
      "bold_statement", "question", "pattern_interrupt", "proof_first",
      "curiosity_gap", "negativity", "callout_you", "none",
    ])
    .default("none"),
  hook_t_norm_end: Norm.default(0), // measured boundary (0..1 of duration), not a guess
  cta: z.object({
    present: z.boolean(),
    type: z
      .enum(["follow", "comment", "save", "share", "link", "subscribe", "watch_next", "none"])
      .default("none"),
  }),
  // per-beat B-roll role — drives the Context-Aware Resource Planner (master spec §7.1):
  broll_role: z
    .enum([
      "literal_illustration", "metaphor", "cover_jumpcut", "establishing",
      "ui_demo", "screen_recording", "none",
    ])
    .default("none"),
});

/* ── FRONTIER (optional, post-demo — engine can detect, renderer can't yet apply) ─ */
const Frontier = z
  .object({
    mask_feather_px: z.number().optional(),
    ducking_curve: z.object({ attack_ms: z.number(), release_ms: z.number() }).optional(),
    speed_ramps: z.array(z.object({ t_norm: Vec2Norm, rate: z.number() })).optional(),
    story_spine: z.array(z.record(z.unknown())).optional(), // full beat sequence (engine spec §0.5)
    transition_easing: z.string().optional(), // only if the renderer becomes pluggable
  })
  .partial()
  .optional();

/* ── THE SCHEMA ──────────────────────────────────────────────────────────── */
export const StyleProfileSchema = z.object({
  schema_version: z.literal(STYLE_PROFILE_VERSION),
  reference_meta: z.object({
    duration_s: z.number().positive(),
    fps: z.number().positive().default(30),
    resolution: z.tuple([z.number(), z.number()]).default([1080, 1920]),
    aspect_ratio: z.enum(["9:16", "16:9", "1:1", "4:5"]).default("9:16"),
  }),
  pacing: Pacing,
  layout: Layout,
  captions: Captions,
  transitions: Transitions,
  motion_graphics: MotionGraphics,
  color: Color,
  audio: Audio,
  narrative: Narrative,
  frontier: Frontier,
});

export type StyleProfile = z.infer<typeof StyleProfileSchema>;

/** Validate unknown input (e.g. an engine/LLM result) into a StyleProfile. */
export function parseStyleProfile(input: unknown): StyleProfile {
  return StyleProfileSchema.parse(input);
}
export function safeParseStyleProfile(input: unknown) {
  return StyleProfileSchema.safeParse(input);
}
