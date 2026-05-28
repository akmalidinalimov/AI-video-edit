/**
 * Editing Plan — The structured intermediate format
 *
 * This is the CONTRACT between analysis (Phase 1-2) and rendering (Phase 3).
 *
 * The editing plan answers: "What exactly should every frame of this video
 * look like?" It contains:
 *
 * 1. Which VCS template to use
 * 2. Timeline ranges — what layout is active when
 * 3. Text overlays — what text appears where and when
 * 4. Transition boundaries — frame-aligned, sentence-snapped
 * 5. A-roll/B-roll source paths
 * 6. Enable expressions — pre-computed for FFmpeg
 *
 * RULES:
 * - The plan is COMPLETE: every second of video is accounted for
 * - The plan is UNAMBIGUOUS: no decisions left for the renderer
 * - The plan is VALIDATED before rendering (see validateEditingPlan)
 * - When something looks wrong, fix the PLAN, not the renderer
 * - The renderer is a pure function: plan → video
 */

import type { VCSTemplate, LayoutVariant, BorderDef } from "./vcs-templates";

// ════════════════════════════════════════════════════════════
// EDITING PLAN TYPES
// ════════════════════════════════════════════════════════════

export interface TimeRange {
  /** Start time in seconds (frame-aligned) */
  start: number;
  /** End time in seconds (frame-aligned) */
  end: number;
}

export interface SentenceInfo {
  /** The sentence text */
  text: string;
  /** When the first word starts */
  start: number;
  /** When the last word ends */
  end: number;
  /** Index in the original transcription */
  index: number;
  /** Semantic tags describing what this sentence is about (e.g., ["app_demo", "tutorial_step"]) */
  semanticTags?: string[];
}

export interface TextOverlay {
  /** Which text slot from the VCS template to use */
  slotId: string;
  /** The actual text content */
  text: string;
  /** Override font size (or use slot default) */
  fontSize?: number;
  /** Override font color as FFmpeg hex (or use slot default) */
  fontColor?: string;
  /** Override font file path (or use slot default) */
  fontFile?: string;
  /** Override background color (or use slot default) */
  bgColor?: string;
  /** Override background padding (or use slot default) */
  bgPadding?: number;
}

export interface LayoutRange {
  /** Unique ID for this range */
  id: string;
  /** Which layout variant from the VCS template */
  layoutId: string;
  /** Time range this layout is active (frame-aligned) */
  timeRange: TimeRange;
  /** Which sentence(s) this range covers */
  sentences: SentenceInfo[];
  /** Text overlays active during this range */
  textOverlays: TextOverlay[];
  /** Why this layout was chosen (for audit trail) */
  reasoning: string;
  /** Aggregated semantic tags from all sentences in this range */
  semanticTags?: string[];
  /** B-roll content tags relevant to this range (from B-roll analysis) */
  brollContentTags?: string[];
  /** B-roll seek offset: which time in the B-roll video to show during this range */
  brollOffset?: number;
  /** B-roll source index (for multi-B-roll support; 0-based) */
  brollSourceIndex?: number;

  // ── Direct replication: per-range coordinate overrides ──

  /**
   * Optional per-range layout override with exact coordinates from the
   * reference blueprint segment. When present, the renderer uses these
   * instead of the template's canonical (median-aggregated) coordinates.
   *
   * This enables "direct replication" — reproducing the exact layout
   * of each reference segment rather than using clustered averages.
   */
  layoutOverride?: {
    aroll?: {
      region: { x: number; y: number; width: number; height: number };
      shape: "rectangle" | "circle";
      hasBorder?: boolean;
      borderColor?: string | null;
      borderWidth?: number;
    };
    broll?: {
      region: { x: number; y: number; width: number; height: number };
      isBackground?: boolean;
    };
    headerZone?: {
      region: { x: number; y: number; width: number; height: number };
    };
    texts?: Array<{
      text: string;
      region: { x: number; y: number; width: number; height: number };
      fontSize?: number;
      color?: string;
      backgroundColor?: string | null;
      fontWeight?: string;
    }>;
  };

