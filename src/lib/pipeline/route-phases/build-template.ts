/**
 * Phase: BUILD TEMPLATE (Wave 0.5 decomposition — moved verbatim from
 * src/app/api/clone-style/route.ts; no behavior change).
 *
 * Covers: faceInfo extraction + generateTemplate + template save.
 */

import path from "path";
import fs from "fs";

import { generateTemplate, extractFaceInfo } from "@/lib/pipeline/template-generator";

import type { PipelineCtx } from "./types";

export async function buildTemplate(ctx: PipelineCtx): Promise<void> {
  const { tempDir, sendSSE } = ctx;
  const blueprint = ctx.blueprint!;

  // ════════════════════════════════════════════
  // PHASE 2: Dynamic Template Generation
  // ════════════════════════════════════════════
  sendSSE({ phase: "generating_template", progress: 35, message: "Generating layout template from reference..." });

  // Extract face info from A-roll analysis for face-centered cropping
  const faceInfo = blueprint.aroll
    ? extractFaceInfo({
        faceFrames: blueprint.aroll.faceFrames,
        recommendedCrop: blueprint.aroll.recommendedCrop,
        resolution: blueprint.aroll.resolution ?? { width: 1920, height: 1080 },
      })
    : undefined;

  const dynamicTemplate = generateTemplate({
    canvas: blueprint.canvas,
    fps: blueprint.reference.fps,
    segments: blueprint.reference.segments as unknown as Parameters<typeof generateTemplate>[0]["segments"],
    faceInfo,
    aspectRatio: "9:16",
    // V2: Pass reference transcription for content profile building
    referenceTranscription: blueprint.reference.transcription,
  });

  sendSSE({ phase: "generating_template", progress: 45, message: `Template generated: ${Object.keys(dynamicTemplate.layouts).length} layouts` });

  // Save template for debugging
  fs.writeFileSync(
    path.join(tempDir, "dynamic-template.json"),
    JSON.stringify(dynamicTemplate, null, 2)
  );

  // ── Write phase outputs back to the shared ctx ──
  ctx.faceInfo = faceInfo;
  ctx.dynamicTemplate = dynamicTemplate;
}
