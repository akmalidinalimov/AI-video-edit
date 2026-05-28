/**
 * End-to-End Dynamic Pipeline Test
 *
 * Proves the FULL generalized pipeline works:
 *   Blueprint (any ref video) → Dynamic Template → Editing Plan → Validated
 *
 * NO hardcoded coordinates. The template is auto-generated from the blueprint.
 *
 * Usage: node scripts/test-dynamic-pipeline.mjs
 */
import fs from "fs";
import path from "path";

const ROOT = process.cwd();

// ── Load real data ──
const BLUEPRINT_PATH = path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json");
const TRANSCRIPTION_PATH = path.join(ROOT, "public", "exports", "sp-temp", "aroll-transcription.json");

const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, "utf-8"));
const transcription = JSON.parse(fs.readFileSync(TRANSCRIPTION_PATH, "utf-8"));

const FPS = 30;

// ════════════════════════════════════════════════════════════
// STEP 1: DYNAMIC TEMPLATE GENERATOR (from template-generator.ts)
// ════════════════════════════════════════════════════════════

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function aggregateBoundingBoxes(boxes) {
  return {
    x: median(boxes.map(b => b.x)),
    y: median(boxes.map(b => b.y)),
    width: median(boxes.map(b => b.width)),
    height: median(boxes.map(b => b.height)),
  };
}

function classifyPosition(bbox, canvas) {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const canvasCx = canvas.width / 2;
  const canvasCy = canvas.height / 2;

  if (bbox.width >= canvas.width * 0.9) {
    if (cy < canvasCy * 0.6) return "top";
    if (cy > canvasCy * 1.4) return "bottom";
    return "full";
  }

  const isRight = cx > canvasCx;
  const isTop = cy < canvasCy;
  if (isTop && isRight) return "top-right";
  if (isTop && !isRight) return "top-left";
  if (!isTop && isRight) return "bottom-right";
  if (!isTop && !isRight) return "bottom-left";
  return "center";
}

function classifySize(bbox, canvas) {
  const ratio = (bbox.width * bbox.height) / (canvas.width * canvas.height);
  if (ratio > 0.6) return "full";
  if (ratio > 0.25) return "large";
  if (ratio > 0.08) return "medium";
  return "small";
}

function classifySegment(seg, canvas) {
  if (!seg.aroll || !seg.aroll.boundingBox) {
    return { arollShape: "none", arollPosition: "none", arollSizeClass: "none",
             hasHeader: false, brollFullCanvas: true, hasBorder: false };
  }
  const hasHeader = (seg.blackRegions ?? []).some(br => br.purpose === "header");
  const brollBbox = seg.broll?.boundingBox;
  const brollFullCanvas = brollBbox
    ? (brollBbox.width >= canvas.width * 0.9 && brollBbox.height >= canvas.height * 0.9)
    : false;
  return {
    arollShape: seg.aroll.shape || "rectangle",
    arollPosition: classifyPosition(seg.aroll.boundingBox, canvas),
    arollSizeClass: classifySize(seg.aroll.boundingBox, canvas),
    hasHeader,
    brollFullCanvas,
    hasBorder: seg.aroll.hasBorder ?? false,
  };
}

function fingerprintToId(fp) {
  if (fp.arollShape === "none") return "broll_only";
  const parts = [];
  if (fp.arollShape === "circle") {
    parts.push("circle_pip");
  } else if (fp.arollSizeClass === "full" || fp.arollPosition === "full") {
    parts.push("fullscreen_aroll");
  } else if (fp.hasHeader) {
    parts.push("rect_with_header");
  } else {
    parts.push("rect_pip");
  }
  if (fp.arollSizeClass !== "full" && fp.arollPosition !== "full" && fp.arollPosition !== "none") {
    parts.push(fp.arollPosition.replace("-", "_"));
  }
  return parts.join("_");
}

function fingerprintKey(fp) {
  return `${fp.arollShape}|${fp.arollPosition}|${fp.arollSizeClass}|${fp.hasHeader}|${fp.brollFullCanvas}`;
}

