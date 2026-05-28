/**
 * End-to-End Pipeline Test
 *
 * Exercises the FULL production render pipeline with real videos.
 * Reimplements the same logic from src/lib/render/segmentRenderer.ts
 * (buildSentenceDrivenSegments + renderFullVideo) so it can run
 * directly from Node.js without TypeScript compilation.
 *
 * Usage: node scripts/test-e2e-pipeline.mjs
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── Load .env.local ──
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

// ── Constants (must match production code exactly) ──

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const FPS = 30;

const CONSISTENT_CIRCLE_PIP = { x: 544, y: 175, width: 426, height: 426 };
const CIRCLE_BORDER_WIDTH = 4;
const CIRCLE_BORDER_COLOR = "0xFFFFFF@0.6";

const FACE_CENTER = { x: 940, y: 350 };
const AROLL_SOURCE_W = 1920;
const AROLL_SOURCE_H = 1080;

// ── Source paths ──

const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const BLUEPRINT_PATH = path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json");
const AROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6108.MOV");
const BROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const OUTPUT_DIR = path.join(ROOT, "public", "exports");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "e2e-pipeline-test.mp4");
const FRAMES_DIR = path.join(OUTPUT_DIR, "e2e-frames");
const TEMP_DIR = path.join(OUTPUT_DIR, "e2e-temp");

// ── Utility: face-centered crop ──

function faceCenteredCrop(targetW, targetH) {
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

// ── Utility: text escaping for filter_complex_script ──

function escapeText(text) {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/'/g, "’")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .trim();
}

// ── Utility: segment duration ──

function segDuration(segment) {
  return Math.max(0.1, segment.end - segment.start);
}

// ── Utility: run FFmpeg ──

function runFFmpeg(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
    });

    let stderr = "";
    proc.stderr?.on("data", (data) => {
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

// ── Text filter builder (matches production exactly) ──

function buildDrawTextFilter(text, inputLabel, outputLabel) {
  let cleanText = escapeText(text.text);
  if (!cleanText) return null;

  const fontColor = text.color.startsWith("#")
    ? text.color.replace("#", "0x")
    : "0xFFFFFF";

  const fontSize = text.estimatedFontSize || 36;

  const textX = text.boundingBox.x + text.boundingBox.width / 2;
  const textY = text.boundingBox.y + text.boundingBox.height / 2;

  const isGoldHeadline = text.isHeadline && (
    text.color.toUpperCase() === "#FDD835" ||
    text.color.toUpperCase() === "#FFD700" ||
    text.color.toUpperCase() === "#FFEB3B"
  );

  let fontFile;
  if (isGoldHeadline) {
    fontFile = "C\\:/Windows/Fonts/GeorgiaPro-BoldItalic.ttf";
  } else if (text.fontWeight === "bold") {
    fontFile = "C\\:/Windows/Fonts/arialbd.ttf";
  } else {
    fontFile = "C\\:/Windows/Fonts/arial.ttf";
  }

  let bgOpts = "";
  if (text.backgroundColor) {
    const bgColor = text.backgroundColor.startsWith("#")
      ? text.backgroundColor.replace("#", "0x")
      : "0x000000@0.7";
    bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=10`;
  }

  return `[${inputLabel}]drawtext=fontfile='${fontFile}':text='${cleanText}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)${bgOpts}[${outputLabel}]`;
}

// ── Layout filter builders ──

/**
 * Vertical split: black canvas + B-roll + face-centered A-roll + headline texts.
 * Triggered when: aroll.shape === "rectangle" AND blackRegions has header AND aroll.width >= 1000
 */
