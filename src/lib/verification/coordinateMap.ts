/**
 * Virtual Coordinate System
 *
 * Extracts a coordinate blueprint from the reference StyleProfile,
 * mapping every element (A-roll, B-roll, text overlays, other elements)
 * to its expected position, size, and timing within a 1080×1920 canvas.
 *
 * This blueprint is then used to:
 * 1. Place elements correctly in the generated timeline
 * 2. Verify that the output matches the reference layout
 */

import type { StyleProfile, Segment, ARollElement, BRollElement, TextOverlay } from "@/lib/types/styleProfile";
import type { TimelineDefinition, TimelineSegment } from "@/lib/types/timeline";

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
const SAFE_MARGIN = 60; // px from edges

/** A single element's expected position and size on the canvas */
export interface ElementCoordinate {
  elementType: "aroll" | "broll" | "text_overlay" | "other";
  /** Position [x, y] in pixels from top-left */
  position: [number, number];
  /** Size [width, height] in pixels */
  size: [number, number];
  /** Optional shape for PIP elements */
  shape?: "circle" | "rectangle";
  /** Z-index layer (higher = on top) */
  zIndex: number;
  /** Extra metadata */
  meta?: Record<string, unknown>;
}

/** Coordinate blueprint for one segment */
export interface SegmentCoordinateMap {
  segmentId: string;
  segmentIndex: number;
  layout: string;
  timeRange: { start: number; end: number };
  elements: ElementCoordinate[];
}

/** Full coordinate blueprint for the entire video */
export interface VideoCoordinateBlueprint {
  canvasWidth: number;
  canvasHeight: number;
  totalDuration: number;
  segments: SegmentCoordinateMap[];
  /** Global defaults extracted from style profile */
  defaults: {
    pipPosition: [number, number];
    pipSize: number;
    pipShape: "circle" | "rectangle";
    captionPosition: [number, number];
  };
}

/**
 * Extract a coordinate blueprint from the reference StyleProfile.
 * Maps every element to its expected position on the canvas.
 */
export function extractCoordinateBlueprint(style: StyleProfile): VideoCoordinateBlueprint {
  const defaults = {
    pipPosition: style.pip_style.preferred_positions?.[0] ?? [CANVAS_WIDTH - 200, CANVAS_HEIGHT - 200],
    pipSize: style.pip_style.typical_size ?? style.pip_style.size ?? 280,
    pipShape: style.pip_style.shape ?? "circle" as const,
    captionPosition: [CANVAS_WIDTH / 2, CANVAS_HEIGHT - 320] as [number, number],
  };

  const segments: SegmentCoordinateMap[] = style.segments.map((seg, i) => {
    const elements: ElementCoordinate[] = [];

    // B-roll layer (always at z=0, full canvas or specific position)
    if (seg.broll) {
      elements.push({
        elementType: "broll",
        position: seg.broll.position ?? [0, 0],
        size: seg.broll.size ?? [CANVAS_WIDTH, CANVAS_HEIGHT],
        zIndex: 0,
        meta: {
          scroll: seg.broll.scroll,
          crop: seg.broll.crop,
        },
      });
    } else {
      // Default full-screen B-roll
      elements.push({
        elementType: "broll",
        position: [0, 0],
        size: [CANVAS_WIDTH, CANVAS_HEIGHT],
        zIndex: 0,
      });
    }

    // A-roll PIP (z=10)
    if (seg.aroll) {
      const arollSize: [number, number] = [seg.aroll.size[0], seg.aroll.size[1]];
      elements.push({
        elementType: "aroll",
        position: seg.aroll.position,
        size: arollSize,
        shape: seg.aroll.shape,
        zIndex: 10,
        meta: {
          border: seg.aroll.border,
          animation: seg.aroll.animation,
        },
      });
    } else if (seg.layout === "pip_overlay") {
      // Default PIP position from style
      elements.push({
        elementType: "aroll",
        position: defaults.pipPosition,
        size: [defaults.pipSize, defaults.pipSize],
        shape: defaults.pipShape,
        zIndex: 10,
      });
    }

    // Text overlays (z=20)
    if (seg.text_overlays?.length) {
      for (const overlay of seg.text_overlays) {
        elements.push({
          elementType: "text_overlay",
          position: overlay.position,
          size: [
            overlay.style.fontSize ? overlay.style.fontSize * 10 : 400,
            overlay.style.fontSize ? overlay.style.fontSize * 2 : 80,
          ],
          zIndex: 20,
          meta: {
            text: overlay.text,
            style: overlay.style,
            animation: overlay.animation,
          },
        });
      }
    }

    // Other elements (z=15)
    if (seg.other_elements?.length) {
      for (const elem of seg.other_elements) {
        elements.push({
          elementType: "other",
          position: elem.position,
          size: elem.size,
          zIndex: 15,
          meta: { type: elem.type, style: elem.style },
        });
      }
    }

    return {
      segmentId: seg.id,
      segmentIndex: i,
      layout: seg.layout,
      timeRange: { start: seg.start as number, end: seg.end as number },
      elements,
    };
  });

  return {
    canvasWidth: CANVAS_WIDTH,
    canvasHeight: CANVAS_HEIGHT,
    totalDuration: style.source.duration,
    segments,
    defaults,
  };
}

