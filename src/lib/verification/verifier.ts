/**
 * Closed-Loop Verification Engine
 *
 * Compares a generated timeline against the reference StyleProfile
 * and scores it across 6 dimensions. Returns a detailed report
 * with issues that can be auto-fixed.
 *
 * Dimensions (100 points total):
 * 1. Element Placement Accuracy (25 pts)
 * 2. Layout Matching (15 pts)
 * 3. No Repetition (20 pts)
 * 4. Transcript Continuity (15 pts)
 * 5. Timing Accuracy (10 pts)
 * 6. Visual Style Match (15 pts)
 */

import type { StyleProfile } from "@/lib/types/styleProfile";
import type { TimelineDefinition, TimelineSegment } from "@/lib/types/timeline";
import type { ARollClipAnalysis, BRollCatalogEntry } from "@/lib/types/project";
import {
  extractCoordinateBlueprint,
  isInSafeArea,
  checkElementCollision,
  type VideoCoordinateBlueprint,
  type ElementCoordinate,
} from "./coordinateMap";

export type IssueSeverity = "critical" | "major" | "minor";
export type IssueCategory =
  | "placement"
  | "layout"
  | "repetition"
  | "transcript"
  | "timing"
  | "style";

export interface VerificationIssue {
  id: string;
  category: IssueCategory;
  severity: IssueSeverity;
  segmentId?: string;
  segmentIndex?: number;
  description: string;
  expected?: unknown;
  actual?: unknown;
  /** Points deducted for this issue */
  pointsLost: number;
  /** Auto-fix available? */
  autoFixable: boolean;
  /** Fix function key */
  fixKey?: string;
}

export interface DimensionScore {
  name: string;
  maxPoints: number;
  scored: number;
  issues: VerificationIssue[];
}

export interface VerificationReport {
  /** Overall score 0-100 */
  totalScore: number;
  /** Individual dimension scores */
  dimensions: DimensionScore[];
  /** All issues found */
  issues: VerificationIssue[];
  /** Number of auto-fixable issues */
  autoFixableCount: number;
  /** Whether the 95% threshold is met */
  passesThreshold: boolean;
  /** Iteration number in the verification loop */
  iteration: number;
  /** Coordinate blueprint used for verification */
  blueprint: VideoCoordinateBlueprint;
}

/**
 * Run full verification of a timeline against its reference.
 */
export function verifyTimeline(
  timeline: TimelineDefinition,
  style: StyleProfile,
  clips: ARollClipAnalysis[],
  brollCatalog: BRollCatalogEntry[],
  iteration: number = 1
): VerificationReport {
  const blueprint = extractCoordinateBlueprint(style);
  const allIssues: VerificationIssue[] = [];

  // Run all dimension checks
  const d1 = checkPlacementAccuracy(timeline, blueprint, style);
  const d2 = checkLayoutMatching(timeline, blueprint);
  const d3 = checkNoRepetition(timeline, brollCatalog);
  const d4 = checkTranscriptContinuity(timeline, clips);
  const d5 = checkTimingAccuracy(timeline, style);
  const d6 = checkVisualStyleMatch(timeline, style);

  const dimensions = [d1, d2, d3, d4, d5, d6];
  for (const dim of dimensions) {
    allIssues.push(...dim.issues);
  }

  const totalScore = dimensions.reduce((sum, d) => sum + d.scored, 0);

  return {
    totalScore,
    dimensions,
    issues: allIssues,
    autoFixableCount: allIssues.filter((i) => i.autoFixable).length,
    passesThreshold: totalScore >= 95,
    iteration,
    blueprint,
  };
}

// ─── Dimension 1: Element Placement Accuracy (25 pts) ─────────────────────

