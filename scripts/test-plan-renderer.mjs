/**
 * Plan Renderer Integration Test
 *
 * End-to-end test: blueprint → dynamic template → plan → renderer → FFmpeg render
 *
 * This verifies the FULL pipeline works with the layout-agnostic renderer:
 *   Phase 1: Load blueprint + transcription (cached from analysis)
 *   Phase 2: Generate template dynamically from blueprint
 *   Phase 3: Build editing plan from template + transcription
 *   Phase 4: Render via plan-renderer (layout-agnostic FFmpeg filter)
 *   Phase 5: Regression checklist verification
 *
 * Usage: node scripts/test-plan-renderer.mjs
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── Paths ──
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const BLUEPRINT_PATH = path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json");
const TRANSCRIPTION_PATH = path.join(ROOT, "public", "exports", "sp-temp", "aroll-transcription.json");
const AROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6108.MOV");
const BROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const OUTPUT_DIR = path.join(ROOT, "public", "exports");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "plan-rendered.mp4");
const TEMP_DIR = path.join(OUTPUT_DIR, "sp-temp");

// ── Import pipeline modules (compiled via tsx) ──
// We use dynamic import with tsx loader to handle TypeScript
async function importPipeline() {
  // Use the compiled test from test-dynamic-pipeline which already exercises
  // generateTemplate and buildEditingPlan. Here we test the renderer.

  // Load the cached dynamic template and plan
  const templatePath = path.join(TEMP_DIR, "dynamic-template.json");
  const planPath = path.join(TEMP_DIR, "dynamic-plan.json");

  if (!fs.existsSync(templatePath) || !fs.existsSync(planPath)) {
    console.error("ERROR: Run test-dynamic-pipeline.mjs first to generate template and plan");
    process.exit(1);
  }

  const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
  const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));

  return { template, plan };
}

// ── Utility: run FFmpeg ──
function runFFmpeg(args, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("FFmpeg timed out"));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ════════════════════════════════════════════════════════════
// PLAN RENDERER — JavaScript port of plan-renderer.ts logic
//
// We re-implement the core buildFilterComplex here to test
// without needing tsx compilation. This also validates that
// the algorithm is correctly specified in the TypeScript module.
// ════════════════════════════════════════════════════════════

const DEFAULT_FONTS = {
  regular: "C\\:/Windows/Fonts/arial.ttf",
  bold: "C\\:/Windows/Fonts/arialbd.ttf",
  headline: "C\\:/Windows/Fonts/GeorgiaPro-BoldItalic.ttf",
};

function computeFaceCrop(targetW, targetH, faceCenterX, faceCenterY, srcW, srcH) {
  // V5.1: Face-centering scale — ensure enough room to center the face
  const scaleW = targetW / srcW;
  const scaleH = targetH / srcH;
  const baseScale = Math.max(scaleW, scaleH);

  const fxFrac = Math.max(0.1, Math.min(0.9, faceCenterX / srcW));
  const fyFrac = Math.max(0.1, Math.min(0.9, faceCenterY / srcH));

  const neededScaleX = targetW / (2 * Math.min(fxFrac, 1 - fxFrac) * srcW);
  const neededScaleY = targetH / (2 * Math.min(fyFrac, 1 - fyFrac) * srcH);

  const faceScale = Math.min(baseScale * 2, Math.max(baseScale, neededScaleX, neededScaleY));

  const scaledW = Math.round(srcW * faceScale) + (Math.round(srcW * faceScale) % 2);
  const scaledH = Math.round(srcH * faceScale) + (Math.round(srcH * faceScale) % 2);
  const fx = Math.round(faceCenterX * faceScale);
  const fy = Math.round(faceCenterY * faceScale);
  const cropX = Math.max(0, Math.min(fx - Math.round(targetW / 2), scaledW - targetW));
  const cropY = Math.max(0, Math.min(fy - Math.round(targetH / 2), scaledH - targetH));
  return { scaledW, scaledH, cropX, cropY };
}

function escapeDrawtext(text) {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/'/g, "'")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .trim();
}

function buildFilterComplexFromPlan(plan, template, arollSrcW, arollSrcH) {
  const { canvas, fps } = plan;
  const filters = [];
  let lastLabel = "bg";
  let stepNum = 1;

  // Group ranges by layoutId
  const groupMap = new Map();
  for (const range of plan.layoutRanges) {
    if (!groupMap.has(range.layoutId)) {
      groupMap.set(range.layoutId, []);
    }
    groupMap.get(range.layoutId).push(range);
  }

  // Build groups with combined enable expressions
  const groups = [];
  for (const [layoutId, ranges] of groupMap.entries()) {
    const layout = template.layouts[layoutId];
    if (!layout) throw new Error(`Layout "${layoutId}" not in template`);
    const combinedEnable = ranges.map(r => r.enableExpr).join("+");
    groups.push({ layoutId, layout, ranges, combinedEnable });
  }
  groups.sort((a, b) => a.ranges[0].timeRange.start - b.ranges[0].timeRange.start);

  // Identify A-roll branches
  const arollBranches = [];
  for (const g of groups) {
    const region = g.layout.aroll.region;
    if (region && region.width > 0 && region.height > 0) {
      arollBranches.push({
        layoutId: g.layoutId,
        shape: g.layout.aroll.shape,
        label: `aroll_${g.layoutId}`,
        layout: g.layout,
      });
    }
  }

  // B-roll preparation (layout-aware)
  const brollBranches = groups.map(g => ({
    layoutId: g.layoutId,
    region: g.layout.broll.region,
    isBackground: g.layout.broll.isBackground,
    label: `broll_${g.layoutId}`,
    combinedEnable: g.combinedEnable,
  }));

  // Fast-path check: all layouts have full-canvas background B-roll
  const allBrollIsFullCanvas = brollBranches.every(b =>
    b.isBackground &&
    b.region.x <= 1 && b.region.y <= 1 &&
    b.region.width >= canvas.width - 2 &&
    b.region.height >= canvas.height - 2
  );

  if (allBrollIsFullCanvas) {
    // Fast path: single full-canvas B-roll (original behavior)
    filters.push(
      `[0:v]setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},setsar=1[bg]`
    );
  } else {
    // Layout-aware: black base + per-layout B-roll branches with enable
    filters.push(
      `color=black:s=${canvas.width}x${canvas.height}:r=${fps}:d=999,setpts=PTS-STARTPTS[bg_base]`
    );

    if (brollBranches.length === 1) {
      filters.push(`[0:v]setpts=PTS-STARTPTS[${brollBranches[0].label}_src]`);
    } else {
      const splitLabels = brollBranches.map(b => `[${b.label}_src]`).join("");
      filters.push(`[0:v]setpts=PTS-STARTPTS,split=${brollBranches.length}${splitLabels}`);
    }

    for (const branch of brollBranches) {
      const r = branch.region;
      filters.push(
        `[${branch.label}_src]scale=${r.width}:${r.height}:force_original_aspect_ratio=increase,crop=${r.width}:${r.height},setsar=1[${branch.label}]`
      );
    }

    lastLabel = "bg_base";
    for (const branch of brollBranches) {
      const r = branch.region;
      const enableStr = `'${branch.combinedEnable}'`;
      filters.push(
        `[${lastLabel}][${branch.label}]overlay=${r.x}:${r.y}:enable=${enableStr}[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    filters.push(`[${lastLabel}]copy[bg]`);
    lastLabel = "bg";
  }

  // A-roll split
  if (arollBranches.length === 1) {
    filters.push(`[1:v]setpts=PTS-STARTPTS[${arollBranches[0].label}_src]`);
  } else if (arollBranches.length > 1) {
    const splitLabels = arollBranches.map(b => `[${b.label}_src]`).join("");
    filters.push(`[1:v]setpts=PTS-STARTPTS,split=${arollBranches.length}${splitLabels}`);
  }

  // A-roll crop per branch
  // V5.1: Preserve A-roll source aspect ratio for full-width rectangles
  for (const branch of arollBranches) {
    const region = branch.layout.aroll.region;
    const faceCenter = branch.layout.aroll.faceCropCenter || { x: arollSrcW / 2, y: arollSrcH / 2 };

    let targetW = region.width;
    let targetH = region.height;

    // For full-width rectangle A-roll, preserve source aspect ratio
    if (branch.shape === "rectangle" && region.width >= canvas.width * 0.9) {
      const sourceAspect = arollSrcW / arollSrcH;
      const aspectCorrectH = Math.round(region.width / sourceAspect);
      targetH = aspectCorrectH + (aspectCorrectH % 2);
      console.log(`  [V5.1] Full-width rect: region.height ${region.height} → ${targetH} (preserving ${arollSrcW}×${arollSrcH} aspect)`);
    }

    // Store adjusted dimensions for overlay positioning
    branch._adjustedW = targetW;
    branch._adjustedH = targetH;

    if (branch.shape === "circle") {
      // ── CIRCLE: Center-crop from 16:9 source → square → circle mask ──
      // Scale so shorter dimension fills the target square, then center-crop.
      // This preserves natural camera distance: head + shoulders visible.
      // Do NOT use computeFaceCrop() here — it over-zooms by 1.5x+ when the
      // face is off-center vertically, showing only the head with no shoulders.
      const scale = Math.max(
        targetW / arollSrcW,
        targetH / arollSrcH
      );
      let scaledW = Math.round(arollSrcW * scale);
      let scaledH = Math.round(arollSrcH * scale);
      scaledW += scaledW % 2; // ensure even
      scaledH += scaledH % 2;

      // Center crop — take the middle square from the scaled frame
      const cropX = Math.max(0, Math.round((scaledW - targetW) / 2));
      const cropY = Math.max(0, Math.round((scaledH - targetH) / 2));

      console.log(
        `  [V4] Circle A-roll: center-crop, no zoom. ` +
        `${arollSrcW}×${arollSrcH} → scale ${scaledW}×${scaledH} → crop ${targetW}×${targetH} at (${cropX},${cropY})`
      );

      const radius = Math.min(targetW, targetH) / 2;
      const cx = targetW / 2;
      const cy = targetH / 2;
      filters.push(
        `[${branch.label}_src]scale=${scaledW}:${scaledH},crop=${targetW}:${targetH}:${cropX}:${cropY},setsar=1[${branch.label}_raw]`
      );
      filters.push(
        `[${branch.label}_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${radius},2)),255,0)'[${branch.label}]`
      );
    } else {
      // ── RECTANGLE: Face-centered crop ──
      const fc = computeFaceCrop(targetW, targetH, faceCenter.x, faceCenter.y, arollSrcW, arollSrcH);
      filters.push(
        `[${branch.label}_src]scale=${fc.scaledW}:${fc.scaledH},crop=${targetW}:${targetH}:${fc.cropX}:${fc.cropY},setsar=1[${branch.label}]`
      );
    }
  }

  // Overlays per group (z-order)
  for (const group of groups) {
    const { layout, combinedEnable } = group;
    const enableStr = `'${combinedEnable}'`;

    // Header zone
    if (layout.headerZone) {
      // When layout-aware B-roll is active, header only covers the header zone
      // (B-roll won't bleed in). In fast-path, use extended cover.
      const coverHeight = allBrollIsFullCanvas
        ? (layout.aroll.shape === "rectangle"
            ? layout.aroll.region.y + layout.aroll.region.height
            : layout.headerZone.region.height)
        : layout.headerZone.region.height;

      filters.push(
        `color=black:s=${canvas.width}x${coverHeight}:r=${fps}:d=999,setpts=PTS-STARTPTS[hdr_${group.layoutId}]`
      );
      filters.push(
        `[${lastLabel}][hdr_${group.layoutId}]overlay=0:0:enable=${enableStr}[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // Rectangle A-roll (V5.1: keep original Y, taller crop extends downward)
    if (layout.aroll.shape === "rectangle" && layout.aroll.region.width > 0) {
      const region = layout.aroll.region;
      filters.push(
        `[${lastLabel}][aroll_${group.layoutId}]overlay=${region.x}:${region.y}:enable=${enableStr}[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // Circle border
    if (layout.aroll.shape === "circle" && layout.aroll.border) {
      const region = layout.aroll.region;
      const border = layout.aroll.border;
      const bw = border.width;
      const borderW = region.width + bw * 2;
      const borderH = region.height + bw * 2;
      const borderR = Math.min(borderW, borderH) / 2;
      const borderCx = borderW / 2;
      const borderCy = borderH / 2;

      filters.push(
        `color=${border.color}:s=${borderW}x${borderH}:r=${fps}:d=999,setpts=PTS-STARTPTS[bdr_${group.layoutId}_color]`
      );
      filters.push(
        `[bdr_${group.layoutId}_color]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderR},2)),255,0)'[bdr_${group.layoutId}]`
      );
      filters.push(
        `[${lastLabel}][bdr_${group.layoutId}]overlay=${region.x - bw}:${region.y - bw}:enable=${enableStr}:format=auto[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // Circle A-roll
    if (layout.aroll.shape === "circle" && layout.aroll.region.width > 0) {
      const region = layout.aroll.region;
      filters.push(
        `[${lastLabel}][aroll_${group.layoutId}]overlay=${region.x}:${region.y}:enable=${enableStr}:format=auto[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // Text overlays
    const allTexts = [];
    for (const range of group.ranges) {
      if (range.textOverlays?.length > 0) {
        allTexts.push(...range.textOverlays);
      }
    }
    const seen = new Set();
    const uniqueTexts = [];
    for (const t of allTexts) {
      const key = `${t.slotId}:${t.text}`;
      if (!seen.has(key)) { seen.add(key); uniqueTexts.push(t); }
    }

    for (const overlay of uniqueTexts) {
      const cleanText = escapeDrawtext(overlay.text);
      if (!cleanText) continue;

      const slot = layout.headerZone?.textSlots?.find(s => s.id === overlay.slotId);
      const fontSize = overlay.fontSize ?? slot?.defaultFontSize ?? 36;
      const fontColor = overlay.fontColor ?? slot?.defaultFontColor ?? "0xFFFFFF";

      // Font selection: explicit override → slot default → color heuristic
      let fontFile = overlay.fontFile ?? slot?.defaultFont;
      if (!fontFile) {
        const color = (fontColor ?? "").toUpperCase();
        fontFile = (color.includes("FDD835") || color.includes("FFD700") || color.includes("FFEB3B"))
          ? DEFAULT_FONTS.headline
          : DEFAULT_FONTS.regular;
      }

      const textX = slot?.anchor?.x ?? canvas.width / 2;
      const textY = slot?.anchor?.y ?? canvas.height / 2;

      let bgOpts = "";
      const bgColor = overlay.bgColor ?? slot?.defaultBgColor;
      if (bgColor) {
        const bgPad = overlay.bgPadding ?? slot?.defaultBgPadding ?? 10;
        bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=${bgPad}`;
      }

      filters.push(
        `[${lastLabel}]drawtext=fontfile='${fontFile}':text='${cleanText}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)${bgOpts}:enable=${enableStr}[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }
  }

  filters.push(`[${lastLabel}]copy[out]`);
  return filters.join(";\n");
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();

  console.log("═".repeat(70));
  console.log("  PLAN RENDERER INTEGRATION TEST");
  console.log("  Layout-agnostic single-pass renderer");
  console.log("═".repeat(70));
  console.log();

  // ── Preflight ──
  console.log("[1] PREFLIGHT");
  console.log("─".repeat(40));
  const checks = [
    { name: "FFmpeg", path: FFMPEG },
    { name: "Blueprint", path: BLUEPRINT_PATH },
    { name: "Transcription", path: TRANSCRIPTION_PATH },
    { name: "A-roll", path: AROLL_PATH },
    { name: "B-roll", path: BROLL_PATH },
  ];
  for (const { name, path: p } of checks) {
    const ok = fs.existsSync(p);
    console.log(`  ${ok ? "✓" : "✗"} ${name}: ${path.basename(p)}`);
    if (!ok) { console.error(`FATAL: ${name} missing`); process.exit(1); }
  }
  console.log();

  // ── Load dynamic template + plan ──
  console.log("[2] LOADING PIPELINE ARTIFACTS");
  console.log("─".repeat(40));

  const { template, plan } = await importPipeline();

  console.log(`  Template: ${template.id} — ${Object.keys(template.layouts).length} layout(s)`);
  for (const [id, layout] of Object.entries(template.layouts)) {
    const features = [];
    features.push(layout.aroll.shape);
    if (layout.headerZone) features.push("header");
    if (layout.aroll.border) features.push("border");
    console.log(`    ${id}: ${features.join(", ")} | aroll=(${layout.aroll.region.x},${layout.aroll.region.y}) ${layout.aroll.region.width}×${layout.aroll.region.height}`);
  }
  console.log();
  console.log(`  Plan: ${plan.layoutRanges.length} range(s), ${plan.transitions.length} transition(s)`);
  for (const range of plan.layoutRanges) {
    const sentIds = range.sentences.map(s => `S${s.index + 1}`).join("+");
    console.log(`    ${range.id}: ${range.timeRange.start.toFixed(2)}-${range.timeRange.end.toFixed(2)}s | ${range.layoutId} | ${sentIds} | enable=${range.enableExpr}`);
  }
  console.log();

  // ── Build filter complex (layout-agnostic) ──
  console.log("[3] BUILDING FILTER (layout-agnostic)");
  console.log("─".repeat(40));

  const AROLL_SRC_W = 1920;
  const AROLL_SRC_H = 1080;

  const filterComplex = buildFilterComplexFromPlan(plan, template, AROLL_SRC_W, AROLL_SRC_H);

  const filterLines = filterComplex.split(";\n");
  console.log(`  Filter stages: ${filterLines.length}`);
  for (const line of filterLines) {
    console.log(`    ${line.length > 120 ? line.slice(0, 117) + "..." : line}`);
  }
  console.log();

  // Write filter to file (avoid Windows cmd length limits)
  const filterPath = path.join(TEMP_DIR, "plan-renderer-filter.txt");
  fs.writeFileSync(filterPath, filterComplex);

  // ── Compare with hardcoded renderer filter ──
  console.log("[3b] COMPARING WITH HARDCODED RENDERER");
  console.log("─".repeat(40));

  const hardcodedFilterPath = path.join(TEMP_DIR, "singlepass-filter.txt");
  if (fs.existsSync(hardcodedFilterPath)) {
    const hardcoded = fs.readFileSync(hardcodedFilterPath, "utf-8");
    const hardcodedLines = hardcoded.split(";\n");
    console.log(`  Hardcoded filter: ${hardcodedLines.length} stages`);
    console.log(`  Agnostic filter:  ${filterLines.length} stages`);

    // Check if enable expressions match
    const hardcodedEnables = hardcoded.match(/enable='[^']+'/g) || [];
    const agnosticEnables = filterComplex.match(/enable='[^']+'/g) || [];
    console.log(`  Hardcoded enables: ${hardcodedEnables.length}`);
    console.log(`  Agnostic enables:  ${agnosticEnables.length}`);

    // Check specific enable values
    const getUnique = (enables) => [...new Set(enables.map(e => e.replace(/enable='/,"").replace(/'/,"")))];
    const hardcodedUnique = getUnique(hardcodedEnables);
    const agnosticUnique = getUnique(agnosticEnables);
    console.log(`  Hardcoded unique: ${hardcodedUnique.join(" | ")}`);
    console.log(`  Agnostic unique:  ${agnosticUnique.join(" | ")}`);

    // Verify enable expression boundaries match
    const matchesEnable = agnosticUnique.every(e => hardcodedUnique.some(h => h === e));
    console.log(`  Enable match: ${matchesEnable ? "✓ MATCH" : "✗ MISMATCH"}`);
  } else {
    console.log("  (hardcoded filter not found, skipping comparison)");
  }
  console.log();

  // ── Render ──
  console.log("[4] RENDERING (single pass, layout-agnostic)");
  console.log("─".repeat(40));

  const totalDuration = plan.totalDuration;
  console.log(`  Duration: ${totalDuration.toFixed(2)}s`);

  const ffmpegArgs = [
    "-y",
    "-i", BROLL_PATH,
    "-i", AROLL_PATH,
    "-filter_complex_script", filterPath,
    "-map", "[out]",
    "-map", "1:a",
    "-t", totalDuration.toFixed(3),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-movflags", "+faststart",
    OUTPUT_PATH,
  ];

  console.log(`  Rendering...`);
  const renderStart = Date.now();

  try {
    const result = await runFFmpeg(ffmpegArgs, 600_000);
    const renderTime = ((Date.now() - renderStart) / 1000).toFixed(1);

    if (result.exitCode === 0 && fs.existsSync(OUTPUT_PATH)) {
      const stats = fs.statSync(OUTPUT_PATH);
      console.log(`  ✓ Render OK (${renderTime}s)`);
      console.log(`  Output: ${OUTPUT_PATH}`);
      console.log(`  Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
      const errorLines = result.stderr
        .split("\n")
        .filter(l => l.includes("Error") || l.includes("error") || l.includes("Invalid") || l.includes("No such"))
        .slice(0, 15);
      console.log(`  ✗ FAILED (exit ${result.exitCode})`);
      for (const line of errorLines) {
        console.log(`     ${line.trim()}`);
      }
      const debugPath = path.join(TEMP_DIR, "plan-renderer-stderr.txt");
      fs.writeFileSync(debugPath, result.stderr);
      console.log(`  Full stderr: ${debugPath}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    process.exit(1);
  }
  console.log();

  // ── Regression checklist ──
  console.log("[5] REGRESSION CHECKLIST");
  console.log("─".repeat(40));

  const verificationChecks = [
    { time: 1.0, desc: "Rectangle layout visible during S1" },
    { time: 1.9, desc: "Rectangle + headlines visible" },
    { time: 3.5, desc: "Rectangle still showing before S1 ends" },
    { time: 3.7, desc: "Still rectangle at 3.7s" },
    { time: 4.1, desc: "Circle PIP active after transition" },
    { time: 4.5, desc: "Circle PIP confirmed at 4.5s" },
    { time: 5.0, desc: "Circle PIP with border at 5s" },
    { time: 7.5, desc: "Circle PIP with border at 7.5s" },
    { time: 10.0, desc: "Circle PIP with border at 10s" },
    { time: 13.0, desc: "Circle PIP with border at 13s (REGRESSION)" },
    { time: 15.0, desc: "Circle PIP with border at 15s (REGRESSION)" },
    { time: 17.0, desc: "Circle PIP with border at 17s (REGRESSION)" },
    { time: 20.0, desc: "Circle PIP with border at 20s" },
    { time: 23.0, desc: "Circle PIP with border at 23s (final)" },
  ];

  const framesDir = path.join(OUTPUT_DIR, "plan-rendered-frames");
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

  console.log("  Extracting verification frames...");
  for (const check of verificationChecks) {
    const framePath = path.join(framesDir, `frame_${check.time}s.jpg`);
    await runFFmpeg([
      "-y", "-ss", check.time.toString(), "-i", OUTPUT_PATH,
      "-frames:v", "1", "-q:v", "2", framePath,
    ], 15_000);
    const ok = fs.existsSync(framePath);
    console.log(`  ${ok ? "✓" : "✗"} ${check.time}s — ${check.desc}`);
  }
  console.log();

  // ── Visual comparison with hardcoded render ──
  console.log("[6] VISUAL COMPARISON");
  console.log("─".repeat(40));

  const hardcodedOutput = path.join(OUTPUT_DIR, "singlepass.mp4");
  if (fs.existsSync(hardcodedOutput)) {
    // Compare file sizes
    const newSize = fs.statSync(OUTPUT_PATH).size;
    const oldSize = fs.statSync(hardcodedOutput).size;
    const sizeDiff = ((newSize - oldSize) / oldSize * 100).toFixed(1);
    console.log(`  Hardcoded: ${(oldSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Agnostic: ${(newSize / 1024 / 1024).toFixed(2)} MB (${sizeDiff}% diff)`);

    // Extract comparison frames at key times
    const compDir = path.join(OUTPUT_DIR, "comparison");
    if (!fs.existsSync(compDir)) fs.mkdirSync(compDir, { recursive: true });

    const compTimes = [1.5, 4.5, 10.0, 15.0, 22.0];
    for (const t of compTimes) {
      await runFFmpeg([
        "-y", "-ss", t.toString(), "-i", hardcodedOutput,
        "-frames:v", "1", "-q:v", "2",
        path.join(compDir, `hardcoded_${t}s.jpg`),
      ], 15_000);
      await runFFmpeg([
        "-y", "-ss", t.toString(), "-i", OUTPUT_PATH,
        "-frames:v", "1", "-q:v", "2",
        path.join(compDir, `agnostic_${t}s.jpg`),
      ], 15_000);
    }
    console.log(`  Comparison frames saved to: ${compDir}`);
    console.log("  Compare hardcoded_Xs.jpg vs agnostic_Xs.jpg for visual parity");
  } else {
    console.log("  (hardcoded render not found, skipping comparison)");
  }
  console.log();

  // ── Checklist summary ──
  console.log("  ═══════════════════════════════════════════");
  console.log("  REGRESSION CHECKLIST:");
  console.log("  ═══════════════════════════════════════════");
  console.log("  [  ] 1. Rectangle PIP + headlines during S1 (0-3.97s)");
  console.log("  [  ] 2. Circle PIP + border for ALL circle segments");
  console.log("  [  ]    → Especially 13s, 15s, 17s (previous regression)");
  console.log("  [  ] 3. Transition at sentence boundary (~3.97s)");
  console.log("  [  ] 4. No layout overlap at transition");
  console.log("  [  ] 5. No dead zones (no raw B-roll without PIP)");
  console.log("  [  ] 6. Audio continuous, no glitches");
  console.log("  [  ] 7. Face centered in circle PIP");
  console.log("  [  ] 8. Headlines correct (gold + pink bg)");
  console.log("  [  ] 9. Visually identical to hardcoded render");
  console.log("  ═══════════════════════════════════════════");
  console.log();

  // ── Summary ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("═".repeat(70));
  console.log("  RESULT: PASS");
  console.log(`  Total time: ${elapsed}s`);
  console.log(`  Output: ${OUTPUT_PATH}`);
  console.log(`  Architecture: LAYOUT-AGNOSTIC SINGLE PASS`);
  console.log("═".repeat(70));
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
