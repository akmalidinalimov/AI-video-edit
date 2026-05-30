/**
 * OLD Approach Video Render (Time-Proportional B-roll)
 *
 * Same pipeline as render-content-aware.ts but WITHOUT:
 * - Speech keyword extraction
 * - Narrative context analysis
 * - OCR-based matching
 *
 * Uses only time-proportional B-roll fallback for a clean comparison.
 *
 * Usage: npx tsx scripts/render-old-approach.ts
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";

import { generateTemplate, extractFaceInfo } from "@/lib/pipeline/template-generator";
import { buildEditingPlan } from "@/lib/pipeline/plan-builder";
import { buildRenderArgsWithScript, logRenderPlan } from "@/lib/pipeline/plan-renderer";
import { getVideoMetadata } from "@/lib/analysis/frameExtractor";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const CACHE_DIR = path.join(ROOT, "public", "analysis", ".cache");
const AROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6108.MOV");
const BROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const OUTPUT_DIR = path.join(ROOT, "public", "exports");
const TEMP_DIR = path.join(OUTPUT_DIR, "sp-temp");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "old-approach-render.mp4");

async function main() {

console.log("═".repeat(60));
console.log("  OLD APPROACH VIDEO RENDER (time-proportional B-roll)");
console.log("═".repeat(60));

// Load cached data
const blueprintRaw = JSON.parse(
  fs.readFileSync(path.join(CACHE_DIR, "278b7f948b1f1d35-visual_blueprint.json"), "utf-8")
);
const blueprint = blueprintRaw.data;
const blueprintSegments = blueprint.reference?.segments ?? blueprint.segments ?? [];
console.log(`\n✓ Blueprint loaded: ${blueprintSegments.length} segments`);

const transPath = path.join(TEMP_DIR, "aroll-transcription.json");
const transcription = JSON.parse(fs.readFileSync(transPath, "utf-8"));
console.log(`✓ Transcription loaded: ${transcription.sentences.length} sentences`);

const arollMaterial = (() => {
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.endsWith("-aroll_material.json"))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, files[0].name), "utf-8")).data;
})();
console.log(`✓ A-roll material loaded`);

const brollMaterial = (() => {
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.endsWith("-broll_material.json"))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, files[0].name), "utf-8")).data;
})();
console.log(`✓ B-roll material loaded: ${brollMaterial.duration}s`);

// Generate template
const faceInfo = extractFaceInfo(arollMaterial);
const dynamicTemplate = generateTemplate({
  canvas: blueprint.canvas,
  fps: 30,
  segments: blueprintSegments,
  faceInfo,
  aspectRatio: "9:16",
  referenceTranscription: transcription,
} as any);
console.log(`\n✓ Template: ${dynamicTemplate.name}`);

// Build plan WITHOUT narrative context — pure time-proportional
console.log("\n── Building plan (NO content awareness) ──");
const editingPlan = buildEditingPlan({
  blueprintSegments,
  transcription,
  templateId: dynamicTemplate.id,
  template: dynamicTemplate,
  sources: { aroll: AROLL_PATH, broll: BROLL_PATH },
  // NO brollScenes — forces uniform/proportional division
  // NO narrativeContext
  brollDuration: brollMaterial.duration,
});

console.log(`  Plan: ${editingPlan.layoutRanges.length} ranges`);
for (const range of editingPlan.layoutRanges) {
  const offset = range.brollOffset !== undefined ? ` broll@${range.brollOffset.toFixed(1)}s` : " broll@0s (default)";
  console.log(`    ${range.id}: ${range.layoutId} [${range.timeRange.start.toFixed(2)}-${range.timeRange.end.toFixed(2)}s]${offset}`);
}

// Render
console.log("\n── Rendering (single-pass FFmpeg) ──");
const arollMeta = await getVideoMetadata(AROLL_PATH);
const filterScriptPath = path.join(TEMP_DIR, "filter-old-approach.txt");

const renderOutput = buildRenderArgsWithScript(
  {
    plan: editingPlan,
    template: dynamicTemplate,
    arollSourceDimensions: arollMeta.resolution,
    ffmpegPath: FFMPEG,
    outputPath: OUTPUT_PATH,
  },
  filterScriptPath
);

fs.writeFileSync(filterScriptPath, renderOutput.filterComplex);
logRenderPlan(renderOutput);

const startTime = Date.now();
await new Promise<void>((resolve, reject) => {
  const proc = spawn(FFMPEG, renderOutput.ffmpegArgs, { cwd: ROOT, shell: false });
  let stderr = "";
  const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Timeout")); }, 180_000);

  proc.stderr?.on("data", (data: Buffer) => {
    const line = data.toString();
    stderr += line;
    const m = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    if (m) {
      const pct = Math.round(((+m[1]*3600 + +m[2]*60 + +m[3]) / editingPlan.totalDuration) * 100);
      process.stdout.write(`\r  Progress: ${pct}%  `);
    }
  });

  proc.on("close", (code) => {
    clearTimeout(timeout);
    if (code === 0) resolve();
    else { console.error(stderr.slice(-500)); reject(new Error(`FFmpeg exit ${code}`)); }
  });
  proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
});

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
const fileSizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1);

console.log(`\n\n✅ OLD APPROACH RENDER COMPLETE`);
console.log(`  Output: ${OUTPUT_PATH}`);
console.log(`  Size: ${fileSizeMB} MB | Time: ${elapsed}s`);
console.log("═".repeat(60));

}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