function buildVerticalSplitFilter(segment, duration) {
  const aroll = segment.aroll;
  const broll = segment.broll;
  const headerBlack = segment.blackRegions.find((br) => br.purpose === "header");

  const headerH = headerBlack?.boundingBox.height ?? 200;
  const arollBox = aroll?.boundingBox ?? { x: 0, y: headerH, width: CANVAS_W, height: 600 };
  const brollBox = broll.boundingBox ?? { x: 0, y: headerH + 600, width: CANVAS_W, height: CANVAS_H - headerH - 600 };

  const filters = [];

  // 1. Black canvas base
  filters.push(
    `color=black:s=${CANVAS_W}x${CANVAS_H}:r=${FPS}:d=${duration}[canvas]`
  );

  // 2. Scale/crop B-roll to fit its region
  filters.push(
    `[0:v]scale=${brollBox.width}:${brollBox.height}:force_original_aspect_ratio=increase,crop=${brollBox.width}:${brollBox.height},setsar=1[broll_scaled]`
  );

  // 3. Overlay B-roll onto canvas
  filters.push(
    `[canvas][broll_scaled]overlay=${brollBox.x}:${brollBox.y}[step1]`
  );

  if (aroll) {
    // 4. Scale/crop A-roll with face-centered crop
    const fc = faceCenteredCrop(arollBox.width, arollBox.height);
    filters.push(
      `[1:v]scale=${fc.scaledW}:${fc.scaledH},crop=${arollBox.width}:${arollBox.height}:${fc.cropX}:${fc.cropY},setsar=1[aroll_scaled]`
    );

    // 5. Overlay A-roll onto canvas
    filters.push(
      `[step1][aroll_scaled]overlay=${arollBox.x}:${arollBox.y}[step2]`
    );

    // 6. Add ALL headline texts in the header region
    const headerBottom = headerH + 150;
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
 * Circle PIP: B-roll fullscreen + border circle + face-centered A-roll with circular mask.
 * NO text overlays.
 */
function buildPipOverlayCircleFilter(segment, duration) {
  const pip = CONSISTENT_CIRCLE_PIP;
  const radius = Math.min(pip.width, pip.height) / 2;
  const cx = pip.width / 2;
  const cy = pip.height / 2;

  const fc = faceCenteredCrop(pip.width, pip.height);

  const bw = CIRCLE_BORDER_WIDTH;
  const borderW = pip.width + bw * 2;
  const borderH = pip.height + bw * 2;
  const borderR = Math.min(borderW, borderH) / 2;
  const borderCx = borderW / 2;
  const borderCy = borderH / 2;

  const filters = [];

  // 1. Scale B-roll to fill canvas
  filters.push(
    `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},setsar=1[bg]`
  );

  // 2. Create border circle (slightly larger, semi-transparent white)
  filters.push(
    `color=${CIRCLE_BORDER_COLOR}:s=${borderW}x${borderH}:r=${FPS}:d=999[border_color]`
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
  filters.push(
    `[bg_border][pip_circle]overlay=${pip.x}:${pip.y}:format=auto[out]`
  );

  return filters.join(";\n");
}

/**
 * Rectangle PIP: B-roll fullscreen + rectangle A-roll overlay.
 */
function buildPipOverlayRectFilter(segment, duration) {
  const aroll = segment.aroll;
  const pipBox = aroll.boundingBox;

  const filters = [];

  filters.push(
    `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},setsar=1[bg]`
  );

  filters.push(
    `[1:v]scale=${pipBox.width}:${pipBox.height}:force_original_aspect_ratio=increase,crop=${pipBox.width}:${pipBox.height},setsar=1[pip]`
  );

  filters.push(
    `[bg][pip]overlay=${pipBox.x}:${pipBox.y}[step1]`
  );

  const headline = segment.texts.find((t) => t.isHeadline);
  const textFilter = headline ? buildDrawTextFilter(headline, "step1", "out") : null;
  if (textFilter) {
    filters.push(textFilter);
  } else {
    filters.push(`[step1]copy[out]`);
  }

  return filters.join(";\n");
}

/**
 * Full screen: B-roll only.
 */
function buildFullScreenFilter(segment, duration) {
  const filters = [];

  filters.push(
    `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},setsar=1[bg]`
  );

  const headline = segment.texts.find((t) => t.isHeadline);
  const textFilter = headline ? buildDrawTextFilter(headline, "bg", "out") : null;
  if (textFilter) {
    filters.push(textFilter);
  } else {
    filters.push(`[bg]copy[out]`);
  }

  return filters.join(";\n");
}

// ── buildSentenceDrivenSegments (matches production exactly) ──

function buildSentenceDrivenSegments(blueprintSegments, sentenceBoundaries) {
  if (!sentenceBoundaries.length) return blueprintSegments;
  if (blueprintSegments.length === 0) return [];

  function findBestOverlap(start, end) {
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

    // Fallback: if no overlap, use nearest segment by midpoint
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

  const result = [];
  let segCounter = 1;

  for (const sentence of sentenceBoundaries) {
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

  // Remove zero/negative duration segments
  return result.filter((seg) => seg.end > seg.start + 0.05);
}

// ── Determine effective layout (matches production smart detection) ──

function getEffectiveLayout(segment) {
  const isActuallyVerticalSplit =
    segment.aroll?.shape === "rectangle" &&
    (segment.blackRegions?.length ?? 0) > 0 &&
    (segment.aroll?.boundingBox.width ?? 0) >= 1000;

  return isActuallyVerticalSplit ? "vertical_split" : segment.layout;
}

// ── Render a single segment ──

async function renderSegment(segment, brollStartFrom, arollStartFrom) {
  const duration = segDuration(segment);
  const outputPath = path.join(TEMP_DIR, `segment-${segment.id}.mp4`);

  let filterComplex;
  let hasAroll = false;

  const effectiveLayout = getEffectiveLayout(segment);

  switch (effectiveLayout) {
    case "vertical_split":
      filterComplex = buildVerticalSplitFilter(segment, duration);
      hasAroll = !!segment.aroll;
      break;

    case "pip_overlay":
      if (segment.aroll?.shape === "circle") {
        filterComplex = buildPipOverlayCircleFilter(segment, duration);
      } else {
        filterComplex = buildPipOverlayRectFilter(segment, duration);
      }
      hasAroll = !!segment.aroll;
      break;

    case "full_screen":
    case "side_by_side":
    default:
      filterComplex = buildFullScreenFilter(segment, duration);
      hasAroll = false;
      break;
  }

  // Write filter to temp file (Windows escaping workaround)
  const filterPath = path.join(TEMP_DIR, `filter-${segment.id}.txt`);
  fs.writeFileSync(filterPath, filterComplex);

  // Build FFmpeg args
  const args = ["-y"];

  // Input 0: B-roll (seek to segment start)
  args.push("-ss", brollStartFrom.toString());
  args.push("-i", BROLL_PATH);

  // Input 1: A-roll (if layout needs it)
  if (hasAroll) {
    args.push("-ss", arollStartFrom.toString());
    args.push("-i", AROLL_PATH);
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
    "-r", FPS.toString(),
    outputPath
  );

  try {
    const result = await runFFmpeg(args, 120_000);

    // Clean up filter file
    try { fs.unlinkSync(filterPath); } catch { /* ignore */ }

    if (result.exitCode === 0 && fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      return {
        segmentId: segment.id,
        outputPath,
        duration,
        success: true,
        fileSize: stats.size,
        effectiveLayout,
      };
    } else {
      const errorLines = result.stderr
        .split("\n")
        .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid"))
        .slice(0, 5);
      return {
        segmentId: segment.id,
        outputPath: "",
        duration,
        success: false,
        error: errorLines.join("\n") || `FFmpeg exited with code ${result.exitCode}`,
        filterComplex,
        effectiveLayout,
      };
    }
  } catch (err) {
    try { fs.unlinkSync(filterPath); } catch { /* ignore */ }
    return {
      segmentId: segment.id,
      outputPath: "",
      duration,
      success: false,
      error: err.message || "Unknown render error",
      filterComplex,
      effectiveLayout,
    };
  }
}

// ── Concatenate segments ──

async function concatenateSegments(segmentPaths) {
  // Step 1: Concatenate video using concat filter (re-encodes for gapless transitions)
  const tempVideoPath = path.join(TEMP_DIR, "concat-video-only.mp4");

  const inputArgs = [];
  const filterInputs = [];
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
    "-r", FPS.toString(),
    tempVideoPath,
  ];

  try {
    const concatResult = await runFFmpeg(concatArgs, 300_000);
    if (concatResult.exitCode !== 0 || !fs.existsSync(tempVideoPath)) {
      return { success: false, error: `Video concat failed with code ${concatResult.exitCode}` };
    }

    // Step 2: Mux continuous A-roll audio with concatenated video
    const muxArgs = [
      "-y",
      "-i", tempVideoPath,
      "-i", AROLL_PATH,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "128k",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-shortest",
      "-movflags", "+faststart",
      OUTPUT_PATH,
    ];

    const muxResult = await runFFmpeg(muxArgs, 120_000);

    // Clean up temp video
    try { fs.unlinkSync(tempVideoPath); } catch { /* ignore */ }

    if (muxResult.exitCode === 0 && fs.existsSync(OUTPUT_PATH)) {
      return { success: true };
    } else {
      return { success: false, error: `Audio mux failed with code ${muxResult.exitCode}` };
    }
  } catch (err) {
    try { fs.unlinkSync(tempVideoPath); } catch { /* ignore */ }
    return { success: false, error: err.message || "Concat error" };
  }
}

// ── Extract frame at a given time ──

async function extractFrame(videoPath, timeSec, outputFramePath) {
  const args = [
    "-y",
    "-ss", timeSec.toString(),
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "2",
    outputFramePath,
  ];

  try {
    const result = await runFFmpeg(args, 30_000);
    return result.exitCode === 0 && fs.existsSync(outputFramePath);
  } catch {
    return false;
  }
}

// ── Format bytes ──

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();

  console.log("=".repeat(70));
  console.log("  E2E PIPELINE TEST — Full Production Render Path");
  console.log("=".repeat(70));
  console.log();

  // ── Preflight checks ──

  console.log("[1] PREFLIGHT CHECKS");
  console.log("-".repeat(40));

  const checks = [
    { name: "FFmpeg", path: FFMPEG },
    { name: "Blueprint", path: BLUEPRINT_PATH },
    { name: "A-roll (audio source)", path: AROLL_PATH },
    { name: "B-roll", path: BROLL_PATH },
  ];

  let allOk = true;
  for (const c of checks) {
    const exists = fs.existsSync(c.path);
    console.log(`  ${exists ? "OK" : "MISSING"} ${c.name}: ${c.path}`);
    if (!exists) allOk = false;
  }

  if (!allOk) {
    console.error("\nFATAL: Missing required files. Aborting.");
    process.exit(1);
  }
  console.log();

  // ── Create directories ──

  for (const dir of [OUTPUT_DIR, FRAMES_DIR, TEMP_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // ── Load blueprint ──

  console.log("[2] LOADING BLUEPRINT");
  console.log("-".repeat(40));

  const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, "utf-8"));
  const bpData = blueprint.data;

  console.log(`  Canvas: ${bpData.canvas.width}x${bpData.canvas.height}`);
  console.log(`  Reference duration: ${bpData.reference.duration}s`);
  console.log(`  Blueprint segments: ${bpData.reference.segments.length}`);

  for (const seg of bpData.reference.segments) {
    const effectiveLayout = getEffectiveLayout(seg);
    console.log(`    ${seg.id}: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s | blueprint: ${seg.layout} | effective: ${effectiveLayout} | aroll: ${seg.aroll?.shape ?? "none"} | blackRegions: ${seg.blackRegions?.length ?? 0}`);
  }
  console.log();

  // ── Extract sentence boundaries ──

  console.log("[3] SENTENCE BOUNDARIES");
  console.log("-".repeat(40));

  const sentences = bpData.reference.transcription?.sentences ?? [];
  console.log(`  Sentences found: ${sentences.length}`);

  if (sentences.length === 0) {
    console.error("FATAL: No sentence boundaries found in blueprint transcription.");
    process.exit(1);
  }

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const preview = s.text.length > 60 ? s.text.slice(0, 57) + "..." : s.text;
    console.log(`    S${i + 1}: ${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s (${(s.end - s.start).toFixed(2)}s) | "${preview}"`);
  }
  console.log();

  // ── Build sentence-driven segments ──

  console.log("[4] SENTENCE-DRIVEN SEGMENTATION");
  console.log("-".repeat(40));

  const sentenceBoundaries = sentences.map((s) => ({ start: s.start, end: s.end }));
  const segments = buildSentenceDrivenSegments(bpData.reference.segments, sentenceBoundaries);

  console.log(`  Sentence-driven segments: ${segments.length}`);
  console.log();

  for (const seg of segments) {
    const effectiveLayout = getEffectiveLayout(seg);
    const donorId = bpData.reference.segments.find(
      (bp) => bp.layout === seg.layout && bp.aroll?.shape === seg.aroll?.shape && bp.blackRegions?.length === seg.blackRegions?.length
    )?.id ?? "?";
    console.log(`    ${seg.id}: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s (${(seg.end - seg.start).toFixed(2)}s) | effective: ${effectiveLayout} | inherited from: ${donorId}`);
  }
  console.log();

  // ── Render all segments ──

  console.log("[5] RENDERING SEGMENTS");
  console.log("-".repeat(40));

  const renderResults = [];
  let arollCursor = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const duration = segDuration(seg);
    const brollStartFrom = seg.start;
    const arollStartFrom = arollCursor;

    console.log(`  Rendering ${seg.id} (${i + 1}/${segments.length})...`);
    console.log(`    B-roll seek: ${brollStartFrom.toFixed(2)}s | A-roll seek: ${arollStartFrom.toFixed(2)}s | Duration: ${duration.toFixed(2)}s`);

    const segStart = Date.now();
    const result = await renderSegment(seg, brollStartFrom, arollStartFrom);
    const segElapsed = ((Date.now() - segStart) / 1000).toFixed(1);

    renderResults.push(result);
    arollCursor += duration;

    if (result.success) {
      console.log(`    -> OK (${segElapsed}s, ${formatBytes(result.fileSize)}) | layout: ${result.effectiveLayout}`);
    } else {
      console.log(`    -> FAILED (${segElapsed}s) | layout: ${result.effectiveLayout}`);
      console.log(`       Error: ${result.error}`);
      if (result.filterComplex) {
        console.log(`       Filter (first 300 chars): ${result.filterComplex.slice(0, 300)}`);
      }
    }
  }
  console.log();

  // ── Check for failures ──

  const failures = renderResults.filter((r) => !r.success);
  if (failures.length > 0) {
    console.log(`WARN: ${failures.length}/${segments.length} segments failed to render.`);
    console.log("Attempting concatenation with successful segments only...");
    console.log();
  }

  const successPaths = renderResults
    .filter((r) => r.success)
    .map((r) => r.outputPath);

  if (successPaths.length === 0) {
    console.error("FATAL: All segments failed to render. Aborting.");
    process.exit(1);
  }

  // ── Concatenate ──

  console.log("[6] CONCATENATION");
  console.log("-".repeat(40));
  console.log(`  Concatenating ${successPaths.length} segments (concat filter + continuous audio)...`);

  const concatResult = await concatenateSegments(successPaths);

  if (concatResult.success) {
    const stats = fs.statSync(OUTPUT_PATH);
    console.log(`  -> OK | Output: ${OUTPUT_PATH}`);
    console.log(`  -> File size: ${formatBytes(stats.size)}`);
  } else {
    console.log(`  -> FAILED: ${concatResult.error}`);
  }
  console.log();

  // ── Clean up temp segment files ──

  for (const r of renderResults) {
    if (r.success && r.outputPath) {
      try { fs.unlinkSync(r.outputPath); } catch { /* ignore */ }
    }
  }
  try { fs.rmdirSync(TEMP_DIR); } catch { /* ignore */ }

  // ── Extract comparison frames ──

  console.log("[7] EXTRACTING COMPARISON FRAMES");
  console.log("-".repeat(40));

  if (concatResult.success) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const midpoint = (seg.start + seg.end) / 2;
      const framePath = path.join(FRAMES_DIR, `frame-${seg.id}-${midpoint.toFixed(2)}s.jpg`);

      const ok = await extractFrame(OUTPUT_PATH, midpoint, framePath);
      console.log(`  ${ok ? "OK" : "FAIL"} ${seg.id} @ ${midpoint.toFixed(2)}s -> ${path.basename(framePath)}`);
    }
  } else {
    console.log("  Skipped (concatenation failed).");
  }
  console.log();

  // ── Final video info ──

  console.log("[8] FINAL VIDEO INFO");
  console.log("-".repeat(40));

  if (concatResult.success && fs.existsSync(OUTPUT_PATH)) {
    const stats = fs.statSync(OUTPUT_PATH);

    // Get duration via ffprobe-like method
    const probeResult = await runFFmpeg([
      "-i", OUTPUT_PATH,
      "-f", "null",
      "-"
    ], 30_000).catch(() => ({ exitCode: 1, stderr: "" }));

    const durationMatch = probeResult.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    let finalDuration = "unknown";
    if (durationMatch) {
      const h = parseInt(durationMatch[1]);
      const m = parseInt(durationMatch[2]);
      const s = parseFloat(durationMatch[3]);
      finalDuration = `${(h * 3600 + m * 60 + s).toFixed(2)}s`;
    }

    console.log(`  Output file: ${OUTPUT_PATH}`);
    console.log(`  File size: ${formatBytes(stats.size)}`);
    console.log(`  Duration: ${finalDuration}`);
    console.log(`  Segments rendered: ${successPaths.length}/${segments.length}`);
    console.log(`  Frames dir: ${FRAMES_DIR}`);
  } else {
    console.log("  No final video produced.");
  }
  console.log();

  // ── Summary ──

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  console.log(`  Total time: ${elapsed}s`);
  console.log(`  Blueprint segments: ${bpData.reference.segments.length}`);
  console.log(`  Sentence boundaries: ${sentences.length}`);
  console.log(`  Sentence-driven segments: ${segments.length}`);
  console.log(`  Rendered successfully: ${successPaths.length}/${segments.length}`);
  console.log(`  Failed: ${failures.length}/${segments.length}`);
  console.log(`  Concatenation: ${concatResult.success ? "OK" : "FAILED"}`);
  console.log(`  Result: ${concatResult.success ? "PASS" : "FAIL"}`);
  console.log("=".repeat(70));

  if (!concatResult.success || failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
