/**
 * broll-critic.ts — STEP 4 quality gates for generated B-roll.
 *
 * Two adversarial critics that bracket generation:
 *   critiquePrompt  — BEFORE generation: catch over-prompting / geometry / wrong length /
 *                     off-style, and return a corrected prompt. Cheap insurance.
 *   critiqueVideo   — AFTER generation: watch the clip (Gemini vision) and catch the
 *                     failures a prompt can't prevent — flipped/floating objects, warped
 *                     faces, gibberish text, off-concept — and decide whether to re-roll.
 *
 * Both take an INJECTED model call so the logic is deterministically testable; the route
 * wires Gemini. The discipline comes from broll-prompt-schema (one source of truth).
 */
import { PROMPT_DISCIPLINE } from "./broll-prompt-schema";

/** Text model call: instruction → JSON string. (Same shape as the prompt engine's.) */
export type TextLLM = (instruction: string) => Promise<string>;
/** Vision call: a video path + a question → JSON string. */
export type VisionLLM = (clipPath: string, question: string) => Promise<string>;

export interface PromptVerdict { approved: boolean; issues: string[]; revised?: string }
export interface VideoVerdict { approved: boolean; issues: string[]; severity: "ok" | "minor" | "reroll" }

function parseJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim()); } catch { return {}; }
}

export function buildPromptCritique(prompt: string): string {
  return [
    `You are a STRICT critic for Kling 3.0 text-to-video B-roll prompts. Enforce these rules:`,
    ...PROMPT_DISCIPLINE.map((r) => `- ${r}`),
    ``,
    `Critique this prompt:`,
    `"${prompt}"`,
    ``,
    `Flag any: over-prompting, object geometry/orientation, forced on-screen text, two+ camera moves or actions, word count outside ~25–70, or off-style. If it breaks ANY rule, set approved=false and provide a corrected LIGHT prompt.`,
    `Return ONLY JSON: {"approved": boolean, "issues": string[], "revised": string}  (revised = "" when approved).`,
  ].join("\n");
}

export async function critiquePrompt(prompt: string, callLLM: TextLLM): Promise<PromptVerdict> {
  const o = parseJson(await callLLM(buildPromptCritique(prompt)));
  const revised = String(o.revised ?? "").trim();
  return {
    approved: o.approved === true,
    issues: Array.isArray(o.issues) ? o.issues.map(String) : [],
    revised: revised && revised !== prompt ? revised : undefined,
  };
}

export interface VideoCritiqueCtx { concept: string; keyword?: string; style?: string; durationSec?: number }

export function buildVideoCritique(ctx: VideoCritiqueCtx): string {
  return [
    `Watch this ${ctx.durationSec ?? 4}s vertical B-roll clip and judge it as a video editor.`,
    `It is meant to show: ${ctx.concept}${ctx.keyword ? ` (emphasising "${ctx.keyword}")` : ""}, in a ${ctx.style ?? "realistic_person"} style.`,
    `Check, in order:`,
    `1) Does it broadly match that concept?`,
    `2) ARTIFACTS — flipped / floating / duplicated objects, warped or morphing faces, extra limbs or fingers, gibberish on-screen text, unnatural motion.`,
    `3) Is it on-style (believable, not glossy stock)?`,
    `Return ONLY JSON: {"approved": boolean, "issues": string[], "severity": "ok" | "minor" | "reroll"}.`,
    `Use severity "reroll" ONLY for a clear, visible defect (e.g. a flipped/floating device, warped face) that a viewer would notice; "minor" for small imperfections; "ok" if clean.`,
  ].join("\n");
}

export async function critiqueVideo(clipPath: string, ctx: VideoCritiqueCtx, vision: VisionLLM): Promise<VideoVerdict> {
  const o = parseJson(await vision(clipPath, buildVideoCritique(ctx)));
  const severity = o.severity === "reroll" || o.severity === "minor" || o.severity === "ok" ? o.severity : "minor";
  return {
    approved: o.approved === true && severity !== "reroll",
    issues: Array.isArray(o.issues) ? o.issues.map(String) : [],
    severity,
  };
}
