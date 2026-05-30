/**
 * A-roll Narrative Orderer
 *
 * When the user uploads multiple A-roll clips, the upload order is not
 * necessarily the narrative order — a creator may have shot clips in
 * convenience order (best take last, intro recorded after the punchline,
 * etc.). This module asks Gemini to read each clip's transcription text and
 * return the indices in the order that creates the most coherent narrative
 * (hook/intro → problem → solution → CTA, or whatever structure best fits
 * the content).
 *
 * The ordering result is applied BEFORE timeline stitching, so cumulative
 * timestamps, the renderer's -i input order, and downstream sentence→clip
 * mapping all flow from the narrative-correct sequence automatically.
 *
 * Failure is non-blocking: on any error the upload order is returned, so
 * existing pipelines remain green.
 */

import { geminiFlash } from "@/lib/gemini/client";

export interface ClipForOrdering {
  /** Original upload index (0-based). Returned values reference this. */
  uploadIndex: number;
  /** Full concatenated text of all sentences in this clip. */
  text: string;
}

/**
 * Decide the narrative order of N A-roll clips by reading their transcripts.
 *
 * @returns Permutation of upload indices in narrative order. For example,
 *   `[2, 0, 3, 1]` means "play clip 2 first, then 0, then 3, then 1".
 *   When ordering fails, returns the upload order unchanged.
 */
export async function orderArollClipsByNarrative(
  clips: ClipForOrdering[]
): Promise<{ order: number[]; reasoning: string }> {
  // Identity ordering — used as fallback and as the trivial case.
  const identity = clips.map((c) => c.uploadIndex);

  if (clips.length <= 1) {
    return { order: identity, reasoning: "single clip — nothing to reorder" };
  }

  const prompt = buildPrompt(clips);

  try {
    const result = await geminiFlash.generateContent(prompt);
    const raw = result.response.text();
    const parsed = JSON.parse(raw) as {
      order?: number[];
      reasoning?: string;
    };

    if (!Array.isArray(parsed.order)) {
      return { order: identity, reasoning: "no order field returned" };
    }

    // Validate: must be a permutation of the input upload indices.
    const expected = new Set(identity);
    const received = new Set(parsed.order);
    if (received.size !== expected.size) {
      return { order: identity, reasoning: `bad permutation size ${parsed.order.length}` };
    }
    for (const v of expected) {
      if (!received.has(v)) {
        return { order: identity, reasoning: `missing index ${v}` };
      }
    }

    return {
      order: parsed.order,
      reasoning: parsed.reasoning ?? "no reasoning provided",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { order: identity, reasoning: `gemini error: ${msg}` };
  }
}

function buildPrompt(clips: ClipForOrdering[]): string {
  const items = clips
    .map(
      (c) =>
        `[Clip ${c.uploadIndex}]\n${c.text.trim() || "(empty transcription)"}`
    )
    .join("\n\n");

  return `You are sequencing video clips to form a coherent narrative.

The user uploaded ${clips.length} video clips. Each clip's transcribed speech is below. The upload order is NOT necessarily the intended narrative order — creators often shoot out of order.

Your task: read all transcriptions and decide the order that creates the strongest coherent story. Look for cues like:
  - hooks / attention-grabbers (often go first)
  - problem framing (sets up the solution)
  - solution / product reveal (the core message)
  - calls-to-action (usually last)
  - transitional phrases ("Chunki...", "Shuning uchun...", "Va shuning uchun...", "So...", "And here's why...", "Now...")
  - questions answered later
  - introductions that reference details paid off later

Clips (each labeled by upload index):

${items}

Return JSON with this exact shape:
{
  "order": [<indices in narrative order, must be a permutation of 0..${clips.length - 1}>],
  "reasoning": "<one short sentence explaining why this order is most coherent>"
}

Only return the JSON. Do not wrap in markdown. The 'order' array must contain every input index exactly once.`;
}
