/**
 * aroll-gesture.ts — Stage 1: gesture/deixis-driven layout DIRECTION.
 *
 * Watches the A-roll with Gemini multimodal and, per sentence, decides whether
 * the speaker makes a directional gesture or deictic reference (e.g. points UP
 * while saying "our students"). That direction drives the split layout: a
 * point-UP means the referenced content (B-roll) goes ABOVE and the A-roll
 * speaker sits BELOW — so the layout follows the A-roll's own meaning, not just
 * the reference geometry. (MediaPipe pose is unavailable here, so we use the
 * multimodal model the user approved for this judgement.)
 */
import { geminiFlash } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";

export type GestureDir = "up" | "down" | "left" | "right" | "neutral";

export interface SentenceGesture {
  index: number;
  direction: GestureDir;
  reason: string;
}

/**
 * @param arollVideoPath the (clean) A-roll video
 * @param sentences      the A-roll sentences with global index + time range + text
 * @returns one gesture per sentence, or null on failure (caller falls back)
 */
export async function detectArollGestures(
  arollVideoPath: string,
  sentences: Array<{ index: number; text: string; start: number; end: number }>
): Promise<SentenceGesture[] | null> {
  if (sentences.length === 0) return null;
  try {
    const uploaded = await uploadToGemini(arollVideoPath, "video/mp4", "aroll-gesture");
    const ready = await waitForFileProcessing(uploaded.name);

    const list = sentences
      .map((s) => `${s.index}: [${s.start.toFixed(1)}-${s.end.toFixed(1)}s] "${s.text}"`)
      .join("\n");

    const prompt = `You are a short-form video editor. Watch this talking-head A-roll and, for EACH sentence below, decide where the B-ROLL should be placed relative to the speaker, based ONLY on the speaker's GESTURE and what they REFERENCE in that exact time range.

Rules:
- "up": the speaker points/raises a hand UP, looks up, or references people/things that should appear ABOVE (e.g. "our students" with an upward gesture) → B-roll goes ABOVE, speaker BELOW.
- "down": points down / references something below → B-roll BELOW, speaker ABOVE.
- "left" / "right": clearly points to that side.
- "neutral": no clear directional gesture or reference.

Be conservative: only return up/down/left/right when the gesture or reference is clear; otherwise "neutral".

Return STRICT JSON: {"gestures":[{"index":<sentence index>,"direction":"up|down|left|right|neutral","reason":"<short>"}]}

Sentences:
${list}`;

    const result = await geminiFlash.generateContent([
      { fileData: { mimeType: ready.mimeType ?? "video/mp4", fileUri: ready.uri } },
      { text: prompt },
    ]);
    const txt = result.response.text();
    const parsed = JSON.parse(txt) as { gestures?: SentenceGesture[] };
    if (!parsed.gestures || !Array.isArray(parsed.gestures)) return null;
    return parsed.gestures.map((g) => ({
      index: Number(g.index),
      direction: (["up", "down", "left", "right", "neutral"].includes(g.direction) ? g.direction : "neutral") as GestureDir,
      reason: String(g.reason ?? ""),
    }));
  } catch (e) {
    console.error("[aroll-gesture] detection failed (non-blocking):", (e as Error).message);
    return null;
  }
}
