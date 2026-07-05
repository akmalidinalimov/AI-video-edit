/**
 * Phase: RENDER VIDEO (Wave 0.5 decomposition — moved verbatim from
 * src/app/api/clone-style/route.ts; no behavior change).
 *
 * Covers: YuNet group crop, montage pass (buildBrollMontageArgs w/ motionMix),
 * composite pass (buildRenderArgsWithScript + spawn/timeout plumbing), caption
 * burn (renderCaptions + style parsing from decode).
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";

import { getVideoMetadata } from "@/lib/analysis/frameExtractor";
import { buildRenderArgsWithScript, buildBrollMontageArgs, toMontageCompositePlan } from "@/lib/pipeline/plan-renderer";
import { renderCaptions } from "@/lib/pipeline/caption-render";
// Face-safe crop (docs/cropping-rules.md): YuNet face detection → calculateSquareCrop
import { detectArollGroup } from "@/lib/pipeline/yunet-face";
// UNIVERSAL-1 Wave 2: N-region pipeline (multi_region_stack / pip_over_fullscreen)
import { renderNRegion, type NRegionRenderRegion, type MontageSegment } from "@/lib/pipeline/nregion-renderer";

import type { PipelineCtx, NRegionPlan } from "./types";
import { getFFmpegPath } from "./utils";

export async function renderVideo(ctx: PipelineCtx): Promise<void> {
  const { arollPath, arollPaths, tempDir, exportsDir, sendSSE, faceInfo } = ctx;
  const blueprint = ctx.blueprint!;
  const dynamicTemplate = ctx.dynamicTemplate!;
  const editingPlan = ctx.editingPlan!;
  const mergedTranscription = ctx.mergedTranscription!;
  const refDecode = ctx.refDecode ?? null;

  // ════════════════════════════════════════════
  // PHASE 4: Single-Pass FFmpeg Render
  // ════════════════════════════════════════════
  sendSSE({ phase: "rendering", progress: 60, message: "Preparing render..." });

  const ffmpegPath = getFFmpegPath();

  // Get A-roll source dimensions for face-centered crop (use first clip)
  const arollMeta = await getVideoMetadata(arollPath);

  // ── Face-safe crop (docs/cropping-rules.md) ──
  // Detect the speaker's face with YuNet per A-roll clip and average, so the
  // (concatenated) A-roll crops on the REAL face — head + shoulders, top gap —
  // instead of the geometric center (which clipped heads). Non-blocking:
  // falls back to center-crop if detection/setup fails.
  let arollFace: { centerX: number; centerY: number; height: number; width?: number } | undefined;
  try {
    sendSSE({ phase: "rendering", progress: 61, message: "Framing all speakers (YuNet group)..." });
    // Detect the GROUP box of ALL faces so the crop frames EVERYONE (a
    // 2-person A-roll must show both), not just the largest face.
    const groups = arollPaths
      .map((p) => detectArollGroup(p))
      .filter((g): g is NonNullable<typeof g> => g !== null);
    if (groups.length > 0) {
      const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
      arollFace = {
        centerX: avg(groups.map((g) => g.centerX)),
        centerY: avg(groups.map((g) => g.centerY)),
        height: avg(groups.map((g) => g.faceHeight)),
        width: avg(groups.map((g) => g.width)),
      };
      console.log(
        `[clone-style] A-roll group (${groups[0].nFaces} face${groups[0].nFaces > 1 ? "s" : ""}): ` +
          `center=(${arollFace.centerX.toFixed(3)},${arollFace.centerY.toFixed(3)}) ` +
          `groupW=${(arollFace.width ?? 0).toFixed(3)} faceH=${arollFace.height.toFixed(3)} → frames all speakers`
      );
    } else {
      console.warn("[clone-style] A-roll group detection found no faces — center-crop fallback");
    }
  } catch (err) {
    console.error("[clone-style] A-roll group detection failed (non-blocking):", err);
  }

  // `let` — reassigned to the CAPTIONED output after the composite render (below).
  let outputFilename = `styleclone-${Date.now()}.mp4`;
  let outputPath = path.join(exportsDir, outputFilename);
  const filterScriptPath = path.join(tempDir, `filter-${Date.now()}.txt`);

  if (ctx.nregionPlan) {
    // ════════════════════════════════════════════
    // UNIVERSAL-1 Wave 2: N-REGION pipeline
    // (feeders → single FFmpeg composite; captions pass below is UNCHANGED)
    // ════════════════════════════════════════════
    sendSSE({ phase: "rendering", progress: 63, message: `N-region render (${ctx.nregionPlan.regions.length} regions)...` });
    await renderNRegionRoute(ctx.nregionPlan, {
      ffmpegPath,
      outputPath,
      tempDir,
      durationSec: editingPlan.totalDuration,
      fps: blueprint.reference.fps || 30,
      arollDims: { w: arollMeta.resolution.width, h: arollMeta.resolution.height },
      arollFace,
      headerText: (() => {
        // Prefer literal quoted text from the decode's overlay semantics.
        const desc = (refDecode?.overlays.value ?? []).map((o) => o.description).join(" ");
        const m = desc.match(/'([^']{8,80})'/);
        return m ? m[1] : "Your headline here";
      })(),
    });
    console.log(`[clone-style] N-region composite rendered → ${outputPath}`);
  } else {
  // ── Two-pass render: B-roll montage (pass 1) → composite (pass 2) ──
  // When the plan cuts B-roll per range (the paced montage), render those
  // shots into ONE continuous full-canvas track first (memory-light cut-list
  // via per-segment input-seek + concat), then composite the A-roll/text
  // over it. A single pass with many shots OOMs (huge per-segment pads).
  let compositePlan = editingPlan;
  const planHasBrollOffsets = editingPlan.layoutRanges.some(
    (r) => r.brollOffset !== undefined
  );
  if (planHasBrollOffsets) {
    sendSSE({
      phase: "rendering",
      progress: 63,
      message: `Building B-roll montage (${editingPlan.layoutRanges.length} shots)...`,
    });
    const montagePath = path.join(tempDir, `montage-${Date.now()}.mp4`);
    // Consume the MEASURED reference camera-motion distribution (was discarded).
    const montageArgs = buildBrollMontageArgs(editingPlan, dynamicTemplate, montagePath, { motionMix: refDecode?.motion.distribution.value });
    await new Promise<void>((resolve, reject) => {
      const mp = spawn(ffmpegPath, montageArgs, { cwd: process.cwd(), shell: false });
      let merr = "";
      const mt = setTimeout(() => {
        mp.kill("SIGKILL");
        reject(new Error("B-roll montage timed out"));
      }, 300_000);
      mp.stderr?.on("data", (d: Buffer) => { merr += d.toString(); });
      mp.on("close", (code) => {
        clearTimeout(mt);
        if (code === 0 && fs.existsSync(montagePath)) resolve();
        else reject(new Error(
          `B-roll montage failed: ${merr.split("\n").filter((l) => /error|Invalid|memory/i.test(l)).slice(0, 3).join("; ")}`
        ));
      });
      mp.on("error", (err) => { clearTimeout(mt); reject(err); });
    });
    compositePlan = toMontageCompositePlan(editingPlan, montagePath);
    console.log(`[clone-style] B-roll montage built (${editingPlan.layoutRanges.length} shots): ${montagePath}`);
  }

  // Build FFmpeg args using single-pass plan renderer (composite over montage)
  const renderOutput = buildRenderArgsWithScript(
    {
      plan: compositePlan,
      template: dynamicTemplate,
      arollSourceDimensions: arollMeta.resolution,
      arollFace,
      ffmpegPath,
      outputPath,
    },
    filterScriptPath
  );

  // Write filter script to file
  fs.writeFileSync(filterScriptPath, renderOutput.filterComplex);

  // Debug logging: key render parameters
  console.log("[clone-style] ═══ RENDER DEBUG ═══");
  console.log("[clone-style] A-roll source:", JSON.stringify(arollMeta.resolution));
  console.log("[clone-style] Face info:", JSON.stringify(faceInfo));
  for (const [layoutId, layout] of Object.entries(dynamicTemplate.layouts)) {
    console.log(`[clone-style] Layout "${layoutId}" faceCropCenter:`, JSON.stringify((layout as any).aroll?.faceCropCenter));
    console.log(`[clone-style] Layout "${layoutId}" aroll region:`, JSON.stringify((layout as any).aroll?.region));
    console.log(`[clone-style] Layout "${layoutId}" aroll shape:`, (layout as any).aroll?.shape);
  }
  console.log("[clone-style] Filter (first 500 chars):", renderOutput.filterComplex.slice(0, 500));
  console.log("[clone-style] ═══ END DEBUG ═══");

  sendSSE({ phase: "rendering", progress: 65, message: "Rendering video (single-pass FFmpeg)..." });

  // Spawn FFmpeg
  const totalDuration = editingPlan.totalDuration;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, renderOutput.ffmpegArgs, {
      cwd: process.cwd(),
      shell: false,
    });

    let stderr = "";
    // 5 minutes — the geq circle-mask filters are CPU-heavy and can run
    // 75-180s depending on machine load; route maxDuration is 600s.
    const timeoutMs = 300_000;
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("FFmpeg render timed out after 5 minutes"));
    }, timeoutMs);

    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString();
      stderr += line;

      // Parse FFmpeg progress from stderr
      const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseFloat(timeMatch[3]);
        const currentTime = hours * 3600 + minutes * 60 + seconds;
        const pct = Math.min(currentTime / totalDuration, 0.99);
        // Map rendering progress to 65-95 range
        const progress = 65 + Math.round(pct * 30);
        sendSSE({
          phase: "rendering",
          progress,
          message: `Rendering: ${Math.round(pct * 100)}%`,
        });
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      // Preserve filter script for debugging (copy to sp-temp)
      try {
        const debugFilterPath = path.join(tempDir, "last-render-filter.txt");
        fs.copyFileSync(filterScriptPath, debugFilterPath);
        console.log(`[clone-style] Filter saved to: ${debugFilterPath}`);
      } catch { /* ignore copy failure */ }
      // Clean up original filter script
      try { fs.unlinkSync(filterScriptPath); } catch { /* ignore */ }

      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        const errorLines = stderr
          .split("\n")
          .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid"))
          .slice(0, 5);
        reject(new Error(
          errorLines.length > 0
            ? `FFmpeg failed: ${errorLines.join("; ")}`
            : `FFmpeg exited with code ${code}`
        ));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(filterScriptPath); } catch { /* ignore */ }
      reject(err);
    });
  });
  } // end legacy (non-N-region) render path

  // ════════════════════════════════════════════
  // PHASE 4b: Burn captions (productionized into the route)
  // ════════════════════════════════════════════
  // Overlay the MMS-timed 2-row caption track, positioned where the REFERENCE puts it
  // (just below the measured split divider). Non-blocking: on failure the uncaptioned
  // composite is kept. The captioned file becomes the final output.
  try {
    const capWords = (mergedTranscription.words ?? []).map((w: { word: string; start: number; end: number }) => ({ word: w.word, start: w.start, end: w.end }));
    if (capWords.length > 0) {
      sendSSE({ phase: "rendering", progress: 92, message: "Burning captions..." });
      const divider = refDecode?.layout.dividerFraction.value ?? null;
      const yFraction = divider != null ? Math.min(0.9, divider + 0.06) : 0.43; // just below the divider
      // Consume the MEASURED caption STYLE (color/weight parsed from the VLM style string;
      // animation from the decode) so the render matches the reference, not a fixed house style.
      const capStyleStr = (refDecode?.captions.style.value || "").toLowerCase();
      const COLORS: Record<string, string> = { white: "#FFFFFF", black: "#141414", yellow: "#FFE14D", red: "#FF3B30", blue: "#2E7BFF", green: "#34C759", orange: "#FF9500", pink: "#FF375F" };
      const fillColor = Object.entries(COLORS).find(([n]) => capStyleStr.includes(n))?.[1] ?? "#FFFFFF";
      const fontWeight = /(black|heavy|extra ?bold|900)/.test(capStyleStr) ? 900 : /(bold|semibold|800|700)/.test(capStyleStr) ? 800 : 700;
      const capAnimation = refDecode?.captions.animation.value || "word-pop-in";
      console.log(`[clone-style] Caption style ← decode: color ${fillColor}, weight ${fontWeight}, animation ${capAnimation}`);
      const capFilename = `styleclone-cap-${Date.now()}.mp4`;
      const capPath = path.join(exportsDir, capFilename);
      const capResult = await renderCaptions({
        baseVideoRelPath: `exports/${outputFilename}`,
        words: capWords,
        outputPath: capPath,
        durationSec: editingPlan.totalDuration,
        yFraction,
        keywords: [], // UNIFORM captions (the user's chosen style — no italic keyword emphasis)
        fps: blueprint.reference.fps || 30,
        fillColor, fontWeight, animation: capAnimation,
      });
      if (capResult) {
        outputFilename = capFilename;
        outputPath = capPath;
        console.log(`[clone-style] Captions burned (yFraction ${yFraction.toFixed(2)}, below divider ${divider}) → ${capFilename}`);
      } else {
        console.warn("[clone-style] Caption render returned null — keeping uncaptioned composite.");
      }
    }
  } catch (err) {
    console.error("[clone-style] caption burn failed (non-blocking):", err);
  }

  // ── Write phase outputs back to the shared ctx ──
  ctx.outputFilename = outputFilename;
  ctx.outputPath = outputPath;
}

