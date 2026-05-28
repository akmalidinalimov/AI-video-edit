/**
 * Closed-Loop Verification Runner
 *
 * Runs the verify → fix → verify cycle until the timeline
 * reaches 95% match with the reference or max iterations.
 *
 * After convergence, saves lessons learned for future edits.
 */

import type { StyleProfile } from "@/lib/types/styleProfile";
import type { TimelineDefinition } from "@/lib/types/timeline";
import type { ARollClipAnalysis, BRollCatalogEntry } from "@/lib/types/project";
import { verifyTimeline, type VerificationReport } from "./verifier";
import { autoFixTimeline, type FixResult } from "./autoFixer";

const TARGET_SCORE = 95;
const MAX_ITERATIONS = 5;

export interface VerificationLoopResult {
  /** The final (possibly fixed) timeline */
  timeline: TimelineDefinition;
  /** Score history across iterations */
  scoreHistory: number[];
  /** All verification reports */
  reports: VerificationReport[];
  /** All fixes applied across iterations */
  allFixesApplied: string[];
  /** Final score */
  finalScore: number;
  /** Whether threshold was reached */
  passed: boolean;
  /** Total iterations run */
  iterations: number;
  /** Lessons learned for knowledge base */
  lessons: VerificationLesson[];
}

export interface VerificationLesson {
  category: string;
  description: string;
  fixApplied: string;
  scoreImprovement: number;
  tags: string[];
}

/**
 * Run the closed-loop verification cycle.
 */
export function runVerificationLoop(
  initialTimeline: TimelineDefinition,
  style: StyleProfile,
  clips: ARollClipAnalysis[],
  brollCatalog: BRollCatalogEntry[]
): VerificationLoopResult {
  let currentTimeline = initialTimeline;
  const scoreHistory: number[] = [];
  const reports: VerificationReport[] = [];
  const allFixes: string[] = [];
  const lessons: VerificationLesson[] = [];

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    // Step 1: Verify
    const report = verifyTimeline(currentTimeline, style, clips, brollCatalog, iter);
    reports.push(report);
    scoreHistory.push(report.totalScore);

    console.log(
      `[Verification Loop] Iteration ${iter}: Score ${report.totalScore}/100` +
      ` (${report.issues.length} issues, ${report.autoFixableCount} fixable)`
    );

    // Extract lessons from score improvements (do this BEFORE break check)
    if (scoreHistory.length >= 2) {
      const prevScore = scoreHistory[scoreHistory.length - 2];
      const improvement = report.totalScore - prevScore;

      if (improvement > 0) {
        for (const issue of reports[reports.length - 2]?.issues.filter((i) => i.autoFixable) ?? []) {
          lessons.push({
            category: issue.category,
            description: issue.description,
            fixApplied: issue.fixKey ?? "unknown",
            scoreImprovement: improvement / Math.max(report.autoFixableCount, 1),
            tags: [issue.category, issue.severity, issue.fixKey ?? ""].filter(Boolean),
          });
        }
      }
    }

    // Step 2: Check if we pass
    if (report.passesThreshold) {
      console.log(`[Verification Loop] ✅ Passed threshold at ${report.totalScore}%`);
      break;
    }

    // Step 3: Auto-fix
    if (report.autoFixableCount === 0) {
      console.log(`[Verification Loop] No auto-fixable issues remaining. Score: ${report.totalScore}`);
      break;
    }

    const fixResult = autoFixTimeline(currentTimeline, report, style, brollCatalog);
    currentTimeline = fixResult.timeline;
    allFixes.push(...fixResult.fixesApplied);

    // Log fixes
    for (const fix of fixResult.fixesApplied) {
      console.log(`[Verification Loop] 🔧 ${fix}`);
    }
    for (const fail of fixResult.fixesFailed) {
      console.log(`[Verification Loop] ⚠️ ${fail}`);
    }

    // Note: Lesson extraction happens at the TOP of the next iteration,
    // where we can accurately measure the score improvement from these fixes.
  }

  // Final verification after all fixes
  const finalReport = reports[reports.length - 1];
  const finalScore = finalReport.totalScore;

  // Re-verify if we applied fixes after the last report
  let actualFinalScore = finalScore;
  if (allFixes.length > 0 && !finalReport.passesThreshold) {
    const recheck = verifyTimeline(
      currentTimeline, style, clips, brollCatalog, reports.length + 1
    );
    reports.push(recheck);
    scoreHistory.push(recheck.totalScore);
    actualFinalScore = recheck.totalScore;

    // Capture lessons from this final improvement
    const improvement = recheck.totalScore - finalScore;
    if (improvement > 0) {
      for (const issue of finalReport.issues.filter((i) => i.autoFixable)) {
        lessons.push({
          category: issue.category,
          description: issue.description,
          fixApplied: issue.fixKey ?? "unknown",
          scoreImprovement: improvement / Math.max(finalReport.autoFixableCount, 1),
          tags: [issue.category, issue.severity, issue.fixKey ?? ""].filter(Boolean),
        });
      }
    }
  }

  // If we applied fixes but captured no lessons (e.g. no measurable improvement),
  // still learn from the critical/major issues found in iteration 1
  if (lessons.length === 0 && allFixes.length > 0 && reports.length > 0) {
    const firstReport = reports[0];
    for (const issue of firstReport.issues.filter((i) => i.severity !== "minor")) {
      lessons.push({
        category: issue.category,
        description: issue.description,
        fixApplied: issue.fixKey ?? "unknown",
        scoreImprovement: 0,
        tags: [issue.category, issue.severity, issue.fixKey ?? "", "baseline"].filter(Boolean),
      });
    }
  }

  // Deduplicate lessons — merge identical (category + fixApplied) into one with summed improvement
  const deduped = new Map<string, VerificationLesson>();
  for (const lesson of lessons) {
    const key = `${lesson.category}::${lesson.fixApplied}::${lesson.description}`;
    const existing = deduped.get(key);
    if (existing) {
      existing.scoreImprovement = Math.max(existing.scoreImprovement, lesson.scoreImprovement);
    } else {
      deduped.set(key, { ...lesson });
    }
  }

  return {
    timeline: currentTimeline,
    scoreHistory,
    reports,
    allFixesApplied: allFixes,
    finalScore: actualFinalScore,
    passed: actualFinalScore >= TARGET_SCORE,
    iterations: scoreHistory.length,
    lessons: Array.from(deduped.values()),
  };
}
