import { z } from "zod";

export const Pass1Schema = z.object({
  duration: z.number(),
  fps: z.number(),
  resolution: z.string(),
  segments: z.array(
    z.object({
      id: z.string(),
      start: z.number(),
      end: z.number(),
      layout: z.enum(["full_screen", "vertical_split", "pip_overlay", "side_by_side"]),
      transition_in: z.string(),
      description: z.string().optional(),
    })
  ),
  editing_rhythm: z.object({
    avg_segment_duration: z.number(),
    total_segments: z.number(),
    cut_style: z.enum(["hard_cut", "smooth_transition", "mixed"]),
    pacing: z.enum(["fast", "moderate", "slow"]),
  }),
});

export const Pass2SegmentSchema = z.object({
  id: z.string(),
  aroll: z.object({
    position: z.tuple([z.number(), z.number()]),
    size: z.array(z.number()),
    shape: z.enum(["circle", "rectangle"]),
    border: z.object({ color: z.string(), width: z.number() }).nullable().optional(),
    animation: z.object({
      from: z.tuple([z.number(), z.number()]),
      to: z.tuple([z.number(), z.number()]),
      easing: z.enum(["linear", "ease-out", "spring"]),
    }).nullable().optional(),
  }).optional(),
  broll: z.object({
    position: z.tuple([z.number(), z.number()]),
    size: z.tuple([z.number(), z.number()]),
    crop: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(),
    scroll: z.object({
      speed: z.number(),
      direction: z.enum(["up", "down", "left", "right"]),
      max_offset: z.number(),
    }).nullable().optional(),
  }).optional(),
  text_overlays: z.array(
    z.object({
      text: z.string(),
      position: z.tuple([z.number(), z.number()]),
      style: z.record(z.unknown()),
      animation: z.record(z.unknown()).nullable().optional(),
    })
  ).optional().default([]),
  other_elements: z.array(z.record(z.unknown())).optional().default([]),
});

export const Pass2Schema = z.object({
  segments: z.array(Pass2SegmentSchema),
});

export const Pass3Schema = z.object({
  transcription: z.object({
    full_text: z.string(),
    language: z.enum(["uz", "ru", "en", "mixed"]),
    words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })),
    sentences: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })),
  }),
  visual_events: z.array(
    z.object({
      timestamp: z.number(),
      event: z.string(),
      description: z.string(),
    })
  ),
  sync_map: z.array(
    z.object({
      speech_start: z.number(),
      speech_end: z.number(),
      speech_text: z.string(),
      visual_segment: z.string(),
      visual_description: z.string(),
    })
  ),
});

export const Pass4Schema = z.object({
  color_grade: z.object({
    brightness: z.number(),
    saturation: z.number(),
    contrast: z.number(),
    temperature: z.enum(["warm", "neutral", "cool"]),
  }),
  pip_style: z.object({
    shape: z.enum(["circle", "rectangle"]),
    typical_size: z.number(),
    border: z.object({ color: z.string(), width: z.number() }).optional(),
    shadow: z.string().optional(),
    preferred_positions: z.array(z.tuple([z.number(), z.number()])).optional(),
  }),
  text_style: z.object({
    primary_font_weight: z.string(),
    title_size_range: z.tuple([z.number(), z.number()]),
    body_size_range: z.tuple([z.number(), z.number()]),
    color_palette: z.array(z.string()),
    animation_preference: z.string(),
  }),
  editing_rhythm: z.object({
    avg_segment_duration: z.number(),
    cut_frequency: z.string(),
    transition_preference: z.string(),
  }),
  broll_treatment: z.object({
    scroll_speed_range: z.tuple([z.number(), z.number()]),
    crop_style: z.string(),
    overlay_opacity: z.number(),
  }),
  mood: z.string(),
});

export type Pass1Result = z.infer<typeof Pass1Schema>;
export type Pass2Result = z.infer<typeof Pass2Schema>;
export type Pass3Result = z.infer<typeof Pass3Schema>;
export type Pass4Result = z.infer<typeof Pass4Schema>;