/**
 * Apply coordinate blueprint to a generated timeline.
 * Remaps A-roll, B-roll, and text overlay positions to match the reference.
 */
export function applyCoordinateBlueprint(
  timeline: TimelineDefinition,
  blueprint: VideoCoordinateBlueprint
): TimelineDefinition {
  const updatedSegments = timeline.segments.map((seg, i) => {
    // Find the matching blueprint segment by position ratio
    const ratio = i / Math.max(timeline.segments.length - 1, 1);
    const bpIndex = Math.min(
      Math.round(ratio * (blueprint.segments.length - 1)),
      blueprint.segments.length - 1
    );
    const bpSeg = blueprint.segments[bpIndex];
    if (!bpSeg) return seg;

    const updated = { ...seg };

    // Apply A-roll coordinates from blueprint
    const arollCoord = bpSeg.elements.find((e) => e.elementType === "aroll");
    if (arollCoord && updated.aroll) {
      updated.aroll = {
        ...updated.aroll,
        position: arollCoord.position,
        size: [arollCoord.size[0], arollCoord.size[1]] as [number, number],
        shape: arollCoord.shape ?? updated.aroll.shape,
      };
    }

    // Apply layout from blueprint
    updated.layout = bpSeg.layout as TimelineSegment["layout"];

    // Apply text overlay positions from blueprint
    const textCoords = bpSeg.elements.filter((e) => e.elementType === "text_overlay");
    if (textCoords.length > 0 && updated.text_overlays.length > 0) {
      updated.text_overlays = updated.text_overlays.map((overlay, j) => {
        const coord = textCoords[j % textCoords.length];
        return coord
          ? { ...overlay, position: coord.position }
          : overlay;
      });
    }

    return updated;
  });

  return { ...timeline, segments: updatedSegments };
}

/**
 * Validate that a coordinate is within canvas safe area.
 * Position is TOP-LEFT corner of the element bounding box.
 */
export function isInSafeArea(
  position: [number, number],
  size: [number, number]
): boolean {
  const [x, y] = position;
  const [w, h] = size;
  return (
    x >= SAFE_MARGIN &&
    x + w <= CANVAS_WIDTH - SAFE_MARGIN &&
    y >= SAFE_MARGIN &&
    y + h <= CANVAS_HEIGHT - SAFE_MARGIN
  );
}

/**
 * Check for element overlap/collision.
 * Positions are TOP-LEFT corner of the element bounding box.
 */
export function checkElementCollision(
  a: ElementCoordinate,
  b: ElementCoordinate
): boolean {
  const aLeft = a.position[0];
  const aRight = a.position[0] + a.size[0];
  const aTop = a.position[1];
  const aBottom = a.position[1] + a.size[1];

  const bLeft = b.position[0];
  const bRight = b.position[0] + b.size[0];
  const bTop = b.position[1];
  const bBottom = b.position[1] + b.size[1];

  return !(aRight < bLeft || aLeft > bRight || aBottom < bTop || aTop > bBottom);
}