function checkPlacementAccuracy(
  timeline: TimelineDefinition,
  blueprint: VideoCoordinateBlueprint,
  style: StyleProfile
): DimensionScore {
  const maxPoints = 25;
  const issues: VerificationIssue[] = [];
  let deductions = 0;

  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];

    // Find matching blueprint segment
    const ratio = i / Math.max(timeline.segments.length - 1, 1);
    const bpIndex = Math.min(
      Math.round(ratio * (blueprint.segments.length - 1)),
      blueprint.segments.length - 1
    );
    const bpSeg = blueprint.segments[bpIndex];
    if (!bpSeg) continue;

    // Check A-roll position
    const expectedAroll = bpSeg.elements.find((e) => e.elementType === "aroll");
    if (expectedAroll && seg.aroll) {
      const dx = Math.abs(seg.aroll.position[0] - expectedAroll.position[0]);
      const dy = Math.abs(seg.aroll.position[1] - expectedAroll.position[1]);
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > 200) {
        const pts = Math.min(3, distance / 200);
        deductions += pts;
        issues.push({
          id: `placement_aroll_${i}`,
          category: "placement",
          severity: distance > 400 ? "critical" : "major",
          segmentId: seg.id,
          segmentIndex: i,
          description: `A-roll PIP is ${Math.round(distance)}px away from reference position`,
          expected: expectedAroll.position,
          actual: seg.aroll.position,
          pointsLost: pts,
          autoFixable: true,
          fixKey: "fix_aroll_position",
        });
      }

      // Check A-roll safe area — skip for full-width layouts (vertical_split, side_by_side)
      // where the A-roll is intentionally edge-to-edge
      const isFullWidthLayout = seg.layout === "vertical_split" || seg.layout === "side_by_side";
      if (!isFullWidthLayout && !isInSafeArea(seg.aroll.position, seg.aroll.size)) {
        deductions += 1;
        issues.push({
          id: `placement_aroll_safe_${i}`,
          category: "placement",
          severity: "minor",
          segmentId: seg.id,
          segmentIndex: i,
          description: "A-roll PIP extends outside safe area",
          pointsLost: 1,
          autoFixable: true,
          fixKey: "fix_safe_area",
        });
      }
    } else if (expectedAroll && !seg.aroll && seg.layout === "pip_overlay") {
      // Expected A-roll but missing
      deductions += 4;
      issues.push({
        id: `placement_aroll_missing_${i}`,
        category: "placement",
        severity: "critical",
        segmentId: seg.id,
        segmentIndex: i,
        description: "Reference has A-roll PIP but generated segment is missing it",
        expected: expectedAroll.position,
        pointsLost: 4,
        autoFixable: true,
        fixKey: "add_missing_aroll",
      });
    }

    // Check B-roll position and size match reference layout
    const refBroll = style.segments[bpIndex]?.broll;
    if (refBroll && seg.broll) {
      const brollPos = seg.broll.position ?? [0, 0];
      const brollSize = seg.broll.size ?? [1080, 1920];
      const refPos = refBroll.position;
      const refSize = refBroll.size;

      // Check position
      const bDx = Math.abs(brollPos[0] - refPos[0]);
      const bDy = Math.abs(brollPos[1] - refPos[1]);
      if (bDx > 100 || bDy > 100) {
        const pts = Math.min(2, Math.sqrt(bDx * bDx + bDy * bDy) / 200);
        deductions += pts;
        issues.push({
          id: `placement_broll_pos_${i}`,
          category: "placement",
          severity: "major",
          segmentId: seg.id,
          segmentIndex: i,
          description: `B-roll position [${brollPos}] differs from reference [${refPos}]`,
          expected: refPos,
          actual: brollPos,
          pointsLost: pts,
          autoFixable: true,
          fixKey: "fix_broll_position",
        });
      }

      // Check size
      const bSw = Math.abs(brollSize[0] - refSize[0]);
      const bSh = Math.abs(brollSize[1] - refSize[1]);
      if (bSw > 100 || bSh > 200) {
        const pts = Math.min(2, (bSw + bSh) / 400);
        deductions += pts;
        issues.push({
          id: `placement_broll_size_${i}`,
          category: "placement",
          severity: "major",
          segmentId: seg.id,
          segmentIndex: i,
          description: `B-roll size [${brollSize}] differs from reference [${refSize}]`,
          expected: refSize,
          actual: brollSize,
          pointsLost: pts,
          autoFixable: true,
          fixKey: "fix_broll_size",
        });
      }
    }

    // Check text overlay count — if reference has text overlays, we should too
    const refTextOverlays = style.segments[bpIndex]?.text_overlays ?? [];
    if (refTextOverlays.length > 0 && seg.text_overlays.length === 0) {
      deductions += 2;
      issues.push({
        id: `placement_text_missing_${i}`,
        category: "placement",
        severity: "major",
        segmentId: seg.id,
        segmentIndex: i,
        description: `Reference has ${refTextOverlays.length} text overlays but generated segment has none`,
        expected: refTextOverlays.length,
        actual: 0,
        pointsLost: 2,
        autoFixable: false,
      });
    }

    // Check text overlay positions
    const expectedTexts = bpSeg.elements.filter((e) => e.elementType === "text_overlay");
    for (let j = 0; j < Math.min(expectedTexts.length, seg.text_overlays.length); j++) {
      const expected = expectedTexts[j];
      const actual = seg.text_overlays[j];
      const dx = Math.abs(actual.position[0] - expected.position[0]);
      const dy = Math.abs(actual.position[1] - expected.position[1]);
      if (dx > 150 || dy > 150) {
        deductions += 1;
        issues.push({
          id: `placement_text_${i}_${j}`,
          category: "placement",
          severity: "minor",
          segmentId: seg.id,
          segmentIndex: i,
          description: `Text overlay ${j} is ${Math.round(Math.sqrt(dx * dx + dy * dy))}px from reference position`,
          expected: expected.position,
          actual: actual.position,
          pointsLost: 1,
          autoFixable: true,
          fixKey: "fix_text_position",
        });
      }
    }
  }

  return {
    name: "Element Placement Accuracy",
    maxPoints,
    scored: Math.max(0, maxPoints - deductions),
    issues,
  };
}

