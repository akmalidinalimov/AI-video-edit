export type ExportFormat = "9:16" | "1:1" | "16:9";

export interface RenderConfig {
  format: ExportFormat;
  codec: "h264" | "h265";
  quality: number; // 0-100, maps to CRF
  includeGrain: boolean;
  includeVignette: boolean;
  includeProgressBar: boolean;
  includeSFX: boolean;
  endScreen: EndScreenConfig | null;
}

export interface EndScreenConfig {
  text: string;
  subtext?: string;
  durationFrames: number;
}

export interface RenderProgress {
  stage: "preparing" | "rendering" | "encoding" | "complete" | "error";
  progress: number; // 0-1
  framesRendered?: number;
  totalFrames?: number;
  estimatedTimeRemaining?: number;
  outputUrl?: string;
  fileSize?: number;
  error?: string;
}

export interface ThumbnailCandidate {
  frame: number;
  url: string;
  score: number;
  reason: string;
}

export interface SFXEvent {
  type: "transition" | "text_appear" | "caption_highlight" | "hook" | "beat_drop";
  frame: number;
  sfxId: string;
  volume: number;
}

export interface SpeedRampPoint {
  frame: number;
  speed: number; // 1.0 = normal, 0.85 = slow-mo, 1.3 = speed up
}

export interface VolumeKeyframe {
  frame: number;
  volume: number; // 0-1
}

export interface BeatMap {
  bpm: number;
  beats: number[]; // timestamps in seconds
  confidence: number;
}

export const FORMAT_DIMENSIONS: Record<ExportFormat, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  format: "9:16",
  codec: "h264",
  quality: 80,
  includeGrain: true,
  includeVignette: true,
  includeProgressBar: true,
  includeSFX: true,
  endScreen: null,
};
