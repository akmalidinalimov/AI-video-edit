/**
 * CV Adjustment — Deterministic Template Correction from Verification Deltas
 *
 * Takes a CvVerificationReport and adjusts the template + plan coordinates
 * to compensate for measured deltas. The adjustments are pure arithmetic:
 *
 *   output_cx was 745, reference was 770 → shift template cx by +25px
 *   output_radius was 200, reference was 215 → grow template radius by +15px
 *
 * This is the "adjuster" in the closed-loop:
 *   render → cv-verify → cv-adjust → re-render → cv-verify (max 3 iterations)
 *
 * Because the adjustments are deterministic (not LLM-generated), convergence
 * is typically achieved in 1-2 iterations. The only reason it might need >1
 * is that changing the circle size slightly shifts where the Hough detector
 * finds the peak.
 */

import type { VCSTemplate, LayoutVariant } from "./vcs-templates";
import type { EditingPlan } from "./editing-plan";
import type { CvVerificationReport, SegmentVerification, MetricDelta } from "./cv-verifier";

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface AdjustmentAction {
  segmentId: string;
  layoutId: string;
  metric: string;
  currentValue: number;
  targetValue: number;
  adjustment: number;
  description: string;
}

export interface AdjustmentResult {
  /** Whether any adjustments were made */
  adjusted: boolean;
  /** List of adjustments applied */
  actions: AdjustmentAction[];
  /** The modified template (deep-cloned, original not mutated) */
  adjustedTemplate: VCSTemplate;
  /** Human-readable summary */
  summary: string;
}

// ════════════════════════════════════════════════════════════
// MAIN ADJUSTMENT FUNCTION
// ════════════════════════════════════════════════════════════

/**
 * Compute and apply deterministic adjustments to a template based on
 * CV verification deltas.
 *
 * The adjustment logic is simple: if the output circle is 25px too far
 * left, shift the template's circle 25px to the right. The renderer
 * faithfully reproduces template coordinates, so this compensates
 * exactly for any systematic offset.
 *
 * @param report  The CV verification report with per-segment deltas
 * @param template  The original template (NOT mutated — a deep clone is returned)
 * @param dampingFactor  Fraction of delta to apply (default 1.0 = full correction).
 *                       Use 0.8 if overcorrection oscillation is observed.
 * @returns AdjustmentResult with the modified template and list of changes
 */
export function computeAdjustments(
  report: CvVerificationReport,
  template: VCSTemplate,
  dampingFactor = 1.0
): AdjustmentResult {
  // Deep clone to avoid mutating the original
  const adjusted: VCSTemplate = JSON.parse(JSON.stringify(template));
  const actions: AdjustmentAction[] = [];

  for (const seg of report.segments) {
    if (seg.passed) continue; // No adjustment needed
    if (!seg.detected) continue; // Can't adjust what we can't measure

    const layout = adjusted.layouts[seg.layoutId];
    if (!layout) continue;

    for (const metric of seg.metrics) {
      if (metric.passed) continue; // This metric is fine

      // The adjustment is the NEGATIVE of the delta:
      // If output was 25px too far right (delta = +25), we need to
      // shift the template 25px to the LEFT (adjustment = -25)
      const rawAdj = -metric.delta;
      const adj = Math.round(rawAdj * dampingFactor);

      if (Math.abs(adj) < 1) continue; // Sub-pixel, skip

      switch (metric.metric) {
        case "circle_cx": {
          if (!layout.aroll.circle) break;
          const oldCx = layout.aroll.circle.cx;
          layout.aroll.circle.cx += adj;
          layout.aroll.region.x += adj;
          actions.push({
            segmentId: seg.segmentId,
            layoutId: seg.layoutId,
            metric: "circle_cx",
            currentValue: oldCx,
            targetValue: oldCx + adj,
            adjustment: adj,
            description: `Shift circle cx ${adj > 0 ? "right" : "left"} by ${Math.abs(adj)}px`,
          });
          break;
        }
        case "circle_cy": {
          if (!layout.aroll.circle) break;
          const oldCy = layout.aroll.circle.cy;
          layout.aroll.circle.cy += adj;
          layout.aroll.region.y += adj;
          actions.push({
            segmentId: seg.segmentId,
            layoutId: seg.layoutId,
            metric: "circle_cy",
            currentValue: oldCy,
            targetValue: oldCy + adj,
            adjustment: adj,
            description: `Shift circle cy ${adj > 0 ? "down" : "up"} by ${Math.abs(adj)}px`,
          });
          break;
        }
        case "circle_radius": {
          if (!layout.aroll.circle) break;
          const oldR = layout.aroll.circle.radius;
          const newR = oldR + adj;
          if (newR < 50) break; // Sanity: don't shrink to nothing

          layout.aroll.circle.radius = newR;
          // Adjust region to match new radius
          const cx = layout.aroll.circle.cx;
          const cy = layout.aroll.circle.cy;
          layout.aroll.region = {
            x: cx - newR,
            y: cy - newR,
            width: newR * 2,
            height: newR * 2,
          };
          actions.push({
            segmentId: seg.segmentId,
            layoutId: seg.layoutId,
            metric: "circle_radius",
            currentValue: oldR,
            targetValue: newR,
            adjustment: adj,
            description: `${adj > 0 ? "Grow" : "Shrink"} circle radius by ${Math.abs(adj)}px`,
          });
          break;
        }
        case "rect_top": {
          const oldY = layout.aroll.region.y;
          layout.aroll.region.y += adj;
          actions.push({
            segmentId: seg.segmentId,
            layoutId: seg.layoutId,
            metric: "rect_top",
            currentValue: oldY,
            targetValue: oldY + adj,
            adjustment: adj,
            description: `Shift rect top ${adj > 0 ? "down" : "up"} by ${Math.abs(adj)}px`,
          });
          break;
        }
        case "rect_height": {
          const oldH = layout.aroll.region.height;
          const newH = oldH + adj;
          if (newH < 100) break; // Sanity
          layout.aroll.region.height = newH;
          actions.push({
            segmentId: seg.segmentId,
            layoutId: seg.layoutId,
            metric: "rect_height",
            currentValue: oldH,
            targetValue: newH,
            adjustment: adj,
            description: `${adj > 0 ? "Increase" : "Decrease"} rect height by ${Math.abs(adj)}px`,
          });
          break;
        }
      }
    }
  }

  // Summary
  const summary = actions.length === 0
    ? "No adjustments needed — all metrics within tolerance"
    : `Applied ${actions.length} adjustment(s): ${actions.map((a) => a.description).join("; ")}`;

  console.log(`\n  CV ADJUSTMENTS: ${summary}`);
  for (const a of actions) {
    console.log(`    ${a.segmentId} [${a.layoutId}]: ${a.description}`);
  }

  return {
    adjusted: actions.length > 0,
    actions,
    adjustedTemplate: adjusted,
    summary,
  };
}