// ─── Dimension 2: Layout Matching (15 pts) ────────────────────────────────

function checkLayoutMatching(
  timeline: TimelineDefinition,
  blueprint: VideoCoordinateBlueprint
): DimensionScore {
  const maxPoints = 15;
  const issues: VerificationIssue[] = [];
  let deductions = 0;

  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    const ratio = i / Math.max(timeline.segments.length - 1, 1);
    const bpIndex = Math.min(
      Math.round(ratio * (blueprint.segments.length - 1)),
      blueprint.segments.length - 1
    );
    const bpSeg = blueprint.segments[bpIndex];
    if (!bpSeg) continue;

    if (seg.layout !== bpSeg.layout) {
      deductions += 2.5;
      issues.push({
        id: `layout_mismatch_${i}`,
        category: "layout",
        severity: "major",
        segmentId: seg.id,
        segmentIndex: i,
        description: `Layout mismatch: expected "${bpSeg.layout}", got "${seg.layout}"`,
        expected: bpSeg.layout,
        actual: seg.layout,
        pointsLost: 2.5,
        autoFixable: true,
        fixKey: "fix_layout",
      });
    }
  }

  return {
    name: "Layout Matching",
    maxPoints,
    scored: Math.max(0, maxPoints - deductions),
    issues,
  };
}

// ─── Dimension 3: No Repetition (20 pts) ──────────────────────────────────

