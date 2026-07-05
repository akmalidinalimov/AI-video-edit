/**
 * Phase: ANALYZE REFERENCE (Wave 0.5 decomposition — moved verbatim from
 * src/app/api/clone-style/route.ts; no behavior change).
 *
 * Covers: blueprint (Gemini consolidated + frame extraction + screenshot
 * coords + material analyzers + assembleBlueprint + caching), CV correction,
 * face-anchored A-roll bands, StyleProfile2 shadow emit, layoutMap build,
 * Layout Analyzer + archetype + semantics + buildReferenceDecode + auto-learn
 * guard, cadence source selection.
 */

import path from "path";
import fs from "fs";

// Analysis pipeline
import { extractFullAnalysis, getVideoMetadata } from "@/lib/analysis/frameExtractor";
import { extractAllCoordinates, assignSegmentIds } from "@/lib/analysis/screenshotAnalyzer";
import { analyzeARollMaterial, analyzeBRollMaterial } from "@/lib/analysis/materialAnalyzer";
import { assembleBlueprint } from "@/lib/analysis/crossValidator";
import { withCache, setCache, getCached } from "@/lib/analysis/analysisCache";

// Gemini
import { geminiFlash, geminiPro, geminiFallback } from "@/lib/gemini/client";
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";
import { REFERENCE_CONSOLIDATED_PROMPT } from "@/lib/gemini/prompts/referenceConsolidated";

// Pipeline modules
import { analyzeLayout, layoutAnalyzerAvailable, type LayoutAnalysis, type LayoutSemantics } from "@/lib/analysis/layout-analyzer";
import { analyzeLayoutSemantics } from "@/lib/analysis/layout-semantics";
import { analyzeLayoutRegions, type RegionLayout } from "@/lib/analysis/layout-regions";
import { matchArchetype, recordConfirmation } from "@/lib/analysis/layout-archetypes";
import {
  buildReferenceDecode, buildDecodedRegions, unifyLayoutClass, classesAgree,
  type ReferenceDecode,
} from "@/lib/analysis/reference-decode";
import { computeFileHash } from "@/lib/analysis/analysisCache";
import { FileSceneKB } from "@/lib/knowledge/scene-kb";
import { buildSceneMatches } from "@/lib/knowledge/scene-kb-route";
import { applyCvCorrections } from "@/lib/pipeline/cv-correction";
import { detectReferenceArollBands } from "@/lib/pipeline/reference-aroll-cv";
import { buildLayoutMap } from "@/lib/pipeline/layout-map";
// B1: unified StyleProfile 2.0 (shadow emit; docs/B1-SCHEMA-RECONCILIATION.md)
import { fromVisualBlueprint } from "@/lib/style-profile/adapters";

// Types
import type {
  FrameExtractionResult,
  VideoAnalysisResult,
  VisualBlueprint,
} from "@/lib/types/blueprint";

import type { PipelineCtx } from "./types";
import { getFFmpegPath, withRetry } from "./utils";

