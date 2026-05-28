/**
 * Step 1.6 — Cross-Validation & Blueprint Assembly
 *
 * Merges all analysis results (Gemini video, screenshot coordinates,
 * A-roll material, B-roll material) into a single VisualBlueprint.
 * Resolves conflicts using deterministic sources as ground truth.
 */

import type {
  VisualBlueprint,
  BlueprintSegment,
  FrameExtractionResult,
  VideoAnalysisResult,
  FrameCoordinates,
  ARollMaterialAnalysis,
  BRollMaterialAnalysis,
  ConfidenceScores,
  AnalysisConflict,
  SceneChange,
  VideoSegment,
  ARollCoordinates,
  BRollCoordinates,
  TextElement,
  BlackRegion,
} from "@/lib/types/blueprint";
import { computeSegmentConsensus, assignSegmentIds } from "./screenshotAnalyzer";

// ── Conflict resolution rules ──
// 1. Segment boundaries: FFmpeg scene detection wins (deterministic)
// 2. Layout type: Screenshot analysis wins (visual proof)
// 3. Element coordinates: Screenshot analysis wins (measured, not guessed)
// 4. Transcription timing: FFmpeg silence detection as anchor
// 5. Content classification: Screenshot tags must agree with Gemini video analysis

interface CrossValidationInput {
  /** Step 1.1: FFmpeg frame extraction (scene changes, silence, metadata) */
  frameExtraction: FrameExtractionResult;
  /** Step 1.2: Gemini consolidated video analysis */
  videoAnalysis: VideoAnalysisResult;
  /** Step 1.3: Screenshot coordinate extraction per frame */
  frameCoordinates: FrameCoordinates[];
  /** Step 1.4: A-roll material analysis */
  arollAnalysis: ARollMaterialAnalysis;
  /** Step 1.5: B-roll material analyses */
  brollAnalyses: BRollMaterialAnalysis[];
  /** Step 1.2 (separate): Style fingerprint from Pass 4 */
  styleFingerprint?: Record<string, unknown>;
}

/**
 * Assemble a VisualBlueprint from all analysis steps.
 */
export function assembleBlueprint(input: CrossValidationInput): VisualBlueprint {
  const conflicts: AnalysisConflict[] = [];

  // ── Step 1: Reconcile segment boundaries ──
  const reconciledSegments = reconcileSegmentBoundaries(
    input.videoAnalysis.segments,
    input.frameExtraction.sceneChanges,
    input.frameExtraction.duration,
    conflicts
  );

  // ── Step 2: Assign segment IDs to frame coordinates ──
  const assignedCoords = assignSegmentIds(input.frameCoordinates, reconciledSegments);

  // ── Step 3: Compute consensus coordinates per segment ──
  const segmentConsensus = computeSegmentConsensus(assignedCoords, reconciledSegments);

  // ── Step 4: Build blueprint segments with validated coordinates ──
  const blueprintSegments: BlueprintSegment[] = reconciledSegments.map((seg) => {
    const consensus = segmentConsensus.get(seg.id);

    if (!consensus) {
      conflicts.push({
        description: `No screenshot data for segment ${seg.id} (${seg.start}s-${seg.end}s)`,
        resolution: "Using Gemini video analysis layout; coordinates may be approximate",
        source: "gemini_video",
      });

      return {
        id: seg.id,
        start: seg.start,
        end: seg.end,
        layout: seg.layout,
        aroll: null,
        broll: {
          boundingBox: { x: 0, y: 0, width: 1080, height: 1920 },
          contentType: "video" as const,
          isCropped: false,
          hasScrollMotion: false,
        },
        texts: [],
        blackRegions: [],
      };
    }

    // Validate layout agreement
    if (consensus.layout !== seg.layout) {
      conflicts.push({
        description: `Layout mismatch for segment ${seg.id}: Gemini says "${seg.layout}", screenshots show "${consensus.layout}"`,
        resolution: `Using screenshot-detected layout "${consensus.layout}" (visual proof)`,
        source: "gemini_vision",
      });
    }

    // Validate coordinates are within canvas bounds
    const validated = validateCoordinates(consensus, conflicts, seg.id);

    return {
      id: seg.id,
      start: seg.start,
      end: seg.end,
      layout: consensus.layout, // Screenshot analysis wins
      aroll: validated.aroll ?? null,
      broll: validated.broll ?? {
        boundingBox: { x: 0, y: 0, width: 1080, height: 1920 },
        contentType: "video" as const,
        isCropped: false,
        hasScrollMotion: false,
      },
      texts: validated.texts,
      blackRegions: validated.blackRegions,
    };
  });

  // ── Step 5: Compute confidence scores ──
  const confidence = computeConfidence(
    reconciledSegments,
    input.frameExtraction.sceneChanges,
    input.videoAnalysis.segments,
    segmentConsensus,
    input.frameExtraction.silenceRegions,
    input.videoAnalysis.transcription
  );

  // ── Step 6: Final validation ──
  validateBlueprint(blueprintSegments, input.frameExtraction.duration, conflicts);

  return {
    canvas: { width: 1080, height: 1920 },
    reference: {
      duration: input.frameExtraction.duration,
      fps: input.frameExtraction.fps,
      segments: blueprintSegments,
      transcription: input.videoAnalysis.transcription,
      syncMap: input.videoAnalysis.sync_map,
      styleFingerprint: input.styleFingerprint ?? {},
    },
    aroll: input.arollAnalysis,
    broll: input.brollAnalyses,
    confidence,
    conflicts,
  };
}

