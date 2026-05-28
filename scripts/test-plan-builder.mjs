/**
 * Integration test: Generate an editing plan from real blueprint + transcription data.
 *
 * This proves Phase 2 works end-to-end:
 *   blueprint + transcription + VCS template → validated editing plan
 *
 * Usage: node scripts/test-plan-builder.mjs
 */
import fs from "fs";
import path from "path";

const ROOT = process.cwd();

// ── Load real data ──

const BLUEPRINT_PATH = path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json");
const TRANSCRIPTION_PATH = path.join(ROOT, "public", "exports", "sp-temp", "aroll-transcription.json");

const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, "utf-8"));
const transcription = JSON.parse(fs.readFileSync(TRANSCRIPTION_PATH, "utf-8"));

// ── Inline the VCS template & plan builder logic (ESM scripts can't import .ts) ──

const FPS = 30;

function alignToFrame(time, fps = FPS) {
  return Math.round(time * fps) / fps;
}

function frameMidpoint(frame, fps = FPS) {
  return (frame - 0.5) / fps;
}

function buildEnableExprForRange(startFrame, endFrame, isLast, fps = FPS) {
  const tStart = Math.max(0, (startFrame - 0.5) / fps);
  const tEnd = isLast ? (endFrame + 5) / fps : (endFrame - 0.5) / fps;
  return `between(t,${tStart.toFixed(4)},${tEnd.toFixed(4)})`;
}

// ── Layout mapping ──

function mapBlueprintToTemplateLayout(segment) {
  const isRectangleAroll =
    segment.aroll?.shape === "rectangle" &&
    (segment.blackRegions?.length ?? 0) > 0 &&
    (segment.aroll?.boundingBox.width ?? 0) >= 800;

  if (isRectangleAroll) return "rect_header";
  if (segment.aroll?.shape === "circle") return "circle_pip";
  return "circle_pip"; // default
}

// ── Build plan ──

