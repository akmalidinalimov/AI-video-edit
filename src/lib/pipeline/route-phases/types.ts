/**
 * PipelineCtx — shared mutable state for the clone-style route phases.
 *
 * Wave 0.5 decomposition (docs/UNIVERSAL-1-MILESTONE.md): the state that used
 * to live as closure locals inside POST → ReadableStream.start is now threaded
 * as ONE mutable ctx object through the sequential phases:
 *   analyzeReference → buildTemplate → prepareContent → buildPlan → renderVideo → verifyOutput
 *
 * Behavior-preserving: fields are filled progressively as each phase runs, in
 * exactly the same order as the original closure code. Later phases read the
 * earlier phases' outputs (non-null asserted at the top of each phase, matching
 * the original "declared above, used below" closure guarantees).
 */

import type { VisualBlueprint } from "@/lib/types/blueprint";
import type { LayoutAnalysis } from "@/lib/analysis/layout-analyzer";
import type { ReferenceDecode } from "@/lib/analysis/reference-decode";
import type { fromVisualBlueprint } from "@/lib/style-profile/adapters";
import type { buildLayoutMap } from "@/lib/pipeline/layout-map";
import type { generateTemplate, extractFaceInfo } from "@/lib/pipeline/template-generator";
import type { buildEditingPlan } from "@/lib/pipeline/plan-builder";
import type { planCadence } from "@/lib/pipeline/cadence-planner";
import type { applyCreativeDirector } from "@/lib/pipeline/creative-director";
import type { BrollStyleResult } from "@/lib/pipeline/broll-style";
import type {
  analyzeNarrativeContext,
  extractSpeechKeywords,
} from "@/lib/pipeline/narrative-analyzer";

// ════════════════════════════════════════════════════════════
// SSE EVENT TYPES
// ════════════════════════════════════════════════════════════

export interface SSEEvent {
  phase: "analyzing_reference" | "generating_template" | "building_plan" | "rendering" | "verifying" | "complete" | "error";
  progress: number;
  message?: string;
  downloadUrl?: string;
  /** Closed-loop structural verification result (on the complete event) */
  verification?: {
    /** Overall style-match percentage (0-100) */
    overall: number;
    /** Whether it met the threshold */
    passed: boolean;
    /** Number of segments analyzed */
    segmentsAnalyzed: number;
    /** Per-dimension average scores (PIP, A-roll, B-roll, text, canvas) */
    dimensions: Record<string, number>;
  };
  /** B1: decoded content-free StyleProfile 2.0 (shadow output; on the complete event) */
  styleProfile?: ReturnType<typeof fromVisualBlueprint>;
}

// ════════════════════════════════════════════════════════════
// TRANSCRIPTION SHAPES (word/sentence records used across phases)
// ════════════════════════════════════════════════════════════

export interface ArollWord {
  word: string;
  start: number;
  end: number;
}

export interface ArollSentence {
  text: string;
  start: number;
  end: number;
  semantic_tags?: string[];
}

/** One B-roll scene collected across ALL B-roll sources (with source tracking). */
export interface BrollSceneInfo {
  start: number;
  end: number;
  contentTags: string[];
  description: string;
  sourceIndex: number;
  visibleText?: string[];
  uiElements?: string[];
  frameContent?: Array<{ timestamp: number; visibleText?: string[]; contentTags: string[] }>;
}

// ════════════════════════════════════════════════════════════
// N-REGION PLAN (UNIVERSAL-1 Wave 2)
// ════════════════════════════════════════════════════════════

/** One decoded region resolved to PIXEL coordinates on the render canvas. */
export interface NRegionPlanRegion {
  id: string;
  /** header_title | broll | screen_recording | aroll | ... */
  role: string;
  /** pixels on the canvas — even dims (regionToPixels) */
  rect: { x: number; y: number; w: number; h: number };
  shape: string;
  zIndex: number;
  /** rounded_rect corner radius in px (alphamerge mask) */
  cornerRadiusPx?: number;
  contentTimeline?: Array<{ start: number; end: number; content: string }>;
}

