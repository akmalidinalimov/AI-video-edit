/**
 * Step 2.1 — Segment-Aware FFmpeg Render Engine
 *
 * Renders each timeline segment independently with its correct layout,
 * then concatenates all segments into the final video.
 *
 * Supports:
 * - vertical_split: black header + headline text + A-roll + B-roll
 * - pip_overlay: B-roll fullscreen + circle/rectangle A-roll PIP
 * - full_screen: B-roll only (or A-roll only)
 *
 * Uses filter_complex_script to avoid Windows argument escaping issues.
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import type { BlueprintSegment, BoundingBox } from "@/lib/types/blueprint";
import { FONTS } from "@/lib/pipeline/fonts";

// ── FFmpeg binary ──

function getFFmpegPath(): string {
  return path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    "win32-x64",
    "ffmpeg.exe"
  );
}

// ── Types ──

export interface SegmentRenderConfig {
  segment: BlueprintSegment;
  brollPath: string;
  arollPath?: string;
  /** Start time in the B-roll source video (seconds) */
  brollStartFrom: number;
  /** Start time in the A-roll source video (seconds) */
  arollStartFrom: number;
  /** Output canvas dimensions */
  canvasWidth: number;
  canvasHeight: number;
  /** Output FPS */
  fps: number;
  /** Working directory for temp files */
  tempDir: string;
}

export interface SegmentRenderResult {
  segmentId: string;
  outputPath: string;
  duration: number;
  success: boolean;
  error?: string;
}

interface RunResult {
  exitCode: number;
  stderr: string;
}

// ── Utility: run FFmpeg ──

function runFFmpeg(args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFFmpegPath();
    const proc = spawn(ffmpegPath, args, {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
    });

    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("FFmpeg timed out"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stderr });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Consistent circle PIP position ──
// RULE: Once in circle PIP mode, keep the SAME position/size for all segments.
// This prevents visual jumping between circle PIP segments.
// Average of reference circle PIP positions across all circle segments:
// seg_2: (442,195,460×460), seg_3: (576,251,388×388),
// seg_4: (579,171,424×424), seg_5: (579,83,432×432)
// → avg size: ~426, avg x: ~544, avg y: ~175
const CONSISTENT_CIRCLE_PIP = {
  x: 544,
  y: 175,
  width: 426,
  height: 426,
};
const CIRCLE_BORDER_WIDTH = 4;
const CIRCLE_BORDER_COLOR = "0xFFFFFF@0.6";

// Face center in A-roll source (1920×1080 landscape)
const FACE_CENTER = { x: 940, y: 350 };
const AROLL_SOURCE_W = 1920;
const AROLL_SOURCE_H = 1080;

/**
 * Calculate crop offset to keep face centered when cropping from scaled A-roll.
 */
function faceCenteredCrop(targetW: number, targetH: number) {
  const scaleW = targetW / AROLL_SOURCE_W;
  const scaleH = targetH / AROLL_SOURCE_H;
  const scale = Math.max(scaleW, scaleH);
  const scaledW = Math.round(AROLL_SOURCE_W * scale);
  const scaledH = Math.round(AROLL_SOURCE_H * scale);
  const faceX = Math.round(FACE_CENTER.x * scale);
  const faceY = Math.round(FACE_CENTER.y * scale);
  const cropX = Math.max(0, Math.min(faceX - Math.round(targetW / 2), scaledW - targetW));
  const cropY = Math.max(0, Math.min(faceY - Math.round(targetH / 2), scaledH - targetH));
  return { scaledW, scaledH, cropX, cropY };
}

// ── Layout-specific filter builders ──

/**
 * Build FFmpeg filter_complex for vertical_split layout.
 *
 * Layout structure:
 * ┌──────────────┐  <- black header region with headline text
 * │  HEADLINE    │
 * ├──────────────┤
 * │  A-ROLL      │  <- talking head (cropped/scaled)
 * │  (upper)     │
 * ├──────────────┤
 * │  B-ROLL      │  <- secondary footage
 * │  (lower)     │
 * └──────────────┘
 */