function checkNoRepetition(
  timeline: TimelineDefinition,
  brollCatalog: BRollCatalogEntry[]
): DimensionScore {
  const maxPoints = 20;
  const issues: VerificationIssue[] = [];
  let deductions = 0;

  // Check B-roll source repetition with same startFrom
  const brollUsage = new Map<string, { startFrom: number; segIndex: number }[]>();

  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    if (!seg.broll.src) continue;

    const key = seg.broll.src;
    const usage = brollUsage.get(key) ?? [];
    usage.push({ startFrom: seg.broll.startFrom ?? 0, segIndex: i });
    brollUsage.set(key, usage);
  }

  for (const [src, usages] of brollUsage) {
    if (usages.length <= 1) continue;

    // Check if same source is used with same startFrom (exact repetition)
    const startTimes = usages.map((u) => u.startFrom);
    const uniqueStarts = new Set(startTimes.map((t) => Math.round(t * 10) / 10)); // round to 0.1s

    if (uniqueStarts.size < usages.length) {
      const repeatedCount = usages.length - uniqueStarts.size;
      const pts = Math.min(15, repeatedCount * 5);
      deductions += pts;
      issues.push({
        id: `repetition_broll_${src}`,
        category: "repetition",
        severity: "critical",
        description: `B-roll "${src.split("/").pop()}" repeats ${repeatedCount} time(s) with same start time`,
        expected: "Each segment shows different portion of B-roll",
        actual: `${usages.length} uses, only ${uniqueStarts.size} unique start times`,
        pointsLost: pts,
        autoFixable: true,
        fixKey: "fix_broll_repetition",
      });
    }

    // Check if start times are too close (visually similar content)
    const sorted = [...startTimes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i] - sorted[i - 1]) < 0.5) {
        deductions += 2;
        issues.push({
          id: `repetition_broll_close_${i}`,
          category: "repetition",
          severity: "major",
          description: `B-roll segments ${i - 1} and ${i} start only ${(sorted[i] - sorted[i - 1]).toFixed(1)}s apart — visually similar content`,
          pointsLost: 2,
          autoFixable: true,
          fixKey: "fix_broll_spacing",
        });
      }
    }
  }

  // Check A-roll audio continuity (should not have gaps or repeats)
  const voiceTracks = timeline.audio.filter((t) => t.type === "aroll_voice");
  for (let i = 1; i < voiceTracks.length; i++) {
    const prev = voiceTracks[i - 1];
    const curr = voiceTracks[i];
    const gap = curr.start_frame - prev.end_frame;

    if (gap < -5) {
      // Overlapping audio = repeated content
      deductions += 3;
      issues.push({
        id: `repetition_audio_overlap_${i}`,
        category: "repetition",
        severity: "major",
        description: `Audio tracks ${i - 1} and ${i} overlap by ${Math.abs(gap)} frames — possible content repetition`,
        pointsLost: 3,
        autoFixable: false,
      });
    }
  }

  return {
    name: "No Repetition",
    maxPoints,
    scored: Math.max(0, maxPoints - deductions),
    issues,
  };
}

// ─── Dimension 4: Transcript Continuity (15 pts) ──────────────────────────

