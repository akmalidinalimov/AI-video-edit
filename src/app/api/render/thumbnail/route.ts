import { NextRequest, NextResponse } from "next/server";
import type { TimelineDefinition } from "@/lib/types/timeline";
import { scoreThumbnailCandidates } from "@/lib/analysis/thumbnailScorer";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface ThumbnailRequest {
  timeline: TimelineDefinition;
}

/**
 * POST /api/render/thumbnail — Score and return thumbnail candidates.
 *
 * Returns the top 3 frames scored by visual interest.
 * Actual thumbnail image rendering requires @remotion/renderer (renderStill).
 * For now, returns frame numbers and scores so the client can
 * seek the preview player to those frames for screenshot.
 */
export async function POST(request: NextRequest) {
  try {
    const body: ThumbnailRequest = await request.json();
    const { timeline } = body;

    if (!timeline || !timeline.segments.length) {
      return NextResponse.json(
        { error: "No timeline provided" },
        { status: 400 }
      );
    }

    const candidates = scoreThumbnailCandidates(timeline);

    return NextResponse.json({
      candidates,
      totalFrames: Math.round(timeline.duration * timeline.fps),
      recommendation: candidates[0] ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Thumbnail scoring failed: ${message}` },
      { status: 500 }
    );
  }
}