// ── Segment boundary reconciliation ──

function reconcileSegmentBoundaries(
  geminiSegments: VideoSegment[],
  sceneChanges: SceneChange[],
  totalDuration: number,
  conflicts: AnalysisConflict[]
): VideoSegment[] {
  if (geminiSegments.length === 0) {
    // No Gemini segments — use scene changes as boundaries
    if (sceneChanges.length === 0) {
      return [{
        id: "seg_1",
        start: 0,
        end: totalDuration,
        layout: "full_screen",
        transition_in: "none",
        description: "Full video (no segments detected)",
      }];
    }

    return sceneChangesToSegments(sceneChanges, totalDuration);
  }

  // Compare scene change count with segment count
  const scDiff = Math.abs(sceneChanges.length - (geminiSegments.length - 1));
  if (scDiff > 2) {
    conflicts.push({
      description: `Scene changes (${sceneChanges.length}) differ from Gemini segments (${geminiSegments.length}) by ${scDiff}`,
      resolution: "Using Gemini segment count with FFmpeg-adjusted boundaries",
      source: "ffmpeg",
    });
  }

  // Snap Gemini segment boundaries to nearest scene change (within 0.5s)
  const adjusted = geminiSegments.map((seg, idx) => {
    const adjustedSeg = { ...seg };

    // Snap start time (except first segment)
    if (idx > 0) {
      const nearestSC = findNearestSceneChange(seg.start, sceneChanges);
      if (nearestSC && Math.abs(nearestSC.timestamp - seg.start) < 0.5) {
        adjustedSeg.start = nearestSC.timestamp;
      }
    } else {
      adjustedSeg.start = 0;
    }

    // Snap end time (except last segment)
    if (idx < geminiSegments.length - 1) {
      const nearestSC = findNearestSceneChange(seg.end, sceneChanges);
      if (nearestSC && Math.abs(nearestSC.timestamp - seg.end) < 0.5) {
        adjustedSeg.end = nearestSC.timestamp;
      }
    } else {
      adjustedSeg.end = totalDuration;
    }

    return adjustedSeg;
  });

  // Ensure segments are contiguous (no gaps)
  for (let i = 1; i < adjusted.length; i++) {
    if (adjusted[i].start !== adjusted[i - 1].end) {
      adjusted[i].start = adjusted[i - 1].end;
    }
  }

  return adjusted;
}