/**
 * The N-region render plan (multi_region_stack / pip_over_fullscreen), attached
 * by buildPlan when the unified decode reports an N-region layoutClass.
 * renderVideo branches on its presence: nregion pipeline vs the legacy 2-region path.
 */
export interface NRegionPlan {
  layoutClass: string;
  canvas: { width: number; height: number };
  regions: NRegionPlanRegion[];
  sources: {
    aroll: string;
    arollClips: string[];
    brollClips: string[];
  };
  /** decode pacing → montage cut cadence (clamped) */
  targetShotSec: number;
  motionMix?: Record<string, number>;
}

// ════════════════════════════════════════════════════════════
// PIPELINE CONTEXT
// ════════════════════════════════════════════════════════════

export interface PipelineCtx {
  // ── Request/paths + config (set by route.ts before any phase runs) ──
  refPath: string;
  /** All A-roll clips. MUTATED IN PLACE by prepareContent (reordered to narrative order). */
  arollPaths: string[];
  brollPaths: string[];
  /** Primary A-roll path (first clip = backward compatible). */
  arollPath: string;
  /** Primary B-roll path (first clip = backward compatible). */
  brollPath: string;
  tempDir: string;
  exportsDir: string;
  /** Skip the post-render structural verification (request flag). */
  skipVerification: boolean;
  /** SSE emitter bound to the route's ReadableStream controller. */
  sendSSE: (event: SSEEvent) => void;

  // ── analyzeReference outputs ──
  blueprint?: VisualBlueprint;
  /** B1 shadow: unified StyleProfile 2.0 (surfaced on the complete event). */
  styleProfile2?: ReturnType<typeof fromVisualBlueprint> | null;
  /** CV-measured reference Layout Map (drives PIP motion animation). */
  layoutMap?: ReturnType<typeof buildLayoutMap>;
  /** Deterministic Layout Analyzer measurement (null on any failure). */
  measuredLayout?: LayoutAnalysis | null;
  /** The CANONICAL reference decode (single source of truth). */
  refDecode?: ReferenceDecode | null;
  /** Cadence source — measured decode preferred, blueprint rhythm fallback. */
  cadenceRhythm?: Parameters<typeof planCadence>[0];
  /** scene-KB (spec §3.4): segmented scene windows of the reference. */
  sceneWindows?: import("@/lib/analysis/scene-segmenter").SceneWindow[];
  /** scene-KB: per-scene KB match results, index-aligned with sceneWindows. */
  sceneMatches?: Array<{
    scene: import("@/lib/knowledge/scene-kb").DecodedScene;
    match: import("@/lib/knowledge/scene-kb").SceneMatch;
  }>;
  /** scene-KB: CV/VLM class agreement for this reference (learnExemplar gate input). */
  sceneCvVlmAgree?: boolean;

  // ── buildTemplate outputs ──
  faceInfo?: ReturnType<typeof extractFaceInfo>;
  dynamicTemplate?: ReturnType<typeof generateTemplate>;

  // ── prepareContent outputs ──
  allArollTranscriptions?: Array<{ words: ArollWord[]; sentences: ArollSentence[] }>;
  arollClipMeta?: Array<{ path: string; duration: number; timelineStart: number }>;
  mergedTranscription?: { words: ArollWord[]; sentences: ArollSentence[] };
  allBrollScenes?: BrollSceneInfo[];
  brollClipMeta?: Array<{ path: string; duration: number; inputIndex: number }>;
  totalBrollDuration?: number;
  narrativeContext?: Awaited<ReturnType<typeof analyzeNarrativeContext>>;
  speechKeywords?: Awaited<ReturnType<typeof extractSpeechKeywords>>;

  // ── buildPlan outputs ──
  editingPlan?: ReturnType<typeof buildEditingPlan>;
  /** UNIVERSAL-1 Wave 2: set when layoutClass is multi_region_stack / pip_over_fullscreen. */
  nregionPlan?: NRegionPlan;
  referenceStyle?: BrollStyleResult | null;
  plannedModalityOf?: Record<number, string>;
  brollSlots?: Parameters<typeof applyCreativeDirector>[1]["brollSlots"];

  // ── renderVideo outputs (the captioned final output when captions succeed) ──
  outputFilename?: string;
  outputPath?: string;
}
