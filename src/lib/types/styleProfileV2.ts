/**
 * StyleProfileV2 — the structured, TEMPORAL "edit recipe" extracted from a
 * reference reel. It is the contract the Reference Style Profiler emits and that
 * the replication pipeline (Remotion compositor) consumes.
 *
 * ACCURACY PRINCIPLE (mirrors the A-roll work): every measurable fact is pinned by
 * the most authoritative source and tagged as such — geometry & colour by CV,
 * caption timing by MMS forced alignment, semantics (what the b-roll shows, the
 * caption text, the narrative role) by Gemini. The `source` + `confidence` on each
 * event make this auditable and let the closed loop drive accuracy to a number.
 *
 * It maps near-mechanically onto the render schema in ./timeline.ts:
 *   presenter → TimelineSegment.aroll · broll → .broll/BRollMotion ·
 *   caption → CaptionTrack/Line/Word/Style · card|logo_bumper → text_overlays ·
 *   cta → EngagementHook/EndScreen · transition → transition_in/out ·
 *   meta.colorGrade → TimelineDefinition.color_grade.
 */
import type { ColorGrade } from "./styleProfile";

export type EvidenceSource = "gemini" | "cv" | "mms" | "reconciled";

/** Where a fact came from + how sure we are (drives the accuracy gate). */
export interface Provenanced {
  source: EvidenceSource;
  confidence: number; // 0..1
}

export interface StyleProfileV2 {
  schemaVersion: "2.0";
  id: string; // slug, e.g. "uzbek-presenter-yellow"
  sourceVideo: string;
  contentHash: string; // sha256 of the mp4 — cache key
  createdAt: string;
  meta: GlobalMeta;
  layers: LayerEvent[]; // flat, time-ordered recipe
  phases: NarrativePhase[]; // per-narrative-phase grammar
  globalStyle: GlobalStyle; // reusable fingerprint
  transcript: TranscriptBlock; // full text + WORD times (MMS) + sentences
  styleMatch?: StyleMatchReport; // filled by the closed-loop style-diff
  provenance: ProfileProvenance;
}

export interface GlobalMeta {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  language: "uz" | "ru" | "en" | "mixed";
  hasPresenter: boolean;
  /** none ⇒ the "showcase" grammar (no talking head). */
  presenterModel:
    | "persistent_pip" // PIP always present
    | "interleaved_fullscreen" // presenter ⇄ fullscreen b-roll
    | "fullscreen_dominant" // presenter fills frame, overlays on top
    | "none";
  mood: string;
  colorGrade: ColorGrade;
  brandColors: string[];
}

export type LayerType =
  | "presenter"
  | "broll"
  | "caption"
  | "card" // inset image/clip card (corner)
  | "chrome" // persistent post/app wrapper (header, thumbnail strip, caption block)
  | "logo_bumper" // branded logo card
  | "cta"
  | "transition";

export interface LayerEvent extends Provenanced {
  id: string;
  type: LayerType;
  startSec: number;
  endSec: number;
  startFrame?: number; // resolved at reconcile (from probed fps)
  endFrame?: number;
  zIndex: number;
  phaseId?: string;
  region: Region;
  content: ContentDescriptor;
  text?: TextLayerStyle; // for caption/card/cta/chrome
  animation?: AnimationSpec;
}

/** Canvas-space 1080×1920 (or the profile's own width/height). */
export interface Region {
  shape: "circle" | "rectangle" | "fullscreen";
  // rectangle
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  // circle
  cx?: number;
  cy?: number;
  radius?: number;
  // named anchor Gemini proposed before CV pinned exact coords
  anchor?: string;
  crop?: { x: number; y: number; width: number; height: number } | null;
  border?: { color: string; width: number } | null;
  shadow?: string | null;
}

