/**
 * Smoke test for the production render pipeline.
 *
 * Renders ONE segment (seg_2: circle PIP, 3.8-11.2s) using the same
 * logic as segmentRenderer.ts — face-centered crop, consistent circle PIP
 * position, border ring, filter_complex_script for Windows escaping.
 *
 * Run: node scripts/test-production-pipeline.mjs
 */
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const ROOT = process.cwd();

// ── Load .env.local (same pattern as compare-gemini.mjs) ──
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

// ── Paths ──
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const BLUEPRINT_PATH = path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json");
const AROLL = path.join(ROOT, "public", "uploads", "IMG_6108.MOV"); // 1920x1080, has audio
const BROLL = path.join(ROOT, "public", "uploads", "IMG_6163.MP4"); // 880x1912
const OUTPUT = path.join(ROOT, "public", "exports", "pipeline-test.mp4");

// ── Canvas ──
const CANVAS_W = 1080;
const CANVAS_H = 1920;
const FPS = 30;

// ── Consistent circle PIP params (same as segmentRenderer.ts) ──
const CONSISTENT_CIRCLE_PIP = { x: 544, y: 175, width: 426, height: 426 };
const CIRCLE_BORDER_WIDTH = 4;
const CIRCLE_BORDER_COLOR = "0xFFFFFF@0.6";

// ── Face center in A-roll source (1920x1080 landscape) ──
const FACE_CENTER = { x: 650, y: 425 };
const AROLL_SOURCE_W = 1920;
const AROLL_SOURCE_H = 1080;

// ── Sentence boundaries (from transcript analysis) ──
const SENTENCE_BOUNDARIES = [
  { start: 0, end: 3.8 },
  { start: 3.8, end: 11.2 },
  { start: 11.2, end: 21.8 },
  { start: 21.8, end: 24.5 },
];

// ── Face-centered crop calculation (mirrors segmentRenderer.ts) ──
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

// ── Build circle PIP filter_complex for seg_2 ──
function buildCirclePipFilter(segDuration) {
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
    `color=${CIRCLE_BORDER_COLOR}:s=${borderW}x${borderH}:r=${FPS}:d=${segDuration}[border_color]`
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

  // 5. Overlay PIP onto background
  filters.push(
    `[bg_border][pip_circle]overlay=${pip.x}:${pip.y}:format=auto[out]`
  );

  return filters.join(";\n");
}

// ── Run FFmpeg via spawn ──
function runFFmpeg(args, label, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    console.log(`[${label}] Running FFmpeg...`);
    const proc = spawn(FFMPEG, args, { cwd: ROOT, shell: false, windowsHide: true });

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`[${label}] FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errLines = stderr.split("\n").filter((l) => /Error|error/i.test(l)).slice(0, 5);
        reject(new Error(`[${label}] FFmpeg exited with code ${code}\n${errLines.join("\n")}`));
      } else {
        resolve({ code, stderr });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Main ──
async function main() {
  console.log("=== Production Pipeline Smoke Test ===\n");

  // 1. Load blueprint
  console.log("[1] Loading blueprint...");
  if (!fs.existsSync(BLUEPRINT_PATH)) {
    throw new Error(`Blueprint not found: ${BLUEPRINT_PATH}`);
  }
  const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, "utf-8"));
  const segments = blueprint.data.reference.segments;
  console.log(`    Found ${segments.length} segments in blueprint`);

  // 2. Align segments to sentence boundaries
  console.log("[2] Sentence boundaries:");
  for (const sb of SENTENCE_BOUNDARIES) {
    console.log(`    ${sb.start}s - ${sb.end}s`);
  }

  // seg_2 aligns to sentence boundary [3.8, 11.2]
  const seg2 = segments.find((s) => s.id === "seg_2");
  if (!seg2) throw new Error("seg_2 not found in blueprint");

  const alignedStart = 3.8;
  const alignedEnd = 11.2;
  const segDuration = alignedEnd - alignedStart;
  console.log(`\n[3] Rendering seg_2 (circle PIP): ${alignedStart}s - ${alignedEnd}s (${segDuration}s)`);
  console.log(`    PIP position: (${CONSISTENT_CIRCLE_PIP.x}, ${CONSISTENT_CIRCLE_PIP.y})`);
  console.log(`    PIP size: ${CONSISTENT_CIRCLE_PIP.width}x${CONSISTENT_CIRCLE_PIP.height}`);
  console.log(`    Face center: (${FACE_CENTER.x}, ${FACE_CENTER.y})`);

  // 3. Build filter_complex
  const filterComplex = buildCirclePipFilter(segDuration);

  // 4. Write filter to temp file (Windows escaping workaround)
  const tmpFilter = path.join(os.tmpdir(), `pipeline-test-filter-${Date.now()}.txt`);
  fs.writeFileSync(tmpFilter, filterComplex, "utf-8");
  console.log(`\n[4] Filter written to temp file: ${tmpFilter}`);
  console.log(`    Filter preview:\n${filterComplex.split(";\n").map((l) => "      " + l).join("\n")}`);

  // 5. Ensure output directory exists
  const outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 6. Run FFmpeg with filter_complex_script
  const ffmpegArgs = [
    "-y",
    // B-roll input (input 0)
    "-ss", String(alignedStart),
    "-t", String(segDuration),
    "-i", BROLL,
    // A-roll input (input 1)
    "-ss", String(alignedStart),
    "-t", String(segDuration),
    "-i", AROLL,
    // Filter
    "-filter_complex_script", tmpFilter,
    // Map video from filter output, audio from A-roll (input 1)
    "-map", "[out]",
    "-map", "1:a",
    // Encoding
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-r", String(FPS),
    "-pix_fmt", "yuv420p",
    "-shortest",
    OUTPUT,
  ];

  console.log(`\n[5] Running FFmpeg render...`);
  const startTime = Date.now();

  try {
    await runFFmpeg(ffmpegArgs, "seg_2 render");
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[6] SUCCESS! Rendered in ${elapsed}s`);
    console.log(`    Output: ${OUTPUT}`);

    // Report file size
    const stat = fs.statSync(OUTPUT);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(`    Size: ${sizeMB} MB`);
  } catch (err) {
    console.error(`\n[6] FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // Clean up temp filter file
    try {
      fs.unlinkSync(tmpFilter);
    } catch (_) {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
