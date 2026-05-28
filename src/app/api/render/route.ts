import { NextRequest } from "next/server";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import type { TimelineDefinition } from "@/lib/types/timeline";
import type { RenderConfig, RenderProgress } from "@/lib/types/render";
import { DEFAULT_RENDER_CONFIG } from "@/lib/types/render";
import type { VisualBlueprint, BlueprintSegment } from "@/lib/types/blueprint";
import { renderFullVideo } from "@/lib/render/segmentRenderer";

export const maxDuration = 600; // 10 minutes for rendering
export const dynamic = "force-dynamic";

interface RenderRequest {
  timeline: TimelineDefinition;
  config?: Partial<RenderConfig>;
  /** If provided, uses the segment-aware v2 render pipeline */
  blueprint?: VisualBlueprint;
}

/**
 * Resolve a video src (like "/uploads/IMG_6163.MP4") to an absolute file path.
 */
function resolveVideoPath(src: string, publicDir: string): string {
  if (!src) return "";
  if (src.startsWith("http://") || src.startsWith("https://")) {
    const url = new URL(src);
    src = url.pathname;
  }
  if (src.startsWith("file:///")) {
    return src.replace("file:///", "");
  }
  if (src.startsWith("/")) {
    return path.join(publicDir, src);
  }
  return path.join(publicDir, src);
}

/**
 * POST /api/render — Render timeline to MP4 using FFmpeg.
 *
 * If a VisualBlueprint is provided, uses the v2 segment-aware render pipeline
 * that processes each segment with its correct layout.
 * Otherwise falls back to the v1 single-pass render.
 */
