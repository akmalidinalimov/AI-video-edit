/**
 * Phase: BUILD PLAN (Wave 0.5 decomposition — moved verbatim from
 * src/app/api/clone-style/route.ts; no behavior change).
 *
 * Covers: buildEditingPlan + A-roll-end trim + side-snap + geometry override
 * + B-roll style classify + B-roll planner/prompt-engine (incl. the cache
 * read-back merge) + creative director + match verification.
 */

import path from "path";
import fs from "fs";

// Gemini
import { geminiFlash } from "@/lib/gemini/client";

// Pipeline modules
import { buildEditingPlan } from "@/lib/pipeline/plan-builder";
import { planCadence } from "@/lib/pipeline/cadence-planner";
import { planBroll } from "@/lib/pipeline/broll-planner";
import { enrichFootagePrompts } from "@/lib/pipeline/broll-prompt-engine";
import { framingForRegion } from "@/lib/pipeline/broll-framing";
import { applyCreativeDirector } from "@/lib/pipeline/creative-director";
import { classifyReferenceBrollStyle, STYLE_TO_MODALITY, type BrollStyleResult } from "@/lib/pipeline/broll-style";
import { verifyMatches } from "@/lib/pipeline/narrative-analyzer";
import { regionToPixels } from "@/lib/pipeline/nregion-renderer";

import type { PipelineCtx } from "./types";