function findNearestSceneChange(
  timestamp: number,
  sceneChanges: SceneChange[]
): SceneChange | null {
  if (sceneChanges.length === 0) return null;
  let nearest = sceneChanges[0];
  let minDist = Math.abs(nearest.timestamp - timestamp);

  for (const sc of sceneChanges) {
    const dist = Math.abs(sc.timestamp - timestamp);
    if (dist < minDist) {
      minDist = dist;
      nearest = sc;
    }
  }

  return nearest;
}

function sceneChangesToSegments(
  sceneChanges: SceneChange[],
  totalDuration: number
): VideoSegment[] {
  const segments: VideoSegment[] = [];
  let prevEnd = 0;

  for (let i = 0; i < sceneChanges.length; i++) {
    segments.push({
      id: `seg_${i + 1}`,
      start: prevEnd,
      end: sceneChanges[i].timestamp,
      layout: "full_screen",
      transition_in: i === 0 ? "none" : "cut",
      description: `Segment ${i + 1} (from scene detection)`,
    });
    prevEnd = sceneChanges[i].timestamp;
  }

  // Last segment
  segments.push({
    id: `seg_${sceneChanges.length + 1}`,
    start: prevEnd,
    end: totalDuration,
    layout: "full_screen",
    transition_in: "cut",
    description: `Final segment (from scene detection)`,
  });

  return segments;
}

// ── Coordinate validation ──

function validateCoordinates(
  consensus: FrameCoordinates,
  conflicts: AnalysisConflict[],
  segId: string
): {
  aroll?: ARollCoordinates;
  broll?: BRollCoordinates;
  texts: TextElement[];
  blackRegions: BlackRegion[];
} {
  const CANVAS_W = 1080;
  const CANVAS_H = 1920;

  function clampBox(box: { x: number; y: number; width: number; height: number }, label: string) {
    const clamped = { ...box };
    let wasClamped = false;

    if (clamped.x < 0) { clamped.x = 0; wasClamped = true; }
    if (clamped.y < 0) { clamped.y = 0; wasClamped = true; }
    if (clamped.x + clamped.width > CANVAS_W) {
      clamped.width = CANVAS_W - clamped.x;
      wasClamped = true;
    }
    if (clamped.y + clamped.height > CANVAS_H) {
      clamped.height = CANVAS_H - clamped.y;
      wasClamped = true;
    }

    if (wasClamped) {
      conflicts.push({
        description: `${label} in ${segId} was outside canvas bounds, clamped`,
        resolution: "Clamped to canvas [0,0]-[1080,1920]",
        source: "gemini_vision",
      });
    }

    return clamped;
  }

  // Validate A-roll
  let aroll: ARollCoordinates | undefined;
  if (consensus.elements.aroll) {
    aroll = {
      ...consensus.elements.aroll,
      boundingBox: clampBox(consensus.elements.aroll.boundingBox, "A-roll"),
    };

    // For PIP layouts, A-roll should be smaller than 50% of canvas
    if (consensus.layout === "pip_overlay") {
      const area = aroll.boundingBox.width * aroll.boundingBox.height;
      const canvasArea = CANVAS_W * CANVAS_H;
      if (area > canvasArea * 0.5) {
        conflicts.push({
          description: `A-roll in ${segId} covers ${Math.round(area / canvasArea * 100)}% of canvas — too large for PIP`,
          resolution: "Flagged for review; layout might not be pip_overlay",
          source: "gemini_vision",
        });
      }
    }
  }

  // Validate B-roll
  let broll: BRollCoordinates | undefined;
  if (consensus.elements.broll) {
    broll = {
      ...consensus.elements.broll,
      boundingBox: clampBox(consensus.elements.broll.boundingBox, "B-roll"),
    };
  }

  // Validate texts
  const texts = consensus.elements.texts.map((t) => ({
    ...t,
    boundingBox: clampBox(t.boundingBox, `Text "${t.text.substring(0, 20)}"`),
  }));

  // Validate black regions
  const blackRegions = consensus.elements.blackRegions.map((br) => ({
    ...br,
    boundingBox: clampBox(br.boundingBox, `Black region (${br.purpose})`),
  }));

  return { aroll, broll, texts, blackRegions };
}