export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function sendProgress(data: RenderProgress) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream may be closed
        }
      }

      try {
        const body: RenderRequest = await request.json();
        const { timeline, config: partialConfig, blueprint } = body;

        if (!timeline || !timeline.segments.length) {
          sendProgress({ stage: "error", progress: 0, error: "No timeline or segments provided" });
          controller.close();
          return;
        }

        const config: RenderConfig = { ...DEFAULT_RENDER_CONFIG, ...partialConfig };
        const totalFrames = Math.round(timeline.duration * timeline.fps);
        const projectRoot = process.cwd();
        const publicDir = path.join(projectRoot, "public");

        // ════════════════════════════════════════════
        // V2 RENDER: Segment-aware pipeline (when blueprint is provided)
        // ════════════════════════════════════════════
        if (blueprint && blueprint.reference.segments.length > 0) {
          sendProgress({ stage: "preparing", progress: 0, totalFrames });

          // Find source files
          const brollSrc = timeline.segments.find((s) => s.broll?.src)?.broll?.src ?? "";
          const arollSrc = timeline.segments.find((s) => s.aroll)?.aroll?.src ?? "";

          const brollPath = resolveVideoPath(brollSrc, publicDir);
          const arollPath = resolveVideoPath(arollSrc, publicDir);

          if (!brollPath || !fs.existsSync(brollPath)) {
            sendProgress({ stage: "error", progress: 0, error: `B-roll video not found: ${brollSrc}` });
            controller.close();
            return;
          }

          // Ensure exports directory exists
          const exportsDir = path.join(publicDir, "exports");
          if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
          }

          const outputFilename = `styleclone-${Date.now()}.mp4`;
          const outputPath = path.join(exportsDir, outputFilename);

          sendProgress({ stage: "rendering", progress: 0.05, totalFrames });

          const totalSegs = blueprint.reference.segments.length;

          // Extract sentence boundaries from transcription for sentence-aligned cuts.
          // Layout transitions (rect↔circle PIP) ONLY happen at sentence endings —
          // mid-sentence transitions cause audio glitches and visual jarring.
          const sentenceBoundaries = blueprint.reference.transcription?.sentences?.map(
            (s: { start: number; end: number }) => ({ start: s.start, end: s.end })
          ) ?? [];

          const result = await renderFullVideo(
            {
              segments: blueprint.reference.segments,
              brollPath,
              arollPath: arollPath && fs.existsSync(arollPath) ? arollPath : "",
              canvasWidth: blueprint.canvas.width,
              canvasHeight: blueprint.canvas.height,
              fps: timeline.fps,
              sentenceBoundaries,
              onSegmentProgress: (segId, idx, total) => {
                const pct = 0.05 + (idx / total) * 0.90;
                sendProgress({
                  stage: "rendering",
                  progress: pct,
                  totalFrames,
                  framesRendered: Math.round(pct * totalFrames),
                });
              },
            },
            outputPath
          );

          if (!result.success) {
            sendProgress({ stage: "error", progress: 0, error: result.error ?? "V2 render failed" });
            controller.close();
            return;
          }

          // Success
          const stats = fs.statSync(outputPath);
          sendProgress({
            stage: "complete",
            progress: 1,
            totalFrames,
            framesRendered: totalFrames,
            outputUrl: `/exports/${outputFilename}`,
            fileSize: stats.size,
          });
          controller.close();
          return;
        }

        // ════════════════════════════════════════════
        // V1 RENDER: Legacy single-pass pipeline (no blueprint)
        // ════════════════════════════════════════════

        sendProgress({ stage: "preparing", progress: 0, totalFrames });

        const outW = timeline.width || 1080;
        const outH = timeline.height || 1920;

        const brollSrc = timeline.segments.find((s) => s.broll?.src)?.broll?.src ?? "";
        const arollSrc = timeline.segments.find((s) => s.aroll)?.aroll?.src ?? "";

        const brollPath = resolveVideoPath(brollSrc, publicDir);
        const arollPath = resolveVideoPath(arollSrc, publicDir);

        if (!brollPath || !fs.existsSync(brollPath)) {
          sendProgress({ stage: "error", progress: 0, error: `B-roll video not found: ${brollSrc}` });
          controller.close();
          return;
        }

        const arollSeg = timeline.segments.find((s) => s.aroll);
        const pipX = arollSeg?.aroll?.position?.[0] ?? 100;
        const pipY = arollSeg?.aroll?.position?.[1] ?? 100;
        const pipW = arollSeg?.aroll?.size?.[0] ?? 300;
        const pipH = arollSeg?.aroll?.size?.[1] ?? 300;
        const pipShape = arollSeg?.aroll?.shape ?? "circle";

        const exportsDir = path.join(publicDir, "exports");
        if (!fs.existsSync(exportsDir)) {
          fs.mkdirSync(exportsDir, { recursive: true });
        }

        const outputFilename = `styleclone-${Date.now()}.mp4`;
        const outputPath = path.join(exportsDir, outputFilename);
        const duration = timeline.duration;

        const ffmpegPath = path.join(
          projectRoot, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe"
        );

        if (!fs.existsSync(ffmpegPath)) {
          sendProgress({ stage: "error", progress: 0, error: "FFmpeg not found" });
          controller.close();
          return;
        }

        sendProgress({ stage: "preparing", progress: 0.1, totalFrames });

        const hasAroll = arollPath && fs.existsSync(arollPath);

        let filterComplex: string;
        let mapArgs: string[];

        if (hasAroll) {
          if (pipShape === "circle") {
            const radius = Math.min(pipW, pipH) / 2;
            filterComplex = [
              `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1[bg]`,
              `[1:v]scale=${pipW}:${pipH}:force_original_aspect_ratio=increase,crop=${pipW}:${pipH},setsar=1[pip_raw]`,
              `[pip_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${pipW / 2},2)+pow(Y-${pipH / 2},2),pow(${radius},2)),255,0)'[pip_circle]`,
              `[bg][pip_circle]overlay=${pipX}:${pipY}:format=auto[out]`,
            ].join(";");
          } else {
            filterComplex = [
              `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1[bg]`,
              `[1:v]scale=${pipW}:${pipH}:force_original_aspect_ratio=increase,crop=${pipW}:${pipH},setsar=1[pip]`,
              `[bg][pip]overlay=${pipX}:${pipY}[out]`,
            ].join(";");
          }
          mapArgs = ["-map", "[out]", "-map", "1:a?"];
        } else {
          filterComplex = `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1[out]`;
          mapArgs = ["-map", "[out]"];
        }

        const filterScriptPath = path.join(exportsDir, `filter-${Date.now()}.txt`);
        fs.writeFileSync(filterScriptPath, filterComplex);

        const args = [
          "-y",
          "-i", brollPath,
          ...(hasAroll ? ["-i", arollPath] : []),
          "-filter_complex_script", filterScriptPath,
          ...mapArgs,
          "-t", duration.toString(),
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "23",
          "-c:a", "aac",
          "-b:a", "128k",
          "-movflags", "+faststart",
          "-pix_fmt", "yuv420p",
          outputPath,
        ];

        sendProgress({ stage: "rendering", progress: 0.15, totalFrames });

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(ffmpegPath, args, {
            cwd: projectRoot,
            shell: false,
          });

          let stderr = "";

          proc.stderr?.on("data", (data: Buffer) => {
            const line = data.toString();
            stderr += line;

            const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
            if (timeMatch) {
              const hours = parseInt(timeMatch[1]);
              const minutes = parseInt(timeMatch[2]);
              const seconds = parseFloat(timeMatch[3]);
              const currentTime = hours * 3600 + minutes * 60 + seconds;
              const pct = Math.min(currentTime / duration, 0.99);
              sendProgress({
                stage: "rendering",
                progress: 0.15 + pct * 0.80,
                totalFrames,
                framesRendered: Math.round(pct * totalFrames),
              });
            }
          });

          proc.on("close", (code) => {
            try { fs.unlinkSync(filterScriptPath); } catch { /* ignore */ }

            if (code === 0 && fs.existsSync(outputPath)) {
              resolve();
            } else {
              const errorLines = stderr
                .split("\n")
                .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid"))
                .slice(0, 3);
              reject(
                new Error(
                  errorLines.length > 0
                    ? errorLines.join("; ")
                    : `FFmpeg exited with code ${code}`
                )
              );
            }
          });

          proc.on("error", (err) => {
            try { fs.unlinkSync(filterScriptPath); } catch { /* ignore */ }
            reject(err);
          });
        });

        const stats = fs.statSync(outputPath);
        sendProgress({
          stage: "complete",
          progress: 1,
          totalFrames,
          framesRendered: totalFrames,
          outputUrl: `/exports/${outputFilename}`,
          fileSize: stats.size,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown render error";
        sendProgress({ stage: "error", progress: 0, error: message });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
