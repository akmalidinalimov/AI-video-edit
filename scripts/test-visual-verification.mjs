/**
 * Visual Verification Gate — Gemini-Powered Style Match Scoring
 *
 * Compares the pipeline output against the reference video using Gemini Vision.
 * Extracts frames at key timestamps, sends pairs for structural comparison,
 * and gates on a configurable pass threshold (default: 95%).
 *
 * USAGE:
 *   node scripts/test-visual-verification.mjs                     # uses defaults
 *   node scripts/test-visual-verification.mjs --output plan-rendered.mp4  # custom output
 *   node scripts/test-visual-verification.mjs --threshold 90      # custom threshold
 *   node scripts/test-visual-verification.mjs --plan dynamic-plan.json  # auto-detect timestamps
 *
 * This script is part of the regression checklist for EVERY version.
 *
 * SCORING DIMENSIONS (0-10 each):
 *   1. PIP Shape & Type — circle vs rectangle, PIP vs split
 *   2. PIP Position & Size — x,y coordinates + width,height relative to canvas
 *   3. A-roll Framing — face visibility, crop/zoom, centering
 *   4. B-roll Region — spatial coverage (ignore content differences)
 *   5. Text Overlays — headline position/color/style (seg1 only)
 *   6. Canvas Composition — overall 1080x1920 structure, element arrangement
 *
 * PASS: overall >= threshold (default 95%)
 * FAIL: overall < threshold — prints which segments/dimensions failed
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";

const ROOT = process.cwd();

// ════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════

// Load .env.local if GEMINI_API_KEY not already set
if (!process.env.GEMINI_API_KEY) {
  const envPath = path.join(ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  }
}

if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY not set. Add it to .env.local or environment.");
  process.exit(1);
}

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}

const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF_VIDEO = path.join(ROOT, "public", "uploads", getArg("reference", "IMG_6018.MOV"));
const OUTPUT_VIDEO = path.join(ROOT, "public", "exports", getArg("output", "plan-rendered.mp4"));
const PLAN_FILE = path.join(ROOT, "public", "exports", "sp-temp", getArg("plan", "dynamic-plan.json"));
const PASS_THRESHOLD = parseInt(getArg("threshold", "95"), 10);
const OUT_DIR = path.join(ROOT, "public", "exports", "verification");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ════════════════════════════════════════════════════════════
// GEMINI SETUP
// ════════════════════════════════════════════════════════════

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const models = [
  genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } }),
  genAI.getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { responseMimeType: "application/json" } }),
  genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview", generationConfig: { responseMimeType: "application/json" } }),
];

// ════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════

function runFFmpeg(ffmpegArgs, label, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, ffmpegArgs, { cwd: ROOT, shell: false, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve({ code: -1, stderr: "timeout" }); }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errs = stderr.split("\n").filter(l => /Error|error/.test(l)).slice(0, 3);
        console.error(`  [${label}] EXIT ${code}: ${errs.join(" | ")}`);
      }
      resolve({ code, stderr });
    });
  });
}

async function extractFrame(videoPath, timestamp, outPath) {
  await runFFmpeg(["-y", "-ss", timestamp.toString(), "-i", videoPath, "-vframes", "1", "-q:v", "2", outPath], path.basename(outPath));
}

async function createSideBySide(refFrame, outFrame, outPath) {
  await runFFmpeg([
    "-y", "-i", refFrame, "-i", outFrame,
    "-filter_complex",
    "[0:v]scale=540:960[left];[1:v]scale=540:960[right];[left][right]hstack=inputs=2[out]",
    "-map", "[out]", "-frames:v", "1", "-q:v", "2", outPath
  ], "sidebyside");
}

/**
 * Auto-detect verification timestamps from the editing plan.
 * Takes the midpoint of each layout range + the transition points.
 */