// ── Confidence scoring ──

function computeConfidence(
  reconciledSegments: VideoSegment[],
  sceneChanges: SceneChange[],
  geminiSegments: VideoSegment[],
  consensus: Map<string, FrameCoordinates>,
  silenceRegions: { start: number; end: number; duration: number }[],
  transcription: { words: { word: string; start: number; end: number }[] }
): ConfidenceScores {
  // Segment boundary confidence: how well do FFmpeg + Gemini agree?
  let segBoundaryScore = 1.0;
  if (geminiSegments.length > 0) {
    const segDiff = Math.abs(sceneChanges.length - (geminiSegments.length - 1));
    segBoundaryScore = Math.max(0, 1 - segDiff * 0.15);
  }

  // Coordinate confidence: how many segments have screenshot data?
  const segsWithData = reconciledSegments.filter((s) => consensus.has(s.id)).length;
  const coordScore = reconciledSegments.length > 0
    ? segsWithData / reconciledSegments.length
    : 0;

  // Transcription confidence: are word timestamps monotonically increasing?
  let transcriptionScore = 1.0;
  const words = transcription.words;
  if (words.length > 0) {
    let outOfOrder = 0;
    for (let i = 1; i < words.length; i++) {
      if (words[i].start < words[i - 1].start) outOfOrder++;
    }
    transcriptionScore = Math.max(0, 1 - outOfOrder / words.length);
  }

  const overall = (segBoundaryScore + coordScore + transcriptionScore) / 3;

  return {
    segmentBoundaries: Math.round(segBoundaryScore * 100) / 100,
    coordinates: Math.round(coordScore * 100) / 100,
    transcription: Math.round(transcriptionScore * 100) / 100,
    overall: Math.round(overall * 100) / 100,
  };
}

// ── Final blueprint validation ──

function validateBlueprint(
  segments: BlueprintSegment[],
  totalDuration: number,
  conflicts: AnalysisConflict[]
): void {
  // Total duration check
  if (segments.length > 0) {
    const lastEnd = segments[segments.length - 1].end;
    if (Math.abs(lastEnd - totalDuration) > 0.5) {
      conflicts.push({
        description: `Segments end at ${lastEnd}s but video is ${totalDuration}s`,
        resolution: "Extended last segment to video duration",
        source: "ffmpeg",
      });
      segments[segments.length - 1].end = totalDuration;
    }
  }

  // Layout-specific checks
  for (const seg of segments) {
    if (seg.layout === "vertical_split") {
      // For vertical_split: should have black region at top
      const hasHeader = seg.blackRegions.some((br) => br.purpose === "header");
      if (!hasHeader && seg.blackRegions.length === 0) {
        conflicts.push({
          description: `Segment ${seg.id} is vertical_split but no header black region detected`,
          resolution: "May need manual header region specification",
          source: "gemini_vision",
        });
      }

      // A-roll should be above B-roll
      if (seg.aroll && seg.broll) {
        const arollBottom = seg.aroll.boundingBox.y + seg.aroll.boundingBox.height;
        const brollTop = seg.broll.boundingBox.y;
        if (arollBottom > brollTop + 50) {
          conflicts.push({
            description: `Segment ${seg.id} vertical_split: A-roll bottom (${arollBottom}) overlaps B-roll top (${brollTop})`,
            resolution: "Layout may be pip_overlay instead of vertical_split",
            source: "gemini_vision",
          });
        }
      }
    }

    if (seg.layout === "pip_overlay") {
      // A-roll should exist and be smaller than B-roll
      if (!seg.aroll) {
        conflicts.push({
          description: `Segment ${seg.id} is pip_overlay but no A-roll detected`,
          resolution: "May be full_screen layout instead",
          source: "gemini_vision",
        });
      }
    }
  }
}