function buildVerticalSplitFilter(config: SegmentRenderConfig): string {
  const { segment, canvasWidth, canvasHeight } = config;

  // Get element positions from blueprint
  const aroll = segment.aroll;
  const broll = segment.broll;
  const headerBlack = segment.blackRegions.find((br) => br.purpose === "header");

  // Default positions if not specified
  const headerH = headerBlack?.boundingBox.height ?? 200;
  const arollBox = aroll?.boundingBox ?? { x: 0, y: headerH, width: canvasWidth, height: 600 };
  const brollBox = broll.boundingBox ?? { x: 0, y: headerH + 600, width: canvasWidth, height: canvasHeight - headerH - 600 };

  // input [0] = broll, [1] = aroll (if present)
  const filters: string[] = [];

  // 1. Create black canvas as base
  filters.push(
    `color=black:s=${canvasWidth}x${canvasHeight}:r=${config.fps}:d=${segDuration(segment)}[canvas]`
  );

  // 2. Scale/crop B-roll to fit its region
  filters.push(
    `[0:v]scale=${brollBox.width}:${brollBox.height}:force_original_aspect_ratio=increase,crop=${brollBox.width}:${brollBox.height},setsar=1[broll_scaled]`
  );

  // 3. Overlay B-roll onto canvas
  filters.push(
    `[canvas][broll_scaled]overlay=${brollBox.x}:${brollBox.y}[step1]`
  );

  if (aroll && config.arollPath) {
    // 4. Scale/crop A-roll with face-centered crop
    const fc = faceCenteredCrop(arollBox.width, arollBox.height);
    filters.push(
      `[1:v]scale=${fc.scaledW}:${fc.scaledH},crop=${arollBox.width}:${arollBox.height}:${fc.cropX}:${fc.cropY},setsar=1[aroll_scaled]`
    );

    // 5. Overlay A-roll onto canvas
    filters.push(
      `[step1][aroll_scaled]overlay=${arollBox.x}:${arollBox.y}[step2]`
    );

    // 6. Add ALL headline texts in the header region (not just one)
    const headerBottom = headerH + 150; // Allow some margin below header
    const headerTexts = segment.texts.filter(
      (t) => t.isHeadline && t.boundingBox.y < headerBottom
    );

    let lastLabel = "step2";
    let stepNum = 3;

    for (let i = 0; i < headerTexts.length; i++) {
      const outLabel = i === headerTexts.length - 1 ? "out" : `step${stepNum}`;
      const tf = buildDrawTextFilter(headerTexts[i], lastLabel, outLabel);
      if (tf) {
        filters.push(tf);
        lastLabel = outLabel;
        stepNum++;
      }
    }

    if (lastLabel !== "out") {
      filters.push(`[${lastLabel}]copy[out]`);
    }
  } else {
    // No A-roll — just B-roll with possible text
    const headline = segment.texts.find((t) => t.isHeadline);
    const textFilter = headline ? buildDrawTextFilter(headline, "step1", "out") : null;
    if (textFilter) {
      filters.push(textFilter);
    } else {
      filters.push(`[step1]copy[out]`);
    }
  }

  return filters.join(";\n");
}

/**
 * Build FFmpeg filter_complex for pip_overlay layout with circle PIP.
 *
 * Layout: B-roll fills screen, A-roll is a small circular overlay.
 */