export async function buildPlan(ctx: PipelineCtx): Promise<void> {
  const { refPath, arollPath, brollPath, arollPaths, tempDir, sendSSE } = ctx;
  const blueprint = ctx.blueprint!;
  const dynamicTemplate = ctx.dynamicTemplate!;
  const layoutMap = ctx.layoutMap!;
  const cadenceRhythm = ctx.cadenceRhythm!;
  const measuredLayout = ctx.measuredLayout ?? null;
  const refDecode = ctx.refDecode ?? null;
  const allArollTranscriptions = ctx.allArollTranscriptions!;
  const arollClipMeta = ctx.arollClipMeta!;
  const mergedTranscription = ctx.mergedTranscription!;
  const allBrollScenes = ctx.allBrollScenes!;
  const brollClipMeta = ctx.brollClipMeta!;
  const totalBrollDuration = ctx.totalBrollDuration!;
  const narrativeContext = ctx.narrativeContext;
  const speechKeywords = ctx.speechKeywords;

  sendSSE({ phase: "building_plan", progress: 53, message: "Building editing plan..." });

  // ── Build sentence → A-roll clip index map for source pairing ──
  // Each sentence knows which A-roll clip it came from, enabling B-roll N
  // to be preferred for A-roll N's sentences.
  const sentenceArollClipMap = new Map<number, number>();
  {
    let globalSentIdx = 0;
    for (let clipIdx = 0; clipIdx < allArollTranscriptions.length; clipIdx++) {
      for (let _si = 0; _si < allArollTranscriptions[clipIdx].sentences.length; _si++) {
        sentenceArollClipMap.set(globalSentIdx, clipIdx);
        globalSentIdx++;
      }
    }
    if (sentenceArollClipMap.size > 0 && arollPaths.length > 1) {
      console.log(`[clone-style] Source pairing: mapped ${sentenceArollClipMap.size} sentences to ${arollPaths.length} A-roll clips`);
    }
  }

  const editingPlan = buildEditingPlan({
    blueprintSegments: blueprint.reference.segments as unknown as Parameters<typeof buildEditingPlan>[0]["blueprintSegments"],
    transcription: {
      words: mergedTranscription.words ?? [],
      sentences: mergedTranscription.sentences ?? [],
    },
    templateId: dynamicTemplate.id,
    template: dynamicTemplate,
    sources: {
      aroll: arollPath,
      broll: brollPath,
      arollClips: arollClipMeta,
      brollClips: brollClipMeta,
    },
    // Content-aware B-roll matching (all sources unified)
    brollScenes: allBrollScenes.length > 0 ? allBrollScenes : undefined,
    brollDuration: totalBrollDuration > 0 ? totalBrollDuration : undefined,
    // Deep narrative understanding (when available)
    narrativeContext,
    // Source pairing: sentence → A-roll clip index
    sentenceArollClipMap: sentenceArollClipMap.size > 0 ? sentenceArollClipMap : undefined,
    // CV-measured reference Layout Map (drives PIP motion animation)
    layoutMap,
    // Reference-derived B-roll cadence (Step 1: match the reference's cut rhythm)
    cadence: planCadence(cadenceRhythm),
  });

  // ── Fix: the A-roll (the speech) determines the END ──
  // The A-roll is silence-trimmed, so its real length IS the spoken length.
  // Cut the video when the A-roll finishes — even if the B-roll montage runs
  // longer — so the final A-roll frame never freezes while B-roll keeps moving.
  // (-t flows to both the montage and composite passes, and the A-roll audio
  // already ends here, so no spoken word is lost — only the silent tail.)
  const arollTotalSec = arollClipMeta.reduce((s, c) => s + (c.duration || 0), 0);
  if (arollTotalSec > 0 && editingPlan.totalDuration > arollTotalSec + 0.04) {
    console.log(`[clone-style] Cut at A-roll end: ${editingPlan.totalDuration.toFixed(2)}s → ${arollTotalSec.toFixed(2)}s (trailing B-roll past speech removed)`);
    editingPlan.totalDuration = arollTotalSec;
  }

  sendSSE({ phase: "building_plan", progress: 55, message: `Plan: ${editingPlan.layoutRanges.length} ranges, ${editingPlan.transitions.length} transitions` });

  // ── Stage 1: A-ROLL POSITION — MEASURED, CONSISTENT (the end-to-end inversion fix) ──
  // A split is a tutorial frame: the speaker STAYS on ONE side (no top↔bottom
  // switching). WHICH side is now driven by the deterministic Layout Analyzer's
  // MEASURED arollSide (resolves the split-side inversion from the pixels) instead of
  // being hardcoded. The renderer decides rectangle A-roll placement from the group
  // layout's region center (plan-renderer.ts §5b), so we snap every rect_pip range to
  // the template layout whose A-roll sits on the measured side — consistently. Falls
  // back to BOTTOM (the prior default / tutorial convention) when there is no
  // confident split measurement, preserving old behavior.
  // UNIVERSAL-1 Wave 1b: N-REGION references (multi_region_stack / pip_over_fullscreen)
  // have no meaningful 2-region "side" — SKIP the snap + geometry override entirely
  // (do NOT bulldoze to the default-bottom split). Wave 2 wires N-region planning.
  const unifiedLayoutClass = refDecode?.layout.layoutClass?.value;
  if (unifiedLayoutClass === "multi_region_stack" || unifiedLayoutClass === "pip_over_fullscreen") {
    console.log(
      `[clone-style] A-roll position: layoutClass ${unifiedLayoutClass} — N-REGION plan attached (Wave 2); ` +
        `SKIPPING the 2-region side-snap + geometry override (no default-bottom bulldoze).`
    );
    // ── UNIVERSAL-1 Wave 2: attach the N-region render plan ──
    // Decoded fractional regions → even-dim PIXEL rects on the render canvas.
    // renderVideo branches on ctx.nregionPlan (feeders → single composite).
    try {
      const canvas = { width: blueprint.canvas.width, height: blueprint.canvas.height };
      const decRegions = refDecode!.layout.regions.value;
      const avgShot = refDecode!.pacing.avgShotSec.value || 1;
      ctx.nregionPlan = {
        layoutClass: unifiedLayoutClass,
        canvas,
        regions: decRegions.map((r) => {
          const rect = regionToPixels(r, { w: canvas.width, h: canvas.height });
          return {
            id: r.id,
            role: r.role,
            rect,
            shape: r.shape,
            zIndex: r.zIndex,
            cornerRadiusPx:
              r.shape === "rounded_rect"
                ? Math.round((r.cornerRadiusFrac ?? 0.045) * canvas.width)
                : undefined,
            contentTimeline: r.contentTimeline?.map((w) => ({ ...w })),
          };
        }),
        sources: {
          aroll: arollPath,
          arollClips: arollClipMeta.map((c) => c.path),
          brollClips: brollClipMeta.map((c) => c.path),
        },
        targetShotSec: Math.min(2.5, Math.max(0.6, avgShot)),
        motionMix: refDecode!.motion.distribution.value,
      };
      console.log(
        `[clone-style] N-region plan: ${ctx.nregionPlan.regions.length} region(s) ` +
          `[${ctx.nregionPlan.regions.map((r) => `${r.role} ${r.rect.w}x${r.rect.h}@(${r.rect.x},${r.rect.y})z${r.zIndex}`).join(" | ")}] ` +
          `shot ${ctx.nregionPlan.targetShotSec.toFixed(2)}s`
      );

      // ── scene-KB recipe injection (spec §3.4, minimal): when a scene is KNOWN and its
      // layoutClass matches this plan, log recipe availability and pass the exemplar's
      // renderParams into the plan (targetShotSec is the one param the plan consumes today).
      const known = (ctx.sceneMatches ?? []).find(
        (m) => m.match.kind === "known" && m.scene.layoutClass === unifiedLayoutClass && m.match.exemplar
      );
      if (known?.match.exemplar) {
        const ex = known.match.exemplar;
        console.log(
          `[clone-style] Scene KB: KNOWN scene ${known.scene.window.t0}-${known.scene.window.t1}s ` +
            `(${known.match.family}, dist ${known.match.distance.toFixed(3)}, exemplar score ${ex.closedLoopScore}%) — recipe available.`
        );
        const shot = ex.renderParams?.targetShotSec;
        if (typeof shot === "number" && Number.isFinite(shot)) {
          ctx.nregionPlan.targetShotSec = Math.min(2.5, Math.max(0.6, shot));
          console.log(`[clone-style] Scene KB: exemplar renderParams applied — targetShotSec ${ctx.nregionPlan.targetShotSec.toFixed(2)}s.`);
        }
      }
    } catch (err) {
      console.error("[clone-style] N-region plan attach failed (falls back to legacy render):", err);
    }
  } else
  try {
    const H = blueprint.canvas.height;
    const ids = Object.keys(dynamicTemplate.layouts);
    const regOf = (id: string) => (dynamicTemplate.layouts[id] as { aroll?: { region?: { y: number; height: number; width: number } } }).aroll?.region;
    const onSide = (side: "top" | "bottom") => ids.find((id) => {
      const r = regOf(id);
      if (!r || !(r.width > 0)) return false;
      const centerY = r.y + r.height / 2;
      return side === "bottom" ? centerY >= H / 2 : centerY < H / 2;
    });
    // Measured side wins when the CANONICAL DECODE reports a confident split; else default
    // BOTTOM. Sourced from refDecode (single source of truth) — same value as measuredLayout.
    const confidentSplit =
      !!refDecode && refDecode.layout.type.value === "split" &&
      refDecode.layout.layoutClass?.value === "two_region_split" &&   // unified cross-check (Wave 1b)
      refDecode.layout.arollSide.confidence >= 0.7;
    const measuredSide = confidentSplit ? (refDecode!.layout.arollSide.value as "top" | "bottom") : "bottom";
    const targetId = onSide(measuredSide) ?? onSide("bottom");
    const source = confidentSplit ? `MEASURED ${measuredSide} (decode conf ${refDecode!.layout.arollSide.confidence})` : "DEFAULT bottom (no confident split measurement)";
    let n = 0, wrongSide = 0;
    if (targetId) {
      for (const range of editingPlan.layoutRanges) {
        if (!range.layoutId.startsWith("rect_pip")) continue;
        // count ranges that were on the OPPOSITE side (the actual inversion caught)
        const rr = regOf(range.layoutId);
        if (rr && rr.width > 0) {
          const wasSide = (rr.y + rr.height / 2) >= H / 2 ? "bottom" : "top";
          if (wasSide !== measuredSide) wrongSide++;
        }
        if (range.layoutId !== targetId) { range.layoutId = targetId; n++; }
      }
    }
    console.log(`[clone-style] A-roll position: ${n} rect_pip range(s) snapped → consistent ${measuredSide.toUpperCase()} (${targetId}) [${source}]; ${wrongSide} range(s) were on the wrong side (inversion corrected).`);

    // GEOMETRY override: replace the chosen layout's A-roll/B-roll REGIONS with the
    // MEASURED regions (divider proportions), so the render matches the reference's
    // actual band/square proportions — not a hardcoded 1:1 square. High-confidence
    // split only; the renderer now respects these region dimensions.
    if (targetId && confidentSplit && refDecode) {
      const tl = (dynamicTemplate.layouts as Record<string, { aroll?: { region?: unknown }; broll?: { region?: unknown } }>)[targetId];
      const aR = refDecode.layout.arollRegion.value, bR = refDecode.layout.brollRegion.value;
      if (tl?.aroll) tl.aroll.region = { ...aR };
      if (tl?.broll) tl.broll.region = { ...bR };
      console.log(`[clone-style] Layout geometry: ${targetId} regions ← MEASURED (A-roll ${aR.width}x${aR.height}@y${aR.y}, B-roll ${bR.width}x${bR.height}@y${bR.y}, divider ${refDecode.layout.dividerFraction.value}).`);
    }
  } catch (err) {
    console.error("[clone-style] A-roll position step failed (non-blocking):", err);
  }

  // ── Reference B-roll STYLE (informs the Creative Director) ──
  // Classify what KIND of B-roll the reference uses (realistic_person /
  // motion_graphics / product / cartoon …) so we replicate its STYLE, not its
  // content. Cached in sp-temp. A realistic-dominant reference → motion
  // graphics stay a LIGHT accent; a graphics-heavy reference → use more.
  let referenceStyle: BrollStyleResult | null = null;
  try {
    const styleCachePath = path.join(tempDir, "broll-style.json");
    if (fs.existsSync(styleCachePath)) {
      referenceStyle = JSON.parse(fs.readFileSync(styleCachePath, "utf8"));
    } else {
      referenceStyle = await classifyReferenceBrollStyle(refPath);
      if (referenceStyle) fs.writeFileSync(styleCachePath, JSON.stringify(referenceStyle, null, 2));
    }
    if (referenceStyle) {
      console.log(`[clone-style] Reference B-roll style: ${referenceStyle.dominant} → ${STYLE_TO_MODALITY[referenceStyle.dominant]} (${referenceStyle.styles.map((s) => `${s.style} ${Math.round(s.share * 100)}%`).join(", ")})`);
    }
  } catch (err) {
    console.error("[clone-style] B-roll style classification failed (non-blocking):", err);
  }

  // ── B-roll Planner (Steps 1–3): the single OWNER of the deliberate B-roll plan ──
  // Produces one explicit, inspectable plan (cadence-timed slots · per-beat modality ·
  // keyword anchor · layout) and generates a Kling prompt per footage slot. Saved to
  // sp-temp/broll-plan.json. Drives the creative director below (the "breathe" veto).
  let plannedModalityOf: Record<number, string> | undefined;
  let brollSlots: Parameters<typeof applyCreativeDirector>[1]["brollSlots"];
  try {
    const phaseOf: Record<number, string> = {};
    for (const p of narrativeContext?.narrativePhases ?? []) for (const i of p.sentenceIndices ?? []) phaseOf[i] = p.phase;
    const keywordsOf: Record<number, string[]> = {};
    for (const sk of speechKeywords?.sentences ?? []) keywordsOf[sk.index] = sk.keywords ?? [];
    const sents = (mergedTranscription.sentences ?? []) as Array<{ text: string; start: number; end: number }>;
    const brollPlan = planBroll({
      beats: sents.map((s, i) => ({ index: i, text: s.text, start: s.start, end: s.end })),
      words: (mergedTranscription.words ?? []) as Array<{ word: string; start: number; end: number }>,
      keywordsOf,
      phaseOf,
      cadence: planCadence(cadenceRhythm),
      referenceStyle: referenceStyle?.dominant,
    });
    plannedModalityOf = brollPlan.modalityByBeat as Record<number, string>;
    brollSlots = brollPlan.slots;

    // Region-fit framing: MEASURE the B-roll region (the dominant/largest layout band)
    // so generated clips match it (1:1 / wide) with the right shot type — instead of
    // 9:16 close-ups whose heads get cropped into the band.
    let framing: ReturnType<typeof framingForRegion> | undefined;
    try {
      // Prefer the CV-MEASURED B-roll region (authoritative, resolves the side
      // inversion) over the template's invertible estimate; fall back to template.
      let region: { width: number; height: number } | undefined;
      if (measuredLayout?.layout.brollRegion?.width && measuredLayout.layout.brollRegion.height) {
        region = measuredLayout.layout.brollRegion;
        console.log(`[clone-style] B-roll region from Layout Analyzer (measured): ${region.width}x${region.height}`);
      } else {
        const lys = (dynamicTemplate as unknown as { layouts?: Record<string, { broll?: { region?: { width?: number; height?: number } } }> }).layouts ?? {};
        const regions = Object.values(lys).map((l) => l.broll?.region).filter((r): r is { width: number; height: number } => !!r?.width && !!r?.height);
        region = regions.sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (region) console.log(`[clone-style] B-roll region from template (analyzer unavailable): ${region.width}x${region.height}`);
      }
      if (region) { framing = framingForRegion(region, true); console.log(`[clone-style] B-roll framing: ${framing.reason}`); }
    } catch (e) { console.error("[clone-style] framing (non-blocking):", e); }

    // Step 3: generate a Kling prompt for each footage slot (cached; non-blocking).
    // CACHE READ-BACK (audit fix): a cached broll-plan.json carries the enriched prompts
    // AND any offline-generated clipPaths — merge them back into the fresh plan instead of
    // clobbering the file with a promptless plan (the old bug destroyed both).
    const planPath = path.join(tempDir, "broll-plan.json");
    if (fs.existsSync(planPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(planPath, "utf8")) as { slots?: Array<{ id: string; prompt?: string; negative?: string; clipPath?: string }> };
        const byId = new Map((cached.slots ?? []).map((s) => [s.id, s]));
        let merged = 0;
        for (const slot of brollPlan.slots) {
          const c = byId.get(slot.id);
          if (!c) continue;
          if (c.prompt && !slot.prompt) { slot.prompt = c.prompt; slot.negative = c.negative; merged++; }
          if (c.clipPath && !slot.clipPath) { slot.clipPath = c.clipPath; merged++; }
        }
        if (merged) console.log(`[clone-style] B-roll plan cache: merged ${merged} cached prompt/clipPath field(s) back into the plan.`);
      } catch (e) { console.error("[clone-style] broll-plan cache read-back failed (non-blocking):", e); }
    }
    const needsPrompts = brollPlan.slots.some((s) => s.modality === "ai_footage" && !s.prompt);
    if (needsPrompts) {
      try {
        const callLLM = async (instr: string) => (await geminiFlash.generateContent(instr)).response.text();
        const filled = await enrichFootagePrompts(brollPlan.slots, callLLM, { style: referenceStyle?.dominant, framing, beatTextOf: (i) => sents[i]?.text });
        console.log(`[clone-style] B-roll prompt engine: ${filled} footage prompt(s) generated`);
      } catch (e) { console.error("[clone-style] prompt engine (non-blocking):", e); }
    }
    fs.writeFileSync(planPath, JSON.stringify(brollPlan, null, 2));
    console.log(`[clone-style] B-roll plan: ${brollPlan.summary.total} slots ${JSON.stringify(brollPlan.summary.byModality)} | cadence ${brollPlan.summary.targetShotSec}s (${brollPlan.summary.cadenceSource}) | coverage ${brollPlan.summary.coveragePct}%`);
  } catch (err) {
    console.error("[clone-style] B-roll planner failed (non-blocking):", err);
  }

  // ── Creative Director: auto-route motion-graphics B-roll onto beats ──
  // Reads narrative phases + numbers and RENDERS/PINS motion graphics
  // (stat / kinetic text / Ken Burns) at the right beats; footage elsewhere.
  // Programmatic Remotion render (bundle-once, content-hash cached).
  try {
    sendSSE({ phase: "building_plan", progress: 58, message: "Creative director: routing motion graphics..." });
    const genDir = path.join(process.cwd(), "public", "uploads", "generated", "mg-auto");
    const stillAbs = path.join(process.cwd(), "public", "uploads", "generated", "still-hero.jpg");
    const cd = await applyCreativeDirector(
      editingPlan as unknown as Parameters<typeof applyCreativeDirector>[0],
      {
        narrativeContext: (narrativeContext ?? null) as Parameters<typeof applyCreativeDirector>[1]["narrativeContext"],
        speechKeywords: (speechKeywords ?? null) as Parameters<typeof applyCreativeDirector>[1]["speechKeywords"],
        genDir,
        kenBurnsStill: fs.existsSync(stillAbs) ? "uploads/generated/still-hero.jpg" : undefined,
        // family omitted → creative-director selects it from the motion-design library by reference class
        referenceStyle: referenceStyle?.dominant,
        words: (mergedTranscription.words ?? []) as Array<{ word: string; start: number; end: number }>,
        plannedModalityOf,
        brollSlots,
      }
    );
    console.log(`[clone-style] Creative director: ${cd.pinned} MG beat(s) pinned — ${cd.routes.join(" ")}`);
  } catch (err) {
    console.error("[clone-style] creative director failed (non-blocking):", err);
  }

  // ── #3: Cross-modal verification ──
  // Verify that each (sentence, B-roll) match actually makes sense.
  // Bad matches (score < 70) are logged for future re-matching.
  if (narrativeContext && allBrollScenes.length > 0) {
    try {
      sendSSE({ phase: "building_plan", progress: 57, message: "Verifying content matches..." });
      const matchPairs = editingPlan.layoutRanges.map((range) => {
        const sceneIdx = range.brollSourceIndex ?? 0;
        const scene = allBrollScenes[sceneIdx] ?? allBrollScenes[0];
        return {
          sentenceIndex: range.sentences[0]?.index ?? 0,
          sentenceText: range.sentences.map(s => s.text).join(" "),
          sceneIndex: sceneIdx,
          sceneDescription: scene?.description ?? "",
          sceneTags: scene?.contentTags ?? [],
          sceneOcrText: (scene as any)?.visibleText,
        };
      });

      const verification = await verifyMatches(matchPairs);

      // Save verification results for debugging
      fs.writeFileSync(
        path.join(tempDir, "match-verification.json"),
        JSON.stringify(verification, null, 2)
      );

      const badMatches = verification.pairs.filter(p => !p.isGoodMatch);
      if (badMatches.length > 0) {
        console.log(`[clone-style] ${badMatches.length} weak B-roll matches detected (overall: ${verification.overallScore}%)`);
        for (const bad of badMatches) {
          console.log(`  S${bad.sentenceIndex}→B${bad.sceneIndex}: ${bad.score}% — ${bad.suggestion ?? "no suggestion"}`);
        }
      } else {
        console.log(`[clone-style] All B-roll matches verified (${verification.overallScore}%)`);
      }
    } catch (err) {
      console.error("[clone-style] Match verification failed (non-blocking):", err);
    }
  }

  // Save plan for debugging
  fs.writeFileSync(
    path.join(tempDir, "dynamic-plan.json"),
    JSON.stringify(editingPlan, null, 2)
  );

  // ── Write phase outputs back to the shared ctx ──
  ctx.editingPlan = editingPlan;
  ctx.referenceStyle = referenceStyle;
  ctx.plannedModalityOf = plannedModalityOf;
  ctx.brollSlots = brollSlots;
}
