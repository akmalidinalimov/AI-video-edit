import type { ContentSegment } from "./segmenter";
import type { SpeedRampPoint } from "@/lib/types/render";

const FPS = 30;
const NORMAL_SPEED = 1.0;
const EMPHASIS_SPEED = 0.85; // slight slow-mo on key moments
const FILLER_SPEED = 1.2;   // speed up filler/low-importance content
const RAMP_FRAMES = 8;      // frames to transition between speeds

/**
 * Plans speed ramp points from content segment emphasis data.
 * Uses semantic tags and mood to determine importance.
 */
export function planSpeedRamps(
  segments: ContentSegment[]
): SpeedRampPoint[] {
  const points: SpeedRampPoint[] = [];
  let lastSpeed = NORMAL_SPEED;

  for (const seg of segments) {
    const startFrame = Math.round(seg.globalStart * FPS);
    const endFrame = Math.round(seg.globalEnd * FPS);
    const segmentSpeed = getSegmentSpeed(seg);

    // Ramp from previous speed to this segment's speed
    if (segmentSpeed !== lastSpeed) {
      points.push({ frame: startFrame, speed: lastSpeed });
      points.push({ frame: startFrame + RAMP_FRAMES, speed: segmentSpeed });
    } else {
      points.push({ frame: startFrame, speed: segmentSpeed });
    }

    // Hold speed through segment
    points.push({ frame: endFrame - RAMP_FRAMES, speed: segmentSpeed });
    lastSpeed = segmentSpeed;
  }

  // End at normal speed
  const lastSeg = segments[segments.length - 1];
  if (lastSeg) {
    const endFrame = Math.round(lastSeg.globalEnd * FPS);
    points.push({ frame: endFrame, speed: NORMAL_SPEED });
  }

  return deduplicatePoints(points);
}

function getSegmentSpeed(seg: ContentSegment): number {
  const tags = seg.semanticTags ?? [];
  const mood = seg.mood ?? "neutral";

  // Emphasis tags → slow down
  const emphasisTags = ["key_point", "conclusion", "reveal", "important", "climax", "emotional"];
  if (tags.some((t) => emphasisTags.includes(t.toLowerCase()))) {
    return EMPHASIS_SPEED;
  }

  // Emphasis moods → slow down
  if (["dramatic", "emotional", "inspiring", "excited"].includes(mood)) {
    return EMPHASIS_SPEED;
  }

  // Filler tags → speed up
  const fillerTags = ["filler", "transition", "aside", "digression", "repetition"];
  if (tags.some((t) => fillerTags.includes(t.toLowerCase()))) {
    return FILLER_SPEED;
  }

  return NORMAL_SPEED;
}

/**
 * Remove duplicate consecutive speed points.
 */
function deduplicatePoints(points: SpeedRampPoint[]): SpeedRampPoint[] {
  if (points.length <= 1) return points;

  const result: SpeedRampPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    if (points[i].speed !== prev.speed || points[i].frame !== prev.frame) {
      result.push(points[i]);
    }
  }
  return result;
}

/**
 * Get the interpolated speed at a given frame.
 */
export function getSpeedAtFrame(
  points: SpeedRampPoint[],
  frame: number
): number {
  if (points.length === 0) return NORMAL_SPEED;
  if (frame <= points[0].frame) return points[0].speed;
  if (frame >= points[points.length - 1].frame) return points[points.length - 1].speed;

  for (let i = 0; i < points.length - 1; i++) {
    const curr = points[i];
    const next = points[i + 1];
    if (frame >= curr.frame && frame <= next.frame) {
      const t = (frame - curr.frame) / (next.frame - curr.frame);
      return curr.speed + t * (next.speed - curr.speed);
    }
  }

  return NORMAL_SPEED;
}
