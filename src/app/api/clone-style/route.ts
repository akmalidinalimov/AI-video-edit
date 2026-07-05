/**
 * POST /api/clone-style — Full Style Cloning Pipeline (Single Endpoint)
 *
 * Chains the entire pipeline in one HTTP call with SSE progress streaming:
 *   Phase 1: Blueprint analysis (Gemini Vision → VisualBlueprint)
 *   Phase 2: Dynamic template generation (blueprint → VCSTemplate)
 *   Phase 3: Editing plan building (template + transcription → EditingPlan)
 *   Phase 4: Plan rendering (single-pass FFmpeg → MP4)
 *
 * CRITICAL: Uses single-pass FFmpeg rendering — never concatenation.
 * Audio maps from continuous A-roll input (-map 1:a), no splicing.
 * Layout switching via overlay enable='between(t,start,end)' expressions.
 *
 * Wave 0.5 (docs/UNIVERSAL-1-MILESTONE.md): the pipeline body is decomposed
 * into phase modules under src/lib/pipeline/route-phases/ — behavior-preserving.
 * This file keeps request parsing/validation, the SSE stream + concurrency
 * guard, and the sequential phase calls.
 *
 * Body: {
 *   referenceVideo: string,  // path relative to public/ (e.g. "uploads/ref.MOV")
 *   arollVideo: string,      // path relative to public/
 *   brollVideo: string,      // path relative to public/ (single B-roll for prototype)
 * }
 *
 * SSE Events:
 *   { phase: "analyzing_reference", progress: 25, message: "..." }
 *   { phase: "generating_template", progress: 45, message: "..." }
 *   { phase: "building_plan",       progress: 55, message: "..." }
 *   { phase: "rendering",           progress: 70, message: "..." }
 *   { phase: "complete",            progress: 100, downloadUrl: "..." }
 *   { phase: "error",               progress: -1, message: "..." }
 */

import { NextRequest } from "next/server";
import path from "path";
import fs from "fs";

// Route phases (Wave 0.5 decomposition — behavior-preserving)
import type { PipelineCtx, SSEEvent } from "@/lib/pipeline/route-phases/types";
import { analyzeReference } from "@/lib/pipeline/route-phases/analyze-reference";
import { buildTemplate } from "@/lib/pipeline/route-phases/build-template";
import { prepareContent } from "@/lib/pipeline/route-phases/prepare-content";
import { buildPlan } from "@/lib/pipeline/route-phases/build-plan";
import { renderVideo } from "@/lib/pipeline/route-phases/render-video";
import { verifyOutput } from "@/lib/pipeline/route-phases/verify-output";

export const maxDuration = 600; // 10 minutes
export const dynamic = "force-dynamic";

// ════════════════════════════════════════════════════════════
// CONCURRENCY GUARD — prototype allows 1 concurrent render
// ════════════════════════════════════════════════════════════

let isRendering = false;

// ════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════

function resolvePublicPath(relativePath: string): string {
  const publicDir = path.join(process.cwd(), "public");
  if (path.isAbsolute(relativePath)) return relativePath;
  if (relativePath.startsWith("/")) return path.join(publicDir, relativePath);
  return path.join(publicDir, relativePath);
}

// ════════════════════════════════════════════════════════════
// CLONE-STYLE REQUEST
// ════════════════════════════════════════════════════════════

interface CloneStyleRequest {
  referenceVideo: string;
  /** Single A-roll path (backward compatible) */
  arollVideo?: string;
  /** Single B-roll path (backward compatible) */
  brollVideo?: string;
  /**
   * Multiple A-roll videos in upload order.
   * The first uploaded = first in sequence, second = second, etc.
   * When provided, takes precedence over arollVideo.
   */
  arollVideos?: string[];
  /**
   * Multiple B-roll videos in upload order.
   * Content-aware matching picks the best source for each sentence.
   * When provided, takes precedence over brollVideo.
   */
  brollVideos?: string[];
  /**
   * Skip the post-render structural verification (Gemini Vision scoring).
   * Default false — verification runs and returns a style-match score.
   * Set true for faster renders without the quality badge.
   */
  skipVerification?: boolean;
}

// ════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ════════════════════════════════════════════════════════════

export async function POST(request: NextRequest) {
  // Concurrency guard
  if (isRendering) {
    return new Response(
      JSON.stringify({ phase: "error", progress: -1, message: "Server is busy. Please try again in a few minutes." }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  isRendering = true;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function sendSSE(event: SSEEvent) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Stream may be closed
        }
      }

      try {
        const body: CloneStyleRequest = await request.json();

        // ── Resolve multi-file inputs (backward compatible) ──
        // arollVideos[] takes precedence over arollVideo
        // brollVideos[] takes precedence over brollVideo
        const arollPaths: string[] = (body.arollVideos?.length ? body.arollVideos : [body.arollVideo ?? ""])
          .map(resolvePublicPath);
        const brollPaths: string[] = (body.brollVideos?.length ? body.brollVideos : [body.brollVideo ?? ""])
          .map(resolvePublicPath);
        const refPath = resolvePublicPath(body.referenceVideo);

        // Primary paths (first clip = backward compatible)
        const arollPath = arollPaths[0];
        const brollPath = brollPaths[0];

        const isMultiAroll = arollPaths.length > 1;
        const isMultiBroll = brollPaths.length > 1;

        if (isMultiAroll) console.log(`[clone-style] Multi-A-roll mode: ${arollPaths.length} clips`);
        if (isMultiBroll) console.log(`[clone-style] Multi-B-roll mode: ${brollPaths.length} sources`);

        // ── Validate ALL inputs ──
        for (const [label, filePath] of [
          ["Reference video", refPath],
          ...arollPaths.map((p, i) => [`A-roll video #${i + 1}`, p] as [string, string]),
          ...brollPaths.map((p, i) => [`B-roll video #${i + 1}`, p] as [string, string]),
        ]) {
          if (!fs.existsSync(filePath)) {
            sendSSE({ phase: "error", progress: -1, message: `${label} not found: ${filePath}` });
            controller.close();
            return;
          }
        }

        // Ensure output directories exist
        const publicDir = path.join(process.cwd(), "public");
        const exportsDir = path.join(publicDir, "exports");
        const tempDir = path.join(exportsDir, "sp-temp");
        if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        // ── Shared pipeline context (mutated in place by each phase) ──
        const ctx: PipelineCtx = {
          refPath,
          arollPaths,
          brollPaths,
          arollPath,
          brollPath,
          tempDir,
          exportsDir,
          skipVerification: !!body.skipVerification,
          sendSSE,
        };

        // ── Sequential phases (same order + same SSE/caching behavior as before) ──
        await analyzeReference(ctx);
        await buildTemplate(ctx);
        await prepareContent(ctx);
        await buildPlan(ctx);
        await renderVideo(ctx);
        await verifyOutput(ctx);

      } catch (error) {
        const message = error instanceof Error ? error.message : "Pipeline failed";
        console.error("[/api/clone-style] Error:", error);
        sendSSE({ phase: "error", progress: -1, message });
      } finally {
        isRendering = false;
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
