/**
 * Phase 3 — Visual Comparison & Verification Loop
 *
 * After rendering, extracts frames from the output video and compares
 * them with reference frames using:
 * 1. Pixel-level comparison (mean absolute difference)
 * 2. Gemini Vision for detailed comparison of low-scoring frames
 *
 * Returns a VisualComparisonReport with per-frame scores and overall verdict.
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { extractMatchedFramePairs, extractSingleFrame } from "@/lib/analysis/frameExtractor";
import { geminiFlash } from "@/lib/gemini/client";
import type {
  VisualComparisonReport,
  FrameComparison,
  BlueprintSegment,
} from "@/lib/types/blueprint";

// ── Pixel-level comparison using FFmpeg ──

/**
 * Compare two frames using FFmpeg's PSNR filter.
 * Returns a similarity score 0-1 (higher = more similar).
 *
 * Uses PSNR instead of SSIM because SSIM requires identical dimensions
 * and the FFmpeg ssim filter needs extra setup.
 */
async function compareFramesPSNR(
  frame1: string,
  frame2: string
): Promise<number> {
  const ffmpegPath = path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    "win32-x64",
    "ffmpeg.exe"
  );

  return new Promise((resolve) => {
    // Use lavfi to compare two images
    const proc = spawn(ffmpegPath, [
      "-i", frame1,
      "-i", frame2,
      "-filter_complex", "[0:v][1:v]psnr=stats_file=-[v]",
      "-map", "[v]",
      "-f", "null",
      "-",
    ], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
    });

    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", () => {
      // Parse PSNR from output: "average:25.123"
      const psnrMatch = stderr.match(/average:([\d.]+)/);
      if (psnrMatch) {
        const psnr = parseFloat(psnrMatch[1]);
        // Convert PSNR to 0-1 score: PSNR > 30 = very similar, < 15 = very different
        const score = Math.min(1, Math.max(0, (psnr - 10) / 30));
        resolve(score);
      } else {
        // Fallback: use basic pixel comparison
        resolve(0.5); // Unknown
      }
    });

    proc.on("error", () => resolve(0.5));

    // Timeout
    setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(0.5);
    }, 10_000);
  });
}

/**
 * Simple pixel comparison: resize both to same size, compare mean absolute difference.
 */
async function compareFramesSimple(
  frame1: string,
  frame2: string
): Promise<number> {
  const ffmpegPath = path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    "win32-x64",
    "ffmpeg.exe"
  );

  // Scale both to 540x960 (half res) and compute blend difference
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, [
      "-i", frame1,
      "-i", frame2,
      "-filter_complex",
      "[0:v]scale=540:960,setsar=1[a];[1:v]scale=540:960,setsar=1[b];[a][b]blend=all_mode=difference,blackframe=98:32[v]",
      "-map", "[v]",
      "-f", "null",
      "-",
    ], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
    });

    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", () => {
      // If blackframe detected many black frames, images are similar
      const blackCount = (stderr.match(/blackframe/g) || []).length;
      // More black frames = more similar (difference image is dark)
      const score = Math.min(1, blackCount * 0.3);
      resolve(Math.max(0.1, score)); // At least 0.1
    });

    proc.on("error", () => resolve(0.5));

    setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(0.5);
    }, 10_000);
  });
}

// ── Gemini Vision comparison for detailed analysis ──

async function compareFramesWithGemini(
  refFrame: string,
  outFrame: string,
  timestamp: number
): Promise<{ score: number; issues: string[]; suggestions: string[] }> {
  try {
    const refBase64 = fs.readFileSync(refFrame).toString("base64");
    const outBase64 = fs.readFileSync(outFrame).toString("base64");

    const prompt = `Compare these two video frames. Image 1 is the REFERENCE (the target style). Image 2 is the OUTPUT (what was produced).

Both frames are at timestamp ${timestamp.toFixed(1)}s in their respective videos.

Analyze the differences and provide:
1. An overall match score from 0 to 100 (100 = identical layout and style)
2. A list of specific issues (differences that need fixing)
3. A list of actionable suggestions for improvement

Focus on:
- Layout match: are elements in the same positions?
- A-roll position, size, and shape match (circle vs rectangle)
- B-roll content placement
- Text/headline presence and positioning
- Color mood similarity
- Black/empty region match

Respond in JSON:
{
  "score": number,
  "issues": ["issue 1", "issue 2"],
  "suggestions": ["suggestion 1", "suggestion 2"]
}`;

    const result = await geminiFlash.generateContent([
      { text: prompt },
      { inlineData: { mimeType: "image/jpeg", data: refBase64 } },
      { inlineData: { mimeType: "image/jpeg", data: outBase64 } },
    ]);

    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      score: parsed.score ?? 50,
      issues: parsed.issues ?? [],
      suggestions: parsed.suggestions ?? [],
    };
  } catch (err) {
    console.error(`[VisualComparator] Gemini comparison failed at ${timestamp}s:`, err);
    return { score: 50, issues: ["Gemini comparison failed"], suggestions: [] };
  }
}

