/**
 * CV Verifier — Closed-Loop Structural Verification using Computer Vision
 *
 * Replaces the unreliable Gemini Vision scoring with deterministic CV
 * measurement. Runs the SAME circle/rectangle detection pipeline on the
 * rendered OUTPUT video, then compares detected coordinates numerically
 * against the reference measurements.
 *
 * WHY NOT GEMINI:
 * Gemini Vision is a language model that performs SEMANTIC comparison
 * ("both have a circle in the top-right area → 100%"). It cannot detect
 * 20px position shifts or 8% size differences. CV measurement gives
 * exact pixel coordinates — comparison is arithmetic, not subjective.
 *
 * ARCHITECTURE:
 *   1. Extract frames from rendered video at segment midpoints
 *   2. Run measureCircleFromFrame / measureArollRectangle on each
 *   3. Compare output coords vs reference coords (from cv-correction.ts)
 *   4. Return per-segment, per-metric numerical deltas
 *   5. Pass/fail per metric with configurable thresholds
 *
 * USAGE:
 *   const ref = await applyCvCorrections(...); // reference measurements
 *   const report = await cvVerify({
 *     renderedVideoPath, referenceMeasurements, editingPlan, template
 *   });
 *   if (!report.passed) {
 *     const adjusted = computeAdjustments(report);
 *     // re-render with adjusted template, then re-verify
 *   }
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

import {
  measureCircleFromFrame,
  measureArollRectangle,
} from "@/lib/analysis/coordinate-measurer";

import type { EditingPlan, LayoutRange } from "./editing-plan";
import type { VCSTemplate } from "./vcs-templates";

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface ReferenceMeasurement {
  segmentId: string;
  shape: "circle" | "rectangle";
  /** Circle measurements (only when shape=circle) */
  circle?: { cx: number; cy: number; radius: number };
  /** Rectangle measurements (only when shape=rectangle) */
  rect?: { x: number; y: number; width: number; height: number };
}

export interface MetricDelta {
  metric: string;
  reference: number;
  output: number;
  delta: number;
  absDelta: number;
  threshold: number;
  passed: boolean;
}

export interface SegmentVerification {
  segmentId: string;
  rangeId: string;
  layoutId: string;
  shape: "circle" | "rectangle";
  timestamp: number;
  timeRange: { start: number; end: number };
  /** Whether output measurement was detected at all */
  detected: boolean;
  /** Per-metric numerical deltas */
  metrics: MetricDelta[];
  /** Overall segment pass (all metrics passed) */
  passed: boolean;
  /** Human-readable summary */
  summary: string;
}

export interface CvVerificationReport {
  timestamp: string;
  renderedVideo: string;
  /** Per-segment results */
  segments: SegmentVerification[];
  /** Overall pass (all segments passed) */
  passed: boolean;
  /** Overall match percentage (0-100) — based on metric pass rate */
  overallMatch: number;
  /** Total metrics evaluated */
  totalMetrics: number;
  /** Total metrics passed */
  passedMetrics: number;
  /** Segments that failed with their worst deltas */
  failures: Array<{
    segmentId: string;
    worstMetric: string;
    delta: number;
    threshold: number;
  }>;
}

export interface CvVerifyInput {
  /** Path to the rendered output video */
  renderedVideoPath: string;
  /** Path to FFmpeg binary */
  ffmpegPath: string;
  /** Canvas dimensions */
  canvas: { width: number; height: number };
  /** Reference measurements from cv-correction.ts */
  referenceMeasurements: ReferenceMeasurement[];
  /** The editing plan used for the render */
  editingPlan: EditingPlan;
  /** The template used for the render */
  template: VCSTemplate;
  /** Source A-roll aspect ratio (width/height) */
  sourceAspect: number;
  /** Scratch directory for frame extraction */
  tmpDir: string;
  /** Thresholds (px) — defaults are tight */
  thresholds?: {
    /** Circle center position tolerance (default: 20px) */
    circlePosition?: number;
    /** Circle radius tolerance (default: 15px) */
    circleRadius?: number;
    /** Rectangle top edge tolerance (default: 25px) */
    rectTop?: number;
    /** Rectangle height tolerance (default: 30px) */
    rectHeight?: number;
  };
}