// ════════════════════════════════════════════════════════════
// N-REGION route adapter (UNIVERSAL-1 Wave 2)
// ════════════════════════════════════════════════════════════

/**
 * Map the NRegionPlan (from buildPlan) onto the nregion-renderer spec and run it:
 * per-region feeders (header PNG / montage / face-safe A-roll) → ONE composite.
 * The full-canvas zIndex-0 region becomes the background montage (its decoded
 * contentTimeline drives the cut list); everything else overlays in zIndex order.
 * Audio: continuous from the A-roll feeder (hard rule, enforced by the renderer).
 */
async function renderNRegionRoute(
  np: NRegionPlan,
  opts: {
    ffmpegPath: string;
    outputPath: string;
    tempDir: string;
    durationSec: number;
    fps: number;
    arollDims: { w: number; h: number };
    arollFace?: { centerX: number; centerY: number; height: number; width?: number };
    headerText: string;
  }
): Promise<void> {
  const { durationSec, fps } = opts;
  const canvas = { w: np.canvas.width, h: np.canvas.height };
  const brollClips = np.sources.brollClips.length > 0 ? np.sources.brollClips : [np.sources.aroll];

  // Full-canvas base region (zIndex 0) → background montage; others → overlays.
  const isFullCanvas = (r: NRegionPlan["regions"][number]) =>
    r.rect.w >= canvas.w - 2 && r.rect.h >= canvas.h - 2;
  const bgRegion = np.regions.find((r) => r.zIndex === 0 && isFullCanvas(r) && r.role !== "aroll");
  const overlays = np.regions.filter((r) => r !== bgRegion);

  // Background cut list from the decoded contentTimeline (subdivided ≤3s),
  // else cadence cycling. Non-broll classes reuse B-roll clips as PLACEHOLDER
  // content until real screen-capture ingestion lands (post-demo) — log loud.
  let bgSegments: MontageSegment[] | undefined;
  if (bgRegion?.contentTimeline?.length) {
    console.warn("[clone-style] ⚠ N-region background: non-broll timeline classes use PLACEHOLDER B-roll clips (real capture post-demo).");
    bgSegments = [];
    let ci = 0;
    for (const w of bgRegion.contentTimeline) {
      const wEnd = Math.min(w.end, durationSec);
      let t = Math.min(w.start, durationSec);
      while (t < wEnd - 1e-6) {
        const d = Math.min(3, wEnd - t);
        bgSegments.push({ clip: brollClips[ci++ % brollClips.length], durSec: d });
        t += d;
      }
    }
    if (bgSegments.length === 0) bgSegments = undefined;
  }

  const regions: NRegionRenderRegion[] = overlays.map((r): NRegionRenderRegion => {
    if (r.role === "header_title") {
      return { id: r.id, kind: "header", rect: r.rect, zIndex: r.zIndex, text: opts.headerText };
    }
    if (r.role === "aroll") {
      return {
        id: r.id, kind: "aroll", rect: r.rect, zIndex: r.zIndex,
        cornerRadiusPx: r.cornerRadiusPx,
        arollPath: np.sources.aroll, srcDims: opts.arollDims, face: opts.arollFace ?? null,
      };
    }
    if (r.role === "screen_recording") {
      console.warn(`[clone-style] ⚠ N-region ${r.id}: screen_recording strip uses PLACEHOLDER B-roll clips (real capture post-demo).`);
    }
    return {
      id: r.id, kind: "montage", rect: r.rect, zIndex: r.zIndex,
      cornerRadiusPx: r.cornerRadiusPx,
      clips: brollClips, targetShotSec: np.targetShotSec, motionMix: np.motionMix,
    };
  });

  await renderNRegion({
    canvas, fps, durationSec,
    ffmpegPath: opts.ffmpegPath,
    tempDir: path.join(opts.tempDir, "nregion"),
    outputPath: opts.outputPath,
    background: bgRegion
      ? { clips: brollClips, targetShotSec: np.targetShotSec, motionMix: np.motionMix, segments: bgSegments }
      : undefined,
    regions,
    filterDebugPath: path.join(opts.tempDir, "nregion-filter-route.txt"),
  });
}