function buildPlan(bpSegments, transcriptionData) {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         EDITING PLAN BUILDER — TEST              ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const sentences = transcriptionData.sentences.map((s, i) => ({
    text: s.text,
    start: s.start,
    end: s.end,
    index: i,
  }));

  console.log("  ── INPUT ──");
  console.log(`  Blueprint segments: ${bpSegments.length}`);
  for (const seg of bpSegments) {
    const layoutId = mapBlueprintToTemplateLayout(seg);
    console.log(`    ${seg.id}: ${seg.start}-${seg.end}s | ${layoutId} (shape: ${seg.aroll?.shape})`);
  }
  console.log(`  Sentences: ${sentences.length}`);
  for (const s of sentences) {
    const preview = s.text.length > 55 ? s.text.slice(0, 52) + "..." : s.text;
    console.log(`    S${s.index + 1}: ${s.start.toFixed(2)}-${s.end.toFixed(2)}s | "${preview}"`);
  }
  console.log();

  // Step 1: Map sentences to layouts
  console.log("  ── STEP 1: Sentence → Layout mapping ──");

  const sentenceLayouts = [];
  for (const sentence of sentences) {
    const overlaps = [];
    for (const seg of bpSegments) {
      const overlapStart = Math.max(seg.start, sentence.start);
      const overlapEnd = Math.min(seg.end, sentence.end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      if (overlap > 0) {
        overlaps.push({
          segment: seg,
          overlap,
          layoutId: mapBlueprintToTemplateLayout(seg),
        });
      }
    }
    overlaps.sort((a, b) => b.overlap - a.overlap);
    const best = overlaps[0];
    const uniqueLayouts = Array.from(new Set(overlaps.map(o => o.layoutId)));

    let reasoning;
    if (uniqueLayouts.length > 1) {
      reasoning = `Mid-sentence change (${uniqueLayouts.join("→")}), snapped to '${best.layoutId}'`;
    } else {
      reasoning = `Matches '${best.layoutId}' (${best.overlap.toFixed(2)}s)`;
    }

    console.log(`    S${sentence.index + 1}: ${best.layoutId} | ${reasoning}`);
    sentenceLayouts.push({ sentence, layoutId: best.layoutId, segment: best.segment, reasoning });
  }

  // Step 2: Merge
  console.log("\n  ── STEP 2: Merge consecutive same-layout ──");
  const merged = [];
  for (const sl of sentenceLayouts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.layoutId === sl.layoutId) {
      console.log(`    Merging S${sl.sentence.index + 1} into previous`);
      prev.end = sl.sentence.end;
      prev.sentences.push(sl.sentence);
    } else {
      merged.push({
        layoutId: sl.layoutId,
        start: sl.sentence.start,
        end: sl.sentence.end,
        sentences: [sl.sentence],
        segment: sl.segment,
        reasoning: sl.reasoning,
      });
    }
  }

  // Ensure first starts at 0
  if (merged[0].start > 0) merged[0].start = 0;

  // Step 3: Close gaps
  console.log("\n  ── STEP 3: Close gaps ──");
  for (let i = 0; i < merged.length - 1; i++) {
    const gap = merged[i + 1].start - merged[i].end;
    if (gap > 0 && gap < 2) {
      console.log(`    Closing ${gap.toFixed(3)}s gap between range ${i + 1} and ${i + 2}`);
      merged[i].end = merged[i + 1].start;
    }
  }
  // Extend last
  merged[merged.length - 1].end += 0.5;

  // Step 4: Frame-align
  console.log("\n  ── STEP 4: Frame alignment ──");
  for (const r of merged) {
    const oldStart = r.start;
    const oldEnd = r.end;
    r.start = alignToFrame(r.start);
    r.end = alignToFrame(r.end);
    if (r.start !== oldStart || r.end !== oldEnd) {
      console.log(`    ${oldStart.toFixed(3)}→${r.start.toFixed(4)}, ${oldEnd.toFixed(3)}→${r.end.toFixed(4)}`);
    }
  }
  for (let i = 0; i < merged.length - 1; i++) {
    merged[i].end = merged[i + 1].start;
  }

  // Step 5: Build layout ranges with enable expressions
  console.log("\n  ── STEP 5: Enable expressions ──");
  const layoutRanges = [];
  for (let i = 0; i < merged.length; i++) {
    const mr = merged[i];
    const isLast = i === merged.length - 1;
    const startFrame = Math.round(mr.start * FPS);
    const endFrame = Math.round(mr.end * FPS);
    const enableExpr = buildEnableExprForRange(startFrame, endFrame, isLast, FPS);

    console.log(`    range_${i + 1}: ${mr.start.toFixed(4)}-${mr.end.toFixed(4)}s (frames ${startFrame}-${endFrame}) | ${mr.layoutId}`);
    console.log(`      enable='${enableExpr}'`);

    layoutRanges.push({
      id: `range_${i + 1}`,
      layoutId: mr.layoutId,
      timeRange: { start: mr.start, end: mr.end },
      sentences: mr.sentences,
      reasoning: mr.reasoning,
      startFrame,
      endFrame,
      enableExpr,
    });
  }

  // Step 6: Transitions
  console.log("\n  ── STEP 6: Transitions ──");
  const transitions = [];
  for (let i = 0; i < layoutRanges.length - 1; i++) {
    const curr = layoutRanges[i];
    const next = layoutRanges[i + 1];
    if (curr.layoutId !== next.layoutId) {
      const transFrame = Math.round(curr.timeRange.end * FPS);
      const midpoint = frameMidpoint(transFrame, FPS);
      console.log(`    @${curr.timeRange.end.toFixed(4)}s (frame ${transFrame}) | ${curr.layoutId} → ${next.layoutId} | midpoint=${midpoint.toFixed(4)}s`);
      transitions.push({
        time: curr.timeRange.end,
        frame: transFrame,
        fromLayoutId: curr.layoutId,
        toLayoutId: next.layoutId,
        midpointTime: midpoint,
      });
    }
  }

  // Step 7: Validate
  console.log("\n  ── STEP 7: Validation ──");

  const errors = [];
  // Check: first range starts at 0
  if (layoutRanges[0].timeRange.start > 0.05) {
    errors.push(`First range starts at ${layoutRanges[0].timeRange.start}, not 0`);
  }
  // Check: no gaps
  for (let i = 0; i < layoutRanges.length - 1; i++) {
    const gap = layoutRanges[i + 1].timeRange.start - layoutRanges[i].timeRange.end;
    if (Math.abs(gap) > 0.001) {
      errors.push(`Gap/overlap of ${gap.toFixed(4)}s between range ${i + 1} and ${i + 2}`);
    }
  }
  // Check: every range has enable expr
  for (const r of layoutRanges) {
    if (!r.enableExpr) errors.push(`Range ${r.id} missing enable expression`);
  }
  // Check: no consecutive same-layout
  for (let i = 0; i < layoutRanges.length - 1; i++) {
    if (layoutRanges[i].layoutId === layoutRanges[i + 1].layoutId) {
      errors.push(`Adjacent ranges ${layoutRanges[i].id} and ${layoutRanges[i + 1].id} same layout`);
    }
  }

  if (errors.length === 0) {
    console.log("    ✓ Plan is VALID");
  } else {
    console.log("    ✗ VALIDATION FAILED:");
    for (const err of errors) console.log(`      - ${err}`);
  }

  // Build plan object
  const totalDuration = layoutRanges[layoutRanges.length - 1].timeRange.end;
  const plan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    templateId: "vertical_9x16_v1",
    canvas: { width: 1080, height: 1920 },
    fps: FPS,
    sources: {
      aroll: "public/uploads/IMG_6108.MOV",
      broll: "public/uploads/IMG_6163.MP4",
      reference: "public/uploads/IMG_6018.MOV",
    },
    sentences,
    totalDuration,
    totalFrames: Math.round(totalDuration * FPS),
    layoutRanges,
    transitions,
    validated: errors.length === 0,
    validationErrors: errors,
  };

  // Save plan
  const planPath = path.join(ROOT, "public", "exports", "sp-temp", "editing-plan.json");
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`\n  Plan saved: ${planPath}`);

  // Summary
  console.log("\n  ╔══════════════════════════════════════════╗");
  console.log("  ║            PLAN SUMMARY                  ║");
  console.log("  ╚══════════════════════════════════════════╝");
  console.log(`  Template: vertical_9x16_v1 (1080×1920 @ 30fps)`);
  console.log(`  Duration: ${totalDuration.toFixed(2)}s (${plan.totalFrames} frames)`);
  console.log(`  Ranges: ${layoutRanges.length}`);
  console.log(`  Transitions: ${transitions.length}`);
  console.log(`  Valid: ${errors.length === 0 ? "YES" : "NO"}`);
  console.log();

  for (const r of layoutRanges) {
    const dur = (r.timeRange.end - r.timeRange.start).toFixed(2);
    const sentIds = r.sentences.map(s => `S${s.index + 1}`).join("+");
    console.log(`    ${r.id}: ${r.timeRange.start.toFixed(2)}-${r.timeRange.end.toFixed(2)}s (${dur}s) | ${r.layoutId} | ${sentIds}`);
  }
  console.log();

  return plan;
}

// ── Run ──
buildPlan(blueprint.data.reference.segments, transcription);
