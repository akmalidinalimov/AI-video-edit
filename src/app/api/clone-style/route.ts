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
import { spawn } from "child_process";

// Analysis pipeline
import { extractFullAnalysis, getVideoMetadata } from "@/lib/analysis/frameExtractor";
import { extractAllCoordinates, assignSegmentIds } from "@/lib/analysis/screenshotAnalyzer";
import { analyzeARollMaterial, analyzeBRollMaterial } from "@/lib/analysis/materialAnalyzer";
import { assembleBlueprint } from "@/lib/analysis/crossValidator";
import { withCache, setCache, getCached } from "@/lib/analysis/analysisCache";

// Gemini
import { geminiFlash, geminiPro, geminiFallback } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";
import { REFERENCE_CONSOLIDATED_PROMPT } from "@/lib/gemini/prompts/referenceConsolidated";

// Pipeline modules
import { generateTemplate, extractFaceInfo } from "@/lib/pipeline/template-generator";
import { buildEditingPlan } from "@/lib/pipeline/plan-builder";
import { buildRenderArgsWithScript } from "@/lib/pipeline/plan-renderer";

// Types
import type {
  FrameExtractionResult,
  VideoAnalysisResult,
  VisualBlueprint,
} from "@/lib/types/blueprint";

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

function getFFmpegPath(): string {
  const root = process.cwd();
  // Windows dev
  const winPath = path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
  if (fs.existsSync(winPath)) return winPath;
  // Linux deploy
  if (fs.existsSync("/usr/bin/ffmpeg")) return "/usr/bin/ffmpeg";
  // Env override
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  throw new Error("FFmpeg not found. Set FFMPEG_PATH environment variable.");
}

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
      const isRetryable =
        message.includes("503") ||
        message.includes("429") ||
        message.includes("overloaded") ||
        message.includes("high demand");
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.log(`[clone-style] Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("withRetry exhausted");
}

// ════════════════════════════════════════════════════════════
// SSE EVENT TYPES
// ════════════════════════════════════════════════════════════

interface SSEEvent {
  phase: "analyzing_reference" | "generating_template" | "building_plan" | "rendering" | "complete" | "error";
  progress: number;
  message?: string;
  downloadUrl?: string;
}

// ════════════════════════════════════════════════════════════
// CLONE-STYLE REQUEST
// ════════════════════════════════════════════════════════════

interface CloneStyleRequest {
  referenceVideo: string;
  arollVideo: string;
  brollVideo: string;
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

        // ── Validate inputs ──
        const refPath = resolvePublicPath(body.referenceVideo);
        const arollPath = resolvePublicPath(body.arollVideo);
        const brollPath = resolvePublicPath(body.brollVideo);

        for (const [label, filePath] of [
          ["Reference video", refPath],
          ["A-roll video", arollPath],
          ["B-roll video", brollPath],
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

        // ════════════════════════════════════════════
        // PHASE 1: Blueprint Analysis
        // ════════════════════════════════════════════
        sendSSE({ phase: "analyzing_reference", progress: 10, message: "Extracting frames from reference..." });

        // Check for cached blueprint first
        let blueprint = getCached<VisualBlueprint>(refPath, "visual_blueprint");

        if (!blueprint) {
          // Step 1.1: Frame extraction
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

          sendSSE({ phase: "analyzing_reference", progress: 15, message: "Analyzing video with Gemini..." });

          // Step 1.2: Gemini video analysis
          const videoAnalysis = await withCache<VideoAnalysisResult>(
            refPath,
            "video_analysis",
            async () => {
              const mimeType = refPath.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
              const geminiFile = await uploadToGemini(refPath, mimeType, path.basename(refPath));
              const processedFile = await waitForFileProcessing(geminiFile.name);

              const fileData = {
                fileData: {
                  mimeType: processedFile.mimeType,
                  fileUri: processedFile.uri,
                },
              };

              let responseText: string;
              try {
                const result = await withRetry(() =>
                  geminiFlash.generateContent([{ text: REFERENCE_CONSOLIDATED_PROMPT }, fileData])
                );
                responseText = result.response.text();
              } catch {
                try {
                  const result = await withRetry(() =>
                    geminiPro.generateContent([{ text: REFERENCE_CONSOLIDATED_PROMPT }, fileData])
                  );
                  responseText = result.response.text();
                } catch {
                  const result = await withRetry(() =>
                    geminiFallback.generateContent([{ text: REFERENCE_CONSOLIDATED_PROMPT }, fileData])
                  );
                  responseText = result.response.text();
                }
              }

              const cleaned = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
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

          sendSSE({ phase: "analyzing_reference", progress: 20, message: "Measuring coordinates from screenshots..." });

          // Step 1.3: Screenshot coordinates
          const frameCoordinates = await withCache(
            refPath,
            "screenshot_coordinates",
            async () => {
              const coords = await extractAllCoordinates(
                refExtraction.frames, 1080, 1920, 4, 500
              );
              return assignSegmentIds(coords, videoAnalysis.segments);
            }
          );

          sendSSE({ phase: "analyzing_reference", progress: 22, message: "Analyzing A-roll material..." });

          // Step 1.4: A-roll material analysis
          const arollAnalysis = await analyzeARollMaterial(arollPath, videoAnalysis.transcription);

          sendSSE({ phase: "analyzing_reference", progress: 24, message: "Analyzing B-roll material..." });

          // Step 1.5: B-roll analysis
          const brollAnalysis = await analyzeBRollMaterial(brollPath);

          sendSSE({ phase: "analyzing_reference", progress: 25, message: "Assembling blueprint..." });

          // Step 1.6: Assemble blueprint
          blueprint = assembleBlueprint({
            frameExtraction: refExtraction,
            videoAnalysis,
            frameCoordinates,
            arollAnalysis,
            brollAnalyses: [brollAnalysis],
          });

          // Cache it
          setCache(refPath, "visual_blueprint", blueprint);
        } else {
          sendSSE({ phase: "analyzing_reference", progress: 25, message: "Using cached blueprint" });
        }

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

        // ════════════════════════════════════════════
        // PHASE 3: Editing Plan
        // ════════════════════════════════════════════
        sendSSE({ phase: "building_plan", progress: 50, message: "Building editing plan..." });

        // Get A-roll transcription from blueprint (reference video transcription)
        const transcription = blueprint.reference.transcription;

        const editingPlan = buildEditingPlan({
          blueprintSegments: blueprint.reference.segments as unknown as Parameters<typeof buildEditingPlan>[0]["blueprintSegments"],
          transcription: {
            words: transcription.words ?? [],
            sentences: transcription.sentences ?? [],
          },
          templateId: dynamicTemplate.id,
          template: dynamicTemplate,
          sources: {
            aroll: arollPath,
            broll: brollPath,
          },
        });

        sendSSE({ phase: "building_plan", progress: 55, message: `Plan: ${editingPlan.layoutRanges.length} ranges, ${editingPlan.transitions.length} transitions` });

        // Save plan for debugging
        fs.writeFileSync(
          path.join(tempDir, "dynamic-plan.json"),
          JSON.stringify(editingPlan, null, 2)
        );

        // ════════════════════════════════════════════
        // PHASE 4: Single-Pass FFmpeg Render
        // ════════════════════════════════════════════
        sendSSE({ phase: "rendering", progress: 60, message: "Preparing render..." });

        const ffmpegPath = getFFmpegPath();

        // Get A-roll source dimensions for face-centered crop
        const arollMeta = await getVideoMetadata(arollPath);

        const outputFilename = `styleclone-${Date.now()}.mp4`;
        const outputPath = path.join(exportsDir, outputFilename);
        const filterScriptPath = path.join(tempDir, `filter-${Date.now()}.txt`);

        // Build FFmpeg args using single-pass plan renderer
        const renderOutput = buildRenderArgsWithScript(
          {
            plan: editingPlan,
            template: dynamicTemplate,
            arollSourceDimensions: arollMeta.resolution,
            ffmpegPath,
            outputPath,
          },
          filterScriptPath
        );

        // Write filter script to file
        fs.writeFileSync(filterScriptPath, renderOutput.filterComplex);

        sendSSE({ phase: "rendering", progress: 65, message: "Rendering video (single-pass FFmpeg)..." });

        // Spawn FFmpeg
        const totalDuration = editingPlan.totalDuration;

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(ffmpegPath, renderOutput.ffmpegArgs, {
            cwd: process.cwd(),
            shell: false,
          });

          let stderr = "";
          const timeoutMs = 180_000; // 3 minutes
          const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            reject(new Error("FFmpeg render timed out after 3 minutes"));
          }, timeoutMs);

          proc.stderr?.on("data", (data: Buffer) => {
            const line = data.toString();
            stderr += line;

            // Parse FFmpeg progress from stderr
            const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
            if (timeMatch) {
              const hours = parseInt(timeMatch[1]);
              const minutes = parseInt(timeMatch[2]);
              const seconds = parseFloat(timeMatch[3]);
              const currentTime = hours * 3600 + minutes * 60 + seconds;
              const pct = Math.min(currentTime / totalDuration, 0.99);
              // Map rendering progress to 65-95 range
              const progress = 65 + Math.round(pct * 30);
              sendSSE({
                phase: "rendering",
                progress,
                message: `Rendering: ${Math.round(pct * 100)}%`,
              });
            }
          });

          proc.on("close", (code) => {
            clearTimeout(timer);
            // Clean up filter script
            try { fs.unlinkSync(filterScriptPath); } catch { /* ignore */ }

            if (code === 0 && fs.existsSync(outputPath)) {
              resolve();
            } else {
              const errorLines = stderr
                .split("\n")
                .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid"))
                .slice(0, 5);
              reject(new Error(
                errorLines.length > 0
                  ? `FFmpeg failed: ${errorLines.join("; ")}`
                  : `FFmpeg exited with code ${code}`
              ));
            }
          });

          proc.on("error", (err) => {
            clearTimeout(timer);
            try { fs.unlinkSync(filterScriptPath); } catch { /* ignore */ }
            reject(err);
          });
        });

        // ════════════════════════════════════════════
        // COMPLETE
        // ════════════════════════════════════════════
        const stats = fs.statSync(outputPath);
        sendSSE({
          phase: "complete",
          progress: 100,
          downloadUrl: `/exports/${outputFilename}`,
          message: `Done! ${(stats.size / 1024 / 1024).toFixed(1)}MB rendered`,
        });

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
