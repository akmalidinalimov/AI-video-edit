import { z } from "zod";

export const ARollAnalysisSchema = z.object({
  content_type: z.enum(["talking_head", "voiceover", "screen_recording", "product_commercial", "silent_footage", "mixed"]),
  duration: z.number(),
  language: z.enum(["uz", "ru", "en", "mixed"]),
  transcription: z.object({
    full_text: z.string(),
    words: z.array(z.object({
      word: z.string(),
      start: z.number(),
      end: z.number(),
    })),
    sentences: z.array(z.object({
      text: z.string(),
      start: z.number(),
      end: z.number(),
      topic: z.string().optional(),
      semantic_tags: z.array(z.string()).optional(),
    })),
  }),
  speaker: z.object({
    face_position: z.object({
      x_center: z.number(),
      y_center: z.number(),
      face_size: z.number(),
    }),
    gesture_moments: z.array(z.object({
      timestamp: z.number(),
      type: z.string(),
    })),
  }).optional(),
  edit_points: z.array(z.object({
    timestamp: z.number(),
    type: z.string(),
    confidence: z.number(),
  })),
  emotional_arc: z.array(z.object({
    start: z.number(),
    end: z.number(),
    mood: z.string(),
  })),
  silence_regions: z.array(z.object({
    start: z.number(),
    end: z.number(),
    duration: z.number(),
    type: z.enum(["silence", "filler", "breath"]),
  })),
  speech_ratio: z.number(),
  clip_summary: z.string(),
  audio_quality: z.object({
    overall_level: z.enum(["good", "fair", "poor"]),
    background_noise: z.enum(["none", "low", "moderate", "high"]),
    volume_consistency: z.enum(["consistent", "varies", "inconsistent"]),
    estimated_db: z.number(),
    issues: z.array(z.string()),
  }),
});

export type ARollAnalysisResult = z.infer<typeof ARollAnalysisSchema>;
