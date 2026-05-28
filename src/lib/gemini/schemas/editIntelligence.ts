import { z } from "zod";

export const EditIntelligenceSchema = z.object({
  transitions: z.array(
    z.object({
      segment_id: z.string(),
      transition_in: z.string(),
      transition_duration_frames: z.number(),
      reasoning: z.string(),
    })
  ),
  hook: z.object({
    type: z.enum(["text", "question", "visual"]),
    text: z.string(),
    animation: z.enum(["pop", "slide_up", "typewriter", "fade_in"]),
  }),
  missing_asset_prompts: z.array(
    z.object({
      segment_id: z.string(),
      imagen_prompt: z.string(),
      style_guidance: z.string(),
      suggested_type: z.enum(["photo", "illustration", "abstract", "screenshot_mockup"]),
    })
  ),
});

export type EditIntelligenceResult = z.infer<typeof EditIntelligenceSchema>;