// ════════════════════════════════════════════════════════════
// FRAME EXTRACTION
// ════════════════════════════════════════════════════════════

function extractFrame(
  ffmpegPath: string,
  video: string,
  t: number,
  canvas: { width: number; height: number },
  outPath: string
): boolean {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-ss", String(t),
      "-i", video,
      "-frames:v", "1",
      "-vf", `scale=${canvas.width}:${canvas.height}`,
      outPath,
    ],
    { encoding: "utf-8" }
  );
  return r.status === 0 && fs.existsSync(outPath);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ════════════════════════════════════════════════════════════
// CIRCLE MEASUREMENT ON OUTPUT
// ════════════════════════════════════════════════════════════

/**
 * Measure circle position in the rendered output video for a given segment.
 * Samples multiple frames and takes the median — same strategy as
 * reference-measurer.ts but applied to the output.
 */
async function measureOutputCircle(
  ffmpegPath: string,
  videoPath: string,
  canvas: { width: number; height: number },
  timeRange: { start: number; end: number },
  expectedCircle: { cx: number; cy: number; radius: number },
  tmpDir: string,
  framesPerSegment = 5
): Promise<{ cx: number; cy: number; radius: number; samples: number } | null> {
  const N = framesPerSegment;
  const dur = Math.max(0.1, timeRange.end - timeRange.start);
  const a = timeRange.start + dur * 0.15;
  const b = timeRange.end - dur * 0.15;

  // Search region: generous window around expected position (±20% canvas)
  const padX = canvas.width * 0.20;
  const padY = canvas.height * 0.20;
  const centerRegion = {
    xMin: Math.max(0, expectedCircle.cx - padX),
    xMax: Math.min(canvas.width, expectedCircle.cx + padX),
    yMin: Math.max(0, expectedCircle.cy - padY),
    yMax: Math.min(canvas.height, expectedCircle.cy + padY),
  };
  // Tight radius range around expected (±20%)
  const radiusRange = {
    min: Math.max(50, Math.round(expectedCircle.radius * 0.80)),
    max: Math.round(expectedCircle.radius * 1.20),
  };

  const dets: Array<{ cx: number; cy: number; r: number }> = [];

  for (let i = 0; i < N; i++) {
    const t = a + ((b - a) * (i + 0.5)) / N;
    const fp = path.join(tmpDir, `cvout_circle_${i}.jpg`);
    if (!extractFrame(ffmpegPath, videoPath, t, canvas, fp)) continue;

    const d = await measureCircleFromFrame({
      framePath: fp,
      canvas,
      downscale: 3,
      radiusRange,
      centerRegion,
    });
    if (d) {
      dets.push({ cx: d.cx, cy: d.cy, r: d.radius });
    }
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
  }

  if (dets.length === 0) return null;

  return {
    cx: median(dets.map((d) => d.cx)),
    cy: median(dets.map((d) => d.cy)),
    radius: median(dets.map((d) => d.r)),
    samples: dets.length,
  };
}

/**
 * Measure rectangle A-roll position in the rendered output video.
 */
