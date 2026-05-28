/**
 * Step 1.1 — FFmpeg Frame & Scene Infrastructure
 *
 * Core utility for extracting frames, detecting scene changes, and
 * analyzing silence regions from video files using FFmpeg.
 *
 * Uses the bundled ffmpeg.exe from @ffmpeg-installer/win32-x64 to avoid
 * Turbopack module resolution issues with require().
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import type {
  VideoMetadata,
  SceneChange,
  ExtractedFrame,
  SilenceRegion,
  FrameExtractionResult,
} from "@/lib/types/blueprint";

// ── FFmpeg binary resolution ──

function getProjectRoot(): string {
  return process.cwd();
}

function getFFmpegPath(): string {
  const root = getProjectRoot();
  return path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
}

function getFFprobePath(): string {
  // ffprobe ships alongside ffmpeg in the same package
  const root = getProjectRoot();
  const probePath = path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffprobe.exe");
  if (fs.existsSync(probePath)) return probePath;
  // Fallback: some installs put ffprobe in a separate package
  const altPath = path.join(root, "node_modules", "@ffprobe-installer", "win32-x64", "ffprobe.exe");
  if (fs.existsSync(altPath)) return altPath;
  // Last fallback: use ffmpeg with probe-style flags (ffmpeg can still probe)
  return "";
}

// ── Utility: run a process and collect output ──

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runProcess(
  binary: string,
  args: string[],
  timeoutMs = 60_000
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd: getProjectRoot(),
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Frame output directory management ──

export function getAnalysisDir(
  category: "ref" | "aroll" | "broll",
  filename: string
): string {
  const root = getProjectRoot();
  const dir = path.join(root, "public", "analysis", category, filename);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeFilename(videoPath: string): string {
  return path.basename(videoPath, path.extname(videoPath)).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ── 1. getVideoMetadata ──

export async function getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
  const ffmpeg = getFFmpegPath();

  // Use ffmpeg -i to probe (works even without ffprobe)
  const result = await runProcess(ffmpeg, ["-i", videoPath, "-hide_banner"], 15_000);

  // FFmpeg outputs info to stderr when just probing
  const output = result.stderr;

  // Parse duration: "Duration: 00:00:25.08"
  const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  let duration = 0;
  if (durationMatch) {
    duration = parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3]);
  }

  // Parse fps: "30 fps" or "29.97 fps"
  const fpsMatch = output.match(/(\d+\.?\d*)\s*fps/);
  const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;

  // Parse resolution: "1080x1920" or "Stream ... Video: ... 1080x1920"
  const resMatch = output.match(/(\d{3,4})x(\d{3,4})/);
  const width = resMatch ? parseInt(resMatch[1]) : 1080;
  const height = resMatch ? parseInt(resMatch[2]) : 1920;

  // Parse codec: "Video: h264" or "Video: hevc"
  const codecMatch = output.match(/Video:\s*(\w+)/);
  const codec = codecMatch ? codecMatch[1] : "unknown";

  // Parse bitrate: "bitrate: 5847 kb/s"
  const bitrateMatch = output.match(/bitrate:\s*(\d+)\s*kb\/s/);
  const bitrate = bitrateMatch ? parseInt(bitrateMatch[1]) * 1000 : 0;

  // Check for audio stream
  const hasAudio = /Audio:/.test(output);

  return {
    videoPath,
    duration,
    fps,
    resolution: { width, height },
    codec,
    bitrate,
    hasAudio,
  };
}

// ── 2. extractSceneChanges ──

export async function extractSceneChanges(
  videoPath: string,
  threshold = 0.3
): Promise<SceneChange[]> {
  const ffmpeg = getFFmpegPath();

  // Use the select filter with scene detection and showinfo to get timestamps
  const result = await runProcess(ffmpeg, [
    "-i", videoPath,
    "-vf", `select='gt(scene,${threshold})',showinfo`,
    "-f", "null",
    "-",
  ], 30_000);

  const sceneChanges: SceneChange[] = [];

  // Parse showinfo output from stderr:
  // [Parsed_showinfo_1 @ ...] n:  42 pts: 126000 pts_time:4.2 ...
  const lines = result.stderr.split("\n");
  for (const line of lines) {
    const timeMatch = line.match(/pts_time:\s*([\d.]+)/);
    if (timeMatch && line.includes("showinfo")) {
      const timestamp = parseFloat(timeMatch[1]);

      // Try to extract scene score from the select filter metadata
      // Format varies; default to threshold if not parseable
      let score = threshold;
      const scoreMatch = line.match(/scene_score=([\d.]+)/);
      if (scoreMatch) {
        score = parseFloat(scoreMatch[1]);
      }

      sceneChanges.push({ timestamp, score });
    }
  }

  // Sort by timestamp
  sceneChanges.sort((a, b) => a.timestamp - b.timestamp);

  return sceneChanges;
}

// ── 3. extractFrames ──

export interface ExtractFramesOptions {
  /** Extract frames at fixed intervals (seconds). Default: 0.5 */
  intervalSeconds?: number;
  /** Also extract frames at detected scene changes. Default: true */
  includeSceneChanges?: boolean;
  /** Scene detection threshold for scene change extraction. Default: 0.3 */
  sceneThreshold?: number;
  /** Category for output directory naming */
  category?: "ref" | "aroll" | "broll";
  /** JPEG quality 1-31 (lower = better). Default: 2 */
  quality?: number;
  /** Max frames to extract. Default: 200 */
  maxFrames?: number;
}

