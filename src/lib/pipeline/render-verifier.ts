/**
 * Render Verifier — Closed-Loop Structural Verification (V8)
 *
 * Compares a rendered video against its reference using Gemini Vision.
 * Extracts frames at layout transition midpoints, creates side-by-side
 * comparisons, and returns a scored report with actionable fix suggestions.
 *
 * ARCHITECTURE:
 * - Uses extractSingleFrame from frameExtractor for frame capture
 * - Gemini Vision scores 6 structural dimensions per segment
 * - Returns VerificationReport with per-segment and overall scores
 * - Identifies specific fixes when below 95% threshold
 *
 * SCORING DIMENSIONS (0-10 each):
 *   1. PIP Shape & Type
 *   2. PIP Position & Size
 *   3. A-roll Framing
 *   4. B-roll Region (spatial coverage, NOT content)
 *   5. Added Overlays (text/captions)
 *   6. Canvas & Composition
 *
 * USAGE:
 *   const report = await verifyRender({
 *     referenceVideoPath, renderedVideoPath, editingPlan, template
 *   });
 *   if (!report.passed) {
 *     // report.fixes has actionable suggestions
 *   }
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import type { EditingPlan, LayoutRange } from "./editing-plan";
import type { VCSTemplate } from "./vcs-templates";

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface VerificationInput {
  /** Path to the original reference video */
  referenceVideoPath: string;
  /** Path to the rendered output video */
  renderedVideoPath: string;
  /** The editing plan used for the render */
  editingPlan: EditingPlan;
  /** The template used for the render */
  template: VCSTemplate;
  /** Pass threshold percentage (default: 95) */
  threshold?: number;
  /** Directory for verification artifacts (frames, report) */
  outputDir?: string;
  /** Gemini API key (falls back to env) */
  geminiApiKey?: string;
}

export interface DimensionScore {
  score: number;
  notes: string;
}

export interface SegmentVerification {
  id: string;
  rangeId: string;
  layoutId: string;
  timestamp: number;
  timeRange: { start: number; end: number };
  sentenceText: string;
  brollOffset?: number;
  refFramePath: string;
  renderedFramePath: string;
  sideBySidePath: string;
  analysis: {
    pip_shape: DimensionScore;
    pip_position: DimensionScore;
    aroll_framing: DimensionScore;
    broll_region: DimensionScore;
    added_overlays: DimensionScore;
    canvas_composition: DimensionScore;
    total_score: number;
    percentage: number;
    summary: string;
    fixes_needed?: string[];
  } | null;
}

export interface VerificationFix {
  dimension: string;
  segmentId: string;
  currentScore: number;
  issue: string;
  suggestedFix: string;
  priority: "critical" | "high" | "medium" | "low";
}

export interface VerificationReport {
  timestamp: string;
  referenceVideo: string;
  renderedVideo: string;
  threshold: number;
  overallMatch: number;
  passed: boolean;
  segmentsAnalyzed: number;
  segmentsBelowThreshold: number;
  dimensionAverages: Record<string, number>;
  segments: SegmentVerification[];
  fixes: VerificationFix[];
}

// ════════════════════════════════════════════════════════════
// FFMPEG UTILITIES
// ════════════════════════════════════════════════════════════

function getFFmpegPath(): string {
  const root = process.cwd();
  return path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
}

function runFFmpeg(
  ffmpegArgs: string[],
  label: string,
  timeoutMs = 30000
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(getFFmpegPath(), ffmpegArgs, {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: -1, stderr: "timeout" });
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: "spawn error" });
    });
  });
}

async function extractFrame(
  videoPath: string,
  timestamp: number,
  outPath: string
): Promise<void> {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await runFFmpeg(
    ["-y", "-ss", timestamp.toString(), "-i", videoPath, "-vframes", "1", "-q:v", "2", outPath],
    path.basename(outPath)
  );
}