/**
 * Run the full closed-loop: verify → adjust → re-render → verify
 *
 * This is the orchestrator that ties cv-verifier and cv-adjustment together.
 * Callers provide a render function; this module handles the iteration logic.
 *
 * @param maxIterations  Maximum correction iterations (default 3)
 * @param renderFn  Callback that renders the video with the given template.
 *                  Must return the path to the rendered video.
 * @param verifyFn  Callback that runs CV verification.
 *                  Must return a CvVerificationReport.
 * @param template  The initial template to start with.
 * @returns The final template (adjusted or original) and the last report
 */
export async function closedLoopVerify(input: {
  maxIterations?: number;
  template: VCSTemplate;
  dampingFactor?: number;
  renderFn: (template: VCSTemplate, iteration: number) => Promise<string>;
  verifyFn: (renderedVideoPath: string, template: VCSTemplate) => Promise<CvVerificationReport>;
}): Promise<{
  finalTemplate: VCSTemplate;
  finalReport: CvVerificationReport;
  iterations: number;
  converged: boolean;
}> {
  const maxIter = input.maxIterations ?? 3;
  const damping = input.dampingFactor ?? 1.0;
  let currentTemplate = input.template;

  for (let iter = 0; iter < maxIter; iter++) {
    console.log(`\n  ╔═══════════════════════════════════════════╗`);
    console.log(`  ║  CLOSED-LOOP ITERATION ${iter + 1}/${maxIter}`.padEnd(46) + "║");
    console.log(`  ╚═══════════════════════════════════════════╝`);

    // Step 1: Render
    console.log(`\n  [${iter + 1}a] Rendering with ${iter === 0 ? "initial" : "adjusted"} template...`);
    const videoPath = await input.renderFn(currentTemplate, iter);

    // Step 2: Verify
    console.log(`\n  [${iter + 1}b] CV verification...`);
    const report = await input.verifyFn(videoPath, currentTemplate);

    if (report.passed) {
      console.log(`\n  ✓ CONVERGED after ${iter + 1} iteration(s) — all metrics within tolerance`);
      return {
        finalTemplate: currentTemplate,
        finalReport: report,
        iterations: iter + 1,
        converged: true,
      };
    }

    // Step 3: Adjust
    if (iter < maxIter - 1) {
      console.log(`\n  [${iter + 1}c] Computing adjustments...`);
      // Use decreasing damping on later iterations to avoid oscillation
      const iterDamping = damping * (1 - iter * 0.15);
      const adjustment = computeAdjustments(report, currentTemplate, iterDamping);

      if (!adjustment.adjusted) {
        console.log(`\n  ⚠ No adjustments possible — stopping loop`);
        return {
          finalTemplate: currentTemplate,
          finalReport: report,
          iterations: iter + 1,
          converged: false,
        };
      }

      currentTemplate = adjustment.adjustedTemplate;
    } else {
      console.log(`\n  ⚠ Max iterations reached — returning best result`);
      return {
        finalTemplate: currentTemplate,
        finalReport: report,
        iterations: iter + 1,
        converged: false,
      };
    }
  }

  // Should not reach here, but TypeScript requires it
  throw new Error("Unreachable");
}