function getVerificationTimestamps(planPath) {
  if (!fs.existsSync(planPath)) {
    console.log("  No plan file found, using default timestamps");
    return getDefaultTimestamps();
  }

  try {
    const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    const timestamps = [];

    if (plan.layoutRanges) {
      for (const range of plan.layoutRanges) {
        // Midpoint of each range
        const mid = (range.startTime + range.endTime) / 2;
        timestamps.push({
          id: range.id,
          time: Math.round(mid * 10) / 10,
          label: `${range.startTime.toFixed(1)}-${range.endTime.toFixed(1)}s: ${range.layoutId} (${range.sentenceIds?.join("+") || "?"})`,
          layoutId: range.layoutId,
        });
      }
    }

    // Add transition midpoints
    if (plan.transitions) {
      for (const t of plan.transitions) {
        timestamps.push({
          id: `transition_${t.fromLayout}_${t.toLayout}`,
          time: t.time + 0.2, // Just after transition
          label: `Transition at ${t.time.toFixed(1)}s: ${t.fromLayout} → ${t.toLayout}`,
          layoutId: t.toLayout,
          isTransition: true,
        });
      }
    }

    // Sort by time and deduplicate (remove timestamps within 0.5s of each other)
    timestamps.sort((a, b) => a.time - b.time);
    const deduped = [];
    for (const ts of timestamps) {
      if (deduped.length === 0 || ts.time - deduped[deduped.length - 1].time > 0.5) {
        deduped.push(ts);
      }
    }

    console.log(`  Auto-detected ${deduped.length} verification timestamps from plan`);
    return deduped;
  } catch (err) {
    console.log(`  Failed to parse plan: ${err.message}. Using defaults.`);
    return getDefaultTimestamps();
  }
}

function getDefaultTimestamps() {
  return [
    { id: "seg_1", time: 1.9, label: "0-3.8s: Rectangle PIP + headline (sentence 1)", layoutId: "fullscreen_aroll" },
    { id: "seg_2", time: 7.5, label: "3.8-11.2s: Circle PIP (sentence 2)", layoutId: "circle_pip" },
    { id: "seg_3", time: 12.6, label: "11.2-14.0s: Circle PIP (clause break)", layoutId: "circle_pip" },
    { id: "seg_4", time: 17.0, label: "14.0-21.8s: Circle PIP (sentence 3 cont)", layoutId: "circle_pip" },
    { id: "seg_5", time: 23.0, label: "21.8-24.5s: Circle PIP (sentence 4)", layoutId: "circle_pip" },
  ];
}

// ════════════════════════════════════════════════════════════
// GEMINI COMPARISON
// ════════════════════════════════════════════════════════════

const COMPARISON_PROMPT = `You are comparing a REFERENCE video frame (Image 1) against a CLONED/RECREATED video frame (Image 2).
The goal is to evaluate how accurately the clone reproduces the reference's visual LAYOUT STRUCTURE.

Segment: {SEGMENT_LABEL}

CRITICAL INSTRUCTIONS:
- The B-roll is a COMPLETELY DIFFERENT screen recording app. ALL content inside the B-roll area — text, headers, footers, icons, buttons, filter chips, modal dialogs, popups, navigation bars, and ANY UI elements — are EXPECTED to differ. Do NOT penalize for ANY B-roll content differences. A modal dialog visible in one but not the other is a B-roll content difference, NOT a structural difference.
- The A-roll is the same person but from a different camera angle/take.
- Only penalize for STRUCTURAL differences: PIP shape/position/size, canvas aspect ratio, whether the B-roll fills the correct spatial region, and any ADDED styled text overlays that appear ON TOP of the content (not text that is part of the B-roll UI).
- For segment 1 only: there are ADDED styled text overlays (headlines in the header zone) that should match in position and style. For all other segments, there should be NO added text overlays — any text visible is part of the B-roll UI and should NOT be scored.
- For Canvas & Composition: ONLY score the structural arrangement of canvas regions (PIP area, B-roll area, header area). Do NOT let B-roll content (like modal dialogs or popups) affect this score.

Score each dimension 0-10:

1. **PIP Shape & Type** — Does the clone use the same PIP shape (circle vs rectangle)? Is it the correct type (picture-in-picture vs vertical split)?
2. **PIP Position & Size** — Is the PIP overlay in the correct position (x,y coordinates) and correct size (width,height) relative to the canvas?
3. **A-roll Framing** — Is the person's face properly visible and centered within the PIP? Is the crop/zoom level similar?
4. **B-roll Region** — Does the B-roll content fill the correct spatial region of the canvas? (Ignore the actual content — only check spatial coverage)
5. **Added Overlays** — For header/text layout: Do the styled headline texts match in position, color, and style? For circle PIP: Score 10/10 if no unwanted overlays are added (B-roll UI text does NOT count as overlays).
6. **Canvas & Composition** — Is the overall canvas 1080x1920 portrait? Does the spatial arrangement of all elements match the reference's structure?

Return JSON:
{
  "pip_shape": { "score": <0-10>, "notes": "..." },
  "pip_position": { "score": <0-10>, "notes": "..." },
  "aroll_framing": { "score": <0-10>, "notes": "..." },
  "broll_region": { "score": <0-10>, "notes": "..." },
  "added_overlays": { "score": <0-10>, "notes": "..." },
  "canvas_composition": { "score": <0-10>, "notes": "..." },
  "total_score": <0-60>,
  "percentage": <0-100>,
  "summary": "2-3 sentence assessment focusing on STRUCTURAL layout accuracy only"
}`;

