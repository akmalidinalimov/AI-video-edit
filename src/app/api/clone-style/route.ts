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
import {
  analyzeNarrativeContext,
  buildArollSummaries,
  buildBrollSummaries,
  summariesToBrollScenes,
} from "@/lib/pipeline/narrative-analyzer";

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
// A-ROLL TRANSCRIPTION — Independent from reference
// ════════════════════════════════════════════════════════════

/**
 * Transcribe the A-roll video to get accurate word-level timestamps.
 *
 * The reference video's transcription has DIFFERENT timing because it was
 * edited (with B-roll overlays). The A-roll is the raw footage, so we
 * must transcribe it independently to get correct sentence boundaries
 * for layout transitions.
 */
async function transcribeAroll(
  videoPath: string
): Promise<{ words: Array<{ word: string; start: number; end: number }>; sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }> }> {
  return withCache(videoPath, "aroll_transcription", async () => {
    console.log("[clone-style] Transcribing A-roll independently for accurate sentence boundaries...");

    const mimeType = videoPath.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
    const geminiFile = await uploadToGemini(videoPath, mimeType, path.basename(videoPath));
    const processedFile = await waitForFileProcessing(geminiFile.name);

    const fileData = {
      fileData: {
        mimeType: processedFile.mimeType,
        fileUri: processedFile.uri,
      },
    };

    const prompt = `You are a precise speech-to-text transcription engine.

Transcribe this video's audio with EXACT word-level timestamps.

CRITICAL INSTRUCTIONS:
- Provide timestamps for EVERY word
- Timestamps must be in SECONDS (decimal, e.g., 2.35)
- Start time = when the word begins being spoken
- End time = when the word finishes being spoken
- Be as precise as possible — even 0.1s matters for video editing
- Group words into sentences (a sentence ends with a period, question mark, or exclamation mark)
- For each sentence, assign semantic_tags that describe the content topic (e.g., ["intro", "hook"], ["product_demo"], ["call_to_action"])

Return JSON in this EXACT format:
{
  "words": [
    { "word": "example", "start": 0.0, "end": 0.5 },
    ...
  ],
  "sentences": [
    { "text": "Full sentence text.", "start": 0.0, "end": 3.5, "semantic_tags": ["intro", "hook"] },
    ...
  ]
}

Return ONLY the JSON, no markdown fences, no explanation.`;

    const result = await withRetry(() =>
      geminiFlash.generateContent([{ text: prompt }, fileData])
    );
    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const data = JSON.parse(cleaned);

    console.log(`[clone-style] A-roll transcription: ${data.words?.length ?? 0} words, ${data.sentences?.length ?? 0} sentences`);
    for (const s of (data.sentences ?? [])) {
      console.log(`  [${s.start.toFixed(2)}-${s.end.toFixed(2)}s] "${s.text.slice(0, 60)}${s.text.length > 60 ? '...' : ''}"`);
    }

    return {
      words: data.words ?? [],
      sentences: data.sentences ?? [],
    };
  });
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

          sendSSE({ phase: "analyzing_reference", progress: 24, message: `Analyzing B-roll material (${brollPaths.length} source${brollPaths.length > 1 ? 's' : ''})...` });

          // Step 1.5: B-roll analysis — analyze ALL B-roll sources
          const allBrollAnalyses = [];
          for (let bi = 0; bi < brollPaths.length; bi++) {
            const bAnalysis = await analyzeBRollMaterial(brollPaths[bi]);
            allBrollAnalyses.push(bAnalysis);
            if (brollPaths.length > 1) {
              console.log(`[clone-style] B-roll #${bi + 1}: ${bAnalysis.internalScenes.length} scenes, ${bAnalysis.duration.toFixed(1)}s`);
            }
          }

          sendSSE({ phase: "analyzing_reference", progress: 25, message: "Assembling blueprint..." });

          // Step 1.6: Assemble blueprint
          blueprint = assembleBlueprint({
            frameExtraction: refExtraction,
            videoAnalysis,
            frameCoordinates,
            arollAnalysis,
            brollAnalyses: allBrollAnalyses,
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
        sendSSE({ phase: "building_plan", progress: 48, message: `Transcribing A-roll (${arollPaths.length} clip${arollPaths.length > 1 ? 's' : ''})...` });

        // ── Multi-A-roll transcription ──
        // Each clip is transcribed independently. Timestamps are offset by the
        // cumulative duration of preceding clips so they form a continuous timeline.
        const allArollTranscriptions: Array<{
          words: Array<{ word: string; start: number; end: number }>;
          sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }>;
        }> = [];
        const arollClipMeta: Array<{ path: string; duration: number; timelineStart: number }> = [];
        let cumulativeOffset = 0;

        for (let ai = 0; ai < arollPaths.length; ai++) {
          const clipPath = arollPaths[ai];
          const clipTranscription = await transcribeAroll(clipPath);

          // Get clip duration for offset calculation
          const clipMeta = await getVideoMetadata(clipPath);
          const clipDuration = clipMeta.duration;

          // Offset timestamps for clips after the first
          const offsetWords = clipTranscription.words.map((w) => ({
            ...w,
            start: w.start + cumulativeOffset,
            end: w.end + cumulativeOffset,
          }));
          const offsetSentences = clipTranscription.sentences.map((s) => ({
            ...s,
            start: s.start + cumulativeOffset,
            end: s.end + cumulativeOffset,
          }));

          allArollTranscriptions.push({
            words: offsetWords,
            sentences: offsetSentences,
          });

          arollClipMeta.push({
            path: clipPath,
            duration: clipDuration,
            timelineStart: cumulativeOffset,
          });

          if (arollPaths.length > 1) {
            console.log(`[clone-style] A-roll #${ai + 1}: offset=${cumulativeOffset.toFixed(2)}s, duration=${clipDuration.toFixed(2)}s, ${offsetSentences.length} sentences`);
          }

          cumulativeOffset += clipDuration;
        }

        // Merge all transcriptions into one continuous timeline
        const mergedTranscription = {
          words: allArollTranscriptions.flatMap((t) => t.words),
          sentences: allArollTranscriptions.flatMap((t) => t.sentences),
        };

        // Save merged transcription for debugging
        fs.writeFileSync(
          path.join(tempDir, "aroll-transcription.json"),
          JSON.stringify({
            clipCount: arollPaths.length,
            clips: arollClipMeta,
            ...mergedTranscription,
          }, null, 2)
        );

        sendSSE({ phase: "building_plan", progress: 50, message: "Analyzing content relationships..." });

        // ── Multi-B-roll scene extraction ──
        // Collect scenes from ALL B-roll sources with source index tracking
        const allBrollScenes: Array<{ start: number; end: number; contentTags: string[]; description: string; sourceIndex: number }> = [];
        const brollClipMeta: Array<{ path: string; duration: number; inputIndex: number }> = [];

        const brollData = blueprint.broll ?? [];
        for (let bi = 0; bi < brollPaths.length; bi++) {
          const brollAnalysis = brollData[bi];
          const brollMeta = brollAnalysis
            ? { duration: brollAnalysis.duration }
            : await getVideoMetadata(brollPaths[bi]);

          brollClipMeta.push({
            path: brollPaths[bi],
            duration: brollMeta.duration,
            inputIndex: bi,
          });

          const scenes = brollAnalysis?.internalScenes ?? [];
          for (const scene of scenes) {
            allBrollScenes.push({
              start: (scene as { start: number }).start,
              end: (scene as { end: number }).end,
              contentTags: (scene as { contentTags: string[] }).contentTags ?? [],
              description: (scene as { description: string }).description ?? "",
              sourceIndex: bi,
            });
          }
        }

        const totalBrollDuration = brollClipMeta.reduce((sum, m) => sum + m.duration, 0);

        // ── Narrative context analysis (deep content awareness) ──
        // Single Gemini call that understands the overall story and maps
        // sentences to B-roll scenes with reasoning
        let narrativeContext;
        if (allBrollScenes.length > 0 && mergedTranscription.sentences.length > 0) {
          try {
            const arollSummaries = buildArollSummaries(allArollTranscriptions);
            const brollSummaries = buildBrollSummaries(
              brollData.length > 0
                ? brollData.map((b: any) => ({ internalScenes: b.internalScenes ?? [] }))
                : [{ internalScenes: allBrollScenes }]
            );

            narrativeContext = await analyzeNarrativeContext(
              arollSummaries.summaries,
              brollSummaries
            );

            // Save narrative context for debugging
            fs.writeFileSync(
              path.join(tempDir, "narrative-context.json"),
              JSON.stringify(narrativeContext, null, 2)
            );
          } catch (err) {
            console.error("[clone-style] Narrative analysis failed, falling back to tag matching:", err);
          }
        }

        sendSSE({ phase: "building_plan", progress: 53, message: "Building editing plan..." });

        const editingPlan = buildEditingPlan({
          blueprintSegments: blueprint.reference.segments as unknown as Parameters<typeof buildEditingPlan>[0]["blueprintSegments"],
          transcription: {
            words: mergedTranscription.words ?? [],
            sentences: mergedTranscription.sentences ?? [],
          },
          templateId: dynamicTemplate.id,
          template: dynamicTemplate,
          sources: {
            aroll: arollPath,
            broll: brollPath,
            arollClips: arollClipMeta,
            brollClips: brollClipMeta,
          },
          // Content-aware B-roll matching (all sources unified)
          brollScenes: allBrollScenes.length > 0 ? allBrollScenes : undefined,
          brollDuration: totalBrollDuration > 0 ? totalBrollDuration : undefined,
          // Deep narrative understanding (when available)
          narrativeContext,
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

        // Get A-roll source dimensions for face-centered crop (use first clip)
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

        // Debug logging: key render parameters
        console.log("[clone-style] ═══ RENDER DEBUG ═══");
        console.log("[clone-style] A-roll source:", JSON.stringify(arollMeta.resolution));
        console.log("[clone-style] Face info:", JSON.stringify(faceInfo));
        for (const [layoutId, layout] of Object.entries(dynamicTemplate.layouts)) {
          console.log(`[clone-style] Layout "${layoutId}" faceCropCenter:`, JSON.stringify((layout as any).aroll?.faceCropCenter));
          console.log(`[clone-style] Layout "${layoutId}" aroll region:`, JSON.stringify((layout as any).aroll?.region));
          console.log(`[clone-style] Layout "${layoutId}" aroll shape:`, (layout as any).aroll?.shape);
        }
        console.log("[clone-style] Filter (first 500 chars):", renderOutput.filterComplex.slice(0, 500));
        console.log("[clone-style] ═══ END DEBUG ═══");

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
            // Preserve filter script for debugging (copy to sp-temp)
            try {
              const debugFilterPath = path.join(tempDir, "last-render-filter.txt");
              fs.copyFileSync(filterScriptPath, debugFilterPath);
              console.log(`[clone-style] Filter saved to: ${debugFilterPath}`);
            } catch { /* ignore copy failure */ }
            // Clean up original filter script
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