export interface ContentDescriptor {
  brollType?:
    | "ai_cinematic"
    | "ai_character"
    | "ai_lifestyle"
    | "screenshot_app"
    | "screenshot_web"
    | "product"
    | "thumbnail_strip"
    | "stock"
    | "diagram"
    | "logo"
    | "other";
  concepts: string[]; // language-agnostic concept tags
  visibleText?: string[];
  /** Is on-screen text an editor caption, or burned into the b-roll source? */
  textOrigin?: "editor_overlay" | "source_burned_in" | "unknown";
  motion?: "static" | "scroll" | "ken_burns" | "pan" | "zoom_in" | "zoom_out";
  describesSpeech?: string; // the sentence this visual illustrates
}

export interface TextLayerStyle {
  text: string;
  font?: string;
  fontClass?: string; // safer than exact font: "sans-bold", "display", ...
  fontSize?: number;
  fontWeight: "normal" | "bold" | "black";
  color: string;
  highlightColor?: string; // active-word colour (karaoke)
  backgroundColor?: string;
  pill?: boolean; // rounded keyword pill
  borderRadius?: number;
  padding?: number;
  textTransform?: "none" | "uppercase";
  textAlign?: "center" | "left" | "right";
  position: [number, number];
  /** Per-word timing — from MMS, NOT Gemini's eyeballed times. */
  wordTimings?: { word: string; startSec: number; endSec: number }[];
}

export type AnimType =
  | "none" | "cut" | "fade" | "slide_up" | "slide_down" | "slide_left"
  | "slide_right" | "pop" | "scale" | "typewriter" | "wipe" | "dissolve" | "zoom";
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring";

export interface AnimationSpec {
  in: { type: AnimType; durationSec: number; easing: Easing };
  out: { type: AnimType; durationSec: number; easing: Easing };
}

export interface NarrativePhase {
  id: string;
  label: "hook" | "intro" | "body" | "demo" | "proof" | "cta" | "outro" | string;
  startSec: number;
  endSec: number;
  presenter: "circle_pip" | "rect_pip" | "fullscreen" | "absent";
  brollContentType: ContentDescriptor["brollType"] | "mixed" | "none";
  captionStyleRef?: string; // id into globalStyle.captionStyles
  cardUsage: "none" | "occasional" | "frequent";
  pacing: "fast" | "moderate" | "slow";
  notes?: string;
}

export interface GlobalStyle {
  pipStyle: {
    shape: "circle" | "rectangle";
    typicalRadiusPx?: number;
    typicalSizePx?: [number, number];
    border?: { color: string; width: number };
    shadow?: string;
    preferredPositions: [number, number][];
  };
  captionStyles: ({ id: string } & TextLayerStyle)[];
  cardStyle?: TextLayerStyle & { region: Region };
  ctaStyle: TextLayerStyle & {
    trigger: "end_card" | "mid" | "persistent";
    ctaText: string;
    ctaAction: string;
  };
  chromeStyle?: {
    header?: Region & { text?: TextLayerStyle };
    thumbnailStrip?: Region;
    captionBlock?: Region & { text?: TextLayerStyle };
  };
  editingRhythm: {
    avgSegmentDurationSec: number;
    cutStyle: string;
    pacing: string;
    hardCutsPerMin: number;
  };
  brollTreatment: { dominantMotion: string; cropStyle: string; overlayOpacity: number };
  transitionPalette: AnimType[];
}

export interface TranscriptBlock {
  fullText: string;
  language: GlobalMeta["language"];
  words: { word: string; startSec: number; endSec: number }[];
  sentences: { text: string; startSec: number; endSec: number; phaseId?: string }[];
}

/** Quantitative style-fidelity — filled when the output is rendered & compared. */
export interface StyleMatchReport {
  overall: number; // 0..1 (target ≥ 0.98)
  captionTimingErrSec: number;
  geometryErrPx: number;
  layerTypeMatch: number; // 0..1
  pacingMatch: number; // 0..1
  ctaPresent: boolean;
  dimensions: Record<string, number>;
}

export interface ProfileProvenance {
  geminiModel: string;
  passes: string[];
  cvReconciled: boolean;
  mmsAligned: boolean;
  warnings: string[];
}
