/**
 * Motion-Graphics Component System — core types.
 * A component = id + category + status + typed schema + Render + a valid sample
 * + its dedicated specialist. Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2.2
 */
import type React from "react";
import type { z } from "zod";
import type { MGBaseInput } from "./contract";

/** Mirrors StyleProfile.motion_graphics.graphic_type (engine spec §3). */
export type GraphicType =
  | "counter"
  | "bar_chart"
  | "donut"
  | "progress_bar"
  | "comparison"
  | "kinetic_caption"
  | "lower_third"
  | "callout"
  | "emphasis"
  | "stat_grid"
  | "timeline"
  | "leaderboard"
  | "logo"
  | "media";

/** Only `production` components are eligible for auto-use by the Composer. */
export type ComponentStatus = "draft" | "gated" | "production";

export interface MotionComponent<I extends MGBaseInput = MGBaseInput> {
  /** stable id, e.g. "data-viz/bar-chart" */
  id: string;
  category: GraphicType;
  status: ComponentStatus;
  /** the typed input contract — validated before render */
  inputSchema: z.ZodType<I>;
  /** the Remotion component (rendered code, not realtime) */
  Render: React.FC<{ input: I }>;
  /** a valid, illustrative sample input (used for previews + golden renders) */
  defaults: () => I;
  /** the dedicated super-specialist that authors/extends this component */
  specialistId: string;
  /** reference frames/clips this graphic should resemble (grows via learning) */
  exemplars: string[];
}