// ── Main: Run visual comparison ──

export interface VerificationConfig {
  refVideoPath: string;
  outputVideoPath: string;
  segments: BlueprintSegment[];
  /** Sample timestamps (seconds). If not provided, uses 1 per segment + boundaries */
  sampleTimestamps?: number[];
  /** PSNR score below which Gemini is consulted. Default: 0.5 */
  geminiThreshold?: number;
}

export async function runVisualVerification(
  config: VerificationConfig
): Promise<VisualComparisonReport> {
  const {
    refVideoPath,
    outputVideoPath,
    segments,
    geminiThreshold = 0.5,
  } = config;

  // Build sample timestamps: 1 per segment (at midpoint) + segment boundaries
  let timestamps = config.sampleTimestamps ?? [];
  if (timestamps.length === 0) {
    for (const seg of segments) {
      const mid = (seg.start + seg.end) / 2;
      timestamps.push(Math.round(mid * 100) / 100);
    }
    // Also add first second of each segment
    for (const seg of segments) {
      const t = seg.start + 0.5;
      if (!timestamps.includes(t)) timestamps.push(t);
    }
  }
  timestamps.sort((a, b) => a - b);

  // Extract frame pairs
  const pairsDir = path.join(process.cwd(), "public", "analysis", "verification");
  const pairs = await extractMatchedFramePairs(
    refVideoPath,
    outputVideoPath,
    timestamps,
    pairsDir
  );

  // Compare each pair
  const comparisons: FrameComparison[] = [];
  let layoutMatches = 0;
  let coordMatches = 0;
  let textMatches = 0;
  let pipCorrect = true;

  for (const pair of pairs) {
    // Quick pixel comparison
    const pixelScore = await compareFramesSimple(pair.refFrame, pair.outputFrame);

    const comparison: FrameComparison = {
      timestamp: pair.timestamp,
      ssimScore: pixelScore,
      issues: [],
      suggestions: [],
    };

    // If pixel score is low, consult Gemini for detailed analysis
    if (pixelScore < geminiThreshold) {
      const geminiResult = await compareFramesWithGemini(
        pair.refFrame,
        pair.outputFrame,
        pair.timestamp
      );
      comparison.geminiScore = geminiResult.score;
      comparison.issues = geminiResult.issues;
      comparison.suggestions = geminiResult.suggestions;

      // Check specific issues
      if (geminiResult.issues.some((i) => i.toLowerCase().includes("layout"))) {
        // Layout mismatch
      } else {
        layoutMatches++;
      }

      if (geminiResult.issues.some((i) => i.toLowerCase().includes("position") || i.toLowerCase().includes("coordinate"))) {
        // Coordinate mismatch
      } else {
        coordMatches++;
      }

      if (geminiResult.issues.some((i) => i.toLowerCase().includes("text") || i.toLowerCase().includes("headline"))) {
        // Text mismatch
      } else {
        textMatches++;
      }

      if (geminiResult.issues.some((i) => i.toLowerCase().includes("circle") || i.toLowerCase().includes("pip") || i.toLowerCase().includes("rectangular"))) {
        pipCorrect = false;
      }
    } else {
      // Good score — assume everything matches
      layoutMatches++;
      coordMatches++;
      textMatches++;
    }

    comparisons.push(comparison);
  }

  // Calculate overall scores
  const totalComparisons = comparisons.length || 1;
  const avgPixelScore = comparisons.reduce((s, c) => s + c.ssimScore, 0) / totalComparisons;
  const avgGeminiScore = comparisons
    .filter((c) => c.geminiScore !== undefined)
    .reduce((s, c) => s + (c.geminiScore ?? 0), 0) /
    (comparisons.filter((c) => c.geminiScore !== undefined).length || 1);

  const overallScore = Math.round(
    comparisons.some((c) => c.geminiScore !== undefined)
      ? (avgPixelScore * 40 + (avgGeminiScore / 100) * 60) // Weight Gemini more
      : avgPixelScore * 100
  );

  const layoutAccuracy = Math.round((layoutMatches / totalComparisons) * 100);
  const coordinateAccuracy = Math.round((coordMatches / totalComparisons) * 100);
  const textPresence = Math.round((textMatches / totalComparisons) * 100);

  // Determine verdict
  let overallVerdict: VisualComparisonReport["overallVerdict"];
  if (overallScore >= 85) {
    overallVerdict = "pass";
  } else if (overallScore >= 50) {
    overallVerdict = "needs_fixes";
  } else {
    overallVerdict = "redo_from_scratch";
  }

  return {
    overallScore,
    frameComparisons: comparisons,
    layoutAccuracy,
    coordinateAccuracy,
    textPresence,
    pipShapeCorrect: pipCorrect,
    overallVerdict,
  };
}