export async function analyzeReference(ctx: PipelineCtx): Promise<void> {
  const { refPath, arollPath, brollPaths, tempDir, sendSSE } = ctx;

  // ════════════════════════════════════════════
  // PHASE 1: Blueprint Analysis
  // ════════════════════════════════════════════
  sendSSE({ phase: "analyzing_reference", progress: 10, message: "Extracting frames from reference..." });

  // Check for cached blueprint first
  let blueprint = getCached<VisualBlueprint>(refPath, "visual_blueprint");

  if (!blueprint) {
    // Step 1.1: Frame extraction
    const refExtraction = await withCache<FrameExtractionResult>(
      refPath,
      "frame_extraction",
      () => extractFullAnalysis(refPath, {
        category: "ref",
        intervalSeconds: 0.5,
        sceneThreshold: 0.3,
        detectSilenceRegions: true,
      })
    );

    sendSSE({ phase: "analyzing_reference", progress: 15, message: "Analyzing video with Gemini..." });

    // Step 1.2: Gemini video analysis
    const videoAnalysis = await withCache<VideoAnalysisResult>(
      refPath,
      "video_analysis",
      async () => {
        const mimeType = refPath.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
        const geminiFile = await uploadToGemini(refPath, mimeType, path.basename(refPath));
        const processedFile = await waitForFileProcessing(geminiFile.name);

        const fileData = {
          fileData: {
            mimeType: processedFile.mimeType,
            fileUri: processedFile.uri,
          },
        };

        let responseText: string;
        try {
          const result = await withRetry(() =>
            geminiFlash.generateContent([{ text: REFERENCE_CONSOLIDATED_PROMPT }, fileData])
          );
          responseText = result.response.text();
        } catch {
          try {
            const result = await withRetry(() =>
              geminiPro.generateContent([{ text: REFERENCE_CONSOLIDATED_PROMPT }, fileData])
            );
            responseText = result.response.text();
          } catch {
            const result = await withRetry(() =>
              geminiFallback.generateContent([{ text: REFERENCE_CONSOLIDATED_PROMPT }, fileData])
            );
            responseText = result.response.text();
          }
        }

        const cleaned = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed = JSON.parse(cleaned);

        return {
          segments: parsed.segments ?? [],
          editing_rhythm: parsed.editing_rhythm ?? {},
          transcription: parsed.transcription ?? { full_text: "", language: "unknown", words: [], sentences: [] },
          visual_events: parsed.visual_events ?? [],
          sync_map: parsed.sync_map ?? [],
        } as VideoAnalysisResult;
      }
    );

    sendSSE({ phase: "analyzing_reference", progress: 20, message: "Measuring coordinates from screenshots..." });

    // Step 1.3: Screenshot coordinates
    const frameCoordinates = await withCache(
      refPath,
      "screenshot_coordinates",
      async () => {
        const coords = await extractAllCoordinates(
          refExtraction.frames, 1080, 1920, 4, 500
        );
        return assignSegmentIds(coords, videoAnalysis.segments);
      }
    );

    sendSSE({ phase: "analyzing_reference", progress: 22, message: "Analyzing A-roll material..." });

    // Step 1.4: A-roll material analysis
    const arollAnalysis = await analyzeARollMaterial(arollPath, videoAnalysis.transcription);

    sendSSE({ phase: "analyzing_reference", progress: 24, message: `Analyzing B-roll material (${brollPaths.length} source${brollPaths.length > 1 ? 's' : ''})...` });

    // Step 1.5: B-roll analysis — analyze ALL B-roll sources
    const allBrollAnalyses = [];
    for (let bi = 0; bi < brollPaths.length; bi++) {
      const bAnalysis = await analyzeBRollMaterial(brollPaths[bi]);
      allBrollAnalyses.push(bAnalysis);
      if (brollPaths.length > 1) {
        console.log(`[clone-style] B-roll #${bi + 1}: ${bAnalysis.internalScenes.length} scenes, ${bAnalysis.duration.toFixed(1)}s`);
      }
    }

    sendSSE({ phase: "analyzing_reference", progress: 25, message: "Assembling blueprint..." });

    // Step 1.6: Assemble blueprint
    blueprint = assembleBlueprint({
      frameExtraction: refExtraction,
      videoAnalysis,
      frameCoordinates,
      arollAnalysis,
      brollAnalyses: allBrollAnalyses,
    });

    // Cache it
    setCache(refPath, "visual_blueprint", blueprint);
  } else {
    sendSSE({ phase: "analyzing_reference", progress: 25, message: "Using cached blueprint" });
  }

  // ════════════════════════════════════════════
  // PHASE 1b: CV Coordinate Correction
  // ════════════════════════════════════════════
  // Replace the LLM's unreliable bounding-box estimates with deterministic
  // computer-vision measurements from the real reference pixels (circle
  // PIPs, rectangle A-roll, header text + typeface + color spans). This
  // mutates the blueprint segments in place BEFORE template/plan building.
  // Cached on the blueprint so repeat requests skip the ~1-2 min measure.
  if (!(blueprint.reference as unknown as { cvCorrected?: boolean }).cvCorrected) {
    sendSSE({ phase: "analyzing_reference", progress: 28, message: "Measuring exact coordinates (computer vision)..." });
    try {
      const arollMetaForAspect = await getVideoMetadata(arollPath);
      const sourceAspect = arollMetaForAspect.resolution.width / arollMetaForAspect.resolution.height;
      const { logs } = await applyCvCorrections({
        ffmpegPath: getFFmpegPath(),
        refVideoPath: refPath,
        canvas: blueprint.canvas,
        segments: blueprint.reference.segments as unknown as Array<Record<string, unknown>>,
        sourceAspect,
        tmpDir: tempDir,
      });
      for (const line of logs) console.log(`[clone-style] CV: ${line}`);
      (blueprint.reference as unknown as { cvCorrected?: boolean }).cvCorrected = true;
      // Persist the corrected blueprint so future requests skip CV
      setCache(refPath, "visual_blueprint", blueprint);
      sendSSE({ phase: "analyzing_reference", progress: 32, message: `Coordinates corrected (${logs.length} elements)` });
    } catch (err) {
      console.error("[clone-style] CV correction failed (non-blocking, using LLM estimates):", err);
    }
  }

  // ════════════════════════════════════════════
  // PHASE 1b2: VLM multi-region layout decomposition (unified decode input)
  // ════════════════════════════════════════════
  // ALWAYS run (cached) — the unified decode needs the VLM layoutClass to (a) build the
  // canonical regions view, (b) guard the broll_only 50/50 override below (a PIP/stack
  // reference must NOT be bulldozed into a split), and (c) gate archetype auto-learn.
  // Runs BEFORE Phase 1c because 1c's broll_only override needs the guard.
  let regionLayout: RegionLayout | null = getCached<RegionLayout>(refPath, "layout_regions");
  if (!regionLayout) {
    sendSSE({ phase: "analyzing_reference", progress: 33, message: "Decomposing layout regions (VLM)..." });
    try {
      regionLayout = await analyzeLayoutRegions(refPath);
      if (regionLayout) setCache(refPath, "layout_regions", regionLayout);
    } catch (err) {
      console.error("[clone-style] region layout (non-blocking):", err);
    }
  }
  const vlmMultiRegion =
    !!regionLayout && ["multi_region_stack", "circle_pip", "pip_over_fullscreen", "pip"].includes(regionLayout.layoutClass);
  if (regionLayout) {
    console.log(
      `[clone-style] Region layout (VLM): ${regionLayout.layoutClass} | ${regionLayout.bands.length} band(s) | aroll band #${regionLayout.arollBandIndex}`
    );
  }
  if (vlmMultiRegion) {
    console.log("[clone-style] Multi-region/PIP reference detected — broll_only 50/50 split override will be SKIPPED (Wave 2 owns N-region planning).");
  }

  // ════════════════════════════════════════════
  // PHASE 1c: Face-anchored A-roll position (deterministic CV)
  // ════════════════════════════════════════════
  // Replace Gemini's unreliable rectangle A-roll bbox with a YuNet
  // face-anchored band per segment (top/bottom split, fullscreen, or
  // broll-only). This is the fix for the top/bottom inversion: A-roll
  // position is now MEASURED from the actual talking head, not guessed.
  if (!(blueprint.reference as unknown as { arollBandCorrectedV2?: boolean }).arollBandCorrectedV2) {
    sendSSE({ phase: "analyzing_reference", progress: 33, message: "Locating A-roll by face (computer vision)..." });
    try {
      const segs = blueprint.reference.segments as unknown as Array<{
        start: number; end: number;
        aroll?: { boundingBox?: { x: number; y: number; width: number; height: number }; shape?: string } | null;
        broll?: { boundingBox?: { x: number; y: number; width: number; height: number } } | null;
      }>;
      if (segs.length > 0) {
        const W = blueprint.canvas.width, H = blueprint.canvas.height;
        const bounds = [segs[0].start, ...segs.map((s) => s.end)];
        const bands = detectReferenceArollBands(refPath, bounds);
        if (bands) {
          let nFixed = 0;
          for (let i = 0; i < segs.length && i < bands.length; i++) {
            const b = bands[i];
            if ((b.type === "top_split" || b.type === "bottom_split" || b.type === "fullscreen_aroll") && b.bandNorm) {
              const [nx, ny, nw, nh] = b.bandNorm;
              segs[i].aroll = {
                ...(segs[i].aroll ?? {}),
                boundingBox: { x: Math.round(nx * W), y: Math.round(ny * H), width: Math.round(nw * W), height: Math.round(nh * H) },
                shape: "rectangle",
              };
              if (b.brollNorm) {
                const [bx, by, bw, bh] = b.brollNorm;
                segs[i].broll = {
                  ...(segs[i].broll ?? {}),
                  boundingBox: { x: Math.round(bx * W), y: Math.round(by * H), width: Math.round(bw * W), height: Math.round(bh * H) },
                };
              }
              nFixed++;
            } else if (b.type === "broll_only") {
              // GUARD (UNIVERSAL-1 Wave 1b): when the VLM decoded a multi-region stack or a
              // PIP-over-fullscreen, a "broll_only" CV read is the stack/PIP background —
              // do NOT bulldoze it into a 50/50 split (that poisoned R3's decode).
              if (vlmMultiRegion) continue;
              // A-ROLL IS THE HERO (user rule): even where the reference cut
              // to fullscreen B-roll, keep the speaker visible as a SPLIT
              // (B-roll top, A-roll bottom) — the A-roll builds trust. A few
              // true-fullscreen moments can be re-added later; default split.
              const divider = Math.round(H * 0.5);
              segs[i].aroll = {
                ...(segs[i].aroll ?? {}),
                boundingBox: { x: 0, y: divider, width: W, height: H - divider },
                shape: "rectangle",
              };
              segs[i].broll = {
                ...(segs[i].broll ?? {}),
                boundingBox: { x: 0, y: 0, width: W, height: divider },
              };
              nFixed++;
            }
          }
          (blueprint.reference as unknown as { arollBandCorrectedV2?: boolean }).arollBandCorrectedV2 = true;
          setCache(refPath, "visual_blueprint", blueprint);
          console.log(`[clone-style] Face-anchored A-roll: corrected ${nFixed}/${segs.length} segments`);
          sendSSE({ phase: "analyzing_reference", progress: 34, message: `A-roll positions located by face (${nFixed} segments)` });
        }
      }
    } catch (err) {
      console.error("[clone-style] face-anchored A-roll correction failed (non-blocking):", err);
    }
  }

  // ── B1 shadow emit: unified StyleProfile 2.0 (non-breaking) ──
  // Blueprint is now finalized (CV-corrected). Emit the canonical, content-free
  // StyleProfile 2.0 alongside the legacy flow so we validate the adapter on a
  // REAL reference analysis before flipping the Composer to consume it
  // (docs/B1-SCHEMA-RECONCILIATION.md, step 3). Nothing consumes this yet.
  let styleProfile2: ReturnType<typeof fromVisualBlueprint> | null = null;
  try {
    styleProfile2 = fromVisualBlueprint(blueprint);
    fs.writeFileSync(
      path.join(tempDir, "style-profile-2.0.json"),
      JSON.stringify(styleProfile2, null, 2)
    );
    console.log(
      `[clone-style] StyleProfile 2.0 (shadow): ${styleProfile2.layout.patterns.length} pattern(s), ` +
        `captions.present=${styleProfile2.captions.present}, pacing=${styleProfile2.pacing.pacing_class}, ` +
        `temp=${styleProfile2.color.temperature}`
    );
  } catch (err) {
    console.error("[clone-style] StyleProfile 2.0 shadow emit failed (non-blocking):", err);
  }

  // Build the reference Layout Map (virtual-coordinate template/library)
  // from the corrected segments — drives PIP motion animation downstream.
  const refDuration =
    blueprint.reference.duration ??
    (blueprint.reference.segments.length > 0
      ? blueprint.reference.segments[blueprint.reference.segments.length - 1].end
      : 0);
  const layoutMap = buildLayoutMap({
    segments: blueprint.reference.segments as unknown as Parameters<typeof buildLayoutMap>[0]["segments"],
    canvas: blueprint.canvas,
    refDuration,
    sourceFile: path.basename(refPath),
  });

  // ── Deterministic Layout Analyzer (CV) — measures A-roll/B-roll regions + SIDE
  // from the PIXELS, ahead of (and more reliable than) the template's invertible
  // estimate. Non-blocking: null on any failure → template path unchanged. The
  // measured B-roll region drives framing below; the archetype match adds memory. ──
  let measuredLayout: LayoutAnalysis | null = null;
  // The CANONICAL reference decode (single source of truth). Built from the CV Layout
  // Analyzer and CONSUMED below (A-roll side snap + B-roll cadence) — not a shadow object.
  let refDecode: ReferenceDecode | null = null;
  try {
    if (layoutAnalyzerAvailable()) {
      measuredLayout = analyzeLayout(refPath);
      if (measuredLayout) {
        // Unified decode inputs: canonical layoutClass + regions from CV + VLM (one path).
        const unified = unifyLayoutClass(measuredLayout.layout.type, regionLayout);
        const unifiedRegions = buildDecodedRegions(measuredLayout, regionLayout);
        const arch = matchArchetype({ ...measuredLayout.layout, layoutClass: unified.layoutClass, regions: unifiedRegions });
        // Run the VLM SEMANTIC pass so per-shot roles + caption STYLE/animation + overlays
        // + style keywords are actually decoded (previously dormant). Non-blocking (null on
        // failure). Cached on the reference so repeat requests skip the Gemini call.
        let semantics = getCached<LayoutSemantics>(refPath, "layout_semantics");
        if (!semantics) {
          semantics = await analyzeLayoutSemantics(refPath, {
            segments: measuredLayout.segments,
            arollSide: measuredLayout.layout.arollSide,
            dividerFraction: measuredLayout.layout.dividerFraction ?? undefined,
          });
          if (semantics) setCache(refPath, "layout_semantics", semantics);
        }
        if (semantics) console.log(`[clone-style] Semantics: captions ${semantics.captions?.present ? `present (${semantics.captions.position}, ${semantics.captions.animation})` : "none"}, ${semantics.shots?.length ?? 0} shot roles, ${semantics.styleKeywords?.length ?? 0} style keywords.`);
        refDecode = buildReferenceDecode(path.basename(refPath), measuredLayout, { archetype: arch, semantics, regionLayout });
        fs.writeFileSync(
          path.join(tempDir, "layout-analysis.json"),
          JSON.stringify({ ...measuredLayout, archetype: arch, regionLayout }, null, 2)
        );
        fs.writeFileSync(path.join(tempDir, "reference-decode.json"), JSON.stringify(refDecode, null, 2));
        const L = measuredLayout.layout;
        console.log(
          `[clone-style] Layout Analyzer: ${L.type} | A-roll ${L.arollSide} | B-roll ${L.brollRegion.width}x${L.brollRegion.height} (AR ${L.brollAspect}) | divider ${L.dividerFraction} | conf ${L.confidence} | sideAgree ${L.evidence.sideAgree}` +
            (arch ? ` | archetype ${arch.id} (${arch.matchScore}${arch.novel ? ", NOVEL→confirm" : ""})` : "")
        );
        // Unified decode summary: canonical layoutClass + compact band/region table.
        console.log(
          `[clone-style] Unified decode: layoutClass ${refDecode.layout.layoutClass.value} ` +
            `(source ${refDecode.layout.layoutClass.source}, conf ${refDecode.layout.layoutClass.confidence}` +
            `${refDecode.layout.layoutClass.uncertain ? ", CROSS-CHECK DISAGREEMENT" : ""}) | ${refDecode.layout.regions.value.length} region(s)`
        );
        for (const r of refDecode.layout.regions.value) {
          console.log(
            `[clone-style]   region ${r.id.padEnd(20)} ${r.role.padEnd(16)} ` +
              `x=${r.rect.x.toFixed(2)} y=${r.rect.y.toFixed(2)} w=${r.rect.w.toFixed(2)} h=${r.rect.h.toFixed(2)} ` +
              `z=${r.zIndex} ${r.shape}${r.persistent ? " persistent" : ""}` +
              `${r.contentTimeline?.length ? ` timeline(${r.contentTimeline.length})` : ""}`
          );
        }
        // Self-learning AUTO-CONFIRM — RE-ENABLED (UNIVERSAL-1 Wave 1b), gated on the
        // CV-type vs VLM-layoutClass CROSS-CHECK: auto-confirm ONLY when both extractors
        // independently name the same family (both 2-region split, or both fullscreen/
        // broll_only). This is the fix for the Wave-0 poisoning case (R3 PIP decoding as
        // split and re-centering split_aroll_bottom's ranges).
        const crossCheckAgrees = classesAgree(measuredLayout.layout.type, regionLayout);
        if (crossCheckAgrees && arch && !arch.novel && !measuredLayout.layout.typeUncertain && arch.matchScore >= 0.85 && measuredLayout.layout.confidence >= 0.7) {
          const learned = recordConfirmation(arch.id, measuredLayout.layout, path.basename(refPath));
          if (learned) console.log(`[clone-style] Layout Analyzer: auto-confirmed exemplar for archetype ${arch.id} (self-calibrated; CV+VLM cross-check agreed).`);
        } else if (arch?.novel || measuredLayout.layout.typeUncertain || !crossCheckAgrees) {
          console.warn(`[clone-style] NOVEL/uncertain layout (archetype ${arch?.id} score ${arch?.matchScore}, typeUncertain ${measuredLayout.layout.typeUncertain}, cvVlmAgree ${crossCheckAgrees}) — flagged for human confirmation (autonomy policy); NOT auto-learned.`);
        }

        // ── scene-KB (spec §3.4): segment the decode into scenes and match each
        // against the knowledge base. Non-blocking; measurements only. ──
        try {
          const kb = new FileSceneKB();
          const { sceneWindows, sceneMatches } = buildSceneMatches({
            decode: refDecode,
            structureTimeline: regionLayout?.structureTimeline ?? null,
            referenceHash: computeFileHash(refPath),
            kb,
          });
          ctx.sceneWindows = sceneWindows;
          ctx.sceneMatches = sceneMatches;
          ctx.sceneCvVlmAgree = crossCheckAgrees;
          console.log(`[clone-style] Scene KB: ${sceneWindows.length} scene(s)`);
          for (const { scene, match } of sceneMatches) {
            console.log(
              `[clone-style]   scene ${scene.window.t0}-${scene.window.t1}s ${scene.layoutClass.padEnd(21)} ` +
                `${match.kind.toUpperCase()}${match.family ? ` (${match.family})` : ""} dist ${match.distance.toFixed(3)}` +
                `${match.exemplar ? ` ← exemplar ${match.exemplar.id} [${match.exemplar.closedLoopScore}%]` : ""}`
            );
          }
        } catch (err) {
          console.error("[clone-style] scene-KB match failed (non-blocking):", err);
        }
      }
    }
  } catch (e) {
    console.error("[clone-style] layout analyzer (non-blocking):", (e as Error).message);
  }

  // Cadence source — CONSUME the canonical decode: prefer its MEASURED shot cadence
  // (single source of truth) over Gemini's estimated editing_rhythm. This is what moves
  // the closed-loop pacing.shotCount toward the reference. Falls back to the blueprint
  // when the decode is unavailable (behavior unchanged).
  const cadenceRhythm = refDecode
    ? {
        avg_segment_duration: refDecode.pacing.avgShotSec.value,
        pacing: refDecode.pacing.cutFrequency.value,
        cut_style: refDecode.transitions.dominant.value,
      }
    : blueprint.reference.editing_rhythm;
  if (refDecode) console.log(`[clone-style] Cadence source: MEASURED decode (avgShot ${refDecode.pacing.avgShotSec.value}s, ${refDecode.pacing.cutFrequency.value}) — single source of truth.`);

  // ── Write phase outputs back to the shared ctx ──
  ctx.blueprint = blueprint;
  ctx.styleProfile2 = styleProfile2;
  ctx.layoutMap = layoutMap;
  ctx.measuredLayout = measuredLayout;
  ctx.refDecode = refDecode;
  ctx.cadenceRhythm = cadenceRhythm;
}
