/**
 * Motion-Graphics Component System — input contracts.
 *
 * Every motion component is driven by a TYPED contract (zod). The base contract
 * carries the GOAL (`intent`), the style variant, placement, timing and palette.
 * Per-type components extend it with their content payload (data / text / media).
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2.3
 */
import { z } from "zod";

export const Hex = z
  .string()
  .regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, "must be a hex color like #RRGGBB");

export const Vec2 = z.tuple([z.number(), z.number()]);
export const Vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const AnchorEnum = z.enum([
  "top_left", "top_center", "top_right",
  "center_left", "center", "center_right",
  "bottom_left", "bottom_center", "bottom_right",
]);
export type Anchor = z.infer<typeof AnchorEnum>;

export const EasingEnum = z.enum([
  "linear", "ease_in", "ease_out", "ease_in_out", "back", "elastic", "bounce", "spring", "steps",
]);
export type Easing = z.infer<typeof EasingEnum>;

export const SpringName = z.enum(["smooth", "snappy", "gentle", "bouncy", "glass"]);
export type SpringName = z.infer<typeof SpringName>;

export const StyleFamily = z.enum(["glass", "dark", "paper", "warm", "forbidden", "profile"]);
export type StyleFamily = z.infer<typeof StyleFamily>;

/** A single enter/emphasis/exit animation directive (component-interpreted). */
export const AnimSpec = z.object({
  type: z.string().default("fade"),
  duration_ms: z.number().nonnegative().default(300),
  easing: EasingEnum.default("ease_out"),
});
export type AnimSpec = z.infer<typeof AnimSpec>;

/**
 * Tokens injected when `style.family === "profile"` — pulled from the live
 * StyleProfile so one component renders in any cloned style. All optional;
 * the token resolver fills gaps from a neutral default.
 */
export const StyleTokens = z
  .object({
    bg: Hex,
    surface: Hex,
    text: Hex,
    text_muted: Hex,
    accent: Hex,
    palette: z.array(Hex).min(1),
    font_family: z.string(),
    spring: SpringName,
  })
  .partial();
export type StyleTokens = z.infer<typeof StyleTokens>;

export const StyleRef = z.object({
  family: StyleFamily.default("profile"),
  /** present when family === "profile" */
  tokens: StyleTokens.optional(),
});
export type StyleRef = z.infer<typeof StyleRef>;

/** The base every motion component receives — it always KNOWS this much. */
export const MGBaseInput = z.object({
  /** THE GOAL: what this graphic must communicate, e.g. "show 3× revenue growth". */
  intent: z.string().min(1),
  style: StyleRef.default({ family: "profile" }),
  placement: z
    .object({
      /** normalized [x, y, w, h] in 0..1, origin top-left (matches StyleProfile). */
      bbox_norm: Vec4.default([0.1, 0.34, 0.8, 0.32]),
      anchor: AnchorEnum.default("center"),
      z_order: z.number().int().default(2),
    })
    .default({}),
  timing: z
    .object({
      /** [start, end] in seconds. */
      time_range: Vec2.default([0, 3]),
      enter: AnimSpec.default({ type: "fade", duration_ms: 350, easing: "ease_out" }),
      emphasis: AnimSpec.optional(),
      exit: AnimSpec.default({ type: "fade", duration_ms: 300, easing: "ease_in" }),
      easing: EasingEnum.default("ease_out"),
      beat_lock: z.boolean().default(false),
    })
    .default({}),
  palette: z.array(Hex).max(6).default([]),
  reduceMotion: z.boolean().default(false),
});
export type MGBaseInput = z.infer<typeof MGBaseInput>;
