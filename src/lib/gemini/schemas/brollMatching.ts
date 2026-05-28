import { z } from "zod";

export const BRollMatchingSchema = z.object({
  matches: z.array(
    z.object({
      segment_id: z.string(),
      selected_broll: z.string(),
      match_reason: z.string(),
      match_score: z.number(),
      broll_start: z.number().nullable(),
      broll_end: z.number().nullable(),
      alternative_brolls: z.array(z.string()),
      missing_asset_description: z.string().nullable().optional(),
    })
  ),
});

export type BRollMatchingResult = z.infer<typeof BRollMatchingSchema>;
