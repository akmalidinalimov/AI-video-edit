/**
 * POST /api/analyze/blueprint — Full Phase 1 pipeline.
 *
 * Runs the complete analysis engine:
 * 1.1 FFmpeg frame extraction + scene detection
 * 1.2 Gemini consolidated video analysis
 * 1.3 Screenshot coordinate extraction
 * 1.4 A-roll material analysis
 * 1.5 B-roll material analysis
 * 1.6 Cross-validation → VisualBlueprint
 *
 * Streams progress via SSE.
 *
 * Body: {
 *   referenceVideo: string,  // path relative to public/ (e.g. "uploads/IMG_6018.MOV")
 *   arollVideo: string,      // path relative to public/
 *   brollVideos: string[],   // paths relative to public/
 * }
 */

import { NextRequest } from "next/server";
import path from "path";
import fs from "fs";
import { extractFullAnalysis, getVideoMetadata } from "@/lib/analysis/frameExtractor";
import { extractAllCoordinates, assignSegmentIds } from "@/lib/analysis/screenshotAnalyzer";
import { analyzeARollMaterial, analyzeBRollMaterial } from "@/lib/analysis/materialAnalyzer";
import { assembleBlueprint } from "@/lib/analysis/crossValidator";
import { withCache, setCache, getCached } from "@/lib/analysis/analysisCache";
import { geminiFlash, geminiPro, geminiFallback } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";
import { REFERENCE_CONSOLIDATED_PROMPT } from "@/lib/gemini/prompts/referenceConsolidated";
import { REFERENCE_PASS4_PROMPT } from "@/lib/gemini/prompts/referencePass4";
import type {
  FrameExtractionResult,
  VideoAnalysisResult,
  VisualBlueprint,
} from "@/lib/types/blueprint";