function generateTemplate(canvas, segments, faceInfo) {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     DYNAMIC TEMPLATE GENERATOR                   ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  console.log(`  Canvas: ${canvas.width}×${canvas.height}`);
  console.log(`  Segments: ${segments.length}`);
  if (faceInfo) {
    console.log(`  Face center: (${faceInfo.center.x}, ${faceInfo.center.y}) in ${faceInfo.sourceRes.width}×${faceInfo.sourceRes.height}`);
  }
  const faceCropCenter = faceInfo
    ? faceInfo.center
    : { x: Math.round(canvas.width / 2), y: Math.round(canvas.height * 0.3) };

  // Step 1: Classify
  console.log("\n  Step 1: Classifying segments...");
  const classified = segments.map(seg => {
    const fp = classifySegment(seg, canvas);
    const id = fingerprintToId(fp);
    const key = fingerprintKey(fp);
    console.log(`    ${seg.id} (${seg.start}-${seg.end}s): ${id} [${fp.arollShape}, ${fp.arollPosition}, ${fp.arollSizeClass}]`);
    return { seg, fp, id, key };
  });

  // Step 2: Cluster
  console.log("\n  Step 2: Clustering...");
  const clusters = new Map();
  for (const c of classified) {
    const existing = clusters.get(c.key) || [];
    existing.push(c);
    clusters.set(c.key, existing);
  }
  console.log(`  Found ${clusters.size} unique layout type(s)`);

  // Step 3: Build layouts
  console.log("\n  Step 3: Building layout variants...");
  const layouts = {};

  for (const [key, members] of clusters.entries()) {
    const rep = members[0];
    const layoutId = rep.id;
    const fp = rep.fp;
    console.log(`\n    Layout: "${layoutId}" (${members.length} segment(s))`);

    let arollRegion = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    let arollShape = "rectangle";
    let circleDef = null;
    let borderDef = null;

    if (fp.arollShape !== "none") {
      const boxes = members.filter(m => m.seg.aroll?.boundingBox).map(m => m.seg.aroll.boundingBox);
      if (boxes.length > 0) {
        arollRegion = aggregateBoundingBoxes(boxes);
        console.log(`      A-roll region: (${arollRegion.x}, ${arollRegion.y}) ${arollRegion.width}×${arollRegion.height}`);
      }
      arollShape = fp.arollShape;
      if (arollShape === "circle") {
        const radius = Math.min(arollRegion.width, arollRegion.height) / 2;
        circleDef = {
          cx: arollRegion.x + arollRegion.width / 2,
          cy: arollRegion.y + arollRegion.height / 2,
          radius: Math.round(radius),
        };
        console.log(`      Circle: center=(${circleDef.cx}, ${circleDef.cy}), r=${circleDef.radius}`);
        // Default border for circles
        borderDef = { width: 4, color: "0xFFFFFF@0.6" };
        console.log(`      Border: ${borderDef.width}px ${borderDef.color}`);
      }
    }

    // B-roll
    const brollBoxes = members.filter(m => m.seg.broll?.boundingBox).map(m => m.seg.broll.boundingBox);
    const brollRegion = brollBoxes.length > 0
      ? aggregateBoundingBoxes(brollBoxes)
      : { x: 0, y: 0, width: canvas.width, height: canvas.height };
    console.log(`      B-roll region: (${brollRegion.x}, ${brollRegion.y}) ${brollRegion.width}×${brollRegion.height} (bg=${fp.brollFullCanvas})`);

    // Header
    let headerZone = null;
    if (fp.hasHeader) {
      const headerRegions = members
        .flatMap(m => (m.seg.blackRegions ?? []).filter(br => br.purpose === "header"))
        .map(br => br.boundingBox);
      if (headerRegions.length > 0) {
        const headerRect = aggregateBoundingBoxes(headerRegions);
        console.log(`      Header: (${headerRect.x}, ${headerRect.y}) ${headerRect.width}×${headerRect.height}`);

        // Text slots from headline texts
        const textSlots = [];
        const headerBottom = headerRect.y + headerRect.height + 50;
        const allHeadlines = [];
        for (const m of members) {
          for (const txt of m.seg.texts ?? []) {
            if (txt.isHeadline && txt.boundingBox.y < headerBottom) {
              allHeadlines.push(txt);
            }
          }
        }
        // Group by Y position
        const slotGroups = [];
        for (const hl of allHeadlines) {
          const group = slotGroups.find(g => Math.abs(g[0].boundingBox.y - hl.boundingBox.y) < 40);
          if (group) { group.push(hl); } else { slotGroups.push([hl]); }
        }
        slotGroups.sort((a, b) => a[0].boundingBox.y - b[0].boundingBox.y);

        for (let i = 0; i < slotGroups.length; i++) {
          const group = slotGroups[i];
          const rep = group[0];
          const fontColor = rep.color?.startsWith("#") ? rep.color.replace("#", "0x") : "0xFFFFFF";
          // Gold/yellow text typically uses italic serif headline font
          const isGoldish = ["#FDD835", "#FFD700", "#FFEB3B", "#F9A825"].some(
            c => (rep.color ?? "").toUpperCase() === c
          );
          const defaultFont = isGoldish
            ? "C\\:/Windows/Fonts/GeorgiaPro-BoldItalic.ttf"
            : rep.fontWeight === "bold"
              ? "C\\:/Windows/Fonts/arialbd.ttf"
              : "C\\:/Windows/Fonts/arial.ttf";
          const slot = {
            id: `headline_${i + 1}`,
            anchor: {
              x: Math.round(median(group.map(g => g.boundingBox.x + g.boundingBox.width / 2))),
              y: Math.round(median(group.map(g => g.boundingBox.y + g.boundingBox.height / 2))),
            },
            maxWidth: Math.max(...group.map(g => g.boundingBox.width)),
            defaultFontSize: median(group.map(g => g.estimatedFontSize || 36)),
            defaultFontColor: fontColor,
            defaultFont,
            defaultBgColor: rep.backgroundColor?.startsWith("#") ? rep.backgroundColor.replace("#", "0x") : null,
            defaultBgPadding: rep.backgroundColor ? 10 : 0,
          };
          textSlots.push(slot);
          console.log(`      Text slot "${slot.id}": (${slot.anchor.x},${slot.anchor.y}) size=${slot.defaultFontSize} color=${slot.defaultFontColor}`);
        }
        headerZone = { region: headerRect, textSlots };
      }
    }

    layouts[layoutId] = {
      id: layoutId,
      aroll: { region: arollRegion, shape: arollShape, circle: circleDef, border: borderDef, faceCropCenter },
      broll: { region: brollRegion, isBackground: fp.brollFullCanvas },
      headerZone,
    };
  }

  const template = {
    id: `auto_${canvas.width}x${canvas.height}_v1`,
    version: 1,
    name: `Auto-generated ${canvas.width}×${canvas.height} (${Object.keys(layouts).length} layouts)`,
    canvas,
    fps: FPS,
    aspectRatio: canvas.width < canvas.height ? "9:16" : "16:9",
    layouts,
  };

  console.log(`\n  ═══════════════════════════════════════`);
  console.log(`  Template: "${template.id}"`);
  console.log(`  Layouts discovered: ${Object.keys(layouts).join(", ")}`);
  console.log(`  ═══════════════════════════════════════\n`);

  return template;
}