function buildPipOverlayCircleFilter(config: SegmentRenderConfig): string {
  const { canvasWidth, canvasHeight } = config;

  // Use CONSISTENT position for ALL circle PIP segments — no jumping
  const pip = CONSISTENT_CIRCLE_PIP;
  const radius = Math.min(pip.width, pip.height) / 2;
  const cx = pip.width / 2;
  const cy = pip.height / 2;

  // Face-centered crop
  const fc = faceCenteredCrop(pip.width, pip.height);

  // Border ring
  const bw = CIRCLE_BORDER_WIDTH;
  const borderW = pip.width + bw * 2;
  const borderH = pip.height + bw * 2;
  const borderR = Math.min(borderW, borderH) / 2;
  const borderCx = borderW / 2;
  const borderCy = borderH / 2;

  const filters: string[] = [];

  // 1. Scale B-roll to fill canvas
  filters.push(
    `[0:v]scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=increase,crop=${canvasWidth}:${canvasHeight},setsar=1[bg]`
  );

  // 2. Create border circle (slightly larger, semi-transparent white)
  filters.push(
    `color=${CIRCLE_BORDER_COLOR}:s=${borderW}x${borderH}:r=${config.fps}:d=999[border_color]`
  );
  filters.push(
    `[border_color]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderR},2)),255,0)'[border_circle]`
  );
  filters.push(
    `[bg][border_circle]overlay=${pip.x - bw}:${pip.y - bw}:format=auto[bg_border]`
  );

  // 3. Scale A-roll PIP with face-centered crop
  filters.push(
    `[1:v]scale=${fc.scaledW}:${fc.scaledH},crop=${pip.width}:${pip.height}:${fc.cropX}:${fc.cropY},setsar=1[pip_raw]`
  );

  // 4. Apply circular mask using geq filter
  filters.push(
    `[pip_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${radius},2)),255,0)'[pip_circle]`
  );

  // 5. Overlay PIP onto background — NO text overlays for circle PIP segments
  // Detected "headlines" in circle PIP segments are B-roll UI text, not styled overlays
  filters.push(
    `[bg_border][pip_circle]overlay=${pip.x}:${pip.y}:format=auto[out]`
  );

  return filters.join(";\n");
}

/**
 * Build FFmpeg filter_complex for pip_overlay layout with rectangle PIP.
 */
function buildPipOverlayRectFilter(config: SegmentRenderConfig): string {
  const { segment, canvasWidth, canvasHeight } = config;
  const aroll = segment.aroll!;
  const pipBox = aroll.boundingBox;

  const filters: string[] = [];

  filters.push(
    `[0:v]scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=increase,crop=${canvasWidth}:${canvasHeight},setsar=1[bg]`
  );

  filters.push(
    `[1:v]scale=${pipBox.width}:${pipBox.height}:force_original_aspect_ratio=increase,crop=${pipBox.width}:${pipBox.height},setsar=1[pip]`
  );

  filters.push(
    `[bg][pip]overlay=${pipBox.x}:${pipBox.y}[step1]`
  );

  const headline2 = segment.texts.find((t) => t.isHeadline);
  const rectTextFilter = headline2 ? buildDrawTextFilter(headline2, "step1", "out") : null;
  if (rectTextFilter) {
    filters.push(rectTextFilter);
  } else {
    filters.push(`[step1]copy[out]`);
  }

  return filters.join(";\n");
}

/**
 * Build FFmpeg filter_complex for full_screen layout (B-roll or A-roll only).
 */
function buildFullScreenFilter(config: SegmentRenderConfig): string {
  const { canvasWidth, canvasHeight, segment } = config;

  const filters: string[] = [];

  filters.push(
    `[0:v]scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=increase,crop=${canvasWidth}:${canvasHeight},setsar=1[bg]`
  );

  const fullscreenHeadline = segment.texts.find((t) => t.isHeadline);
  const fullscreenTextFilter = fullscreenHeadline ? buildDrawTextFilter(fullscreenHeadline, "bg", "out") : null;
  if (fullscreenTextFilter) {
    filters.push(fullscreenTextFilter);
  } else {
    filters.push(`[bg]copy[out]`);
  }

  return filters.join(";\n");
}

// ── Text filter builder ──

interface TextOverlayInfo {
  text: string;
  boundingBox: BoundingBox;
  isHeadline: boolean;
  estimatedFontSize: number;
  color: string;
  backgroundColor: string | null;
  fontWeight: "normal" | "bold";
}

