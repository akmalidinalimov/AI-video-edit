/**
 * broll-generation.ts — STEP 4 orchestrator: prompt-critic → generate → video-critic → re-roll.
 *
 * Turns a planned footage slot's prompt into an APPROVED clip. The actual generator
 * (Higgsfield/Kling) and both critics are INJECTED, so the control flow is deterministically
 * testable and credit-free in tests; production wires the Higgsfield MCP + Gemini. Generation
 * is the only credit-spending step, so the caller gates it.
 *
 * Per slot:
 *   1. prompt gate — critique the prompt; use the corrected version if rejected.
 *   2. up to maxAttempts: generate (new seed each time) → video gate → stop on approval.
 *   3. on exhaustion, keep the best effort but mark it for human review.
 */
import type { PromptVerdict, VideoVerdict, VideoCritiqueCtx } from "./broll-critic";

export interface GenSlot {
  id: string;
  prompt?: string;
  negative?: string;
  concept: string;
  keyword?: string;
  durationSec: number;
}

export interface GeneratedClip { path: string; meta?: Record<string, unknown> }

export interface GenerationDeps {
  critiquePrompt: (prompt: string) => Promise<PromptVerdict>;
  /** the credit-spending call — Higgsfield/Kling in production */
  generateClip: (prompt: string, opts: { seed: number; durationSec: number; negative?: string }) => Promise<GeneratedClip | null>;
  critiqueVideo: (clipPath: string, ctx: VideoCritiqueCtx) => Promise<VideoVerdict>;
}

export type SlotStatus = "approved" | "exhausted" | "no_prompt" | "gen_failed";

export interface SlotGenResult {
  slotId: string;
  status: SlotStatus;
  clipPath?: string;
  promptUsed: string;
  promptIssues: string[];
  attempts: number;
  verdict?: VideoVerdict;
}

export async function generateBrollForSlot(
  slot: GenSlot,
  deps: GenerationDeps,
  opts?: { maxAttempts?: number; style?: string }
): Promise<SlotGenResult> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 2);
  if (!slot.prompt) return { slotId: slot.id, status: "no_prompt", promptUsed: "", promptIssues: [], attempts: 0 };

  // 1. prompt gate
  const pc = await deps.critiquePrompt(slot.prompt);
  const promptUsed = pc.approved ? slot.prompt : (pc.revised ?? slot.prompt);

  // 2. generate + video gate + re-roll
  let lastClip: GeneratedClip | null = null;
  let lastVerdict: VideoVerdict | undefined;
  let attempts = 0;
  for (let seed = 1; seed <= maxAttempts; seed++) {
    attempts = seed;
    const clip = await deps.generateClip(promptUsed, { seed, durationSec: slot.durationSec, negative: slot.negative });
    if (!clip) continue; // generation failed this attempt; try the next seed
    lastClip = clip;
    const verdict = await deps.critiqueVideo(clip.path, { concept: slot.concept, keyword: slot.keyword, style: opts?.style, durationSec: slot.durationSec });
    lastVerdict = verdict;
    if (verdict.approved) {
      return { slotId: slot.id, status: "approved", clipPath: clip.path, promptUsed, promptIssues: pc.issues, attempts, verdict };
    }
    // else: re-roll on a fresh seed
  }

  if (!lastClip) return { slotId: slot.id, status: "gen_failed", promptUsed, promptIssues: pc.issues, attempts };
  // best effort kept, flagged for review
  return { slotId: slot.id, status: "exhausted", clipPath: lastClip.path, promptUsed, promptIssues: pc.issues, attempts, verdict: lastVerdict };
}

/** Generate clips for many slots SEQUENTIALLY (generation is serial + credit-spending). */
export async function generateBrollForSlots(
  slots: GenSlot[],
  deps: GenerationDeps,
  opts?: { maxAttempts?: number; style?: string }
): Promise<SlotGenResult[]> {
  const out: SlotGenResult[] = [];
  for (const slot of slots) out.push(await generateBrollForSlot(slot, deps, opts));
  return out;
}