  // ── Pre-computed for renderer ──

  /** Start frame number */
  startFrame: number;
  /** End frame number (exclusive for transitions, inclusive for last range) */
  endFrame: number;
  /** Pre-computed FFmpeg enable expression for this range */
  enableExpr: string;
}

export interface TransitionPoint {
  /** Time of the transition (frame-aligned) */
  time: number;
  /** Frame number of the transition */
  frame: number;
  /** Layout ending at this point */
  fromLayoutId: string;
  /** Layout starting at this point */
  toLayoutId: string;
  /** Which sentence boundary this snaps to */
  sentenceBoundary: {
    /** The sentence that ends before this transition */
    endingSentence: SentenceInfo;
    /** The sentence that starts after this transition */
    startingSentence: SentenceInfo;
  };
  /** Midpoint time used in enable expressions (between adjacent frame PTS values) */
  midpointTime: number;
}

export interface SourceFiles {
  /** Path to the A-roll video (camera footage with audio) */
  aroll: string;
  /** Path to the B-roll video (screen recording / demo footage) */
  broll: string;
  /** Path to the reference video (for comparison, not used in render) */
  reference?: string;
  /**
   * Multiple A-roll videos in upload order. When present, `aroll` is the
   * first element's path. Each clip is transcribed independently and
   * concatenated in sequence. Audio maps from the continuous A-roll chain.
   */
  arollClips?: Array<{
    path: string;
    /** Duration of this clip in seconds */
    duration: number;
    /** Cumulative start time in the final timeline */
    timelineStart: number;
  }>;
  /**
   * Multiple B-roll videos in upload order. When present, `broll` is the
   * first element's path. The matcher picks the best B-roll source for
   * each layout range based on content affinity.
   */
  brollClips?: Array<{
    path: string;
    /** Duration of this clip in seconds */
    duration: number;
    /** FFmpeg input index (0-based offset from the first B-roll input) */
    inputIndex: number;
  }>;
}

export interface EditingPlan {
  /** Plan version for compatibility checking */
  version: number;
  /** When this plan was generated */
  generatedAt: string;

  // ── Template reference ──

  /** Which VCS template this plan uses */
  templateId: string;
  /** Canvas dimensions (copied from template for quick access) */
  canvas: { width: number; height: number };
  /** FPS (copied from template) */
  fps: number;

  // ── Source files ──

  sources: SourceFiles;

  // ── Transcription ──

  /** All sentences from A-roll transcription */
  sentences: SentenceInfo[];

  // ── Timeline ──

  /** Total video duration in seconds */
  totalDuration: number;
  /** Total frame count */
  totalFrames: number;

  /** Layout ranges — the core timeline. Every second is covered. */
  layoutRanges: LayoutRange[];

  /** Transition points between layouts */
  transitions: TransitionPoint[];

  // ── Validation metadata ──

  /** Whether this plan has been validated */
  validated: boolean;
  /** Validation errors (empty if valid) */
  validationErrors: string[];
}

// ════════════════════════════════════════════════════════════
// PLAN BUILDER
// ════════════════════════════════════════════════════════════

/**
 * Align a time value to the nearest frame boundary.
 */
export function alignToFrame(time: number, fps: number): number {
  return Math.round(time * fps) / fps;
}

/**
 * Compute the midpoint time between two adjacent frames.
 * Used for enable expression boundaries to avoid float comparison issues.
 *
 * Example: frames 118 and 119 at 30fps → midpoint = 118.5/30 = 3.95s
 * This is well away from either frame's PTS (3.933s and 3.967s).
 */
export function frameMidpoint(frame: number, fps: number): number {
  return (frame - 0.5) / fps;
}

/**
 * Build a `between(t, start, end)` enable expression for a layout range.
 *
 * Uses midpoint boundaries between frames for float-safe comparison.
 * Adjacent ranges share the same midpoint boundary — no overlap, no gap.
 *
 * @param startFrame - First active frame (inclusive)
 * @param endFrame - Last active frame + 1 (exclusive) for transitions
 * @param isLast - Whether this is the last range (extends generously past end)
 * @param fps - Frames per second
 */