export async function extractFrames(
  videoPath: string,
  opts: ExtractFramesOptions = {}
): Promise<ExtractedFrame[]> {
  const {
    intervalSeconds = 0.5,
    includeSceneChanges = true,
    sceneThreshold = 0.3,
    category = "ref",
    quality = 2,
    maxFrames = 200,
  } = opts;

  const ffmpeg = getFFmpegPath();
  const filename = sanitizeFilename(videoPath);
  const outDir = getAnalysisDir(category, filename);

  // Get video duration first
  const meta = await getVideoMetadata(videoPath);
  const duration = meta.duration;

  // Build list of timestamps to extract
  const timestampsSet = new Set<number>();

  // Fixed interval frames
  for (let t = 0; t <= duration; t += intervalSeconds) {
    timestampsSet.add(Math.round(t * 100) / 100); // Round to 2 decimals
  }

  // Scene change frames
  let sceneChangeTimes: Set<number> = new Set();
  if (includeSceneChanges) {
    const scenes = await extractSceneChanges(videoPath, sceneThreshold);
    for (const sc of scenes) {
      const rounded = Math.round(sc.timestamp * 100) / 100;
      timestampsSet.add(rounded);
      sceneChangeTimes.add(rounded);
    }
  }

  // Convert to sorted array and limit
  let timestamps = Array.from(timestampsSet).sort((a, b) => a - b);
  if (timestamps.length > maxFrames) {
    timestamps = timestamps.slice(0, maxFrames);
  }

  // Extract frames using a single FFmpeg call with the fps filter + select
  // For efficiency, use fps filter for interval frames
  // Then extract scene-change frames separately if needed

  // Approach: Extract all at fixed interval using fps filter (fast, single pass)
  const fpsRate = 1 / intervalSeconds; // e.g., 2 fps for 0.5s intervals
  const intervalPattern = `frame-%04d.jpg`;
  const intervalOutPath = path.join(outDir, intervalPattern);

  // Clean old frames
  const existingFrames = fs.readdirSync(outDir).filter(f => f.endsWith(".jpg"));
  for (const f of existingFrames) {
    fs.unlinkSync(path.join(outDir, f));
  }

  // Extract interval frames
  await runProcess(ffmpeg, [
    "-i", videoPath,
    "-vf", `fps=${fpsRate}`,
    "-q:v", quality.toString(),
    "-vsync", "vfr",
    intervalOutPath,
  ], 60_000);

  // Build result from extracted files
  const extractedFiles = fs.readdirSync(outDir)
    .filter(f => f.startsWith("frame-") && f.endsWith(".jpg"))
    .sort();

  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < extractedFiles.length && i < maxFrames; i++) {
    const timestamp = Math.round(i * intervalSeconds * 100) / 100;
    const framePath = path.join(outDir, extractedFiles[i]);

    frames.push({
      timestamp,
      path: framePath,
      isSceneChange: sceneChangeTimes.has(timestamp) ||
        // Check if any scene change is within 0.3s of this frame
        Array.from(sceneChangeTimes).some(sc => Math.abs(sc - timestamp) < intervalSeconds / 2),
    });
  }

  // Extract additional frames specifically at scene change timestamps
  // that don't align with interval frames
  if (includeSceneChanges) {
    const scenes = await extractSceneChanges(videoPath, sceneThreshold);
    let scIdx = frames.length;
    for (const sc of scenes) {
      // Check if we already have a frame within 0.2s of this scene change
      const hasClose = frames.some(f => Math.abs(f.timestamp - sc.timestamp) < 0.2);
      if (!hasClose && frames.length < maxFrames) {
        const scFramePath = path.join(outDir, `scene-${String(scIdx).padStart(4, "0")}.jpg`);

        // Extract single frame at exact timestamp
        const seekResult = await runProcess(ffmpeg, [
          "-ss", sc.timestamp.toString(),
          "-i", videoPath,
          "-frames:v", "1",
          "-q:v", quality.toString(),
          scFramePath,
        ], 10_000);

        if (fs.existsSync(scFramePath)) {
          frames.push({
            timestamp: Math.round(sc.timestamp * 100) / 100,
            path: scFramePath,
            isSceneChange: true,
          });
          scIdx++;
        }
      }
    }
  }

  // Sort by timestamp
  frames.sort((a, b) => a.timestamp - b.timestamp);

  return frames;
}