async function analyzeWithGemini(refFramePath, outFramePath, segLabel) {
  const refBase64 = fs.readFileSync(refFramePath).toString("base64");
  const outBase64 = fs.readFileSync(outFramePath).toString("base64");

  const prompt = COMPARISON_PROMPT.replace("{SEGMENT_LABEL}", segLabel);

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: "image/jpeg", data: refBase64 } },
    { inlineData: { mimeType: "image/jpeg", data: outBase64 } },
  ];

  for (let mi = 0; mi < models.length; mi++) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const result = await models[mi].generateContent(parts);
        const text = result.response.text();
        const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        return JSON.parse(cleaned);
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("503") || msg.includes("429") || msg.includes("overloaded") || msg.includes("high demand")) {
          const delay = 3000 * (retry + 1);
          if (retry < 2) {
            console.log(`    Retry ${retry + 1}/3 in ${delay / 1000}s (model ${mi})...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          console.log(`    Model ${mi} exhausted, trying next...`);
          break;
        }
        console.error(`  Gemini analysis failed for ${segLabel}:`, msg.substring(0, 200));
        return null;
      }
    }
  }
  console.error(`  All models failed for ${segLabel}`);
  return null;
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  VISUAL VERIFICATION GATE — Gemini Style Match Scoring          ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  // Validate inputs
  if (!fs.existsSync(FFMPEG)) {
    console.error(`ERROR: FFmpeg not found at ${FFMPEG}`);
    process.exit(1);
  }
  if (!fs.existsSync(REF_VIDEO)) {
    console.error(`ERROR: Reference video not found: ${REF_VIDEO}`);
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_VIDEO)) {
    console.error(`ERROR: Output video not found: ${OUTPUT_VIDEO}`);
    console.error("  Run test-plan-renderer.mjs first to produce the output video.");
    process.exit(1);
  }

  console.log(`  Reference: ${path.basename(REF_VIDEO)}`);
  console.log(`  Output:    ${path.basename(OUTPUT_VIDEO)}`);
  console.log(`  Threshold: ${PASS_THRESHOLD}%`);
  console.log();

  // Step 1: Determine timestamps
  console.log("Step 1: Determining verification timestamps...\n");
  const timestamps = getVerificationTimestamps(PLAN_FILE);

  for (const ts of timestamps) {
    console.log(`  ${ts.id}: ${ts.time}s — ${ts.label}`);
  }
  console.log();

  // Step 2: Extract frames
  console.log("Step 2: Extracting frames...\n");

  for (const ts of timestamps) {
    const refFrame = path.join(OUT_DIR, `ref_${ts.id}.jpg`);
    const outFrame = path.join(OUT_DIR, `out_${ts.id}.jpg`);
    const sbs = path.join(OUT_DIR, `sidebyside_${ts.id}.jpg`);

    await extractFrame(REF_VIDEO, ts.time, refFrame);
    await extractFrame(OUTPUT_VIDEO, ts.time, outFrame);
    await createSideBySide(refFrame, outFrame, sbs);
    console.log(`  ✓ ${ts.id} (${ts.time}s) — frames extracted + side-by-side`);
  }
  console.log();

  // Step 3: Gemini analysis
  console.log("Step 3: Gemini Vision analysis...\n");

  const results = [];
  for (const ts of timestamps) {
    const refFrame = path.join(OUT_DIR, `ref_${ts.id}.jpg`);
    const outFrame = path.join(OUT_DIR, `out_${ts.id}.jpg`);

    console.log(`  Analyzing ${ts.id}: ${ts.label}...`);
    const analysis = await analyzeWithGemini(refFrame, outFrame, ts.label);

    if (analysis) {
      results.push({ ...ts, analysis });
      const pct = analysis.percentage;
      const icon = pct >= PASS_THRESHOLD ? "✓" : pct >= 85 ? "⚠" : "✗";
      console.log(`    ${icon} Score: ${analysis.total_score}/60 (${pct}%)`);
      console.log(`    PIP Shape: ${analysis.pip_shape.score}/10 | PIP Pos: ${analysis.pip_position.score}/10 | A-roll: ${analysis.aroll_framing.score}/10`);
      console.log(`    B-roll: ${analysis.broll_region.score}/10 | Overlays: ${analysis.added_overlays.score}/10 | Canvas: ${analysis.canvas_composition.score}/10`);
      console.log(`    ${analysis.summary}\n`);
    } else {
      results.push({ ...ts, analysis: null });
      console.log(`    ✗ Analysis failed — Gemini unavailable\n`);
    }

    // Rate limit between API calls
    await new Promise(r => setTimeout(r, 1500));
  }

  // Step 4: Aggregate and verdict
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                    VERIFICATION REPORT                          ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const scored = results.filter(r => r.analysis !== null);
  if (scored.length === 0) {
    console.error("  ERROR: No segments could be analyzed. Gemini may be unavailable.");
    process.exit(1);
  }

  // Dimension averages
  const dims = ["pip_shape", "pip_position", "aroll_framing", "broll_region", "added_overlays", "canvas_composition"];
  const dimLabels = ["PIP Shape & Type", "PIP Position & Size", "A-roll Framing", "B-roll Region", "Text Overlays", "Canvas & Composition"];

  console.log("  DIMENSION SCORES (average across segments):\n");
  const dimAverages = {};
  for (let i = 0; i < dims.length; i++) {
    const scores = scored.map(r => r.analysis[dims[i]].score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    dimAverages[dimLabels[i]] = Math.round(avg * 10) / 10;
    const bar = "█".repeat(Math.round(avg)) + "░".repeat(10 - Math.round(avg));
    const icon = avg >= 9.5 ? "✓" : avg >= 8 ? "⚠" : "✗";
    console.log(`  ${icon} ${dimLabels[i].padEnd(22)} ${bar} ${avg.toFixed(1)}/10  [${scores.join(", ")}]`);
  }

  // Overall score
  const overallPct = scored.reduce((s, r) => s + r.analysis.percentage, 0) / scored.length;
  const overallRounded = Math.round(overallPct * 10) / 10;

  console.log();
  console.log("  ════════════════════════════════════════════════════════════════");

  // Per-segment breakdown
  console.log("\n  PER-SEGMENT BREAKDOWN:\n");
  for (const r of scored) {
    const icon = r.analysis.percentage >= PASS_THRESHOLD ? "✓" : r.analysis.percentage >= 85 ? "⚠" : "✗";
    console.log(`  ${icon} ${r.id} (${r.time}s): ${r.analysis.percentage}% — ${r.analysis.summary}`);
  }

  // Failed segments
  const failed = scored.filter(r => r.analysis.percentage < PASS_THRESHOLD);
  if (failed.length > 0) {
    console.log("\n  SEGMENTS BELOW THRESHOLD:");
    for (const f of failed) {
      console.log(`    ✗ ${f.id}: ${f.analysis.percentage}% (need ${PASS_THRESHOLD}%)`);
      // Show which dimensions are weak
      for (let i = 0; i < dims.length; i++) {
        const score = f.analysis[dims[i]].score;
        if (score < 8) {
          console.log(`      → ${dimLabels[i]}: ${score}/10 — ${f.analysis[dims[i]].notes}`);
        }
      }
    }
  }

  // Final verdict
  console.log();
  console.log("  ╔══════════════════════════════════════════════════════════════╗");
  if (overallRounded >= PASS_THRESHOLD) {
    console.log(`  ║  RESULT: PASS  ✓  (${overallRounded}% >= ${PASS_THRESHOLD}% threshold)                ║`);
  } else {
    console.log(`  ║  RESULT: FAIL  ✗  (${overallRounded}% < ${PASS_THRESHOLD}% threshold)                 ║`);
  }
  console.log(`  ║  Overall Match: ${overallRounded}%                                         ║`);
  console.log(`  ║  Segments: ${scored.length} analyzed, ${failed.length} below threshold               ║`);
  console.log("  ╚══════════════════════════════════════════════════════════════╝\n");

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    referenceVideo: path.basename(REF_VIDEO),
    outputVideo: path.basename(OUTPUT_VIDEO),
    threshold: PASS_THRESHOLD,
    overallMatch: overallRounded,
    passed: overallRounded >= PASS_THRESHOLD,
    segmentsAnalyzed: scored.length,
    segmentsFailed: failed.length,
    dimensionAverages: dimAverages,
    segments: scored.map(r => ({
      id: r.id,
      time: r.time,
      label: r.label,
      layoutId: r.layoutId,
      analysis: r.analysis,
    })),
  };

  const reportPath = path.join(OUT_DIR, "verification-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  Report saved: ${reportPath}`);
  console.log(`  Side-by-side frames: ${OUT_DIR}`);
  console.log();

  // Exit code reflects pass/fail
  if (overallRounded < PASS_THRESHOLD) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