async function createSideBySide(
  refFrame: string,
  outFrame: string,
  outPath: string
): Promise<void> {
  await runFFmpeg(
    [
      "-y",
      "-i", refFrame,
      "-i", outFrame,
      "-filter_complex",
      "[0:v]scale=540:960[left];[1:v]scale=540:960[right];[left][right]hstack=inputs=2[out]",
      "-map", "[out]",
      "-frames:v", "1",
      "-q:v", "2",
      outPath,
    ],
    "sidebyside"
  );
}

// ════════════════════════════════════════════════════════════
// GEMINI COMPARISON
// ════════════════════════════════════════════════════════════

const COMPARISON_PROMPT = `You are comparing a REFERENCE video frame (Image 1, left) against a CLONED/RECREATED video frame (Image 2, right).
The goal is to evaluate how accurately the clone reproduces the reference's visual LAYOUT STRUCTURE.

Segment: {SEGMENT_LABEL}
Layout: {LAYOUT_ID}
Time range: {TIME_RANGE}
Sentence being spoken: "{SENTENCE_TEXT}"

CRITICAL INSTRUCTIONS:
- The B-roll is a COMPLETELY DIFFERENT screen recording. ALL content inside the B-roll area — text, icons, buttons, UI elements — are EXPECTED to differ. Do NOT penalize for B-roll content differences. Only check that B-roll fills the correct spatial region.
- The A-roll is the same person but from a different camera angle/take.
- Only penalize for STRUCTURAL differences: PIP shape/position/size, canvas composition, B-roll spatial coverage, A-roll framing.
- For the first segment with header/text layout: styled headline overlays should match in position and style. For circle PIP segments: score overlays 10/10 if no unwanted overlays are added.

Score each dimension 0-10:

1. **PIP Shape & Type** — Same PIP shape (circle vs rectangle)? Correct type (PIP vs split)?
2. **PIP Position & Size** — PIP position (x,y) and size (width,height) relative to canvas?
3. **A-roll Framing** — Face visible and centered in PIP? Similar crop/zoom?
4. **B-roll Region** — B-roll fills the correct spatial region of canvas? (ignore content)
5. **Added Overlays** — For header layouts: headline text position/color/style match? For circle PIP: 10/10 if no unwanted overlays.
6. **Canvas & Composition** — Overall 1080x1920 portrait? Element arrangement matches reference?

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
  "summary": "2-3 sentence assessment focusing on STRUCTURAL layout accuracy only",
  "fixes_needed": ["specific actionable fix 1", "specific actionable fix 2"]
}`;

async function analyzeWithGemini(
  refFramePath: string,
  outFramePath: string,
  segLabel: string,
  layoutId: string,
  timeRange: string,
  sentenceText: string,
  apiKey: string
): Promise<any | null> {
  // Dynamic import to avoid issues when module is loaded without Gemini
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);

  const models = [
    genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    }),
    genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    }),
  ];

  const refBase64 = fs.readFileSync(refFramePath).toString("base64");
  const outBase64 = fs.readFileSync(outFramePath).toString("base64");

  const prompt = COMPARISON_PROMPT
    .replace("{SEGMENT_LABEL}", segLabel)
    .replace("{LAYOUT_ID}", layoutId)
    .replace("{TIME_RANGE}", timeRange)
    .replace("{SENTENCE_TEXT}", sentenceText);

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
      } catch (err: any) {
        const msg = err.message || "";
        if (msg.includes("503") || msg.includes("429") || msg.includes("overloaded") || msg.includes("high demand")) {
          const delay = 3000 * (retry + 1);
          if (retry < 2) {
            console.log(`      Retry ${retry + 1}/3 in ${delay / 1000}s (model ${mi})...`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          break;
        }
        console.error(`    Gemini analysis failed: ${msg.substring(0, 200)}`);
        return null;
      }
    }
  }
  console.error(`    All Gemini models failed for ${segLabel}`);
  return null;
}