function buildDrawTextFilter(
  text: TextOverlayInfo,
  inputLabel: string,
  outputLabel: string
): string | null {
  // For filter_complex_script files, drawtext escaping rules:
  //  - Colons in option values must be escaped as \:
  //  - Single quotes delimit values — apostrophes in text must be removed/replaced
  //  - Newlines must be removed (single-line drawtext only)
  //  - Backslashes need careful handling

  // Clean text: remove newlines, replace apostrophes, strip problematic chars
  let cleanText = text.text
    .replace(/\r?\n/g, " ")         // newlines → space
    .replace(/'/g, "’")        // ASCII apostrophe → unicode right quote (renders fine)
    .replace(/\\/g, "/")            // backslashes → forward slashes
    .replace(/:/g, "\\:")           // colons must be escaped
    .replace(/%/g, "%%")            // percent signs
    .replace(/;/g, "\\;")           // semicolons (filter separator)
    .replace(/\[/g, "\\[")          // brackets
    .replace(/\]/g, "\\]")
    .trim();

  // Skip empty text
  if (!cleanText) return null;

  // Convert hex color to FFmpeg format
  const fontColor = text.color.startsWith("#")
    ? text.color.replace("#", "0x")
    : "0xFFFFFF";

  const fontSize = text.estimatedFontSize || 36;

  // Position text at the center of its bounding box
  const textX = text.boundingBox.x + text.boundingBox.width / 2;
  const textY = text.boundingBox.y + text.boundingBox.height / 2;

  // Use direct font file path to avoid fontconfig issues on Windows
  // In filter_complex_script files: C\: is the correct escaping (single backslash before colon)
  //
  // Font selection strategy:
  // - Gold/yellow headlines (#FDD835) → Georgia Pro Bold Italic (matches reference's calligraphic serif)
  // - White on pink background → Arial Bold (matches reference's sans-serif bold)
  // - Other bold text → Arial Bold
  // - Normal text → Arial Regular
  const isGoldHeadline = text.isHeadline && (
    text.color.toUpperCase() === "#FDD835" ||
    text.color.toUpperCase() === "#FFD700" ||
    text.color.toUpperCase() === "#FFEB3B"
  );
  let fontFile: string;
  if (isGoldHeadline) {
    fontFile = FONTS.headline;
  } else if (text.fontWeight === "bold") {
    fontFile = FONTS.bold;
  } else {
    fontFile = FONTS.regular;
  }

  // Background box if specified
  let bgOpts = "";
  if (text.backgroundColor) {
    const bgColor = text.backgroundColor.startsWith("#")
      ? text.backgroundColor.replace("#", "0x")
      : "0x000000@0.7";
    bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=10`;
  }

  return `[${inputLabel}]drawtext=fontfile='${fontFile}':text='${cleanText}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)${bgOpts}[${outputLabel}]`;
}

// ── Segment duration helper ──

function segDuration(segment: BlueprintSegment): number {
  return Math.max(0.1, segment.end - segment.start);
}

// ── Main: Render a single segment ──

export async function renderSegment(config: SegmentRenderConfig): Promise<SegmentRenderResult> {
  const { segment, brollPath, arollPath, tempDir } = config;
  const duration = segDuration(segment);
  const outputPath = path.join(tempDir, `segment-${segment.id}.mp4`);

  // Determine which filter to use based on layout
  // Smart detection: a pip_overlay with full-width rectangle A-roll + blackRegions
  // is actually a vertical_split layout (e.g., seg_1 in typical reference videos)
  let filterComplex: string;
  let hasAroll = false;

  const isActuallyVerticalSplit =
    segment.aroll?.shape === "rectangle" &&
    (segment.blackRegions?.length ?? 0) > 0 &&
    (segment.aroll?.boundingBox.width ?? 0) >= 1000;

  const effectiveLayout = isActuallyVerticalSplit
    ? "vertical_split"
    : segment.layout;

  switch (effectiveLayout) {
    case "vertical_split":
      filterComplex = buildVerticalSplitFilter(config);
      hasAroll = !!arollPath && !!segment.aroll;
      break;

    case "pip_overlay":
      if (segment.aroll?.shape === "circle") {
        filterComplex = buildPipOverlayCircleFilter(config);
      } else {
        filterComplex = buildPipOverlayRectFilter(config);
      }
      hasAroll = !!arollPath && !!segment.aroll;
      break;

    case "full_screen":
    case "side_by_side":
    default:
      filterComplex = buildFullScreenFilter(config);
      hasAroll = false;
      break;
  }

  // Write filter to temp file (Windows escaping workaround)
  const filterPath = path.join(tempDir, `filter-${segment.id}.txt`);
  fs.writeFileSync(filterPath, filterComplex);

  // Build FFmpeg args
  const args: string[] = ["-y"];

  // Input 0: B-roll (seek to correct position)
  args.push("-ss", config.brollStartFrom.toString());
  args.push("-i", brollPath);

  // Input 1: A-roll (if layout needs it)
  if (hasAroll && arollPath) {
    args.push("-ss", config.arollStartFrom.toString());
    args.push("-i", arollPath);
  }

  // Filter complex from script file
  args.push("-filter_complex_script", filterPath);

  // Map outputs
  args.push("-map", "[out]");

  // NO audio in individual segments — continuous audio added in final mux step
  args.push("-an");

  // Duration
  args.push("-t", duration.toString());

  // Encoding settings
  args.push(
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-r", config.fps.toString(),
    outputPath
  );

  try {
    const result = await runFFmpeg(args, 60_000);

    // Clean up filter file
    try { fs.unlinkSync(filterPath); } catch { /* ignore */ }

    if (result.exitCode === 0 && fs.existsSync(outputPath)) {
      return {
        segmentId: segment.id,
        outputPath,
        duration,
        success: true,
      };
    } else {
      const errorLines = result.stderr
        .split("\n")
        .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid"))
        .slice(0, 3);
      return {
        segmentId: segment.id,
        outputPath: "",
        duration,
        success: false,
        error: errorLines.join("; ") || `FFmpeg exited with code ${result.exitCode}`,
      };
    }
  } catch (err) {
    try { fs.unlinkSync(filterPath); } catch { /* ignore */ }
    return {
      segmentId: segment.id,
      outputPath: "",
      duration,
      success: false,
      error: err instanceof Error ? err.message : "Unknown render error",
    };
  }
}

// ── Concatenate rendered segments ──

export async function concatenateSegments(
  segmentPaths: string[],
  outputPath: string,
  tempDir: string,
  arollPath?: string
): Promise<{ success: boolean; error?: string }> {
  // Step 1: Concatenate video using concat filter (re-encodes for gapless transitions)
  const tempVideoPath = path.join(tempDir, "concat-video-only.mp4");

  const inputArgs: string[] = [];
  const filterInputs: string[] = [];
  for (let i = 0; i < segmentPaths.length; i++) {
    inputArgs.push("-i", segmentPaths[i]);
    filterInputs.push(`[${i}:v]`);
  }

  const concatFilter = `${filterInputs.join("")}concat=n=${segmentPaths.length}:v=1:a=0[outv]`;

  const concatArgs = [
    "-y",
    ...inputArgs,
    "-filter_complex", concatFilter,
    "-map", "[outv]",
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    tempVideoPath,
  ];

  try {
    const concatResult = await runFFmpeg(concatArgs, 300_000);
    if (concatResult.exitCode !== 0 || !fs.existsSync(tempVideoPath)) {
      return { success: false, error: `Video concat failed with code ${concatResult.exitCode}` };
    }

    if (arollPath) {
      // Step 2: Mux continuous A-roll audio with concatenated video
      const muxArgs = [
        "-y",
        "-i", tempVideoPath,
        "-i", arollPath,
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "128k",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
        "-movflags", "+faststart",
        outputPath,
      ];

      const muxResult = await runFFmpeg(muxArgs, 120_000);

      // Clean up temp video
      try { fs.unlinkSync(tempVideoPath); } catch { /* ignore */ }

      if (muxResult.exitCode === 0 && fs.existsSync(outputPath)) {
        return { success: true };
      } else {
        return { success: false, error: `Audio mux failed with code ${muxResult.exitCode}` };
      }
    } else {
      // No A-roll audio — just rename/move the video-only file
      fs.renameSync(tempVideoPath, outputPath);
      return { success: true };
    }
  } catch (err) {
    try { fs.unlinkSync(tempVideoPath); } catch { /* ignore */ }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Concat error",
    };
  }
}

// ── Full render pipeline ──

export interface FullRenderConfig {
  segments: BlueprintSegment[];
  brollPath: string;
  arollPath: string;
  canvasWidth: number;
  canvasHeight: number;
  fps: number;
  /** Sentence boundaries from transcription — used to align ALL segment cuts.
   *  UNIVERSAL RULE: Every visual transition (PIP changes, B-roll cuts,
   *  animations) must snap to sentence boundaries, never mid-sentence.
   *  Mid-sentence cuts cause audio glitches because the A-roll is continuous. */
  sentenceBoundaries?: { start: number; end: number }[];
  /** Called after each segment renders */
  onSegmentProgress?: (segId: string, index: number, total: number) => void;
}

/**
 * SENTENCE-DRIVEN SEGMENTATION
 *
 * Sentences are the PRIMARY segmentation trigger. Instead of detecting
 * visual changes and then correcting them to sentence boundaries, we
 * BUILD segments from sentences and inherit the visual style from the
 * blueprint analysis.
 *
 * Why: The A-roll talking-head audio is continuous. Cuts mid-sentence
 * cause audible glitches; cuts between sentences land in natural pauses.
 * Screenshots may capture transitions slightly early/late, so we don't
 * trust visual-segment timestamps for cut points — only sentences.
 *
 * How it works:
 * 1. Each sentence boundary becomes a segment boundary (the trigger).
 * 2. For each sentence-segment, we look up which blueprint segment
 *    overlaps that time range to inherit its layout, PIP style, texts.
 * 3. Long sentences that contain clause breaks (e.g., commas, word-
 *    level pauses > 0.3s) can split into sub-segments while keeping
 *    the same layout — only the B-roll advances.
 * 4. No post-correction needed: segments are sentence-aligned by design.
 */
function buildSentenceDrivenSegments(
  blueprintSegments: BlueprintSegment[],
  sentenceBoundaries: { start: number; end: number }[]
): BlueprintSegment[] {
  if (!sentenceBoundaries.length) return blueprintSegments;
  if (blueprintSegments.length === 0) return [];

  /**
   * Find the blueprint segment whose time range overlaps most with
   * the given [start, end] window. This determines the visual style
   * (layout, PIP shape, texts, etc.) for that time range.
   */
  function findBestOverlap(start: number, end: number): BlueprintSegment {
    let bestSeg = blueprintSegments[0];
    let bestOverlap = 0;

    for (const seg of blueprintSegments) {
      const overlapStart = Math.max(seg.start, start);
      const overlapEnd = Math.min(seg.end, end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSeg = seg;
      }
    }

    // Fallback: if no overlap (sentence extends beyond blueprint),
    // use the nearest segment by midpoint
    if (bestOverlap === 0) {
      const mid = (start + end) / 2;
      let bestDist = Infinity;
      for (const seg of blueprintSegments) {
        const segMid = (seg.start + seg.end) / 2;
        const dist = Math.abs(mid - segMid);
        if (dist < bestDist) {
          bestDist = dist;
          bestSeg = seg;
        }
      }
    }

    return bestSeg;
  }

  const result: BlueprintSegment[] = [];
  let segCounter = 1;

  for (const sentence of sentenceBoundaries) {
    // Find which blueprint segment(s) cover this sentence's time range
    const donor = findBestOverlap(sentence.start, sentence.end);

    result.push({
      ...donor,
      id: `sent_seg_${segCounter}`,
      start: sentence.start,
      end: sentence.end,
    });
    segCounter++;
  }

  // Ensure first segment starts at 0
  if (result.length > 0 && result[0].start > 0) {
    result[0] = { ...result[0], start: 0 };
  }

  // Remove any zero/negative duration segments
  return result.filter((seg) => seg.end > seg.start + 0.05);
}

/**
 * Legacy fallback: snap boundaries to nearest sentence end.
 * Used when sentence data is incomplete or as a safety net.
 */
function snapBoundariesToSentences(
  segments: BlueprintSegment[],
  sentenceEnds: number[]
): BlueprintSegment[] {
  if (!sentenceEnds.length || segments.length < 2) return segments;

  function nearest(t: number): number {
    let best = sentenceEnds[0];
    let bestDist = Math.abs(t - best);
    for (const se of sentenceEnds) {
      const dist = Math.abs(t - se);
      if (dist < bestDist) { best = se; bestDist = dist; }
    }
    return best;
  }

  const aligned = segments.map((seg) => ({ ...seg }));
  for (let i = 1; i < aligned.length; i++) {
    const snapped = nearest(aligned[i].start);
    aligned[i - 1] = { ...aligned[i - 1], end: snapped };
    aligned[i] = { ...aligned[i], start: snapped };
  }
  aligned[0] = { ...aligned[0], start: 0 };

  const lastEnd = sentenceEnds[sentenceEnds.length - 1];
  const last = aligned[aligned.length - 1];
  if (lastEnd > last.end) aligned[aligned.length - 1] = { ...last, end: lastEnd };

  return aligned.filter((seg) => seg.end > seg.start + 0.05);
}

export async function renderFullVideo(
  config: FullRenderConfig,
  outputPath: string
): Promise<{ success: boolean; outputPath: string; error?: string }> {
  const tempDir = path.join(process.cwd(), "public", "exports", "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // SENTENCE-DRIVEN SEGMENTATION:
  // Sentences are the primary trigger — we build segments FROM sentences,
  // inheriting the visual style from the blueprint analysis.
  // Fallback: if no sentence data, use blueprint segments as-is.
  const segments = config.sentenceBoundaries?.length
    ? buildSentenceDrivenSegments(config.segments, config.sentenceBoundaries)
    : config.segments;

  const segmentOutputs: string[] = [];
  let arollCursor = 0; // Track A-roll position across segments

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const duration = Math.max(0.1, seg.end - seg.start);

    // Calculate where in A-roll this segment's audio comes from
    const arollStartFrom = arollCursor;

    // B-roll start: use segment start time (or specific startFrom if available)
    const brollStartFrom = seg.start;

    config.onSegmentProgress?.(seg.id, i, segments.length);

    const result = await renderSegment({
      segment: seg,
      brollPath: config.brollPath,
      arollPath: config.arollPath,
      brollStartFrom,
      arollStartFrom,
      canvasWidth: config.canvasWidth,
      canvasHeight: config.canvasHeight,
      fps: config.fps,
      tempDir,
    });

    if (!result.success) {
      return {
        success: false,
        outputPath: "",
        error: `Segment ${seg.id} failed: ${result.error}`,
      };
    }

    segmentOutputs.push(result.outputPath);
    arollCursor += duration; // Advance A-roll cursor
  }

  // Concatenate all segments (concat filter + continuous A-roll audio)
  const concatResult = await concatenateSegments(segmentOutputs, outputPath, tempDir, config.arollPath);

  // Clean up temp segment files
  for (const segPath of segmentOutputs) {
    try { fs.unlinkSync(segPath); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(tempDir); } catch { /* ignore - may not be empty */ }

  if (!concatResult.success) {
    return {
      success: false,
      outputPath: "",
      error: `Concatenation failed: ${concatResult.error}`,
    };
  }

  return { success: true, outputPath };
}