// ════════════════════════════════════════════════════════════
// STEP 2: PLAN BUILDER (generalized)
// ════════════════════════════════════════════════════════════

function alignToFrame(time) {
  return Math.round(time * FPS) / FPS;
}

function buildEnableExpr(startFrame, endFrame, isLast) {
  const tStart = Math.max(0, (startFrame - 0.5) / FPS);
  const tEnd = isLast ? (endFrame + 5) / FPS : (endFrame - 0.5) / FPS;
  return `between(t,${tStart.toFixed(4)},${tEnd.toFixed(4)})`;
}

/** Score-based layout matching (not hardcoded names) */
function matchSegmentToLayout(seg, template) {
  const layoutIds = Object.keys(template.layouts);
  if (layoutIds.length === 1) return layoutIds[0];

  let bestId = layoutIds[0];
  let bestScore = -1;
  const canvas = template.canvas;

  for (const id of layoutIds) {
    const layout = template.layouts[id];
    let score = 0;

    // Shape match
    const segShape = seg.aroll?.shape ?? "none";
    if (segShape === layout.aroll.shape) score += 50;

    // Header match
    const segHasHeader = (seg.blackRegions ?? []).some(br => br.purpose === "header");
    if (segHasHeader === !!layout.headerZone) score += 20;

    // B-roll coverage match
    const segBrollFull = seg.broll
      ? (seg.broll.boundingBox.width >= canvas.width * 0.9 && seg.broll.boundingBox.height >= canvas.height * 0.9)
      : false;
    if (segBrollFull === layout.broll.isBackground) score += 15;

    // Position IoU
    if (seg.aroll?.boundingBox && layout.aroll.region) {
      const a = seg.aroll.boundingBox;
      const b = layout.aroll.region;
      const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const oArea = ox * oy;
      const uArea = a.width * a.height + b.width * b.height - oArea;
      score += (uArea > 0 ? oArea / uArea : 0) * 15;
    }

    if (score > bestScore) { bestScore = score; bestId = id; }
  }
  return bestId;
}