function checkTranscriptContinuity(
  timeline: TimelineDefinition,
  clips: ARollClipAnalysis[]
): DimensionScore {
  const maxPoints = 15;
  const issues: VerificationIssue[] = [];
  let deductions = 0;

  // Check caption lines are sequential and continuous
  const lines = timeline.captions.lines;
  if (lines.length === 0) {
    deductions += 5;
    issues.push({
      id: "transcript_no_captions",
      category: "transcript",
      severity: "major",
      description: "No caption lines generated — transcript not rendered",
      pointsLost: 5,
      autoFixable: false,
    });
  } else {
    // Check for gaps in caption timing
    for (let i = 1; i < lines.length; i++) {
      const prevEnd = lines[i - 1].end_frame;
      const currStart = lines[i].start_frame;
      const gapFrames = currStart - prevEnd;

      if (gapFrames > 30) {
        // More than 1 second gap
        deductions += 1;
        issues.push({
          id: `transcript_gap_${i}`,
          category: "transcript",
          severity: "minor",
          segmentIndex: i,
          description: `Caption gap of ${(gapFrames / 30).toFixed(1)}s between lines ${i - 1} and ${i}`,
          pointsLost: 1,
          autoFixable: false,
        });
      }
    }

    // Check word-level timing exists
    const wordsWithTiming = lines.filter(
      (l) => l.words && l.words.length > 0 && l.words[0].start_frame > 0
    );
    if (wordsWithTiming.length < lines.length * 0.5) {
      deductions += 3;
      issues.push({
        id: "transcript_no_word_timing",
        category: "transcript",
        severity: "major",
        description: `Only ${wordsWithTiming.length}/${lines.length} caption lines have word-level timing`,
        pointsLost: 3,
        autoFixable: false,
      });
    }

    // Check caption text matches original transcription
    if (clips.length > 0) {
      const fullTranscript = clips
        .map((c) => c.analysis.transcription.full_text)
        .join(" ")
        .toLowerCase()
        .replace(/[^\w\s]/g, "");
      const captionText = lines
        .map((l) => l.text)
        .join(" ")
        .toLowerCase()
        .replace(/[^\w\s]/g, "");

      // Check first/last words match (continuity check)
      const transcriptWords = fullTranscript.split(/\s+/).filter(Boolean);
      const captionWords = captionText.split(/\s+/).filter(Boolean);

      if (captionWords.length > 0 && transcriptWords.length > 0) {
        // Check coverage: what % of transcript words appear in captions
        const matchedWords = captionWords.filter((w) => transcriptWords.includes(w));
        const coverage = matchedWords.length / Math.max(transcriptWords.length, 1);

        if (coverage < 0.5) {
          deductions += 4;
          issues.push({
            id: "transcript_low_coverage",
            category: "transcript",
            severity: "critical",
            description: `Only ${Math.round(coverage * 100)}% of transcript words appear in captions`,
            expected: ">80% coverage",
            actual: `${Math.round(coverage * 100)}%`,
            pointsLost: 4,
            autoFixable: false,
          });
        }
      }
    }
  }

  return {
    name: "Transcript Continuity",
    maxPoints,
    scored: Math.max(0, maxPoints - deductions),
    issues,
  };
}

// ─── Dimension 5: Timing Accuracy (10 pts) ────────────────────────────────

function checkTimingAccuracy(
  timeline: TimelineDefinition,
  style: StyleProfile
): DimensionScore {
  const maxPoints = 10;
  const issues: VerificationIssue[] = [];
  let deductions = 0;

  // Check segment count matches reference pacing
  const refSegCount = style.editing_rhythm.total_segments ?? style.segments.length;
  const genSegCount = timeline.segments.length;
  const segDiff = Math.abs(refSegCount - genSegCount);

  if (segDiff > 2) {
    deductions += 3;
    issues.push({
      id: "timing_segment_count",
      category: "timing",
      severity: "major",
      description: `Segment count differs: reference has ${refSegCount}, generated has ${genSegCount}`,
      expected: refSegCount,
      actual: genSegCount,
      pointsLost: 3,
      autoFixable: false,
    });
  }

  // Check average segment duration matches reference pacing
  const refAvgDuration = style.editing_rhythm.avg_segment_duration;
  const genAvgDuration = timeline.duration / Math.max(timeline.segments.length, 1);
  const durationRatio = genAvgDuration / Math.max(refAvgDuration, 0.1);

  if (durationRatio < 0.5 || durationRatio > 2.0) {
    deductions += 3;
    issues.push({
      id: "timing_avg_duration",
      category: "timing",
      severity: "major",
      description: `Average segment duration (${genAvgDuration.toFixed(1)}s) differs significantly from reference (${refAvgDuration.toFixed(1)}s)`,
      expected: refAvgDuration,
      actual: genAvgDuration,
      pointsLost: 3,
      autoFixable: false,
    });
  }

  // Check for zero-length segments
  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    const duration = (seg.end_frame - seg.start_frame) / timeline.fps;
    if (duration < 0.5) {
      deductions += 2;
      issues.push({
        id: `timing_short_seg_${i}`,
        category: "timing",
        severity: "critical",
        segmentId: seg.id,
        segmentIndex: i,
        description: `Segment ${i} is only ${duration.toFixed(2)}s — too short to be visible`,
        pointsLost: 2,
        autoFixable: false,
      });
    }
  }

  return {
    name: "Timing Accuracy",
    maxPoints,
    scored: Math.max(0, maxPoints - deductions),
    issues,
  };
}

