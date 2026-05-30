/**
 * Content-Aware Full Video Render
 *
 * Runs the COMPLETE pipeline with new content-aware B-roll matching:
 *   1. Load cached blueprint + transcription + B-roll material analysis
 *   2. Generate dynamic template from blueprint
 *   3. Extract speech keywords via Gemini (Improvement #4)
 *   4. Build narrative context via Gemini (Improvements #1 + #5)
 *   5. Build editing plan with content-aware B-roll matching
 *   6. Render via single-pass FFmpeg
 *
 * Usage: npx tsx scripts/render-content-aware.ts
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";

// Pipeline modules
import { generateTemplate, extractFaceInfo } from "@/lib/pipeline/template-generator";
import { buildEditingPlan } from "@/lib/pipeline/plan-builder";
import type { BRollScene, NarrativeContext } from "@/lib/pipeline/plan-builder";
import { buildRenderArgsWithScript, logRenderPlan } from "@/lib/pipeline/plan-renderer";
import {
  analyzeNarrativeContext,
  extractSpeechKeywords,
  buildArollSummaries,
  buildBrollSummaries,
  summariesToBrollScenes,
} from "@/lib/pipeline/narrative-analyzer";
import { verifyRender } from "@/lib/pipeline/render-verifier";
import { buildLayoutMap, saveLayoutMap } from "@/lib/pipeline/layout-map";
import { applyCvCorrections } from "@/lib/pipeline/cv-correction";

// Analysis
import { getVideoMetadata } from "@/lib/analysis/frameExtractor";

const ROOT = process.cwd();

// ── Paths ──
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const CACHE_DIR = path.join(ROOT, "public", "analysis", ".cache");
const AROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6108.MOV");
const BROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const REF_VIDEO = path.join(ROOT, "public", "uploads", "IMG_6018.MOV");
const OUTPUT_DIR = path.join(ROOT, "public", "exports");
const TEMP_DIR = path.join(OUTPUT_DIR, "sp-temp");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "content-aware-render.mp4");

async function main() {

// ══════════════════════════════════════════════════════════
// STEP 1: Load cached data
// ══════════════════════════════════════════════════════════

console.log("═".repeat(60));
console.log("  CONTENT-AWARE FULL VIDEO RENDER");
console.log("═".repeat(60));

// Find cache files by category — returns the most recent one
function findCache(category: string): any {
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.endsWith(`-${category}.json`))
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`No ${category} cache found`);
  const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, files[0].name), "utf-8"));
  return raw.data;
}

// Load blueprint (reference analysis) — use the reference video's blueprint (278b7f...)
const blueprintRaw = JSON.parse(
  fs.readFileSync(path.join(CACHE_DIR, "278b7f948b1f1d35-visual_blueprint.json"), "utf-8")
);
const blueprint = blueprintRaw.data;
const blueprintSegments = blueprint.reference?.segments ?? blueprint.segments ?? [];
console.log(`\n✓ Blueprint loaded: ${blueprintSegments.length} segments`);

// ══════════════════════════════════════════════════════════
// STEP 1b: CV coordinate correction (measure the real reference pixels)
// ══════════════════════════════════════════════════════════
// Gemini's bounding-box estimates are unreliable. Measure the actual geometry
// (circle/rectangle/text) via computer vision and OVERRIDE the blueprint
// coordinates before anything downstream. Shared with /api/clone-style.
console.log("\n── Phase 1b: CV Coordinate Correction ──");
{
  const arollMetaEarly = await getVideoMetadata(AROLL_PATH);
  const { logs } = await applyCvCorrections({
    ffmpegPath: FFMPEG,
    refVideoPath: REF_VIDEO,
    canvas: blueprint.canvas,
    segments: blueprintSegments,
    sourceAspect: arollMetaEarly.resolution.width / arollMetaEarly.resolution.height,
    tmpDir: TEMP_DIR,
  });
  for (const line of logs) console.log(`  ${line}`);
}

// Build the Layout Map (virtual coordinate template/library) from the
// reference's layout-state sequence. Saved as a reusable rule set, and used
// to animate PIP motion within sentences.
const refDuration =
  blueprint.reference?.duration ??
  (blueprintSegments.length > 0
    ? blueprintSegments[blueprintSegments.length - 1].end
    : 0);
const layoutMap = buildLayoutMap({
  segments: blueprintSegments,
  canvas: blueprint.canvas,
  refDuration,
  sourceFile: blueprintRaw.sourceFile ?? "IMG_6018.MOV",
});
const LIBRARY_DIR = path.join(ROOT, "public", "analysis", "library");
fs.mkdirSync(LIBRARY_DIR, { recursive: true });
const layoutMapPath = path.join(LIBRARY_DIR, "reference-layout-map.json");
saveLayoutMap(layoutMap, layoutMapPath);
console.log(
  `✓ Layout Map built: ${layoutMap.states.length} states (${layoutMap.aspectRatio}), saved → ${path.relative(ROOT, layoutMapPath)}`
);
for (const s of layoutMap.states) {
  const a = s.aroll;
  const aDesc = a
    ? `${a.shape}(${a.region.x},${a.region.y},${a.region.width}x${a.region.height})`
    : "none";
  console.log(`    state ${s.index} [${s.refTimeRange.start.toFixed(1)}-${s.refTimeRange.end.toFixed(1)}s] aroll=${aDesc}`);
}

// Load transcription
const transPath = path.join(TEMP_DIR, "aroll-transcription.json");
const transcription = JSON.parse(fs.readFileSync(transPath, "utf-8"));
console.log(`✓ Transcription loaded: ${transcription.sentences.length} sentences`);

// Load B-roll material analysis
const brollMaterial = findCache("broll_material");
console.log(`✓ B-roll material loaded: ${brollMaterial.frameContent.length} frames, ${brollMaterial.internalScenes.length} scenes`);

// Load A-roll material analysis (for face crop info)
const arollMaterial = findCache("aroll_material");
console.log(`✓ A-roll material loaded: face frames=${arollMaterial.faceFrames?.length ?? 0}`);

// ══════════════════════════════════════════════════════════
// STEP 2: Generate dynamic template
// ══════════════════════════════════════════════════════════

console.log("\n── Phase 2: Template Generation ──");

const faceInfo = extractFaceInfo(arollMaterial);
console.log(`  Face info:`, JSON.stringify(faceInfo));

const dynamicTemplate = generateTemplate({
  canvas: blueprint.canvas,
  fps: 30,
  segments: blueprintSegments,
  faceInfo,
  aspectRatio: "9:16",
  referenceTranscription: transcription,
} as any);
console.log(`  Template: ${dynamicTemplate.name} (${dynamicTemplate.id})`);
console.log(`  Layouts: ${Object.keys(dynamicTemplate.layouts).join(", ")}`);

// ══════════════════════════════════════════════════════════
// STEP 3: Content-Aware B-roll Matching
// ══════════════════════════════════════════════════════════

console.log("\n── Phase 3: Content-Aware B-roll Matching ──");

// 3a. Build summaries
const { summaries: arollSummaries } = buildArollSummaries([transcription]);
const brollSummaries = buildBrollSummaries([brollMaterial]);
console.log(`  A-roll summaries: ${arollSummaries.length} clip(s), sentences: ${arollSummaries.reduce((s, c) => s + c.sentences.length, 0)}`);
console.log(`  B-roll summaries: ${brollSummaries.length} scene(s)`);

// 3b. Extract speech keywords via Gemini
console.log("  Extracting speech keywords via Gemini...");
const sentencesForKw = arollSummaries.flatMap(c =>
  c.sentences.map(s => ({ index: s.globalIndex, text: s.text }))
);
const speechKeywords = await extractSpeechKeywords(sentencesForKw);
console.log(`  Keywords extracted for ${speechKeywords.sentences?.length ?? 0} sentences`);

// Save keywords debug file
fs.writeFileSync(
  path.join(TEMP_DIR, "render-speech-keywords.json"),
  JSON.stringify(speechKeywords, null, 2)
);

// 3c. Analyze narrative context via Gemini
console.log("  Analyzing narrative context via Gemini...");
const narrativeContext = await analyzeNarrativeContext(
  arollSummaries,
  brollSummaries,
  speechKeywords
);
console.log(`  Theme: "${narrativeContext.theme}"`);
console.log(`  Phases: ${narrativeContext.narrativePhases.length}`);
console.log(`  Relevance entries: ${narrativeContext.relevanceMap.length}`);

// Save narrative context debug file
fs.writeFileSync(
  path.join(TEMP_DIR, "render-narrative-context.json"),
  JSON.stringify(narrativeContext, null, 2)
);

// 3d. Convert summaries to BRollScene format for plan builder
const brollScenes: BRollScene[] = summariesToBrollScenes(brollSummaries, [brollMaterial]);

// Ensure OCR text is on the scenes
for (let i = 0; i < brollScenes.length; i++) {
  if (brollSummaries[i]) {
    brollScenes[i].visibleText = brollSummaries[i].visibleText;
    brollScenes[i].uiElements = brollSummaries[i].uiElements;
  }
}

console.log(`  B-roll scenes for plan builder: ${brollScenes.length}`);
for (const scene of brollScenes) {
  const ocrSample = scene.visibleText?.slice(0, 3).join(", ") || "none";
  console.log(`    [${scene.start}-${scene.end}s] ${scene.contentTags.slice(0, 3).join(", ")} | OCR: [${ocrSample}]`);
}

// ══════════════════════════════════════════════════════════
// STEP 4: Build Editing Plan
// ══════════════════════════════════════════════════════════

console.log("\n── Phase 4: Building Editing Plan ──");

const editingPlan = buildEditingPlan({
  blueprintSegments: blueprintSegments,
  transcription,
  templateId: dynamicTemplate.id,
  template: dynamicTemplate,
  sources: {
    aroll: AROLL_PATH,
    broll: BROLL_PATH,
  },
  brollScenes,
  brollDuration: brollMaterial.duration,
  narrativeContext,
  layoutMap,
});

console.log(`\n  Plan built: ${editingPlan.layoutRanges.length} ranges, ${editingPlan.transitions.length} transitions`);
for (const range of editingPlan.layoutRanges) {
  const offset = range.brollOffset !== undefined ? ` broll@${range.brollOffset.toFixed(1)}s` : "";
  console.log(`    ${range.id}: ${range.layoutId} [${range.timeRange.start.toFixed(2)}-${range.timeRange.end.toFixed(2)}s]${offset}`);
}

// Save plan
fs.writeFileSync(
  path.join(TEMP_DIR, "content-aware-plan.json"),
  JSON.stringify(editingPlan, null, 2)
);

// ══════════════════════════════════════════════════════════
// STEP 5: Single-Pass FFmpeg Render
// ══════════════════════════════════════════════════════════

console.log("\n── Phase 5: FFmpeg Render ──");

const arollMeta = await getVideoMetadata(AROLL_PATH);
console.log(`  A-roll dimensions: ${arollMeta.resolution.width}x${arollMeta.resolution.height}`);

const filterScriptPath = path.join(TEMP_DIR, `filter-content-aware.txt`);

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

// Write filter script
fs.writeFileSync(filterScriptPath, renderOutput.filterComplex);

// Log render info
logRenderPlan(renderOutput);

// Save filter for debug
fs.writeFileSync(
  path.join(TEMP_DIR, "content-aware-filter.txt"),
  renderOutput.filterComplex
);

console.log(`  Filter script written: ${filterScriptPath}`);
console.log(`  FFmpeg args: ${renderOutput.ffmpegArgs.length} args`);
console.log(`  Output: ${OUTPUT_PATH}`);

// Execute FFmpeg
console.log("\n  Rendering...");
const startTime = Date.now();

await new Promise<void>((resolve, reject) => {
  const proc = spawn(FFMPEG, renderOutput.ffmpegArgs, {
    cwd: ROOT,
    shell: false,
  });

  let stderr = "";
  const timeout = setTimeout(() => {
    proc.kill("SIGKILL");
    reject(new Error("FFmpeg timed out after 3 minutes"));
  }, 180_000);

  proc.stderr?.on("data", (data: Buffer) => {
    const line = data.toString();
    stderr += line;
    // Show progress
    const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    if (timeMatch) {
      const secs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
      const pct = Math.round((secs / editingPlan.totalDuration) * 100);
      process.stdout.write(`\r  Progress: ${pct}%  `);
    }
  });

  proc.on("close", (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      resolve();
    } else {
      // Print last 500 chars of stderr for debugging
      console.error("\n  FFmpeg stderr (last 500 chars):");
      console.error(stderr.slice(-500));
      reject(new Error(`FFmpeg exited with code ${code}`));
    }
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    reject(err);
  });
});

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
const fileSize = fs.statSync(OUTPUT_PATH).size;
const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);

console.log(`\n\n✅ RENDER COMPLETE`);
console.log(`  Output: ${OUTPUT_PATH}`);
console.log(`  Size: ${fileSizeMB} MB`);
console.log(`  Time: ${elapsed}s`);
console.log(`  Duration: ${editingPlan.totalDuration.toFixed(2)}s`);
console.log("═".repeat(60));

// ══════════════════════════════════════════════════════════
// STEP 6: Closed-Loop Verification (V8)
// ══════════════════════════════════════════════════════════

console.log("\n── Phase 6: Structural Verification ──");

const skipVerify = process.argv.includes("--skip-verify");
if (skipVerify) {
  console.log("  Skipped (--skip-verify flag)");
} else {
  const verificationReport = await verifyRender({
    referenceVideoPath: REF_VIDEO,
    renderedVideoPath: OUTPUT_PATH,
    editingPlan,
    template: dynamicTemplate,
    threshold: 95,
    outputDir: path.join(OUTPUT_DIR, "verification"),
  });

  if (!verificationReport.passed) {
    console.log("\n⚠️  VERIFICATION FAILED — Review fixes above");
    console.log(`  Overall: ${verificationReport.overallMatch}% (need 95%)`);
    console.log(`  ${verificationReport.fixes.length} fix(es) identified`);
  } else {
    console.log(`\n✅ VERIFICATION PASSED — ${verificationReport.overallMatch}% match`);
  }
}

} // end main

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
