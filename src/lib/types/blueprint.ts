/**
 * VisualBlueprint types — the core data structure for the v2 pipeline.
 *
 * A VisualBlueprint contains pixel-accurate layout information extracted
 * from the reference video via screenshots + Gemini Vision analysis,
 * plus material analysis for A-roll and B-roll assets.
 */

// ── Frame extraction results ──

export interface VideoMetadata {
  videoPath: string;
  duration: number;
  fps: number;
  resolution: { width: number; height: number };
  codec: string;
  bitrate: number;
  hasAudio: boolean;
}

export interface SceneChange {
  timestamp: number;
  score: number; // 0-1, higher = bigger visual change
}

export interface ExtractedFrame {
  timestamp: number;
  path: string;          // Absolute path to the extracted JPEG
  isSceneChange: boolean;
}

export interface SilenceRegion {
  start: number;
  end: number;
  duration: number;
}

export interface FrameExtractionResult {
  videoPath: string;
  duration: number;
  fps: number;
  resolution: { width: number; height: number };
  sceneChanges: SceneChange[];
  frames: ExtractedFrame[];
  silenceRegions: SilenceRegion[];
}

// ── Gemini video analysis results ──

export interface VideoSegment {
  id: string;
  start: number;
  end: number;
  layout: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side";
  transition_in: string;
  description: string;
}

export interface EditingRhythm {
  avg_segment_duration: number;
  cut_style: string;
  pacing: string;
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface SentenceTimestamp {
  text: string;
  start: number;
  end: number;
  semantic_tags: string[];
}

export interface Transcription {
  full_text: string;
  language: string;
  words: WordTimestamp[];
  sentences: SentenceTimestamp[];
}

export interface VisualEvent {
  timestamp: number;
  event: string;
  description: string;
}

export interface SyncMapEntry {
  speech_start: number;
  speech_end: number;
  speech_text: string;
  visual_segment: string;
}

export interface VideoAnalysisResult {
  segments: VideoSegment[];
  editing_rhythm: EditingRhythm;
  transcription: Transcription;
  visual_events: VisualEvent[];
  sync_map: SyncMapEntry[];
}

// ── Screenshot coordinate extraction ──

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ARollCoordinates {
  boundingBox: BoundingBox;
  shape: "circle" | "rectangle";
  hasBorder: boolean;
  borderColor?: string;
  borderWidth?: number;
  isCropped: boolean;
  cropRegion?: { top: number; bottom: number; left: number; right: number };
}

export interface BRollCoordinates {
  boundingBox: BoundingBox;
  contentType: "screen_recording" | "video" | "image" | "animation" | "text_document";
  isCropped: boolean;
  hasScrollMotion: boolean;
}

export interface TextElement {
  text: string;
  boundingBox: BoundingBox;
  isHeadline: boolean;
  estimatedFontSize: number;
  color: string;
  backgroundColor: string | null;
  fontWeight: "normal" | "bold";
}

export interface BlackRegion {
  boundingBox: BoundingBox;
  purpose: "header" | "footer" | "spacer" | "background";
}

export interface FrameCoordinates {
  timestamp: number;
  framePath: string;
  segmentId: string;
  layout: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side";
  elements: {
    aroll?: ARollCoordinates;
    broll?: BRollCoordinates;
    texts: TextElement[];
    blackRegions: BlackRegion[];
  };
}

// ── Material analysis ──

export interface FaceFrame {
  timestamp: number;
  faceBoundingBox: BoundingBox;
  faceCenter: { x: number; y: number };
}

export interface ARollMaterialAnalysis {
  videoPath: string;
  duration: number;
  resolution: { width: number; height: number };
  transcription: Transcription;
  faceFrames: FaceFrame[];
  recommendedCrop: {
    circle: { centerX: number; centerY: number; radius: number };
    rectangle: BoundingBox;
  };
  silenceRegions: SilenceRegion[];
  editPoints: { timestamp: number; type: string }[];
  speechRatio: number;
}

export interface BRollFrameContent {
  timestamp: number;
  contentTags: string[];
  visibleText: string[];
  uiElements: string[];
  topicMatch: string;
}

export interface BRollInternalScene {
  start: number;
  end: number;
  description: string;
  contentTags: string[];
}

export interface BRollMaterialAnalysis {
  videoPath: string;
  duration: number;
  resolution: { width: number; height: number };
  contentType: "screen_recording" | "video" | "image" | "animation";
  motionType: string;
  frameContent: BRollFrameContent[];
  internalScenes: BRollInternalScene[];
}

// ── Cross-validated blueprint ──

export interface BlueprintSegment {
  id: string;
  start: number;
  end: number;
  layout: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side";
  aroll: ARollCoordinates | null;
  broll: BRollCoordinates;
  texts: TextElement[];
  blackRegions: BlackRegion[];
  /** B-roll content tags from material analysis (what appears in the B-roll during this segment) */
  brollContentTags?: string[];
}

export interface ConfidenceScores {
  segmentBoundaries: number;
  coordinates: number;
  transcription: number;
  overall: number;
}

export interface AnalysisConflict {
  description: string;
  resolution: string;
  source: "gemini_video" | "gemini_vision" | "ffmpeg";
}

export interface VisualBlueprint {
  canvas: { width: 1080; height: 1920 };
  reference: {
    duration: number;
    fps: number;
    segments: BlueprintSegment[];
    transcription: Transcription;
    syncMap: SyncMapEntry[];
    styleFingerprint: Record<string, unknown>;
  };
  aroll: ARollMaterialAnalysis;
  broll: BRollMaterialAnalysis[];
  confidence: ConfidenceScores;
  conflicts: AnalysisConflict[];
}

// ── Verification types ──

export interface FrameComparison {
  timestamp: number;
  ssimScore: number;
  geminiScore?: number;
  issues: string[];
  suggestions: string[];
}

export interface VisualComparisonReport {
  overallScore: number;
  frameComparisons: FrameComparison[];
  layoutAccuracy: number;
  coordinateAccuracy: number;
  textPresence: number;
  pipShapeCorrect: boolean;
  overallVerdict: "pass" | "needs_fixes" | "redo_from_scratch";
}
