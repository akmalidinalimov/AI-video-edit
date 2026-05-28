export interface StyleProfile {
  version: string;
  source: {
    duration: number;
    fps: number;
    resolution: string;
  };
  segments: Segment[];
  color_grade: ColorGrade;
  pip_style: PIPStyle;
  editing_rhythm: EditingRhythm;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  layout: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side";
  aroll?: ARollElement;
  broll?: BRollElement;
  text_overlays: TextOverlay[];
  other_elements?: OtherElement[];
  transition_in: string;
  transition_out: string;
  description?: string;
}

export interface ARollElement {
  position: [number, number];
  size: [number, number] | number[];
  shape: "circle" | "rectangle";
  border?: { color: string; width: number } | null;
  animation?: {
    from: [number, number];
    to: [number, number];
    easing: "linear" | "ease-out" | "spring";
  } | null;
}

export interface BRollElement {
  position: [number, number];
  size: [number, number];
  crop?: { x: number; y: number; width: number; height: number } | null;
  scroll?: {
    speed: number;
    direction: "up" | "down" | "left" | "right";
    max_offset: number;
  } | null;
}

export interface TextOverlay {
  text: string;
  position: [number, number];
  style: {
    font?: string;
    fontSize?: number;
    size?: number;
    fontWeight?: "normal" | "bold";
    color: string;
    background?: string;
    backgroundColor?: string;
    padding?: number;
    borderRadius?: number;
  };
  animation?: {
    type: "none" | "slide_up" | "slide_down" | "fade_in" | "pop" | "typewriter";
    start_offset?: number;
    duration?: number;
    delay?: number;
  } | null;
}

export interface OtherElement {
  type: "title_bar" | "cta" | "icon" | "shape";
  position: [number, number];
  size: [number, number];
  style: Record<string, unknown>;
}

export interface ColorGrade {
  brightness: number;
  saturation: number;
  contrast: number;
  temperature: "warm" | "neutral" | "cool";
}

export interface PIPStyle {
  shape: "circle" | "rectangle";
  size?: number;
  typical_size?: number;
  border?: { color: string; width: number };
  shadow?: string;
  preferred_positions?: [number, number][];
}

export interface EditingRhythm {
  avg_segment_duration: number;
  total_segments: number;
  cut_style: "hard_cut" | "smooth_transition" | "mixed";
  pacing: "fast" | "moderate" | "slow";
  cut_frequency?: string;
  transition_preference?: string;
}
