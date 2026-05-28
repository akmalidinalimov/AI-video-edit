/**
 * Narrative Analyzer — Content-Aware Intelligence Layer
 *
 * This module provides deep content understanding by analyzing ALL A-roll
 * transcriptions and ALL B-roll scene summaries together in a single Gemini
 * call. The result is a NarrativeContext that maps each sentence to the most
 * relevant B-roll scenes with reasoning.
 *
 * WHY THIS EXISTS:
 * The previous approach used shallow string overlap (computeSemanticAffinity)
 * to match B-roll to sentences. This works for obvious cases ("app_demo" tag
 * on both sentence and B-roll scene) but fails when:
 * - The sentence talks about a PROBLEM and the B-roll shows the SOLUTION
 * - The sentence is a transition phrase and needs contextual B-roll
 * - Multiple B-roll sources exist and the best one isn't the one with
 *   the most tag overlap but the one that VISUALLY supports the narrative
 *
 * The narrative analyzer understands the STORY being told and matches
 * B-roll based on narrative purpose, not just keyword overlap.
 *
 * USAGE:
 * Called once before plan building, after all transcriptions and B-roll
 * analyses are complete. The result is passed to buildEditingPlan() as
 * the `narrativeContext` field.
 */

import { geminiFlash } from "@/lib/gemini/client";
import type { NarrativeContext, BRollScene } from "./plan-builder";

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface ArollClipSummary {
  /** Index of this clip in the upload sequence */
  clipIndex: number;
  /** Full transcription text */
  fullText: string;
  /** Sentences with indices (global across all clips) */
  sentences: Array<{
    globalIndex: number;
    text: string;
    semanticTags?: string[];
  }>;
}

export interface BrollSceneSummary {
  /** Global scene index (across all B-roll sources) */
  sceneIndex: number;
  /** Which B-roll source this came from */
  sourceIndex: number;
  /** Content tags from frame analysis */
  contentTags: string[];
  /** Human-readable description */
  description: string;
  /** Duration of this scene */
  duration: number;
}

// ════════════════════════════════════════════════════════════
// NARRATIVE ANALYSIS
// ════════════════════════════════════════════════════════════

/**
 * Analyze the narrative structure across all A-roll and B-roll content.
 *
 * Makes a single Gemini Flash call that:
 * 1. Understands the overall story/topic being communicated
 * 2. Identifies narrative phases (hook, problem, solution, demo, CTA, etc.)
 * 3. For each sentence, ranks which B-roll scenes are most relevant and WHY
 *
 * @param arollClips - Summaries of all A-roll transcriptions in sequence order
 * @param brollScenes - Summaries of all B-roll scenes from all sources
 * @returns NarrativeContext with relevance map
 */
export async function analyzeNarrativeContext(
  arollClips: ArollClipSummary[],
  brollScenes: BrollSceneSummary[]
): Promise<NarrativeContext> {
  // Build the prompt with all available data
  const arollSection = arollClips.map((clip) => {
    const sentenceList = clip.sentences
      .map((s) => `  [S${s.globalIndex}] "${s.text}"${s.semanticTags?.length ? ` (tags: ${s.semanticTags.join(", ")})` : ""}`)
      .join("\n");
    return `--- A-roll Clip #${clip.clipIndex + 1} ---\n${clip.fullText}\n\nSentences:\n${sentenceList}`;
  }).join("\n\n");

  const brollSection = brollScenes.map((scene) =>
    `  [B${scene.sceneIndex}] Source #${scene.sourceIndex + 1} | ${scene.duration.toFixed(1)}s | Tags: [${scene.contentTags.join(", ")}] | "${scene.description}"`
  ).join("\n");

  const totalSentences = arollClips.reduce((sum, c) => sum + c.sentences.length, 0);
  const totalScenes = brollScenes.length;

  const prompt = `You are a video editing intelligence that understands narrative structure.

TASK: Analyze the A-roll speech content and B-roll visual content below. Produce a narrative context map that connects them intelligently.

═══ A-ROLL CONTENT (${arollClips.length} clip(s), ${totalSentences} sentences) ═══
${arollSection}

═══ B-ROLL SCENES (${totalScenes} scene(s)) ═══
${brollSection}

═══ INSTRUCTIONS ═══

1. Identify the overall THEME (what is this content about?)
2. Identify NARRATIVE PHASES across all A-roll sentences (e.g., hook, problem statement, solution introduction, demo/walkthrough, social proof, call to action)
3. For EACH sentence, rank the TOP 3 most relevant B-roll scenes that should play behind/alongside that speech. Consider:
   - Does the B-roll VISUALLY SUPPORT what's being said?
   - Does it show the PRODUCT/FEATURE being discussed?
   - Does it provide CONTEXT for an abstract statement?
   - Does it create EMOTIONAL resonance with the message?
   - Avoid repetition: if a scene was already the best match for a neighboring sentence, prefer variety.

Return JSON in this EXACT format (no markdown fences):
{
  "theme": "brief description of overall content theme",
  "narrativePhases": [
    {
      "phase": "hook",
      "sentenceIndices": [0, 1],
      "description": "Opening that grabs attention with the pain point"
    }
  ],
  "relevanceMap": [
    {
      "sentenceIndex": 0,
      "rankedScenes": [
        { "sceneIndex": 2, "relevanceScore": 95, "reason": "Shows the exact feature being described" },
        { "sceneIndex": 0, "relevanceScore": 60, "reason": "General app overview provides context" },
        { "sceneIndex": 4, "relevanceScore": 30, "reason": "Related but less directly relevant" }
      ]
    }
  ]
}

RULES:
- relevanceScore is 0-100 (100 = perfect match, 0 = irrelevant)
- Include up to 3 rankedScenes per sentence, only if relevanceScore > 20
- sentenceIndex uses the global indices [S0, S1, ...] from above
- sceneIndex uses the global indices [B0, B1, ...] from above
- Be generous with scores when content clearly matches
- Return ONLY valid JSON, no explanation`;

  try {
    const result = await geminiFlash.generateContent([{ text: prompt }]);
    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as NarrativeContext;

    console.log(`[NarrativeAnalyzer] Theme: "${parsed.theme}"`);
    console.log(`[NarrativeAnalyzer] Phases: ${parsed.narrativePhases?.length ?? 0}`);
    console.log(`[NarrativeAnalyzer] Relevance entries: ${parsed.relevanceMap?.length ?? 0}`);

    // Validate and clean
    return {
      theme: parsed.theme ?? "unknown",
      narrativePhases: parsed.narrativePhases ?? [],
      relevanceMap: (parsed.relevanceMap ?? []).filter(
        (entry) => typeof entry.sentenceIndex === "number" && Array.isArray(entry.rankedScenes)
      ),
    };
  } catch (err) {
    console.error("[NarrativeAnalyzer] Failed:", err);
    // Return empty context — system falls back to tag-based matching
    return {
      theme: "unknown",
      narrativePhases: [],
      relevanceMap: [],
    };
  }
}