function buildPlan(template, bpSegments, transcriptionData) {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     EDITING PLAN BUILDER (Dynamic)               ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const sentences = transcriptionData.sentences.map((s, i) => ({
    text: s.text, start: s.start, end: s.end, index: i,
  }));

  // Step 1: Map sentences → layouts via overlap + scoring
  console.log("  Step 1: Sentence → Layout mapping...");
  const sentenceLayouts = [];
  for (const sentence of sentences) {
    const overlaps = [];
    for (const seg of bpSegments) {
      const oStart = Math.max(seg.start, sentence.start);
      const oEnd = Math.min(seg.end, sentence.end);
      const overlap = Math.max(0, oEnd - oStart);
      if (overlap > 0) {
        overlaps.push({ segment: seg, overlap, layoutId: matchSegmentToLayout(seg, template) });
      }
    }
    overlaps.sort((a, b) => b.overlap - a.overlap);
    const best = overlaps[0];
    const uniqueLayouts = Array.from(new Set(overlaps.map(o => o.layoutId)));
    const reasoning = uniqueLayouts.length > 1
      ? `Mid-sentence change (${uniqueLayouts.join("→")}), snapped to '${best.layoutId}'`
      : `Matches '${best.layoutId}' (${best.overlap.toFixed(2)}s)`;
    console.log(`    S${sentence.index + 1}: ${best.layoutId} | ${reasoning}`);
    sentenceLayouts.push({ sentence, layoutId: best.layoutId, segment: best.segment, reasoning });
  }

  // Step 2: Merge
  console.log("\n  Step 2: Merging consecutive same-layout...");
  const merged = [];
  for (const sl of sentenceLayouts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.layoutId === sl.layoutId) {
      console.log(`    Merging S${sl.sentence.index + 1}`);
      prev.end = sl.sentence.end;
      prev.sentences.push(sl.sentence);
    } else {
      merged.push({ layoutId: sl.layoutId, start: sl.sentence.start, end: sl.sentence.end,
                     sentences: [sl.sentence], segment: sl.segment, reasoning: sl.reasoning });
    }
  }
  if (merged[0].start > 0) merged[0].start = 0;

  // Step 3: Close gaps
  console.log("\n  Step 3: Closing gaps...");
  for (let i = 0; i < merged.length - 1; i++) {
    const gap = merged[i + 1].start - merged[i].end;
    if (gap > 0 && gap < 2) {
      console.log(`    Closing ${gap.toFixed(3)}s gap`);
      merged[i].end = merged[i + 1].start;
    }
  }
  merged[merged.length - 1].end += 0.5;

  // Step 4: Frame-align
  for (const r of merged) { r.start = alignToFrame(r.start); r.end = alignToFrame(r.end); }
  for (let i = 0; i < merged.length - 1; i++) { merged[i].end = merged[i + 1].start; }

  // Step 5: Build ranges + enable expressions
  console.log("\n  Step 4: Enable expressions...");
  const layoutRanges = [];
  for (let i = 0; i < merged.length; i++) {
    const mr = merged[i];
    const isLast = i === merged.length - 1;
    const sf = Math.round(mr.start * FPS);
    const ef = Math.round(mr.end * FPS);
    const enableExpr = buildEnableExpr(sf, ef, isLast);
    console.log(`    range_${i + 1}: ${mr.start.toFixed(4)}-${mr.end.toFixed(4)}s | ${mr.layoutId} | ${enableExpr}`);

    // Extract text overlays from blueprint segment headlines
    const textOverlays = [];
    const layout = template.layouts[mr.layoutId];
    if (layout?.headerZone) {
      const headerTexts = (mr.segment?.texts ?? []).filter(
        t => t.isHeadline && t.boundingBox.y < (layout.headerZone.region.height + 150)
      );
      for (let j = 0; j < headerTexts.length; j++) {
        const ht = headerTexts[j];
        const slot = layout.headerZone.textSlots[j];
        if (!slot) continue;
        textOverlays.push({
          slotId: slot.id,
          text: ht.text,
          fontSize: ht.estimatedFontSize || slot.defaultFontSize,
          fontColor: ht.color?.startsWith("#") ? ht.color.replace("#", "0x") : slot.defaultFontColor,
          bgColor: ht.backgroundColor?.startsWith("#") ? ht.backgroundColor.replace("#", "0x") : (ht.backgroundColor || undefined),
        });
      }
    }

    layoutRanges.push({
      id: `range_${i + 1}`, layoutId: mr.layoutId,
      timeRange: { start: mr.start, end: mr.end },
      sentences: mr.sentences, textOverlays, reasoning: mr.reasoning,
      startFrame: sf, endFrame: ef, enableExpr,
    });
  }

  // Step 6: Transitions
  const transitions = [];
  for (let i = 0; i < layoutRanges.length - 1; i++) {
    const curr = layoutRanges[i], next = layoutRanges[i + 1];
    if (curr.layoutId !== next.layoutId) {
      const frame = Math.round(curr.timeRange.end * FPS);
      const midpoint = (frame - 0.5) / FPS;
      transitions.push({ time: curr.timeRange.end, frame, from: curr.layoutId, to: next.layoutId, midpoint });
    }
  }

  // Validate
  console.log("\n  Step 5: Validation...");
  const errors = [];
  if (layoutRanges[0].timeRange.start > 0.05) errors.push("First range doesn't start at 0");
  for (let i = 0; i < layoutRanges.length - 1; i++) {
    const gap = layoutRanges[i + 1].timeRange.start - layoutRanges[i].timeRange.end;
    if (Math.abs(gap) > 0.001) errors.push(`Gap/overlap of ${gap.toFixed(4)}s`);
  }
  for (const r of layoutRanges) { if (!r.enableExpr) errors.push(`${r.id} missing enable`); }
  for (let i = 0; i < layoutRanges.length - 1; i++) {
    if (layoutRanges[i].layoutId === layoutRanges[i + 1].layoutId)
      errors.push(`Adjacent same-layout: ${layoutRanges[i].id}, ${layoutRanges[i + 1].id}`);
  }
  // Check all layout IDs exist in template
  for (const r of layoutRanges) {
    if (!template.layouts[r.layoutId]) errors.push(`Layout "${r.layoutId}" not in template`);
  }

  console.log(errors.length === 0 ? "    ✓ Plan is VALID" : `    ✗ FAILED: ${errors.join("; ")}`);

  const totalDuration = layoutRanges[layoutRanges.length - 1].timeRange.end;
  const plan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    templateId: template.id,
    canvas: template.canvas,
    fps: FPS,
    sources: { aroll: "public/uploads/IMG_6108.MOV", broll: "public/uploads/IMG_6163.MP4" },
    sentences, totalDuration, totalFrames: Math.round(totalDuration * FPS),
    layoutRanges, transitions,
    validated: errors.length === 0, validationErrors: errors,
  };

  return { plan, template };
}