// ─── Dimension 6: Visual Style Match (15 pts) ─────────────────────────────

function checkVisualStyleMatch(
  timeline: TimelineDefinition,
  style: StyleProfile
): DimensionScore {
  const maxPoints = 15;
  const issues: VerificationIssue[] = [];
  let deductions = 0;

  // Check color grade matches
  const refCg = style.color_grade;
  const genCg = timeline.color_grade;

  if (refCg.temperature !== genCg.temperature) {
    deductions += 2;
    issues.push({
      id: "style_color_temp",
      category: "style",
      severity: "minor",
      description: `Color temperature mismatch: reference "${refCg.temperature}", generated "${genCg.temperature}"`,
      expected: refCg.temperature,
      actual: genCg.temperature,
      pointsLost: 2,
      autoFixable: true,
      fixKey: "fix_color_grade",
    });
  }

  // Check PIP style — compare against per-segment reference shape, not just global pip_style
  {
    const blueprint = extractCoordinateBlueprint(style);
    const hasArollSegments = timeline.segments.filter((s) => s.aroll);
    for (let si = 0; si < hasArollSegments.length; si++) {
      const seg = hasArollSegments[si];
      if (!seg.aroll) continue;

      // Find the matching blueprint segment's expected shape
      const segIdx = timeline.segments.indexOf(seg);
      const ratio = segIdx / Math.max(timeline.segments.length - 1, 1);
      const bpIndex = Math.min(
        Math.round(ratio * (blueprint.segments.length - 1)),
        blueprint.segments.length - 1
      );
      const bpSeg = blueprint.segments[bpIndex];
      const expectedAroll = bpSeg?.elements.find((e) => e.elementType === "aroll");
      const expectedShape = expectedAroll?.shape ?? style.pip_style.shape;

      if (seg.aroll.shape !== expectedShape) {
        deductions += 1;
        issues.push({
          id: `style_pip_shape_${seg.id}`,
          category: "style",
          severity: "minor",
          segmentId: seg.id,
          description: `PIP shape "${seg.aroll.shape}" doesn't match reference "${expectedShape}"`,
          expected: expectedShape,
          actual: seg.aroll.shape,
          pointsLost: 1,
          autoFixable: true,
          fixKey: "fix_pip_shape",
        });
      }
    }
  }

  // Check transitions match reference preference
  const refTransStyle = style.editing_rhythm.cut_style;
  const hasTransitions = timeline.segments.filter(
    (s) => s.transition_in && s.transition_in.type !== "none" && s.transition_in.type !== "cut"
  ).length;
  const transitionRatio = hasTransitions / Math.max(timeline.segments.length, 1);

  if (refTransStyle === "hard_cut" && transitionRatio > 0) {
    deductions += 2;
    issues.push({
      id: "style_too_many_transitions",
      category: "style",
      severity: "minor",
      description: `Reference uses hard cuts, but ${Math.round(transitionRatio * 100)}% of segments have transitions`,
      pointsLost: 2,
      autoFixable: true,
      fixKey: "fix_transitions",
    });
  } else if (refTransStyle === "smooth_transition" && transitionRatio < 0.3) {
    deductions += 2;
    issues.push({
      id: "style_too_few_transitions",
      category: "style",
      severity: "minor",
      description: `Reference uses smooth transitions, but only ${Math.round(transitionRatio * 100)}% of segments have them`,
      pointsLost: 2,
      autoFixable: true,
      fixKey: "fix_transitions",
    });
  }

  // Check hook presence
  const refHasHook = style.segments.some(
    (s) => s.text_overlays.length > 0 && (s.start as number) < 3
  );
  if (refHasHook && !timeline.hook) {
    deductions += 2;
    issues.push({
      id: "style_missing_hook",
      category: "style",
      severity: "major",
      description: "Reference video has engagement hook in first 3s, but generated video has none",
      pointsLost: 2,
      autoFixable: false,
    });
  }

  return {
    name: "Visual Style Match",
    maxPoints,
    scored: Math.max(0, maxPoints - deductions),
    issues,
  };
}