// ════════════════════════════════════════════════════════════
// VERIFICATION TIMESTAMPS
// ════════════════════════════════════════════════════════════

interface VerificationTimestamp {
  id: string;
  rangeId: string;
  layoutId: string;
  timestamp: number;
  timeRange: { start: number; end: number };
  sentenceText: string;
  brollOffset?: number;
}

/**
 * Compute verification timestamps from the editing plan.
 * Takes the midpoint of each layout range.
 */
function getVerificationTimestamps(plan: EditingPlan): VerificationTimestamp[] {
  const timestamps: VerificationTimestamp[] = [];

  for (let i = 0; i < plan.layoutRanges.length; i++) {
    const range = plan.layoutRanges[i];
    const mid = (range.timeRange.start + range.timeRange.end) / 2;
    const sentenceText = range.sentences.map((s) => s.text).join(" ");

    timestamps.push({
      id: `seg_${i + 1}`,
      rangeId: range.id,
      layoutId: range.layoutId,
      timestamp: Math.round(mid * 100) / 100,
      timeRange: range.timeRange,
      sentenceText,
      brollOffset: range.brollOffset,
    });
  }

  return timestamps;
}

// ════════════════════════════════════════════════════════════
// FIX GENERATOR
// ════════════════════════════════════════════════════════════

const DIMENSION_KEYS = [
  "pip_shape",
  "pip_position",
  "aroll_framing",
  "broll_region",
  "added_overlays",
  "canvas_composition",
] as const;

const DIMENSION_LABELS: Record<string, string> = {
  pip_shape: "PIP Shape & Type",
  pip_position: "PIP Position & Size",
  aroll_framing: "A-roll Framing",
  broll_region: "B-roll Region",
  added_overlays: "Text Overlays",
  canvas_composition: "Canvas & Composition",
};