async function measureOutputRectangle(
  ffmpegPath: string,
  videoPath: string,
  canvas: { width: number; height: number },
  timeRange: { start: number; end: number },
  expectedRect: { x: number; y: number; width: number; height: number },
  sourceAspect: number,
  tmpDir: string,
  framesPerSegment = 3
): Promise<{ top: number; height: number } | null> {
  const N = framesPerSegment;
  const dur = Math.max(0.1, timeRange.end - timeRange.start);
  const a = timeRange.start + dur * 0.15;
  const b = timeRange.end - dur * 0.15;

  // Search region around expected position (±12% canvas height)
  const ry = canvas.height * 0.12;
  const searchFromY = Math.max(0, expectedRect.y - ry);
  const searchToY = Math.min(canvas.height, expectedRect.y + expectedRect.height + ry);

  const tops: number[] = [];
  let lastHeight = expectedRect.height;

  for (let i = 0; i < N; i++) {
    const t = a + ((b - a) * (i + 0.5)) / N;
    const fp = path.join(tmpDir, `cvout_rect_${i}.jpg`);
    if (!extractFrame(ffmpegPath, videoPath, t, canvas, fp)) continue;

    const res = await measureArollRectangle({
      framePath: fp,
      canvas,
      sourceAspect,
      searchFromY,
      searchToY,
    });
    if (res) {
      tops.push(res.top);
      lastHeight = res.height;
    }
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
  }

  if (tops.length === 0) return null;

  return {
    top: median(tops),
    height: lastHeight,
  };
}

// ════════════════════════════════════════════════════════════
// MAIN VERIFICATION
// ════════════════════════════════════════════════════════════

/**
 * CV-based verification of a rendered video against reference measurements.
 *
 * Runs the same CV detection pipeline on the OUTPUT video and compares
 * detected coordinates numerically against the reference.
 */