/**
 * Build A-roll clip summaries from multiple transcriptions.
 *
 * Takes transcriptions in upload order and assigns global sentence indices
 * that are consistent across all clips (0-based, incrementing).
 */
export function buildArollSummaries(
  transcriptions: Array<{
    sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }>;
  }>
): { summaries: ArollClipSummary[]; totalSentences: number } {
  const summaries: ArollClipSummary[] = [];
  let globalIndex = 0;

  for (let clipIdx = 0; clipIdx < transcriptions.length; clipIdx++) {
    const trans = transcriptions[clipIdx];
    const sentences = trans.sentences.map((s) => ({
      globalIndex: globalIndex++,
      text: s.text,
      semanticTags: s.semantic_tags,
    }));

    summaries.push({
      clipIndex: clipIdx,
      fullText: trans.sentences.map((s) => s.text).join(" "),
      sentences,
    });
  }

  return { summaries, totalSentences: globalIndex };
}

/**
 * Build B-roll scene summaries from multiple analyses.
 *
 * Flattens scenes from all B-roll sources into a single list with
 * global indices and source tracking.
 */
export function buildBrollSummaries(
  analyses: Array<{
    internalScenes: Array<{
      start: number;
      end: number;
      description: string;
      contentTags: string[];
    }>;
  }>
): BrollSceneSummary[] {
  const summaries: BrollSceneSummary[] = [];
  let globalIndex = 0;

  for (let sourceIdx = 0; sourceIdx < analyses.length; sourceIdx++) {
    const analysis = analyses[sourceIdx];
    for (const scene of analysis.internalScenes) {
      summaries.push({
        sceneIndex: globalIndex++,
        sourceIndex: sourceIdx,
        contentTags: scene.contentTags,
        description: scene.description,
        duration: scene.end - scene.start,
      });
    }
  }

  return summaries;
}

/**
 * Convert B-roll scene summaries back into BRollScene format for the plan builder.
 *
 * The plan builder's matchBrollScenes() works with BRollScene[]. This function
 * converts the summaries (used for Gemini analysis) back to that format.
 */
export function summariesToBrollScenes(
  summaries: BrollSceneSummary[],
  analyses: Array<{
    internalScenes: Array<{
      start: number;
      end: number;
      description: string;
      contentTags: string[];
    }>;
  }>
): BRollScene[] {
  return summaries.map((summary) => {
    const source = analyses[summary.sourceIndex];
    // Find the actual scene in the source to get start/end times
    const sceneInSource = source.internalScenes.find(
      (s) => s.description === summary.description && s.contentTags.length === summary.contentTags.length
    ) ?? source.internalScenes[0];

    return {
      start: sceneInSource?.start ?? 0,
      end: sceneInSource?.end ?? summary.duration,
      contentTags: summary.contentTags,
      description: summary.description,
      sourceIndex: summary.sourceIndex,
    };
  });
}
