import type { TimelineDefinition } from "@/lib/types/timeline";
import type { ThumbnailCandidate } from "@/lib/types/render";

/**
 * Scores frames as thumbnail candidates based on visual interest criteria.
 * Returns top 3 candidates sorted by score.
 */
export function scoreThumbnailCandidates(
  timeline: TimelineDefinition
): ThumbnailCandidate[] {
  const candidates: ThumbnailCandidate[] = [];
  const fps = timeline.fps;

  for (const segment of timeline.segments) {
    const midFrame = Math.round((segment.start_frame + segment.end_frame) / 2);

    let score = 0;
    const reasons: string[] = [];

    // Has speaker visible (A-roll PIP) — faces grab attention
    if (segment.aroll) {
      score += 30;
      reasons.push("speaker visible");
    }

    // Has text overlay — text in thumbnail increases CTR
    if (segment.text_overlays.length > 0) {
      score += 25;
      reasons.push("text overlay present");
    }

    // Has B-roll content (not empty src)
    if (segment.broll.src) {
      score += 15;
      reasons.push("B-roll background");
    }

    // Layout variety bonus — pip_overlay shows both speaker and content
    if (segment.layout === "pip_overlay") {
      score += 20;
      reasons.push("PIP overlay layout");
    } else if (segment.layout === "vertical_split") {
      score += 10;
      reasons.push("split layout");
    }

    // Prefer frames in first third of video (hooks viewers)
    const frameRatio = midFrame / (timeline.duration * fps);
    if (frameRatio < 0.33) {
      score += 15;
      reasons.push("early in video");
    } else if (frameRatio < 0.66) {
      score += 5;
      reasons.push("mid-video");
    }

    // B-roll motion type bonus — dynamic content looks better
    if (segment.broll.motion) {
      if (segment.broll.motion.type === "ken_burns" || segment.broll.motion.type === "zoom_in") {
        score += 10;
        reasons.push("dynamic motion");
      }
    }

    // Segment duration — longer segments likely have more interesting content
    const durationSec = (segment.end_frame - segment.start_frame) / fps;
    if (durationSec > 3) {
      score += 5;
      reasons.push("long segment");
    }

    candidates.push({
      frame: midFrame,
      url: "", // populated during actual render
      score: Math.min(100, score),
      reason: reasons.join(", "),
    });
  }

  // Sort by score descending, return top 3
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
