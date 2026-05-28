/**
 * Auto-Fixer — Resolves verification issues automatically.
 *
 * Takes a timeline + verification report and applies fixes
 * for all auto-fixable issues. Returns the corrected timeline.
 */

import type { TimelineDefinition, TimelineSegment } from "@/lib/types/timeline";
import type { StyleProfile } from "@/lib/types/styleProfile";
import type { BRollCatalogEntry } from "@/lib/types/project";
import type { VerificationReport, VerificationIssue } from "./verifier";
import type { VideoCoordinateBlueprint } from "./coordinateMap";

export interface FixResult {
  timeline: TimelineDefinition;
  fixesApplied: string[];
  fixesFailed: string[];
}

/**
 * Apply all auto-fixable corrections to a timeline.
 */
export function autoFixTimeline(
  timeline: TimelineDefinition,
  report: VerificationReport,
  style: StyleProfile,
  brollCatalog: BRollCatalogEntry[]
): FixResult {
  let fixed = structuredClone(timeline);
  const applied: string[] = [];
  const failed: string[] = [];

  const fixableIssues = report.issues.filter((i) => i.autoFixable && i.fixKey);

  for (const issue of fixableIssues) {
    try {
      switch (issue.fixKey) {
        case "fix_aroll_position":
          fixed = fixArollPosition(fixed, issue, report.blueprint);
          applied.push(`Fixed A-roll position in segment ${issue.segmentIndex}`);
          break;

        case "fix_safe_area":
          fixed = fixSafeArea(fixed, issue);
          applied.push(`Moved element to safe area in segment ${issue.segmentIndex}`);
          break;

        case "add_missing_aroll":
          fixed = addMissingAroll(fixed, issue, report.blueprint, style);
          applied.push(`Added missing A-roll PIP to segment ${issue.segmentIndex}`);
          break;

        case "fix_text_position":
          fixed = fixTextPosition(fixed, issue, report.blueprint);
          applied.push(`Fixed text overlay position in segment ${issue.segmentIndex}`);
          break;

        case "fix_layout":
          fixed = fixLayout(fixed, issue);
          applied.push(`Fixed layout for segment ${issue.segmentIndex}: ${issue.actual} → ${issue.expected}`);
          break;

        case "fix_broll_repetition":
          fixed = fixBrollRepetition(fixed, brollCatalog);
          applied.push("Fixed B-roll repetition — staggered start times");
          break;

        case "fix_broll_spacing":
          fixed = fixBrollSpacing(fixed, brollCatalog);
          applied.push("Fixed B-roll spacing — increased separation between start times");
          break;

        case "fix_color_grade":
          fixed = fixColorGrade(fixed, style);
          applied.push(`Fixed color grade temperature: ${issue.actual} → ${issue.expected}`);
          break;

        case "fix_pip_shape":
          fixed = fixPipShape(fixed, issue, style);
          applied.push(`Fixed PIP shape in segment ${issue.segmentId}`);
          break;

        case "fix_transitions":
          fixed = fixTransitions(fixed, style);
          applied.push("Adjusted transition style to match reference");
          break;

        default:
          failed.push(`Unknown fix key: ${issue.fixKey}`);
      }
    } catch (err) {
      failed.push(`Fix ${issue.fixKey} failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return { timeline: fixed, fixesApplied: applied, fixesFailed: failed };
}

// ─── Individual Fix Functions ──────────────────────────────────────────────

function fixArollPosition(
  tl: TimelineDefinition,
  issue: VerificationIssue,
  blueprint: VideoCoordinateBlueprint
): TimelineDefinition {
  if (issue.segmentIndex === undefined || !issue.expected) return tl;

  const expected = issue.expected as [number, number];
  const segments = [...tl.segments];
  const seg = { ...segments[issue.segmentIndex] };

  if (seg.aroll) {
    seg.aroll = { ...seg.aroll, position: expected };
  }

  segments[issue.segmentIndex] = seg;
  return { ...tl, segments };
}

function fixSafeArea(tl: TimelineDefinition, issue: VerificationIssue): TimelineDefinition {
  if (issue.segmentIndex === undefined) return tl;

  const SAFE = 60;
  const W = 1080;
  const H = 1920;
  const segments = [...tl.segments];
  const seg = { ...segments[issue.segmentIndex] };

  if (seg.aroll) {
    // Position is TOP-LEFT corner of bounding box
    const [x, y] = seg.aroll.position;
    const [w, h] = seg.aroll.size;
    const clampedX = Math.max(SAFE, Math.min(W - SAFE - w, x));
    const clampedY = Math.max(SAFE, Math.min(H - SAFE - h, y));
    seg.aroll = { ...seg.aroll, position: [clampedX, clampedY] };
  }

  segments[issue.segmentIndex] = seg;
  return { ...tl, segments };
}

function addMissingAroll(
  tl: TimelineDefinition,
  issue: VerificationIssue,
  blueprint: VideoCoordinateBlueprint,
  style: StyleProfile
): TimelineDefinition {
  if (issue.segmentIndex === undefined) return tl;

  const segments = [...tl.segments];
  const seg = { ...segments[issue.segmentIndex] };

  // Find the first segment that has an A-roll src to reuse
  const existingAroll = tl.segments.find((s) => s.aroll?.src);
  if (!existingAroll?.aroll) return tl;

  const pos = (issue.expected as [number, number]) ?? blueprint.defaults.pipPosition;

  seg.aroll = {
    src: existingAroll.aroll.src,
    position: pos,
    size: [blueprint.defaults.pipSize, blueprint.defaults.pipSize] as [number, number],
    shape: blueprint.defaults.pipShape,
    border: style.pip_style.border,
    shadow: style.pip_style.shadow,
  };

  segments[issue.segmentIndex] = seg;
  return { ...tl, segments };
}

function fixTextPosition(
  tl: TimelineDefinition,
  issue: VerificationIssue,
  blueprint: VideoCoordinateBlueprint
): TimelineDefinition {
  if (issue.segmentIndex === undefined || !issue.expected) return tl;

  const expected = issue.expected as [number, number];
  const segments = [...tl.segments];
  const seg = { ...segments[issue.segmentIndex] };

  // Fix the first text overlay that doesn't match
  if (seg.text_overlays.length > 0) {
    seg.text_overlays = seg.text_overlays.map((overlay, j) => {
      if (j === 0) return { ...overlay, position: expected };
      return overlay;
    });
  }

  segments[issue.segmentIndex] = seg;
  return { ...tl, segments };
}

function fixLayout(tl: TimelineDefinition, issue: VerificationIssue): TimelineDefinition {
  if (issue.segmentIndex === undefined || !issue.expected) return tl;

  const segments = [...tl.segments];
  segments[issue.segmentIndex] = {
    ...segments[issue.segmentIndex],
    layout: issue.expected as TimelineSegment["layout"],
  };

  return { ...tl, segments };
}

function fixBrollRepetition(
  tl: TimelineDefinition,
  brollCatalog: BRollCatalogEntry[]
): TimelineDefinition {
  // Group segments by B-roll source
  const srcGroups = new Map<string, number[]>();
  for (let i = 0; i < tl.segments.length; i++) {
    const src = tl.segments[i].broll.src;
    if (!src) continue;
    const group = srcGroups.get(src) ?? [];
    group.push(i);
    srcGroups.set(src, group);
  }

  const segments = [...tl.segments];

  for (const [src, indices] of srcGroups) {
    if (indices.length <= 1) continue;

    // Find the B-roll duration
    const fileName = src.split("/").pop() ?? "";
    const entry = brollCatalog.find(
      (b) => b.fileId === fileName || `/uploads/${b.fileId}` === src
    );
    const totalDuration = entry?.duration ?? 30;

    // Distribute segments evenly across the B-roll duration
    const step = totalDuration / indices.length;
    for (let j = 0; j < indices.length; j++) {
      const idx = indices[j];
      const segDuration =
        (segments[idx].end_frame - segments[idx].start_frame) / tl.fps;

      let startFrom = j * step;
      // Ensure we don't go past the end
      if (startFrom + segDuration > totalDuration) {
        startFrom = Math.max(0, totalDuration - segDuration);
      }

      segments[idx] = {
        ...segments[idx],
        broll: { ...segments[idx].broll, startFrom },
      };
    }
  }

  return { ...tl, segments };
}

function fixBrollSpacing(
  tl: TimelineDefinition,
  brollCatalog: BRollCatalogEntry[]
): TimelineDefinition {
  // Same as fixBrollRepetition — just redistributes more evenly
  return fixBrollRepetition(tl, brollCatalog);
}

function fixColorGrade(tl: TimelineDefinition, style: StyleProfile): TimelineDefinition {
  return {
    ...tl,
    color_grade: { ...style.color_grade },
  };
}

function fixPipShape(
  tl: TimelineDefinition,
  issue: VerificationIssue,
  style: StyleProfile
): TimelineDefinition {
  if (!issue.segmentId) return tl;

  // Use the per-segment expected shape from the issue, falling back to global pip_style
  const expectedShape = (issue.expected as string) ?? style.pip_style.shape;

  const segments = tl.segments.map((seg) => {
    if (seg.id === issue.segmentId && seg.aroll) {
      return {
        ...seg,
        aroll: { ...seg.aroll, shape: expectedShape as "circle" | "rectangle" },
      };
    }
    return seg;
  });

  return { ...tl, segments };
}

function fixTransitions(tl: TimelineDefinition, style: StyleProfile): TimelineDefinition {
  const cutStyle = style.editing_rhythm.cut_style;

  const segments = tl.segments.map((seg, i) => {
    if (i === 0) return seg; // Keep first segment as-is

    if (cutStyle === "hard_cut") {
      // Remove transitions for hard cut style
      return { ...seg, transition_in: undefined };
    } else if (cutStyle === "smooth_transition") {
      // Add fade transitions if missing
      if (!seg.transition_in) {
        return {
          ...seg,
          transition_in: { type: "fade", duration_frames: 8 },
        };
      }
    }
    return seg;
  });

  return { ...tl, segments };
}
