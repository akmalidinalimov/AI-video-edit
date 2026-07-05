/**
 * broll-prompt-engine.ts — STEP 3 of the deliberate B-roll pipeline.
 *
 * The UNIVERSAL, MODULAR prompt generator. Given a planned footage slot (its concept,
 * the keyword to highlight, the reference style, the duration) it produces ONE light,
 * on-style, Kling-ready prompt — by filling the 6 cinematographic components via an LLM
 * and assembling them through the schema's discipline. This is what makes B-roll work
 * for ANY A-roll with NO user-supplied clip: analyse context → compose the shot.
 *
 * The LLM call is INJECTED (callLLM) so the assembly + discipline are deterministically
 * testable, and the real wiring uses Gemini. assemblePrompt + the negative-prompt choice
 * + the light-guard all come from broll-prompt-schema (one source of truth).
 */
import {
  type PromptComponents,
  COMPONENT_ORDER,
  COMPONENT_GUIDE,
  PROMPT_DISCIPLINE,
  NEGATIVE_PROMPT,
  NEGATIVE_PROMPT_GROUP,
  assemblePrompt,
  isLight,
} from "./broll-prompt-schema";
import { type CreativeAngle, angleDirection, assignAngles } from "./broll-diversity";
import { getStyle, defaultStyleFor, composeStyleKeywords } from "./style-library";
import type { FramingSpec } from "./broll-framing";

export interface GenBrollPromptInput {
  concept: string;          // from the slot — WHAT to show
  keyword?: string;         // the spoken keyword to emphasise
  beatText?: string;        // the narration line (context)
  style?: string;           // a style-library id (e.g. "naturalistic_handheld") OR a reference class (e.g. "realistic_person")
  styleModifier?: string;   // optional grade modifier id (e.g. "golden_warm", "mono_bw")
  durationSec?: number;     // 3–5s
  angle?: CreativeAngle;    // diversity direction (distinct subject/action/setting/framing)
  framing?: FramingSpec;    // region-fit framing (overrides composition so the head isn't cropped)
}

export interface GenBrollPromptResult {
  components: PromptComponents;
  prompt: string;
  negative: string;
  wordCount: number;
  light: boolean;           // passes the schema's word-count guard
}

/** A pluggable LLM call: takes an instruction, returns JSON text with the 6 components. */
export type ComponentLLM = (instruction: string) => Promise<string>;

/** Build the LLM instruction from the schema discipline + the slot context. Pure + testable. */
export function buildComponentInstruction(input: GenBrollPromptInput): string {
  // resolve a style-library entry from either a library id or a reference classification
  const style = getStyle(input.style ?? "") ?? defaultStyleFor(input.style);
  const styleKeywords = composeStyleKeywords(style.id, input.styleModifier);
  const dur = input.durationSec ?? 4;
  const components = COMPONENT_ORDER.map((k) => `- ${k}: ${COMPONENT_GUIDE[k]}`).join("\n");
  return [
    `You are a B-roll director writing ONE text-to-video prompt for Kling 3.0 (9:16, ${dur}s).`,
    `STYLE: ${style.name} — weave in these style keywords: ${styleKeywords}`,
    ``,
    `CONTEXT (the narration this B-roll plays under): "${input.beatText ?? input.concept}"`,
    `CONCEPT (what this shot should show): ${input.concept}`,
    input.keyword ? `EMPHASISE the idea of: "${input.keyword}"` : ``,
    input.angle
      ? `VISUAL DIRECTION for THIS shot (make it visibly DISTINCT from other shots): ${angleDirection(input.angle)}. Honour this subject/action/setting, and do NOT default to a person typing at a laptop.`
      : ``,
    input.framing ? input.framing.direction : ``,
    ``,
    `Fill these 6 components, ONE short natural line each — no labels in the values:`,
    components,
    ``,
    `HARD RULES:`,
    ...PROMPT_DISCIPLINE.map((r) => `- ${r}`),
    ``,
    `Return ONLY JSON: {"camera":"","subject":"","action":"","setting":"","lighting":"","style":""}`,
  ].filter(Boolean).join("\n");
}

/** Assemble validated components → final prompt + negative + light-guard. Pure + testable. */
export function assembleFromComponents(components: PromptComponents, opts?: { group?: boolean }): GenBrollPromptResult {
  const prompt = assemblePrompt(components);
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const group = opts?.group ||
    /\b(group|crowd|people|team|family|together)\b/i.test(`${components.subject} ${components.action}`);
  return {
    components,
    prompt,
    negative: group ? NEGATIVE_PROMPT_GROUP : NEGATIVE_PROMPT,
    wordCount,
    light: isLight(prompt),
  };
}

function parseComponents(raw: string): PromptComponents {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const obj = JSON.parse(cleaned);
  const pick = (k: keyof PromptComponents) => String(obj[k] ?? "").trim();
  return {
    camera: pick("camera"), subject: pick("subject"), action: pick("action"),
    setting: pick("setting"), lighting: pick("lighting"), style: pick("style"),
  };
}

/** Generate a Kling prompt for a footage slot. callLLM is injected (Gemini in production). */
export async function generateBrollPrompt(input: GenBrollPromptInput, callLLM: ComponentLLM): Promise<GenBrollPromptResult> {
  const instruction = buildComponentInstruction(input);
  const raw = await callLLM(instruction);
  const components = parseComponents(raw);
  return assembleFromComponents(components);
}

/** A minimal slot shape the enricher fills (matches broll-planner's BrollSlot). */
export interface EnrichableSlot {
  modality: string;
  concept: string;
  keyword?: string;
  durationSec: number;
  beatIndex: number;
  prompt?: string;
  negative?: string;
  generateAspect?: string; // region-fit aspect to GENERATE at (from the framing planner)
}

/**
 * Fill every ai_footage slot with a generated Kling prompt (parallel, error-tolerant —
 * a failed slot is simply left without a prompt). Mutates the slots in place.
 */
export async function enrichFootagePrompts(
  slots: EnrichableSlot[],
  callLLM: ComponentLLM,
  opts?: { style?: string; seed?: number; framing?: FramingSpec; beatTextOf?: (beatIndex: number) => string | undefined }
): Promise<number> {
  const footage = slots.filter((s) => s.modality === "ai_footage" && !s.prompt);
  // diversity pass: each footage slot gets a distinct creative angle (no laptop repeats)
  const angles = assignAngles(footage.length, opts?.seed ?? 0);
  let filled = 0;
  await Promise.all(footage.map(async (slot, i) => {
    try {
      const res = await generateBrollPrompt({
        concept: slot.concept,
        keyword: slot.keyword,
        beatText: opts?.beatTextOf?.(slot.beatIndex),
        style: opts?.style,
        durationSec: slot.durationSec,
        angle: angles[i],
        framing: opts?.framing,
      }, callLLM);
      slot.prompt = res.prompt;
      slot.negative = res.negative;
      if (opts?.framing) slot.generateAspect = opts.framing.generateAspect; // region-fit aspect for generation
      filled++;
    } catch { /* leave this slot promptless; non-blocking */ }
  }));
  return filled;
}