export async function cvVerify(input: CvVerifyInput): Promise<CvVerificationReport> {
  const {
    renderedVideoPath,
    ffmpegPath,
    canvas,
    referenceMeasurements,
    editingPlan,
    template,
    sourceAspect,
    tmpDir,
  } = input;

  const thresholds = {
    circlePosition: input.thresholds?.circlePosition ?? 20,
    circleRadius: input.thresholds?.circleRadius ?? 15,
    rectTop: input.thresholds?.rectTop ?? 25,
    rectHeight: input.thresholds?.rectHeight ?? 30,
  };

  const verifyDir = path.join(tmpDir, "cv-verify");
  fs.mkdirSync(verifyDir, { recursive: true });

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         CV VERIFICATION — Deterministic Pixel Comparison    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`  Rendered:   ${path.basename(renderedVideoPath)}`);
  console.log(`  Thresholds: circle pos ±${thresholds.circlePosition}px, r ±${thresholds.circleRadius}px`);
  console.log(`              rect top ±${thresholds.rectTop}px, height ±${thresholds.rectHeight}px`);

  // Build a map from segmentId → reference measurement
  const refMap = new Map<string, ReferenceMeasurement>();
  for (const m of referenceMeasurements) {
    refMap.set(m.segmentId, m);
  }

  // Map layout ranges to segments, matching by time overlap
  const segments: SegmentVerification[] = [];

  for (let i = 0; i < editingPlan.layoutRanges.length; i++) {
    const range = editingPlan.layoutRanges[i];
    const layout = template.layouts[range.layoutId];
    if (!layout) continue;

    const shape = layout.aroll.shape as "circle" | "rectangle";
    const segId = `seg_${i + 1}`;

    // Find the closest reference measurement for this range
    // Match by shape and time overlap with original blueprint segments
    let refMeas: ReferenceMeasurement | undefined;
    for (const [id, m] of Array.from(refMap.entries())) {
      if (m.shape === shape) {
        refMeas = m;
        // If there are multiple of the same shape, prefer the one that
        // hasn't been used yet or the closest in time
        break;
      }
    }

    // For per-segment circle layouts (circle_pip_top_right_s2, etc.),
    // try to find a reference measurement that matches the specific segment index
    if (!refMeas && shape === "circle") {
      // Try matching by layout ID suffix
      const match = range.layoutId.match(/_s(\d+)$/);
      if (match) {
        const segNum = parseInt(match[1]);
        for (const [id, m] of Array.from(refMap.entries())) {
          if (m.shape === "circle") {
            refMeas = m;
            break;
          }
        }
      }
    }

    // Use template coordinates as reference if no cv-correction measurement
    if (!refMeas) {
      if (shape === "circle" && layout.aroll.circle) {
        refMeas = {
          segmentId: segId,
          shape: "circle",
          circle: {
            cx: layout.aroll.circle.cx,
            cy: layout.aroll.circle.cy,
            radius: layout.aroll.circle.radius,
          },
        };
      } else if (shape === "rectangle") {
        refMeas = {
          segmentId: segId,
          shape: "rectangle",
          rect: { ...layout.aroll.region },
        };
      }
    }

    if (!refMeas) {
      console.log(`  ⚠ ${segId}: No reference measurement for ${shape} — skipping`);
      continue;
    }

    const mid = (range.timeRange.start + range.timeRange.end) / 2;
    const metrics: MetricDelta[] = [];
    let detected = false;

    if (shape === "circle" && refMeas.circle) {
      const ref = refMeas.circle;
      console.log(`\n  ${segId} [${range.layoutId}] — circle detection @ ${mid.toFixed(2)}s`);
      console.log(`    Reference: cx=${ref.cx}, cy=${ref.cy}, r=${ref.radius}`);

      const output = await measureOutputCircle(
        ffmpegPath, renderedVideoPath, canvas,
        range.timeRange, ref, verifyDir
      );

      if (output) {
        detected = true;
        console.log(`    Output:    cx=${output.cx}, cy=${output.cy}, r=${output.radius} (${output.samples} samples)`);

        const dCx = output.cx - ref.cx;
        const dCy = output.cy - ref.cy;
        const dR = output.radius - ref.radius;

        metrics.push({
          metric: "circle_cx",
          reference: ref.cx, output: output.cx,
          delta: dCx, absDelta: Math.abs(dCx),
          threshold: thresholds.circlePosition,
          passed: Math.abs(dCx) <= thresholds.circlePosition,
        });
        metrics.push({
          metric: "circle_cy",
          reference: ref.cy, output: output.cy,
          delta: dCy, absDelta: Math.abs(dCy),
          threshold: thresholds.circlePosition,
          passed: Math.abs(dCy) <= thresholds.circlePosition,
        });
        metrics.push({
          metric: "circle_radius",
          reference: ref.radius, output: output.radius,
          delta: dR, absDelta: Math.abs(dR),
          threshold: thresholds.circleRadius,
          passed: Math.abs(dR) <= thresholds.circleRadius,
        });

        const cxIcon = Math.abs(dCx) <= thresholds.circlePosition ? "✓" : "✗";
        const cyIcon = Math.abs(dCy) <= thresholds.circlePosition ? "✓" : "✗";
        const rIcon = Math.abs(dR) <= thresholds.circleRadius ? "✓" : "✗";
        console.log(`    Δcx=${dCx > 0 ? "+" : ""}${dCx}px ${cxIcon}  Δcy=${dCy > 0 ? "+" : ""}${dCy}px ${cyIcon}  Δr=${dR > 0 ? "+" : ""}${dR}px ${rIcon}`);
      } else {
        console.log(`    Output:    ✗ NOT DETECTED`);
      }
    } else if (shape === "rectangle" && refMeas.rect) {
      const ref = refMeas.rect;
      console.log(`\n  ${segId} [${range.layoutId}] — rectangle detection @ ${mid.toFixed(2)}s`);
      console.log(`    Reference: top=${ref.y}, height=${ref.height}`);

      const output = await measureOutputRectangle(
        ffmpegPath, renderedVideoPath, canvas,
        range.timeRange, ref, sourceAspect, verifyDir
      );

      if (output) {
        detected = true;
        console.log(`    Output:    top=${output.top}, height=${output.height}`);

        const dTop = output.top - ref.y;
        const dHeight = output.height - ref.height;

        metrics.push({
          metric: "rect_top",
          reference: ref.y, output: output.top,
          delta: dTop, absDelta: Math.abs(dTop),
          threshold: thresholds.rectTop,
          passed: Math.abs(dTop) <= thresholds.rectTop,
        });
        metrics.push({
          metric: "rect_height",
          reference: ref.height, output: output.height,
          delta: dHeight, absDelta: Math.abs(dHeight),
          threshold: thresholds.rectHeight,
          passed: Math.abs(dHeight) <= thresholds.rectHeight,
        });

        const topIcon = Math.abs(dTop) <= thresholds.rectTop ? "✓" : "✗";
        const hIcon = Math.abs(dHeight) <= thresholds.rectHeight ? "✓" : "✗";
        console.log(`    Δtop=${dTop > 0 ? "+" : ""}${dTop}px ${topIcon}  Δheight=${dHeight > 0 ? "+" : ""}${dHeight}px ${hIcon}`);
      } else {
        console.log(`    Output:    ✗ NOT DETECTED`);
      }
    }

    const allPassed = detected && metrics.every((m) => m.passed);
    const summary = !detected
      ? `${shape} not detected in output`
      : allPassed
        ? `All metrics within tolerance`
        : `Failed: ${metrics.filter((m) => !m.passed).map((m) => `${m.metric} off by ${m.delta > 0 ? "+" : ""}${m.delta}px`).join(", ")}`;

    segments.push({
      segmentId: segId,
      rangeId: range.id,
      layoutId: range.layoutId,
      shape,
      timestamp: mid,
      timeRange: range.timeRange,
      detected,
      metrics,
      passed: allPassed,
      summary,
    });
  }

  // ── Aggregate ──
  const totalMetrics = segments.reduce((s, seg) => s + seg.metrics.length, 0);
  const passedMetrics = segments.reduce((s, seg) => s + seg.metrics.filter((m) => m.passed).length, 0);
  const overallMatch = totalMetrics > 0 ? Math.round((passedMetrics / totalMetrics) * 100 * 10) / 10 : 0;
  const allPassed = segments.every((s) => s.passed);

  const failures = segments
    .filter((s) => !s.passed)
    .map((s) => {
      const worst = s.metrics
        .filter((m) => !m.passed)
        .sort((a, b) => b.absDelta - a.absDelta)[0];
      return {
        segmentId: s.segmentId,
        worstMetric: worst?.metric ?? "undetected",
        delta: worst?.delta ?? 999,
        threshold: worst?.threshold ?? 0,
      };
    });

  // ── Report ──
  console.log("\n  ════════════════════════════════════════════════════════════");
  console.log("  CV VERIFICATION RESULTS:\n");
  for (const seg of segments) {
    const icon = seg.passed ? "✓" : "✗";
    console.log(`    ${icon} ${seg.segmentId} [${seg.layoutId}]: ${seg.summary}`);
  }
  console.log(`\n  Metrics: ${passedMetrics}/${totalMetrics} passed (${overallMatch}%)`);
  console.log(`  Result: ${allPassed ? "PASS ✓" : "FAIL ✗"}`);

  if (failures.length > 0) {
    console.log("\n  FAILURES:");
    for (const f of failures) {
      console.log(`    ${f.segmentId}: ${f.worstMetric} off by ${f.delta > 0 ? "+" : ""}${f.delta}px (threshold: ±${f.threshold}px)`);
    }
  }
  console.log("  ════════════════════════════════════════════════════════════\n");

  const report: CvVerificationReport = {
    timestamp: new Date().toISOString(),
    renderedVideo: path.basename(renderedVideoPath),
    segments,
    passed: allPassed,
    overallMatch,
    totalMetrics,
    passedMetrics,
    failures,
  };

  // Save report
  const reportPath = path.join(tmpDir, "cv-verification-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  Report saved: ${reportPath}`);

  return report;
}
