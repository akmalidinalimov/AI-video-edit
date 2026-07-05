/**
 * broll-prompt-schema.ts — the COMPONENT structure for a B-roll video-gen prompt.
 *
 * Lesson learned the hard way: over-specifying GEOMETRY ("screen upright above the
 * keyboard, facing him, keyboard deck toward the viewer") CONFUSES the model and
 * produces floating/flipped objects. But that is NOT the same as rich cinematography.
 * Research-backed split (Kling 3.0, 2026):
 *   SPEND words on  → camera move (with speed), lighting, shot type/framing — Kling's strengths.
 *   KEEP minimal    → subject attributes (2 details), environment (3-5 elements).
 *   NEVER describe  → object geometry, legible on-screen text, 2+ moves/actions, 3+ faces.
 * Sweet spot for a 3-5s clip: ~45-60 words. Under 30 = random; over ~100 = the model drifts.
 *
 * One prompt, assembled in director order, each component one clear natural line.
 */

export interface PromptComponents {
  /** the ONE main subject/focus — natural, ≤2 distinctive details, no nationality, no geometry */
  subject: string;
  /** ONE concrete physical action the model can do in 3-5s (motion-first) */
  action: string;
  /** the place in 3-5 concrete elements + a touch of environmental motion for life */
  setting: string;
  /** the light: source, quality, time of day, shadows — Kling treats light as "the soul", spend here */
  lighting: string;
  /** the camera: angle + framing + exactly ONE movement WITH SPEED — Kling's #1 strength */
  camera: string;
  /** the look: mood, color/grade, realism level (matched to the reference B-roll style) */
  style: string;
}

/** Director order (research-backed): camera leads, then subject → action → world → light → look. */
export const COMPONENT_ORDER: (keyof PromptComponents)[] = [
  "camera",
  "subject",
  "action",
  "setting",
  "lighting",
  "style",
];

export const COMPONENT_GUIDE: Record<keyof PromptComponents, string> = {
  subject: "ONE subject with at most TWO distinctive details (a young woman in a casual blazer, warm smile). Keep casting open — no nationality unless needed. Never object geometry; more than ~2 attributes degrades output.",
  action: "ONE concrete physical beat for 3-5s (she looks at her phone and her face lights up). Not a chain of micro-actions — multiple beats compress into mush.",
  setting: "The place in 3-5 concrete elements (a sunlit café balcony, city blurred behind, leaves stirring in the breeze). A little environmental motion adds life; keep props minimal — clutter / extra devices cause artifacts.",
  lighting: "Light source + quality + time of day + natural shadows. HIGH-VALUE — Kling treats light as the soul: soft golden-hour window light, gentle rim light, volumetric glow.",
  camera: "Angle + framing + exactly ONE move WITH SPEED (eye-level medium close-up, slow push-in). HIGH-VALUE and Kling's strength — always specify; NEVER two moves (causes drift).",
  style: "Mood + grade + realism, matched to the reference (cinematic, shallow depth of field, natural skin, documentary feel, not glossy stock).",
};

/** Hard discipline — the anti-over-prompting rules the writer + critic enforce. */
export const PROMPT_DISCIPLINE = [
  "ONE subject, ONE action, ONE camera move — never stack more (2+ moves/actions = drift / compressed mush).",
  "SPEND words on the high-value components: camera move (with speed), lighting, shot type/framing — what Kling does best.",
  "Describe naturally; NEVER object geometry (no 'screen above keyboard facing him') — it fights the model's physics and warps.",
  "Never force on-screen text/content legible — Kling renders text as gibberish; do any screen content in post.",
  "Cap it: ≤2 subject details, 3-5 environment elements, a single device. More attributes = competing-demand degradation.",
  "Target ~45-60 words (sweet spot for a 3-5s clip). Under 30 = random; over ~100 = diluted. On a bad render, RE-ROLL a seed — don't add constraints.",
  "Avoid 3+ people / multiple faces (morphing). Keep any group shot WIDE so faces stay small; for a face that must stay consistent use image-to-video, not text.",
];

/** Negative prompt — 5-8 terms, most critical first, positive-phrased (NOT "no robots"). Anatomy/stability, not generic 'quality'. */
export const NEGATIVE_PROMPT = "distorted face, warped hands, extra limbs, morphing, plastic skin, blurry, flicker";
/** For wide group shots — lead with the multi-face failure mode. */
export const NEGATIVE_PROMPT_GROUP = "morphing faces, distorted faces, extra limbs, warped hands, plastic skin, blur";

/** Assemble the components into one director-order prompt (clean prose, no labels/JSON). */
export function assemblePrompt(c: PromptComponents): string {
  return COMPONENT_ORDER.map((k) => (c[k] ?? "").trim())
    .filter(Boolean)
    .join(". ")
    .replace(/\.\.+/g, ".")
    .replace(/\s+/g, " ")
    .trim() + ".";
}

/** Word-count guard. Sweet spot ~45-60; 70 is the hard ceiling before dilution. */
export function isLight(prompt: string, max = 70): boolean {
  const n = prompt.split(/\s+/).filter(Boolean).length;
  return n >= 25 && n <= max;
}