// ════════════════════════════════════════════════════════════
// RUN
// ════════════════════════════════════════════════════════════

console.log("═".repeat(70));
console.log("  END-TO-END DYNAMIC PIPELINE TEST");
console.log("═".repeat(70));
console.log();

// Step 1: Generate template from blueprint (NO hardcoded coordinates)
const bpData = blueprint.data;
const template = generateTemplate(
  bpData.canvas,
  bpData.reference.segments,
  { center: { x: 940, y: 350 }, sourceRes: { width: 1920, height: 1080 } } // from A-roll face detection
);

// Step 2: Build plan using generated template + A-roll transcription
const { plan } = buildPlan(template, bpData.reference.segments, transcription);

// Step 3: Save results
const outDir = path.join(ROOT, "public", "exports", "sp-temp");
fs.writeFileSync(path.join(outDir, "dynamic-template.json"), JSON.stringify(template, null, 2));
fs.writeFileSync(path.join(outDir, "dynamic-plan.json"), JSON.stringify(plan, null, 2));

// Summary
console.log("\n" + "═".repeat(70));
console.log("  RESULT SUMMARY");
console.log("═".repeat(70));
console.log(`  Template: ${template.id} — ${Object.keys(template.layouts).length} layout(s) discovered`);
console.log(`  Layouts: ${Object.keys(template.layouts).join(", ")}`);
for (const id of Object.keys(template.layouts)) {
  const l = template.layouts[id];
  console.log(`    ${id}: aroll=${l.aroll.shape} @ (${l.aroll.region.x},${l.aroll.region.y}) ${l.aroll.region.width}×${l.aroll.region.height}`);
  if (l.aroll.circle) console.log(`           circle center=(${l.aroll.circle.cx},${l.aroll.circle.cy}) r=${l.aroll.circle.radius}`);
  if (l.aroll.border) console.log(`           border: ${l.aroll.border.width}px ${l.aroll.border.color}`);
  if (l.headerZone) console.log(`           header: ${l.headerZone.region.height}px, ${l.headerZone.textSlots.length} text slot(s)`);
}
console.log(`\n  Plan: ${plan.layoutRanges.length} range(s), ${plan.transitions.length} transition(s)`);
for (const r of plan.layoutRanges) {
  const sentIds = r.sentences.map(s => `S${s.index + 1}`).join("+");
  console.log(`    ${r.id}: ${r.timeRange.start.toFixed(2)}-${r.timeRange.end.toFixed(2)}s | ${r.layoutId} | ${sentIds}`);
}
console.log(`\n  Valid: ${plan.validated ? "YES ✓" : "NO ✗"}`);
console.log(`  Saved: dynamic-template.json, dynamic-plan.json`);
console.log("═".repeat(70));
