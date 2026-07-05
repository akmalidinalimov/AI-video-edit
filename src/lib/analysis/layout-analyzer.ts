/**
 * layout-analyzer.ts — Node wrapper for the deterministic reference LAYOUT analyzer
 * (scripts/python/layout_analyzer.py). Fuses geometry (OpenCV) + face-persistence (YuNet)
 * + temporal variance to measure, from the pixels, the A-roll/B-roll regions + SIDE + a
 * confidence/evidence — replacing Gemini's eyeballed boxes and resolving the split-side
 * inversion that geometry alone can't. Non-blocking: returns null if the CV stack is absent.
 *
 * Foundation layer (Stages 1-2 spatial + shot + self-verify). Later layers (transitions,
 * motion, captions, self-learning library) extend the same blueprint.
 */
import { execFileSync } from "child_process";
import path from "path";
import fs from "fs";

export interface LayoutRegion { x: number; y: number; width: number; height: number }

export interface LayoutAnalysis {
  duration: number;
  fps: number;
  dims: [number, number];
  /** Persistent horizontal-edge strength per grid row (normalized 0..1, GRID_H rows) —
   *  used by the unified decode to seam-snap VLM band boundaries. */
  edgeProfile?: number[];
  layout: {
    type: "split" | "circle_pip" | "rect_pip" | "fullscreen" | string;
    arollSide: "top" | "bottom";
    arollRegion: LayoutRegion;
    brollRegion: LayoutRegion;
    brollAspect: number;
    arollAspect: number;
    dividerFraction: number | null;
    shape: "rectangle" | "circle" | string;
    confidence: number;
    /** 0..1 — how strongly the evidence supports a real composited split (vs fullscreen). */
    splitScore: number;
    /** True when splitScore is borderline (0.4–0.6) → flag for human confirmation. */
    typeUncertain: boolean;
    evidence: {
      face: { cyN: number; coverage: number; side: string; score: number } | null;
      temporalSide: string;
      /** Fixed top/bottom-third quieter side — the INDEPENDENT side cross-check backing sideAgree. */
      independentSide: string;
      temporalContrast: number;
      seamProminence: number | null;
      geometryDivider: number | null;
      /** True iff the face sits on the independently-quieter third (genuine cross-check). */
      sideAgree: boolean;
      /** The older divider-derived agreement (kept for transparency; partly self-fulfilling). */
      sideAgreeDivider: boolean;
      geometryAgree: boolean;
    };
  };
  segments: Array<{ start: number; end: number }>;
  rhythm: { shots: number; avgShotSec: number; cutFrequency: "fast" | "moderate" | "slow" | string };
  transitions: {
    perBoundary: Array<{ at: number; type: "cut" | "crossfade" | string; duration: number }>;
    summary: Record<string, number>;
    dominant: string;
  };
  motion: {
    perShot: Array<{
      start: number;
      camera: "static" | "push_in" | "pull_out" | "pan" | "tilt" | "handheld" | "slow_move" | string;
      magnitude: number; radial?: number; pan?: number; tilt?: number;
    }>;
    summary: Record<string, number>;
    dominant: string;
  };
  /** CV best-effort caption band; Gemini (semantics stage) is authoritative for text+style. */
  captions: {
    present: boolean;
    cyN?: number;
    bandFrac?: [number, number];
    region?: LayoutRegion;
    strength?: number;
    note?: string;
  };
  /** PIP-on-PIP / inset sub-regions inside the B-roll band; [] is the common case. */
  overlays: Array<{ approxRegion: number[]; frames: number }>;
  /** Optional Gemini semantics layer (Stage 7), merged in by the Node wrapper when enabled. */
  semantics?: LayoutSemantics | null;
  /** Optional matched archetype (Stage 10 self-learning library). */
  archetype?: { id: string; name: string; matchScore: number; novel: boolean } | null;
}

export interface LayoutSemantics {
  captions: {
    present: boolean;
    position: string;        // e.g. "lower-third", "below-divider", "centered"
    style: string;           // e.g. "bold white sans, word-by-word highlight"
    animation: string;       // e.g. "word pop-in", "fade-up", "none"
    sampleText?: string;
  } | null;
  shots: Array<{ start: number; end: number; content: string; role: string }>;
  overlays: Array<{ kind: string; description: string }>;
  styleKeywords: string[];
  summary: string;
}

const VENV_PY = path.join(process.cwd(), "scripts", "python", ".venv", "Scripts", "python.exe");
const SCRIPT = path.join(process.cwd(), "scripts", "python", "layout_analyzer.py");

/** True if the layout-analyzer CV toolchain is present. */
export function layoutAnalyzerAvailable(): boolean {
  return fs.existsSync(VENV_PY) && fs.existsSync(SCRIPT);
}

/** Measure the reference's layout from the pixels. Returns null on any failure (non-blocking). */
export function analyzeLayout(videoPath: string): LayoutAnalysis | null {
  if (!layoutAnalyzerAvailable()) { console.warn("[layout-analyzer] CV toolchain not found"); return null; }
  try {
    const out = execFileSync(VENV_PY, [SCRIPT, videoPath], { stdio: "pipe", timeout: 300_000 }).toString();
    const parsed = JSON.parse(out) as LayoutAnalysis | { error: string };
    if ("error" in parsed) { console.error("[layout-analyzer]", parsed.error); return null; }
    return parsed;
  } catch (e) {
    console.error("[layout-analyzer] failed (non-blocking):", (e as Error).message?.slice(0, 200));
    return null;
  }
}