export function buildEnableExprForRange(
  startFrame: number,
  endFrame: number,
  isLast: boolean,
  fps: number
): string {
  const tStart = Math.max(0, (startFrame - 0.5) / fps);
  const tEnd = isLast ? (endFrame + 5) / fps : (endFrame - 0.5) / fps;
  return `between(t,${tStart.toFixed(4)},${tEnd.toFixed(4)})`;
}

/**
 * Combine multiple enable expressions with addition (OR logic in FFmpeg).
 */
export function combineEnableExprs(exprs: string[]): string {
  return exprs.join("+");
}

// ════════════════════════════════════════════════════════════
// PLAN VALIDATOR
// ════════════════════════════════════════════════════════════

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate an editing plan before rendering.
 *
 * Checks:
 * 1. Every second of video is covered by exactly one layout range
 * 2. No overlapping ranges
 * 3. No gaps between ranges
 * 4. All layout IDs exist in the template
 * 5. All transitions are at sentence boundaries
 * 6. All times are frame-aligned
 * 7. Enable expressions are present for all ranges
 * 8. Source files are specified
 */
export function validateEditingPlan(
  plan: EditingPlan,
  template: VCSTemplate
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Check 1: Source files ──
  if (!plan.sources.aroll) errors.push("Missing A-roll source path");
  if (!plan.sources.broll) errors.push("Missing B-roll source path");

  // ── Check 2: Layout ranges exist ──
  if (plan.layoutRanges.length === 0) {
    errors.push("No layout ranges defined");
    return { valid: false, errors, warnings };
  }

  // ── Check 3: All layout IDs exist in template ──
  for (const range of plan.layoutRanges) {
    if (!template.layouts[range.layoutId]) {
      errors.push(
        `Range "${range.id}" references layout "${range.layoutId}" which doesn't exist in template "${template.id}". ` +
        `Available: ${Object.keys(template.layouts).join(", ")}`
      );
    }
  }

  // ── Check 4: First range starts at 0 ──
  const firstRange = plan.layoutRanges[0];
  if (firstRange.timeRange.start > 0.05) {
    errors.push(
      `First range starts at ${firstRange.timeRange.start}s, expected 0. ` +
      `Video would have ${firstRange.timeRange.start}s of undefined content at start.`
    );
  }

  // ── Check 5: No gaps or overlaps between consecutive ranges ──
  for (let i = 0; i < plan.layoutRanges.length - 1; i++) {
    const curr = plan.layoutRanges[i];
    const next = plan.layoutRanges[i + 1];
    const gap = next.timeRange.start - curr.timeRange.end;

    if (Math.abs(gap) > 0.001) {
      if (gap > 0) {
        errors.push(
          `Gap of ${gap.toFixed(4)}s between range "${curr.id}" (ends ${curr.timeRange.end}) ` +
          `and "${next.id}" (starts ${next.timeRange.start}). No layout active during gap.`
        );
      } else {
        errors.push(
          `Overlap of ${Math.abs(gap).toFixed(4)}s between range "${curr.id}" ` +
          `and "${next.id}". Both layouts active simultaneously.`
        );
      }
    }
  }

  // ── Check 6: Frame alignment ──
  const fps = plan.fps;
  for (const range of plan.layoutRanges) {
    const startAligned = alignToFrame(range.timeRange.start, fps);
    const endAligned = alignToFrame(range.timeRange.end, fps);
    if (Math.abs(range.timeRange.start - startAligned) > 0.0001) {
      warnings.push(
        `Range "${range.id}" start ${range.timeRange.start} not frame-aligned (nearest: ${startAligned})`
      );
    }
    if (Math.abs(range.timeRange.end - endAligned) > 0.0001) {
      warnings.push(
        `Range "${range.id}" end ${range.timeRange.end} not frame-aligned (nearest: ${endAligned})`
      );
    }
  }

  // ── Check 7: Enable expressions present ──
  for (const range of plan.layoutRanges) {
    if (!range.enableExpr) {
      errors.push(`Range "${range.id}" missing enable expression`);
    }
  }

  // ── Check 8: Transitions at sentence boundaries ──
  for (const transition of plan.transitions) {
    const sentEnd = transition.sentenceBoundary.endingSentence.end;
    const sentStart = transition.sentenceBoundary.startingSentence.start;

    // Transition should be between sentence end and sentence start
    if (transition.time < sentEnd - 0.1 || transition.time > sentStart + 0.1) {
      warnings.push(
        `Transition at ${transition.time}s may not be at a sentence boundary. ` +
        `Sentence ends at ${sentEnd}s, next starts at ${sentStart}s.`
      );
    }
  }

  // ── Check 9: Total duration consistency ──
  const lastRange = plan.layoutRanges[plan.layoutRanges.length - 1];
  if (Math.abs(lastRange.timeRange.end - plan.totalDuration) > 0.1) {
    warnings.push(
      `Last range ends at ${lastRange.timeRange.end}s but total duration is ${plan.totalDuration}s`
    );
  }

  // ── Check 10: Consecutive same-layout ranges should be merged ──
  for (let i = 0; i < plan.layoutRanges.length - 1; i++) {
    const curr = plan.layoutRanges[i];
    const next = plan.layoutRanges[i + 1];
    if (curr.layoutId === next.layoutId) {
      warnings.push(
        `Adjacent ranges "${curr.id}" and "${next.id}" use the same layout "${curr.layoutId}". ` +
        `They should be merged to avoid unnecessary transitions.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ════════════════════════════════════════════════════════════
// PLAN PRETTY PRINTER
// ════════════════════════════════════════════════════════════

/**
 * Print a human-readable summary of an editing plan.
 */
export function printEditingPlan(plan: EditingPlan): void {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║              EDITING PLAN                        ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Template: ${plan.templateId}`);
  console.log(`  Canvas: ${plan.canvas.width}×${plan.canvas.height} @ ${plan.fps}fps`);
  console.log(`  Duration: ${plan.totalDuration.toFixed(2)}s (${plan.totalFrames} frames)`);
  console.log(`  Sentences: ${plan.sentences.length}`);
  console.log(`  Layout ranges: ${plan.layoutRanges.length}`);
  console.log(`  Transitions: ${plan.transitions.length}`);
  console.log();

  // Timeline
  console.log("  ── TIMELINE ──");
  for (const range of plan.layoutRanges) {
    const dur = (range.timeRange.end - range.timeRange.start).toFixed(2);
    const sentIds = range.sentences.map(s => `S${s.index + 1}`).join("+");
    const texts = range.textOverlays.map(t => `"${t.text}"`).join(", ");
    console.log(
      `  ${range.timeRange.start.toFixed(2)}-${range.timeRange.end.toFixed(2)}s ` +
      `(${dur}s) | ${range.layoutId.padEnd(14)} | ${sentIds.padEnd(8)} | ${range.reasoning}`
    );
    if (texts) {
      console.log(`    Texts: ${texts}`);
    }
  }
  console.log();

  // Transitions
  if (plan.transitions.length > 0) {
    console.log("  ── TRANSITIONS ──");
    for (const t of plan.transitions) {
      console.log(
        `  @${t.time.toFixed(3)}s (frame ${t.frame}) | ${t.fromLayoutId} → ${t.toLayoutId} ` +
        `| midpoint: ${t.midpointTime.toFixed(4)}s`
      );
    }
    console.log();
  }

  // Validation
  if (plan.validated) {
    if (plan.validationErrors.length === 0) {
      console.log("  ── VALIDATION: PASS ──");
    } else {
      console.log("  ── VALIDATION: FAIL ──");
      for (const err of plan.validationErrors) {
        console.log(`    ✗ ${err}`);
      }
    }
  } else {
    console.log("  ── VALIDATION: NOT RUN ──");
  }
  console.log();
}
