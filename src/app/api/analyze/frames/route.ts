/**
 * POST /api/analyze/frames — Extract frames and metadata from a video file.
 *
 * Body: { videoPath: string, category?: "ref" | "aroll" | "broll", interval?: number }
 *
 * Returns: FrameExtractionResult as JSON (streamed progress via SSE).
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import {
  extractFullAnalysis,
  getVideoMetadata,
} from "@/lib/analysis/frameExtractor";
import { withCache } from "@/lib/analysis/analysisCache";
import type { FrameExtractionResult } from "@/lib/types/blueprint";

export const maxDuration = 120; // 2 minutes max
export const dynamic = "force-dynamic";

interface FrameAnalysisRequest {
  /** Path relative to public/ (e.g. "uploads/IMG_6018.MOV") or absolute path */
  videoPath: string;
  category?: "ref" | "aroll" | "broll";
  intervalSeconds?: number;
  sceneThreshold?: number;
  detectSilence?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const body: FrameAnalysisRequest = await request.json();
    const { videoPath: rawPath, category = "ref", intervalSeconds = 0.5, sceneThreshold = 0.3, detectSilence = true } = body;

    // Resolve video path
    const publicDir = path.join(process.cwd(), "public");
    let videoPath: string;

    if (path.isAbsolute(rawPath)) {
      videoPath = rawPath;
    } else if (rawPath.startsWith("/")) {
      videoPath = path.join(publicDir, rawPath);
    } else {
      videoPath = path.join(publicDir, rawPath);
    }

    if (!fs.existsSync(videoPath)) {
      return NextResponse.json(
        { error: `Video file not found: ${rawPath}` },
        { status: 404 }
      );
    }

    // Run with caching
    const result = await withCache<FrameExtractionResult>(
      videoPath,
      "frame_extraction",
      () => extractFullAnalysis(videoPath, {
        category,
        intervalSeconds,
        sceneThreshold,
        detectSilenceRegions: detectSilence,
      })
    );

    // Convert absolute paths to relative for JSON response
    const relativizedResult = {
      ...result,
      frames: result.frames.map((f) => ({
        ...f,
        path: "/" + path.relative(publicDir, f.path).replace(/\\/g, "/"),
      })),
    };

    return NextResponse.json(relativizedResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[/api/analyze/frames] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/analyze/frames?video=uploads/IMG_6018.MOV
 * Quick metadata-only endpoint (no frame extraction).
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const videoParam = url.searchParams.get("video");

    if (!videoParam) {
      return NextResponse.json(
        { error: "Missing 'video' query parameter" },
        { status: 400 }
      );
    }

    const publicDir = path.join(process.cwd(), "public");
    const videoPath = path.join(publicDir, videoParam);

    if (!fs.existsSync(videoPath)) {
      return NextResponse.json(
        { error: `Video file not found: ${videoParam}` },
        { status: 404 }
      );
    }

    const metadata = await getVideoMetadata(videoPath);
    return NextResponse.json(metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
