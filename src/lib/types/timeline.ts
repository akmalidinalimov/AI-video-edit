import type { ColorGrade } from "./styleProfile";

export interface TimelineDefinition {
  id: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  segments: TimelineSegment[];
  audio: AudioTrack[];
  captions: CaptionTrack;
  hook: EngagementHook | null;
  color_grade: ColorGrade;
}

export interface TimelineSegment {
  id: string;
  start_frame: number;
  end_frame: number;
  layout: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side";
  broll: {
    src: string;
    /** Start time in seconds within the source video (prevents repetition) */
    startFrom?: number;
    /** Position [x, y] within the 1080×1920 canvas */
    position?: [number, number];
    /** Size [width, height] — varies by layout (e.g. bottom half for vertical_split) */
    size?: [number, number];
    crop?: { x: number; y: number; width: number; height: number };
    scroll?: { speed: number; direction: "up" | "down"; maxOffset: number };
    scale?: number;
    motion?: BRollMotion;
  };
  aroll?: {
    src: string;
    /** Start time in seconds within the source video (each segment plays a different portion) */
    startFrom?: number;
    position: [number, number];
    /** [width, height] — supports non-square shapes like 16:9 rectangles */
    size: [number, number];
    shape: "circle" | "rectangle";
    border?: { color: string; width: number };
    shadow?: string;
    animation?: {
      from: [number, number];
      to: [number, number];
      easing: string;
    };
  };
  text_overlays: {
    text: string;
    position: [number, number];
    style: Record<string, unknown>;
    animation?: Record<string, unknown>;
    start_frame: number;
    end_frame: number;
  }[];
  transition_in?: { type: string; duration_frames: number };
  transition_out?: { type: string; duration_frames: number };
}

export interface BRollMotion {
  type: "static" | "scroll" | "ken_burns" | "pan" | "zoom_in" | "zoom_out";
  keyframes: {
    frame: number;
    x: number;
    y: number;
    scale: number;
  }[];
  easing: "linear" | "ease-in-out" | "ease-out";
}

export interface AudioTrack {
  src: string;
  type: "aroll_voice" | "background_music" | "sfx";
  volume: number;
  start_frame: number;
  end_frame: number;
  /** Frame in the SOURCE file to start playing from (for correct A-roll sync) */
  sourceStartFrom?: number;
  fade_in?: number;
  fade_out?: number;
}

export interface CaptionWord {
  word: string;
  start_frame: number;
  end_frame: number;
}

export interface CaptionLine {
  text: string;
  start_frame: number;
  end_frame: number;
  words: CaptionWord[];
  position: [number, number];
  style: CaptionStyle;
}

export interface CaptionStyle {
  fontSize: number;
  fontWeight: "normal" | "bold";
  color: string;
  highlightColor: string;
  backgroundColor?: string;
  padding?: number;
  borderRadius?: number;
  textAlign: "center" | "left" | "right";
  textTransform?: "none" | "uppercase";
  maxWidth: number;
}

export interface CaptionTrack {
  lines: CaptionLine[];
  style: CaptionStyle;
  position: [number, number];
}

export interface EngagementHook {
  type: "text" | "visual" | "question";
  text: string;
  duration_frames: number;
  position: [number, number];
  style: Record<string, unknown>;
  animation: {
    type: "pop" | "slide_up" | "typewriter" | "fade_in";
    duration_frames: number;
  };
}

export interface TransitionPlan {
  segment_id: string;
  transition_in: { type: string; duration_frames: number } | null;
  transition_out: { type: string; duration_frames: number } | null;
  reasoning: string;
}

export interface MissingAssetPrompt {
  segment_id: string;
  speech_text: string;
  imagen_prompt: string;
  style_guidance: string;
  aspect_ratio: string;
  suggested_type: "photo" | "illustration" | "abstract" | "screenshot_mockup";
}
