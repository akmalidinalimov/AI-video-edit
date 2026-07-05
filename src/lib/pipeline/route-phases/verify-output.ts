/**
 * Phase: VERIFY OUTPUT (Wave 0.5 decomposition — moved verbatim from
 * src/app/api/clone-style/route.ts; no behavior change).
 *
 * Covers: verifyRender (closed-loop structural verification, best-effort) +
 * the SSE complete event assembly.
 */

import path from "path";
import fs from "fs";

import { verifyRender } from "@/lib/pipeline/render-verifier";
import { FileSceneKB } from "@/lib/knowledge/scene-kb";
import { queueNovelProposal } from "@/lib/knowledge/scene-kb-route";

import type { PipelineCtx, SSEEvent } from "./types";

export async function verifyOutput(ctx: PipelineCtx): Promise<void> {
  const { refPath, exportsDir, skipVerification, sendSSE, styleProfile2 } = ctx;
  const editingPlan = ctx.editingPlan!;
  const dynamicTemplate = ctx.dynamicTemplate!;
  const outputFilename = ctx.outputFilename!;
  const outputPath = ctx.outputPath!;

  // ════════════════════════════════════════════
  // PHASE 5: Closed-Loop Verification (best-effort)
  // ════════════════════════════════════════════
  // Compare the render against the reference (Gemini Vision, 6 structural
  // dimensions) and surface a style-match score on the complete event.
  // Non-blocking: a verification failure just omits the badge.
  let verification: SSEEvent["verification"];
  if (!skipVerification) {
    try {
      sendSSE({ phase: "verifying", progress: 96, message: "Verifying style match..." });
      const report = await verifyRender({
        referenceVideoPath: refPath,
        renderedVideoPath: outputPath,
        editingPlan,
        template: dynamicTemplate,
        threshold: 95,
        outputDir: path.join(exportsDir, "verification"),
      });
      verification = {
        overall: report.overallMatch,
        passed: report.passed,
        segmentsAnalyzed: report.segmentsAnalyzed,
        dimensions: report.dimensionAverages,
      };
      console.log(`[clone-style] Verification: ${report.overallMatch}% (${report.passed ? "PASS" : "FAIL"})`);

      // ── scene-KB learning (spec §2 [5], §4): score-gated exemplar admission.
      // Guard: only when scene matches exist AND the closed-loop score is ≥ 95.
      // (verification.overall is the whole-video closed-loop score; a ≥95 whole-video
      // pass bounds every stable-structure window — the windowed score refinement per
      // scene comes from compareWindowedStyle when an output decode exists.)
      if (ctx.sceneMatches?.length && verification.overall >= 95) {
        try {
          const kb = new FileSceneKB();
          const kbDir = path.join(process.cwd(), ".knowledge", "scene-kb");
          const queuePath = path.join(kbDir, "review-queue.json");

          for (const { scene, match } of ctx.sceneMatches) {
            // Novel scenes: queue for human review (spec §4 learning gates)
            if (match.kind === "novel") {
              try {
                queueNovelProposal(kb, scene, queuePath);
                console.log(
                  `[scene-kb] novel scene queued for review: ${scene.layoutClass} ` +
                    `${scene.window.t0}-${scene.window.t1}s`
                );
              } catch (err) {
                console.error("[scene-kb] Failed to queue novel proposal (non-blocking):", err);
              }
            }

            // Known/family_new: learn exemplar (score-gated)
            const res = kb.learnExemplar({
              scene,
              closedLoopScore: verification.overall,
              cvVlmAgree: ctx.sceneCvVlmAgree ?? false,
              sourceFile: path.basename(refPath),
              renderParams: ctx.nregionPlan
                ? { targetShotSec: ctx.nregionPlan.targetShotSec }
                : undefined,
            });
            console.log(
              `[clone-style] Scene KB learn ${scene.window.t0}-${scene.window.t1}s: ` +
                `${res.learned ? `ADMITTED ${res.exemplarId}` : `skipped (${res.reason})`}`
            );
          }
          console.log(`[clone-style] Scene KB coverage: ${JSON.stringify(kb.coverageReport().perFamily)}`);
        } catch (err) {
          console.error("[clone-style] scene-KB learn failed (non-blocking):", err);
        }
      } else if (ctx.sceneMatches?.length) {
        console.log(`[clone-style] Scene KB learn: gated OFF (score ${verification.overall} < 95).`);
      }
    } catch (err) {
      console.error("[clone-style] Verification failed (non-blocking):", err);
    }
  }

  // ════════════════════════════════════════════
  // COMPLETE
  // ════════════════════════════════════════════
  const stats = fs.statSync(outputPath);
  sendSSE({
    phase: "complete",
    progress: 100,
    downloadUrl: `/exports/${outputFilename}`,
    message: verification
      ? `Done! ${(stats.size / 1024 / 1024).toFixed(1)}MB · ${verification.overall}% style match`
      : `Done! ${(stats.size / 1024 / 1024).toFixed(1)}MB rendered`,
    verification,
    // B1 shadow: the decoded content-free StyleProfile 2.0 (validation surface; not driving the render yet)
    styleProfile: styleProfile2 ?? undefined,
  });
}
