/**
 * broll-style.ts — classify the REFERENCE video's B-roll STYLE so we replicate the
 * right kind of B-roll (not the content). The reference might use realistic footage
 * of people, motion-graphics/paper animation, product shots, cartoon, screen
 * recordings, etc. We detect that, map it to the right production modality, and
 * feed per-style guidance to the prompt-writer — so a realistic-footage reference
 * yields realistic AI clips, a motion-graphics reference yields Remotion graphics,
 * and so on. Content stays driven by the A-roll context; only the STYLE is matched.
 */
import { geminiFlash } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";

export type BrollStyle =
  | "realistic_person" // real footage of people doing things
  | "realistic_scene" // real places / objects / environments
  | "product" // product-focused shots
  | "motion_graphics" // animated text, data, infographics
  | "paper_cutout" // paper / collage / cut-out animation
  | "cartoon_animation" // cartoon / animated characters
  | "screen_recording" // UI / app / website capture
  | "abstract" // abstract motion, textures, light
  | "mixed";

/** Where each style should be produced in our stack. */
export const STYLE_TO_MODALITY: Record<BrollStyle, "ai_video" | "remotion" | "screen_capture" | "hybrid"> = {
  realistic_person: "ai_video",
  realistic_scene: "ai_video",
  product: "ai_video",
  cartoon_animation: "ai_video",
  motion_graphics: "remotion",
  paper_cutout: "remotion",
  abstract: "remotion",
  screen_recording: "screen_capture",
  mixed: "hybrid",
};

/** Per-style guidance the prompt-writer must honor so the output matches the reference. */
export const STYLE_PROMPT_GUIDANCE: Record<BrollStyle, string> = {
  realistic_person:
    "Photoreal documentary realism: real-looking people, natural skin/light, candid action; cinematic but believable. Cast to the A-roll's culture/context.",
  realistic_scene:
    "Photoreal real-world places/objects; natural light and motion; establishing or detail shots, no people-as-subject required.",
  product:
    "Clean product-forward framing: the object held/used correctly, soft studio or lifestyle light, shallow depth of field.",
  cartoon_animation:
    "Stylized 2D/3D cartoon animation matching the reference's character look; bold shapes, flat or toon shading; playful motion.",
  motion_graphics:
    "Designed motion graphics (Remotion): animated type, data, diagrams; on-brand palette; no photoreal footage.",
  paper_cutout:
    "Paper/collage/cut-out aesthetic (Remotion): layered textures, hand-made feel, stop-motion-style pops.",
  abstract:
    "Abstract motion/textures (Remotion): gradients, particles, light leaks, shapes; mood over literal subject.",
  screen_recording:
    "Real screen/app capture with smart zoom on the key action; face-in-corner optional; the actual UI, not a faked one.",
  mixed: "A mix — pick the dominant style per beat and combine (AI base + graphics) where it serves the message.",
};

export interface BrollStyleResult {
  dominant: BrollStyle;
  styles: Array<{ style: BrollStyle; share: number; example: string }>;
  reason: string;
}

/**
 * Classify the B-roll style of a reference video via Gemini (multimodal). Looks at
 * the B-roll INSERTS (not the talking head) and reports the dominant style + the mix.
 * Returns null on failure (caller should fall back to a sensible default).
 */
export async function classifyReferenceBrollStyle(referencePath: string): Promise<BrollStyleResult | null> {
  try {
    const mimeType = referencePath.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
    const file = await uploadToGemini(referencePath, mimeType, "ref-style");
    const processed = await waitForFileProcessing(file.name);

    const prompt = `You are a video-style analyst. This is a short-form vertical ad with a talking-head presenter (A-roll) and B-ROLL inserts cut over/around it.
Classify the STYLE of the B-ROLL inserts only (ignore the talking-head presenter).
Allowed styles: realistic_person, realistic_scene, product, motion_graphics, paper_cutout, cartoon_animation, screen_recording, abstract.
Return STRICT JSON only:
{"dominant":"<style>","styles":[{"style":"<style>","share":<0..1>,"example":"<what you saw>"}],"reason":"<1 sentence>"}`;

    const res = await geminiFlash.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { mimeType: processed.mimeType ?? mimeType, fileUri: processed.uri } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    });

    const text = res.response.text();
    const parsed = JSON.parse(text) as BrollStyleResult;
    if (!parsed?.dominant) return null;
    return parsed;
  } catch (err) {
    console.error("[broll-style] classification failed:", err);
    return null;
  }
}
