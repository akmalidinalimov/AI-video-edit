import { z } from "zod";

export const BRollCatalogSchema = z.object({
  type: z.enum(["image", "video"]),
  content_summary: z.string(),
  classification: z.string(),
  quality_score: z.number().min(0).max(100),
  visible_text: z.array(z.string()),
  dominant_colors: z.array(z.string()),
  duration: z.number().nullable(),
  usable_segments: z.array(z.object({
    start: z.number(),
    end: z.number(),
    description: z.string(),
  })).default([]),
  camera_motion: z.string().nullable(),
  crop_recommendation: z.object({
    strategy: z.string(),
    crop: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }).optional(),
    notes: z.string().optional(),
  }),
  semantic_tags: z.array(z.string()),
  best_use: z.string(),
});

export type BRollCatalogResult = z.infer<typeof BRollCatalogSchema>;
