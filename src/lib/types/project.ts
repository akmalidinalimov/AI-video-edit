import type { StyleProfile } from "./styleProfile";

export type UploadStatus = "idle" | "uploading" | "processing" | "complete" | "error";
export type AnalysisStatus = "idle" | "analyzing" | "complete" | "error";

export interface UploadedFile {
  id: string;
  name: string;
  type: "video" | "image";
  mimeType: string;
  size: number;
  url: string;
  thumbnailUrl?: string;
  status: UploadStatus;
  progress: number;
  geminiFileUri?: string;
}

export interface ProjectState {
  id: string;
  referenceFile: UploadedFile | null;
  arollFiles: UploadedFile[];
  brollFiles: UploadedFile[];
  styleProfile: StyleProfile | null;
  arollAnalyses: ARollClipAnalysis[];
  brollCatalog: BRollCatalogEntry[];
  matchResults: MatchResult[] | null;
  analysisStatus: {
    reference: AnalysisStatus;
    aroll: AnalysisStatus;
    broll: AnalysisStatus;
    matching: AnalysisStatus;
  };
}

export interface SilenceRegion {
  start: number;
  end: number;
  duration: number;
  type: "silence" | "filler" | "breath";
}

export interface UsableSegment {
  start: number;
  end: number;
  duration: number;
  text: string;
}

export interface AudioQuality {
  overall_level: "good" | "fair" | "poor";
  background_noise: "none" | "low" | "moderate" | "high";
  volume_consistency: "consistent" | "varies" | "inconsistent";
  estimated_db: number;
  issues: string[];
}

export interface ARollAnalysis {
  content_type: "talking_head" | "voiceover" | "screen_recording" | "product_commercial" | "silent_footage" | "mixed";
  duration: number;
  language: "uz" | "ru" | "en" | "mixed";
  transcription: {
    full_text: string;
    words: { word: string; start: number; end: number }[];
    sentences: {
      text: string;
      start: number;
      end: number;
      topic?: string;
      semantic_tags?: string[];
    }[];
  };
  speaker?: {
    face_position: { x_center: number; y_center: number; face_size: number };
    gesture_moments: { timestamp: number; type: string }[];
  };
  edit_points: { timestamp: number; type: string; confidence: number }[];
  emotional_arc: { start: number; end: number; mood: string }[];
  silence_regions: SilenceRegion[];
  speech_ratio: number;
  clip_summary: string;
  audio_quality: AudioQuality;
}

export interface ARollClipAnalysis {
  fileId: string;
  fileName: string;
  analysis: ARollAnalysis;
  order?: number;
  usableSegments?: UsableSegment[];
  trimmedDuration?: number;
}

export interface ARollSequence {
  clipOrder: { clipId: string; position: number; reasoning: string }[];
  narrativeSummary: string;
  confidence: number;
}

export interface SpeakerConsistency {
  isSameSpeaker: boolean;
  confidence: number;
  details: string;
  perClip: { clipId: string; facePosition: { x: number; y: number; size: number } | null }[];
}

export interface BRollCatalogEntry {
  id: string;
  fileId: string;
  type: "image" | "video";
  content_summary: string;
  classification: string;
  quality_score: number;
  visible_text: string[];
  dominant_colors: string[];
  duration: number | null;
  usable_segments: { start: number; end: number; description: string }[];
  camera_motion: string | null;
  crop_recommendation: {
    strategy: string;
    crop?: { x: number; y: number; width: number; height: number };
    notes?: string;
  };
  semantic_tags: string[];
  best_use: string;
}

export interface MatchResult {
  segment_id: string;
  segment_start: number;
  segment_end: number;
  speech_text: string;
  selected_broll: string;
  match_reason: string;
  match_score: number;
  broll_start: number | null;
  broll_end: number | null;
  alternative_brolls: string[];
}
