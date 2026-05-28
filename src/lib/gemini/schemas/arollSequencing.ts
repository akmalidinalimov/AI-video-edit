import { z } from "zod";

export const ARollSequencingSchema = z.object({
  sequence: z.array(
    z.object({
      clip_id: z.string(),
      position: z.number(),
      reasoning: z.string(),
    })
  ),
  narrative_summary: z.string(),
  confidence: z.number(),
});

export type ARollSequencingResult = z.infer<typeof ARollSequencingSchema>;