function generateFixes(segments: SegmentVerification[]): VerificationFix[] {
  const fixes: VerificationFix[] = [];

  for (const seg of segments) {
    if (!seg.analysis) continue;

    for (const dim of DIMENSION_KEYS) {
      const score = seg.analysis[dim].score;
      if (score >= 9) continue; // Good enough

      const priority: VerificationFix["priority"] =
        score <= 5 ? "critical" : score <= 7 ? "high" : "medium";

      // Generate fix suggestion based on dimension and notes
      let suggestedFix = "";
      const notes = seg.analysis[dim].notes;

      switch (dim) {
        case "pip_shape":
          suggestedFix = `Check template layout "${seg.layoutId}" — A-roll shape may not match reference. ${notes}`;
          break;
        case "pip_position":
          suggestedFix = `Adjust A-roll position/size in template layout "${seg.layoutId}" or layoutOverride for ${seg.rangeId}. ${notes}`;
          break;
        case "aroll_framing":
          suggestedFix = `Adjust face crop center or zoom level in plan-renderer.ts for "${seg.layoutId}". ${notes}`;
          break;
        case "broll_region":
          suggestedFix = `B-roll region doesn't fill expected area. Check isBackground flag and brollRegion override for ${seg.rangeId}. ${notes}`;
          break;
        case "added_overlays":
          suggestedFix = `Text overlay mismatch. Check text slot extraction in plan-builder or drawtext filter in plan-renderer. ${notes}`;
          break;
        case "canvas_composition":
          suggestedFix = `Overall composition off. Check canvas dimensions, element z-ordering, and enable expressions. ${notes}`;
          break;
      }

      // Add Gemini's own fix suggestions if present
      const geminiSuggestions = seg.analysis.fixes_needed;
      if (geminiSuggestions?.length) {
        suggestedFix += ` Gemini suggests: ${geminiSuggestions.join("; ")}`;
      }

      fixes.push({
        dimension: DIMENSION_LABELS[dim],
        segmentId: seg.id,
        currentScore: score,
        issue: notes,
        suggestedFix,
        priority,
      });
    }
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  fixes.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return fixes;
}

// ════════════════════════════════════════════════════════════
// MAIN VERIFICATION FUNCTION
// ════════════════════════════════════════════════════════════

/**
 * Verify a rendered video against its reference.
 *
 * Extracts frames at layout range midpoints, sends to Gemini for
 * structural comparison, and returns a detailed report.
 *
 * @returns VerificationReport with scores, pass/fail, and fix suggestions
 */
export async function verifyRender(
  input: VerificationInput
): Promise<VerificationReport> {
  const {
    referenceVideoPath,
    renderedVideoPath,
    editingPlan,
    threshold = 95,
    geminiApiKey,
  } = input;

  const apiKey = geminiApiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set — required for verification");
  }

  const outputDir = input.outputDir ?? path.join(
    process.cwd(), "public", "exports", "verification"
  );
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         RENDER VERIFICATION — Gemini Vision Scoring         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`  Reference: ${path.basename(referenceVideoPath)}`);
  console.log(`  Rendered:  ${path.basename(renderedVideoPath)}`);
  console.log(`  Threshold: ${threshold}%`);

  // Validate files exist
  if (!fs.existsSync(referenceVideoPath)) {
    throw new Error(`Reference video not found: ${referenceVideoPath}`);
  }
  if (!fs.existsSync(renderedVideoPath)) {
    throw new Error(`Rendered video not found: ${renderedVideoPath}`);
  }

  // ── Step 1: Compute verification timestamps ──
  console.log("\n  Step 1: Computing verification timestamps...");
  const timestamps = getVerificationTimestamps(editingPlan);
  for (const ts of timestamps) {
    const broll = ts.brollOffset !== undefined ? ` broll@${ts.brollOffset.toFixed(1)}s` : "";
    console.log(`    ${ts.id} (${ts.rangeId}): ${ts.timestamp}s | ${ts.layoutId}${broll}`);
  }

  // ── Step 2: Extract frames ──
  console.log("\n  Step 2: Extracting frames...");
  const segments: SegmentVerification[] = [];

  for (const ts of timestamps) {
    const refFrame = path.join(outputDir, `ref_${ts.id}.jpg`);
    const renderedFrame = path.join(outputDir, `rendered_${ts.id}.jpg`);
    const sbsFrame = path.join(outputDir, `sidebyside_${ts.id}.jpg`);

    await extractFrame(referenceVideoPath, ts.timestamp, refFrame);
    await extractFrame(renderedVideoPath, ts.timestamp, renderedFrame);
    await createSideBySide(refFrame, renderedFrame, sbsFrame);

    segments.push({
      id: ts.id,
      rangeId: ts.rangeId,
      layoutId: ts.layoutId,
      timestamp: ts.timestamp,
      timeRange: ts.timeRange,
      sentenceText: ts.sentenceText,
      brollOffset: ts.brollOffset,
      refFramePath: refFrame,
      renderedFramePath: renderedFrame,
      sideBySidePath: sbsFrame,
      analysis: null,
    });

    console.log(`    ✓ ${ts.id} (${ts.timestamp}s) — frames extracted`);
  }

  // ── Step 3: Gemini analysis ──
  console.log("\n  Step 3: Gemini Vision analysis...");

  for (const seg of segments) {
    const timeRange = `${seg.timeRange.start.toFixed(2)}-${seg.timeRange.end.toFixed(2)}s`;
    const label = `${seg.id}: ${seg.layoutId} [${timeRange}]`;

    console.log(`    Analyzing ${label}...`);
    const analysis = await analyzeWithGemini(
      seg.refFramePath,
      seg.renderedFramePath,
      label,
      seg.layoutId,
      timeRange,
      seg.sentenceText,
      apiKey
    );

    if (analysis) {
      seg.analysis = analysis;
      const pct = analysis.percentage;
      const icon = pct >= threshold ? "✓" : pct >= 85 ? "⚠" : "✗";
      console.log(`      ${icon} ${pct}% | Shape:${analysis.pip_shape.score} Pos:${analysis.pip_position.score} A-roll:${analysis.aroll_framing.score} B-roll:${analysis.broll_region.score} Overlay:${analysis.added_overlays.score} Canvas:${analysis.canvas_composition.score}`);
      console.log(`      ${analysis.summary}`);
    } else {
      console.log(`      ✗ Analysis failed`);
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 1500));
  }

  // ── Step 4: Aggregate scores ──
  const scored = segments.filter((s) => s.analysis !== null);
  if (scored.length === 0) {
    throw new Error("No segments could be analyzed — Gemini may be unavailable");
  }

  // Dimension averages
  const dimAverages: Record<string, number> = {};
  for (const dim of DIMENSION_KEYS) {
    const scores = scored.map((s) => s.analysis![dim].score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    dimAverages[DIMENSION_LABELS[dim]] = Math.round(avg * 10) / 10;
  }

  const overallPct =
    scored.reduce((s, r) => s + r.analysis!.percentage, 0) / scored.length;
  const overallRounded = Math.round(overallPct * 10) / 10;

  const belowThreshold = scored.filter(
    (s) => s.analysis!.percentage < threshold
  );

  // ── Step 5: Generate fixes ──
  const fixes = generateFixes(segments);

  // ── Step 6: Print report ──
  console.log("\n  ════════════════════════════════════════════════════════════");
  console.log("  DIMENSION SCORES (average):\n");
  for (const dim of DIMENSION_KEYS) {
    const avg = dimAverages[DIMENSION_LABELS[dim]];
    const bar = "█".repeat(Math.round(avg)) + "░".repeat(10 - Math.round(avg));
    const icon = avg >= 9.5 ? "✓" : avg >= 8 ? "⚠" : "✗";
    console.log(`    ${icon} ${DIMENSION_LABELS[dim].padEnd(22)} ${bar} ${avg.toFixed(1)}/10`);
  }

  console.log("\n  PER-SEGMENT:");
  for (const s of scored) {
    const icon = s.analysis!.percentage >= threshold ? "✓" : "⚠";
    console.log(`    ${icon} ${s.id} [${s.layoutId}]: ${s.analysis!.percentage}%`);
  }

  if (fixes.length > 0) {
    console.log("\n  FIXES NEEDED:");
    for (const f of fixes.slice(0, 8)) {
      const icon = f.priority === "critical" ? "🔴" : f.priority === "high" ? "🟠" : "🟡";
      console.log(`    ${icon} [${f.priority}] ${f.segmentId} — ${f.dimension}: ${f.issue}`);
      console.log(`       Fix: ${f.suggestedFix.substring(0, 120)}`);
    }
  }

  console.log("\n  ╔══════════════════════════════════════════════════════════╗");
  if (overallRounded >= threshold) {
    console.log(`  ║  RESULT: PASS ✓  (${overallRounded}% >= ${threshold}%)`.padEnd(59) + "║");
  } else {
    console.log(`  ║  RESULT: FAIL ✗  (${overallRounded}% < ${threshold}%)`.padEnd(59) + "║");
  }
  console.log(`  ║  Segments: ${scored.length} analyzed, ${belowThreshold.length} below threshold`.padEnd(59) + "║");
  console.log("  ╚══════════════════════════════════════════════════════════╝\n");

  // ── Save report ──
  const report: VerificationReport = {
    timestamp: new Date().toISOString(),
    referenceVideo: path.basename(referenceVideoPath),
    renderedVideo: path.basename(renderedVideoPath),
    threshold,
    overallMatch: overallRounded,
    passed: overallRounded >= threshold,
    segmentsAnalyzed: scored.length,
    segmentsBelowThreshold: belowThreshold.length,
    dimensionAverages: dimAverages,
    segments,
    fixes,
  };

  const reportPath = path.join(outputDir, "verification-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  Report: ${reportPath}`);
  console.log(`  Side-by-side frames: ${outputDir}`);

  return report;
}