/** Retry with exponential backoff for Gemini API calls */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable = message.includes("503") || message.includes("429") || message.includes("overloaded") || message.includes("high demand");
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.log(`[Blueprint] Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("withRetry exhausted");
}

export const maxDuration = 300; // 5 minutes for full pipeline
export const dynamic = "force-dynamic";

interface BlueprintRequest {
  referenceVideo: string;
  arollVideo: string;
  brollVideos: string[];
}

function resolvePublicPath(relativePath: string): string {
  const publicDir = path.join(process.cwd(), "public");
  if (path.isAbsolute(relativePath)) return relativePath;
  if (relativePath.startsWith("/")) return path.join(publicDir, relativePath);
  return path.join(publicDir, relativePath);
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ event, data })}\n\n`)
          );
        } catch {
          // Stream may be closed
        }
      }

      try {
        const body: BlueprintRequest = await request.json();
        const refPath = resolvePublicPath(body.referenceVideo);
        const arollPath = resolvePublicPath(body.arollVideo);
        const brollPaths = body.brollVideos.map(resolvePublicPath);

        // Validate files exist
        for (const [label, p] of [
          ["Reference", refPath],
          ["A-roll", arollPath],
          ...brollPaths.map((bp, i) => [`B-roll ${i + 1}`, bp] as [string, string]),
        ]) {
          if (!fs.existsSync(p)) {
            send("error", { message: `${label} file not found: ${p}` });
            controller.close();
            return;
          }
        }

        // Check for cached final blueprint
        const cachedBlueprint = getCached<VisualBlueprint>(refPath, "visual_blueprint");
        if (cachedBlueprint) {
          send("status", { step: "cache_hit", message: "Using cached blueprint" });
          send("complete", { blueprint: cachedBlueprint });
          controller.close();
          return;
        }

        const totalSteps = 6;
        let currentStep = 0;

        // ═══════════════════════════════════════════
        // STEP 1.1: FFmpeg Frame Extraction
        // ═══════════════════════════════════════════
        currentStep++;
        send("progress", {
          step: currentStep,
          total: totalSteps,
          message: "Step 1/6: Extracting frames & detecting scenes...",
        });

        const refExtraction = await withCache<FrameExtractionResult>(
          refPath,
          "frame_extraction",
          () => extractFullAnalysis(refPath, {
            category: "ref",
            intervalSeconds: 0.5,
            sceneThreshold: 0.3,
            detectSilenceRegions: true,
          })
        );

        send("step_complete", {
          step: currentStep,
          result: {
            frames: refExtraction.frames.length,
            sceneChanges: refExtraction.sceneChanges.length,
            silenceRegions: refExtraction.silenceRegions.length,
            duration: refExtraction.duration,
          },
        });

        // ═══════════════════════════════════════════
        // STEP 1.2: Gemini Video Analysis
        // ═══════════════════════════════════════════
        currentStep++;
        send("progress", {
          step: currentStep,
          total: totalSteps,
          message: "Step 2/6: Analyzing video structure & transcription...",
        });

        const videoAnalysis = await withCache<VideoAnalysisResult>(
          refPath,
          "video_analysis",
          async () => {
            // Upload to Gemini
            send("status", { step: "gemini_upload", message: "Uploading to Gemini..." });

            const mimeType = refPath.toLowerCase().endsWith(".mov")
              ? "video/quicktime"
              : "video/mp4";
            const geminiFile = await uploadToGemini(
              refPath,
              mimeType,
              path.basename(refPath)
            );

            send("status", { step: "gemini_processing", message: "Gemini processing video..." });
            const processedFile = await waitForFileProcessing(geminiFile.name);

            const fileData = {
              fileData: {
                mimeType: processedFile.mimeType,
                fileUri: processedFile.uri,
              },
            };

            // Consolidated analysis (Pass 1 + Pass 3 merged)
            send("status", { step: "gemini_analysis", message: "Running consolidated analysis..." });

            let responseText: string;
            try {
              const result = await withRetry(() =>
                geminiFlash.generateContent([
                  { text: REFERENCE_CONSOLIDATED_PROMPT },
                  fileData,
                ])
              );
              responseText = result.response.text();
            } catch (flashErr) {
              send("status", { step: "gemini_fallback", message: "Flash 2.5 failed, trying Pro 2.5..." });
              try {
                const result = await withRetry(() =>
                  geminiPro.generateContent([
                    { text: REFERENCE_CONSOLIDATED_PROMPT },
                    fileData,
                  ])
                );
                responseText = result.response.text();
              } catch (proErr) {
                send("status", { step: "gemini_fallback2", message: "Pro 2.5 failed, trying Flash 2.0..." });
                const result = await withRetry(() =>
                  geminiFallback.generateContent([
                    { text: REFERENCE_CONSOLIDATED_PROMPT },
                    fileData,
                  ])
                );
                responseText = result.response.text();
              }
            }

            const cleaned = responseText
              .replace(/```json\n?/g, "")
              .replace(/```\n?/g, "")
              .trim();
            const parsed = JSON.parse(cleaned);

            return {
              segments: parsed.segments ?? [],
              editing_rhythm: parsed.editing_rhythm ?? {},
              transcription: parsed.transcription ?? { full_text: "", language: "unknown", words: [], sentences: [] },
              visual_events: parsed.visual_events ?? [],
              sync_map: parsed.sync_map ?? [],
            } as VideoAnalysisResult;
          }
        );

        send("step_complete", {
          step: currentStep,
          result: {
            segments: videoAnalysis.segments.length,
            words: videoAnalysis.transcription.words.length,
            sentences: videoAnalysis.transcription.sentences.length,
          },
        });

        // ═══════════════════════════════════════════
        // STEP 1.3: Screenshot Coordinate Extraction
        // ═══════════════════════════════════════════
        currentStep++;
        send("progress", {
          step: currentStep,
          total: totalSteps,
          message: "Step 3/6: Measuring element coordinates from screenshots...",
        });

        const frameCoordinates = await withCache(
          refPath,
          "screenshot_coordinates",
          async () => {
            // Use canvas dimensions from the video (scaled to 1080x1920)
            const coords = await extractAllCoordinates(
              refExtraction.frames,
              1080,
              1920,
              4,   // batch size
              500  // delay between batches
            );

            // Assign segment IDs based on Gemini segment boundaries
            return assignSegmentIds(coords, videoAnalysis.segments);
          }
        );

        send("step_complete", {
          step: currentStep,
          result: {
            framesAnalyzed: frameCoordinates.length,
            withAroll: frameCoordinates.filter((f) => f.elements.aroll).length,
            withBroll: frameCoordinates.filter((f) => f.elements.broll).length,
            withText: frameCoordinates.filter((f) => f.elements.texts.length > 0).length,
          },
        });

        // ═══════════════════════════════════════════
        // STEP 1.4: A-roll Material Analysis
        // ═══════════════════════════════════════════
        currentStep++;
        send("progress", {
          step: currentStep,
          total: totalSteps,
          message: "Step 4/6: Analyzing A-roll material (face detection)...",
        });

        const arollAnalysis = await analyzeARollMaterial(
          arollPath,
          videoAnalysis.transcription // Pass reference transcription for cross-validation
        );

        send("step_complete", {
          step: currentStep,
          result: {
            duration: arollAnalysis.duration,
            faceFrames: arollAnalysis.faceFrames.length,
            silenceRegions: arollAnalysis.silenceRegions.length,
            speechRatio: arollAnalysis.speechRatio,
            cropCenter: arollAnalysis.recommendedCrop.circle,
          },
        });

        // ═══════════════════════════════════════════
        // STEP 1.5: B-roll Material Analysis
        // ═══════════════════════════════════════════
        currentStep++;
        send("progress", {
          step: currentStep,
          total: totalSteps,
          message: `Step 5/6: Analyzing ${brollPaths.length} B-roll material(s)...`,
        });

        const brollAnalyses = [];
        for (let i = 0; i < brollPaths.length; i++) {
          send("status", {
            step: "broll_analysis",
            message: `Analyzing B-roll ${i + 1}/${brollPaths.length}...`,
          });
          const brollResult = await analyzeBRollMaterial(brollPaths[i]);
          brollAnalyses.push(brollResult);
        }

        send("step_complete", {
          step: currentStep,
          result: {
            brollCount: brollAnalyses.length,
            totalScenes: brollAnalyses.reduce((s, b) => s + b.internalScenes.length, 0),
          },
        });

        // ═══════════════════════════════════════════
        // STEP 1.6: Cross-Validation & Blueprint Assembly
        // ═══════════════════════════════════════════
        currentStep++;
        send("progress", {
          step: currentStep,
          total: totalSteps,
          message: "Step 6/6: Cross-validating & assembling blueprint...",
        });

        const blueprint = assembleBlueprint({
          frameExtraction: refExtraction,
          videoAnalysis,
          frameCoordinates,
          arollAnalysis,
          brollAnalyses,
        });

        // Cache the final blueprint
        setCache(refPath, "visual_blueprint", blueprint);

        send("step_complete", {
          step: currentStep,
          result: {
            segments: blueprint.reference.segments.length,
            confidence: blueprint.confidence,
            conflicts: blueprint.conflicts.length,
          },
        });

        // ═══════════════════════════════════════════
        // COMPLETE
        // ═══════════════════════════════════════════
        send("complete", { blueprint });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Blueprint analysis failed";
        console.error("[/api/analyze/blueprint] Error:", error);
        send("error", { message });
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