// ── 4. detectSilence ──

export async function detectSilence(
  videoPath: string,
  noiseDb = -30,
  minDurationSec = 0.3
): Promise<SilenceRegion[]> {
  const ffmpeg = getFFmpegPath();

  const result = await runProcess(ffmpeg, [
    "-i", videoPath,
    "-af", `silencedetect=n=${noiseDb}dB:d=${minDurationSec}`,
    "-f", "null",
    "-",
  ], 30_000);

  const regions: SilenceRegion[] = [];
  const lines = result.stderr.split("\n");

  let currentStart: number | null = null;

  for (const line of lines) {
    // [silencedetect @ ...] silence_start: 3.456
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    if (startMatch) {
      currentStart = parseFloat(startMatch[1]);
      continue;
    }

    // [silencedetect @ ...] silence_end: 4.789 | silence_duration: 1.333
    const endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (endMatch && currentStart !== null) {
      const end = parseFloat(endMatch[1]);
      const duration = parseFloat(endMatch[2]);
      regions.push({
        start: currentStart,
        end,
        duration,
      });
      currentStart = null;
    }
  }

  return regions;
}

// ── 5. Full extraction pipeline ──

export interface FullExtractionOptions extends ExtractFramesOptions {
  /** Run silence detection (only meaningful for videos with audio). Default: true */
  detectSilenceRegions?: boolean;
  /** Silence detection noise threshold in dB. Default: -30 */
  silenceNoiseDb?: number;
  /** Minimum silence duration in seconds. Default: 0.3 */
  silenceMinDuration?: number;
}

export async function extractFullAnalysis(
  videoPath: string,
  opts: FullExtractionOptions = {}
): Promise<FrameExtractionResult> {
  const {
    detectSilenceRegions = true,
    silenceNoiseDb = -30,
    silenceMinDuration = 0.3,
    ...frameOpts
  } = opts;

  // Run metadata + scene changes + frames in sequence (frames depend on scene changes)
  const metadata = await getVideoMetadata(videoPath);

  // Extract frames (includes scene change detection internally)
  const frames = await extractFrames(videoPath, frameOpts);

  // Extract scene changes list for the result
  const sceneChanges = await extractSceneChanges(
    videoPath,
    frameOpts.sceneThreshold ?? 0.3
  );

  // Detect silence regions if video has audio and it's requested
  let silenceRegions: SilenceRegion[] = [];
  if (detectSilenceRegions && metadata.hasAudio) {
    silenceRegions = await detectSilence(
      videoPath,
      silenceNoiseDb,
      silenceMinDuration
    );
  }

  return {
    videoPath,
    duration: metadata.duration,
    fps: metadata.fps,
    resolution: metadata.resolution,
    sceneChanges,
    frames,
    silenceRegions,
  };
}

// ── 6. Extract a single frame at a specific timestamp ──

export async function extractSingleFrame(
  videoPath: string,
  timestamp: number,
  outputPath: string,
  quality = 2
): Promise<string> {
  const ffmpeg = getFFmpegPath();

  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await runProcess(ffmpeg, [
    "-ss", timestamp.toString(),
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", quality.toString(),
    outputPath,
  ], 10_000);

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Failed to extract frame at ${timestamp}s from ${videoPath}`);
  }

  return outputPath;
}

// ── 7. Extract matched frame pairs (for verification) ──

export async function extractMatchedFramePairs(
  refVideoPath: string,
  outputVideoPath: string,
  timestamps: number[],
  outputDir: string
): Promise<{ timestamp: number; refFrame: string; outputFrame: string }[]> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const pairs: { timestamp: number; refFrame: string; outputFrame: string }[] = [];

  for (const ts of timestamps) {
    const refFrame = path.join(outputDir, `ref-${ts.toFixed(2).replace(".", "_")}.jpg`);
    const outFrame = path.join(outputDir, `out-${ts.toFixed(2).replace(".", "_")}.jpg`);

    await Promise.all([
      extractSingleFrame(refVideoPath, ts, refFrame),
      extractSingleFrame(outputVideoPath, ts, outFrame),
    ]);

    pairs.push({ timestamp: ts, refFrame, outputFrame: outFrame });
  }

  return pairs;
}
