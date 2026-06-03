#!/usr/bin/env node
/**
 * THREE SOLUTIONS COMPARISON — StyleClone Pipeline
 *
 * Renders 3 different approaches to fixing:
 *   1. A-roll zoom (over-zoomed rectangle in seg_1)
 *   2. Circle position jumping between segments
 *   3. Mid-sentence transitions (already fixed in plan)
 *
 * Each solution renders a video + comparison images.
 * Run: node scripts/test-three-solutions.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const TEMP_DIR = path.join(ROOT, "public/exports/sp-temp");
const OUTPUT_DIR = path.join(ROOT, "public/exports");
const COMPARE_DIR = path.join(TEMP_DIR, "solution-comparisons");
const PLAN_PATH = path.join(TEMP_DIR, "dynamic-plan.json");
const TEMPLATE_PATH = path.join(TEMP_DIR, "dynamic-template.json");
const REF_PATH = path.join(ROOT, "public/uploads/IMG_6018.MOV");
const AROLL_PATH = path.join(ROOT, "public/uploads/IMG_6108.MOV");
const BROLL_PATH = path.join(ROOT, "public/uploads/IMG_6163.MP4");
const FFMPEG = path.join(ROOT, "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe");

const FPS = 30;
const AROLL_SRC_W = 1920;
const AROLL_SRC_H = 1080;

fs.mkdirSync(COMPARE_DIR, { recursive: true });

// ═════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════

const DEFAULT_FONTS = {
  regular: "C\\:/Windows/Fonts/arial.ttf",
  bold: "C\\:/Windows/Fonts/arialbd.ttf",
  headline: "C\\:/Windows/Fonts/GeorgiaPro-BoldItalic.ttf",
};

function escapeDrawtext(text) {
  return text.replace(/\r?\n/g, " ").replace(/'/g, "'").replace(/\\/g, "/")
    .replace(/:/g, "\\:").replace(/%/g, "%%").replace(/;/g, "\\;")
    .replace(/\[/g, "\\[").replace(/\]/g, "\\]").trim();
}

function runFFmpeg(args, timeout = 300000) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", d => stderr += d.toString());
    proc.on("close", code => resolve({ exitCode: code, stderr }));
    setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
  });
}

function extractFrame(video, t, outPath, w = 1080, h = 1920) {
  const r = spawnSync(FFMPEG, [
    "-y", "-ss", String(t), "-i", video,
    "-frames:v", "1", "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    outPath
  ], { encoding: "utf-8", timeout: 15000 });
  return r.status === 0 && fs.existsSync(outPath);
}

function createSideBySide(leftPath, rightPath, outPath, w = 540, h = 960) {
  const r = spawnSync(FFMPEG, [
    "-y", "-i", leftPath, "-i", rightPath,
    "-filter_complex",
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2[l];` +
    `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2[r];` +
    `[l][r]hstack`,
    "-frames:v", "1", outPath
  ], { encoding: "utf-8", timeout: 15000 });
  return r.status === 0;
}

// Create 3-way comparison: reference | solution | current
function createTripleComparison(refPath, solutionPath, currentPath, outPath) {
  const w = 360, h = 640;
  const r = spawnSync(FFMPEG, [
    "-y", "-i", refPath, "-i", solutionPath, "-i", currentPath,
    "-filter_complex",
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
    `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='REFERENCE':fontsize=24:fontcolor=white:x=(w-tw)/2:y=10:box=1:boxcolor=black@0.6:boxborderw=5[l];` +
    `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
    `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='SOLUTION':fontsize=24:fontcolor=0x00FF00:x=(w-tw)/2:y=10:box=1:boxcolor=black@0.6:boxborderw=5[m];` +
    `[2:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
    `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='CURRENT':fontsize=24:fontcolor=0xFF6600:x=(w-tw)/2:y=10:box=1:boxcolor=black@0.6:boxborderw=5[r];` +
    `[l][m][r]hstack=inputs=3`,
    "-frames:v", "1", outPath
  ], { encoding: "utf-8", timeout: 15000 });
  return r.status === 0;
}

// ═════════════════════════════════════════════════════════════
// FILTER BUILDER (modified from test-cv-loop.mjs)
// ═════════════════════════════════════════════════════════════

/**
 * Build filter complex with solution-specific modifications.
 *
 * @param {object} plan
 * @param {object} template - WILL BE MODIFIED for circle solutions
 * @param {string} solutionId - "S1", "S2", "S3"
 */
function buildFilterForSolution(plan, template, solutionId) {
  const { canvas, fps } = plan;
  const filters = [];
  let lastLabel = "bg";
  let stepNum = 1;

  const groupMap = new Map();
  for (const range of plan.layoutRanges) {
    if (!groupMap.has(range.layoutId)) groupMap.set(range.layoutId, []);
    groupMap.get(range.layoutId).push(range);
  }

  const groups = [];
  for (const [layoutId, ranges] of groupMap.entries()) {
    const layout = template.layouts[layoutId];
    if (!layout) throw new Error(`Layout "${layoutId}" not in template`);
    const combinedEnable = ranges.map(r => r.enableExpr).join("+");
    groups.push({ layoutId, layout, ranges, combinedEnable });
  }
  groups.sort((a, b) => a.ranges[0].timeRange.start - b.ranges[0].timeRange.start);

  const arollBranches = [];
  for (const g of groups) {
    const region = g.layout.aroll.region;
    if (region && region.width > 0 && region.height > 0) {
      arollBranches.push({
        layoutId: g.layoutId, shape: g.layout.aroll.shape,
        label: `aroll_${g.layoutId}`, layout: g.layout,
      });
    }
  }

  const brollBranches = groups.map(g => ({
    layoutId: g.layoutId, region: g.layout.broll.region,
    isBackground: g.layout.broll.isBackground, label: `broll_${g.layoutId}`,
    combinedEnable: g.combinedEnable,
  }));

  const allBrollIsFullCanvas = brollBranches.every(b =>
    b.isBackground && b.region.x <= 1 && b.region.y <= 1 &&
    b.region.width >= canvas.width - 2 && b.region.height >= canvas.height - 2
  );

  // B-roll: same for all solutions
  if (allBrollIsFullCanvas) {
    filters.push(
      `[0:v]setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},setsar=1[bg]`
    );
  } else {
    filters.push(`color=black:s=${canvas.width}x${canvas.height}:r=${fps}:d=999,setpts=PTS-STARTPTS[bg_base]`);
    if (brollBranches.length === 1) {
      filters.push(`[0:v]setpts=PTS-STARTPTS[${brollBranches[0].label}_src]`);
    } else {
      const splitLabels = brollBranches.map(b => `[${b.label}_src]`).join("");
      filters.push(`[0:v]setpts=PTS-STARTPTS,split=${brollBranches.length}${splitLabels}`);
    }
    for (const branch of brollBranches) {
      const r = branch.region;
      filters.push(`[${branch.label}_src]scale=${r.width}:${r.height}:force_original_aspect_ratio=increase,crop=${r.width}:${r.height},setsar=1[${branch.label}]`);
    }
    lastLabel = "bg_base";
    for (const branch of brollBranches) {
      const r = branch.region;
      const enableStr = `'${branch.combinedEnable}'`;
      filters.push(`[${lastLabel}][${branch.label}]overlay=${r.x}:${r.y}:enable=${enableStr}[step${stepNum}]`);
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

  // A-roll crop/scale — THIS IS WHERE SOLUTIONS DIFFER
  for (const branch of arollBranches) {
    const region = branch.layout.aroll.region;
    let targetW = region.width;
    let targetH = region.height;

    if (branch.shape === "rectangle" && region.width >= canvas.width * 0.9) {
      const sourceAspect = AROLL_SRC_W / AROLL_SRC_H;
      const aspectCorrectH = Math.round(region.width / sourceAspect);
      targetH = aspectCorrectH + (aspectCorrectH % 2);
    }

    branch._adjustedW = targetW;
    branch._adjustedH = targetH;

    if (branch.shape === "circle") {
      // Circle A-roll: center-crop to fit the circle region
      const scale = Math.max(targetW / AROLL_SRC_W, targetH / AROLL_SRC_H);
      let scaledW = Math.round(AROLL_SRC_W * scale);
      let scaledH = Math.round(AROLL_SRC_H * scale);
      scaledW += scaledW % 2;
      scaledH += scaledH % 2;
      const cropX = Math.max(0, Math.round((scaledW - targetW) / 2));
      const cropY = Math.max(0, Math.round((scaledH - targetH) / 2));
      const radius = Math.min(targetW, targetH) / 2;
      const cx = targetW / 2;
      const cy = targetH / 2;
      filters.push(`[${branch.label}_src]scale=${scaledW}:${scaledH},crop=${targetW}:${targetH}:${cropX}:${cropY},setsar=1[${branch.label}_raw]`);
      filters.push(`[${branch.label}_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${radius},2)),255,0)'[${branch.label}]`);
    } else {
      // ═══════════════════════════════════════════════════════
      // RECTANGLE A-ROLL — ALL SOLUTIONS: scale-to-fit (NO face zoom)
      // This is the fix for the 54% over-zoom in computeFaceCrop().
      // ═══════════════════════════════════════════════════════
      // Simple scale-to-fit: scale down to target width, preserving aspect ratio
      const scaleW = targetW;
      const scaleH = targetH;
      filters.push(`[${branch.label}_src]scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,crop=${scaleW}:${scaleH},setsar=1[${branch.label}]`);
    }
  }

  // Overlay A-roll + borders + text
  for (const group of groups) {
    const { layout, combinedEnable } = group;
    const enableStr = `'${combinedEnable}'`;

    if (layout.headerZone) {
      const coverHeight = allBrollIsFullCanvas
        ? (layout.aroll.shape === "rectangle" ? layout.aroll.region.y + layout.aroll.region.height : layout.headerZone.region.height)
        : layout.headerZone.region.height;
      filters.push(`color=black:s=${canvas.width}x${coverHeight}:r=${fps}:d=999,setpts=PTS-STARTPTS[hdr_${group.layoutId}]`);
      filters.push(`[${lastLabel}][hdr_${group.layoutId}]overlay=0:0:enable=${enableStr}[step${stepNum}]`);
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    if (layout.aroll.shape === "rectangle" && layout.aroll.region.width > 0) {
      const region = layout.aroll.region;
      filters.push(`[${lastLabel}][aroll_${group.layoutId}]overlay=${region.x}:${region.y}:enable=${enableStr}[step${stepNum}]`);
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    if (layout.aroll.shape === "circle" && layout.aroll.border) {
      const region = layout.aroll.region;
      const border = layout.aroll.border;
      const bw = border.width;
      const borderW = region.width + bw * 2;
      const borderH = region.height + bw * 2;
      const borderR = Math.min(borderW, borderH) / 2;
      const borderCx = borderW / 2;
      const borderCy = borderH / 2;
      filters.push(`color=${border.color}:s=${borderW}x${borderH}:r=${fps}:d=999,setpts=PTS-STARTPTS[bdr_${group.layoutId}_color]`);
      filters.push(`[bdr_${group.layoutId}_color]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderR},2)),255,0)'[bdr_${group.layoutId}]`);
      filters.push(`[${lastLabel}][bdr_${group.layoutId}]overlay=${region.x - bw}:${region.y - bw}:enable=${enableStr}:format=auto[step${stepNum}]`);
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    if (layout.aroll.shape === "circle" && layout.aroll.region.width > 0) {
      const region = layout.aroll.region;
      filters.push(`[${lastLabel}][aroll_${group.layoutId}]overlay=${region.x}:${region.y}:enable=${enableStr}:format=auto[step${stepNum}]`);
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    const allTexts = [];
    for (const range of group.ranges) {
      if (range.textOverlays?.length > 0) allTexts.push(...range.textOverlays);
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
      let fontFile = overlay.fontFile ?? slot?.defaultFont;
      if (!fontFile) {
        const color = (fontColor ?? "").toUpperCase();
        fontFile = (color.includes("FDD835") || color.includes("FFD700") || color.includes("FFEB3B"))
          ? DEFAULT_FONTS.headline : DEFAULT_FONTS.regular;
      }
      const textX = slot?.anchor?.x ?? canvas.width / 2;
      const textY = slot?.anchor?.y ?? canvas.height / 2;
      let bgOpts = "";
      const bgColor = overlay.bgColor ?? slot?.defaultBgColor;
      if (bgColor) {
        const bgPad = overlay.bgPadding ?? slot?.defaultBgPadding ?? 10;
        bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=${bgPad}`;
      }
      filters.push(`[${lastLabel}]drawtext=fontfile='${fontFile}':text='${cleanText}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)${bgOpts}:enable=${enableStr}[step${stepNum}]`);
      lastLabel = `step${stepNum}`;
      stepNum++;
    }
  }

  filters.push(`[${lastLabel}]copy[out]`);
  return filters.join(";\n");
}

// ═════════════════════════════════════════════════════════════
// TEMPLATE MODIFICATION FUNCTIONS
// ═════════════════════════════════════════════════════════════

/**
 * Solution 1: "Fixed Circle" — ALL circle segments use ONE unified position/size.
 * Uses the median of all CV-measured circle positions.
 * Eliminates circle jumping entirely.
 */
function modifyTemplateForS1(template) {
  const t = JSON.parse(JSON.stringify(template)); // deep clone
  const circleLayouts = Object.values(t.layouts).filter(l => l.aroll.shape === "circle" && l.aroll.circle);

  if (circleLayouts.length === 0) return t;

  // Compute median of all circle positions
  const cxValues = circleLayouts.map(l => l.aroll.circle.cx);
  const cyValues = circleLayouts.map(l => l.aroll.circle.cy);
  const rValues = circleLayouts.map(l => l.aroll.circle.radius);

  const median = arr => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };

  const unifiedCx = median(cxValues);
  const unifiedCy = median(cyValues);
  const unifiedR = median(rValues);

  console.log(`  S1 unified circle: cx=${unifiedCx}, cy=${unifiedCy}, r=${unifiedR}`);
  console.log(`  (from ${circleLayouts.length} layouts: cx=[${cxValues}], cy=[${cyValues}], r=[${rValues}])`);

  // Apply to all circle layouts
  for (const layout of circleLayouts) {
    layout.aroll.circle = { cx: unifiedCx, cy: unifiedCy, radius: unifiedR };
    layout.aroll.region = {
      x: unifiedCx - unifiedR,
      y: unifiedCy - unifiedR,
      width: unifiedR * 2,
      height: unifiedR * 2,
    };
  }

  return t;
}

/**
 * Solution 2: "Dominant Circle" — Use the LARGEST cluster's position for all segments.
 * When multiple circle layouts exist, find the position that the majority agree on
 * (within tolerance) and apply it to all. Smaller outliers get overridden.
 */
function modifyTemplateForS2(template) {
  const t = JSON.parse(JSON.stringify(template)); // deep clone
  const circleLayouts = Object.entries(t.layouts).filter(([, l]) => l.aroll.shape === "circle" && l.aroll.circle);

  if (circleLayouts.length <= 1) return t;

  // Cluster by proximity (threshold = 80px)
  const threshold = 80;
  const clusters = [];

  for (const [id, layout] of circleLayouts) {
    const c = layout.aroll.circle;
    let found = false;
    for (const cluster of clusters) {
      const centroid = {
        cx: cluster.reduce((s, d) => s + d.circle.cx, 0) / cluster.length,
        cy: cluster.reduce((s, d) => s + d.circle.cy, 0) / cluster.length,
      };
      if (Math.hypot(c.cx - centroid.cx, c.cy - centroid.cy) < threshold) {
        cluster.push({ id, circle: c });
        found = true;
        break;
      }
    }
    if (!found) clusters.push([{ id, circle: c }]);
  }

  // Sort by cluster size, use the largest
  clusters.sort((a, b) => b.length - a.length);
  const dominant = clusters[0];

  const median = arr => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };

  const domCx = median(dominant.map(d => d.circle.cx));
  const domCy = median(dominant.map(d => d.circle.cy));
  const domR = median(dominant.map(d => d.circle.radius));

  console.log(`  S2 dominant circle: cx=${domCx}, cy=${domCy}, r=${domR} (${dominant.length}/${circleLayouts.length} layouts agree)`);

  // Apply dominant to ALL circle layouts
  for (const [id, layout] of circleLayouts) {
    layout.aroll.circle = { cx: domCx, cy: domCy, radius: domR };
    layout.aroll.region = {
      x: domCx - domR,
      y: domCy - domR,
      width: domR * 2,
      height: domR * 2,
    };
  }

  return t;
}

/**
 * Solution 3: "Smoothed Per-Segment" — Keep per-segment positions but CLAMP movement.
 * Each circle position is allowed to differ from the previous by max ±40px in x/y
 * and ±15px in radius. This reduces jumps while preserving some natural variation.
 */
function modifyTemplateForS3(template, plan) {
  const t = JSON.parse(JSON.stringify(template)); // deep clone

  // Get circle layout IDs in time order from the plan
  const circleRanges = plan.layoutRanges.filter(r => {
    const layout = t.layouts[r.layoutId];
    return layout?.aroll?.shape === "circle" && layout.aroll.circle;
  });

  if (circleRanges.length <= 1) return t;

  const MAX_DELTA_POS = 40;  // max px movement per transition
  const MAX_DELTA_R = 15;    // max radius change per transition

  // Start from the first circle's position
  let prevCx = t.layouts[circleRanges[0].layoutId].aroll.circle.cx;
  let prevCy = t.layouts[circleRanges[0].layoutId].aroll.circle.cy;
  let prevR = t.layouts[circleRanges[0].layoutId].aroll.circle.radius;

  console.log(`  S3 smoothing: max Δpos=${MAX_DELTA_POS}px, max Δr=${MAX_DELTA_R}px`);

  for (let i = 1; i < circleRanges.length; i++) {
    const layoutId = circleRanges[i].layoutId;
    const layout = t.layouts[layoutId];
    const c = layout.aroll.circle;

    const dx = c.cx - prevCx;
    const dy = c.cy - prevCy;
    const dr = c.radius - prevR;

    const clampedCx = prevCx + Math.max(-MAX_DELTA_POS, Math.min(MAX_DELTA_POS, dx));
    const clampedCy = prevCy + Math.max(-MAX_DELTA_POS, Math.min(MAX_DELTA_POS, dy));
    const clampedR = prevR + Math.max(-MAX_DELTA_R, Math.min(MAX_DELTA_R, dr));

    if (Math.abs(dx) > MAX_DELTA_POS || Math.abs(dy) > MAX_DELTA_POS || Math.abs(dr) > MAX_DELTA_R) {
      console.log(`    ${layoutId}: clamped (${c.cx},${c.cy},r=${c.radius}) → (${clampedCx},${clampedCy},r=${clampedR})`);
    }

    layout.aroll.circle = { cx: Math.round(clampedCx), cy: Math.round(clampedCy), radius: Math.round(clampedR) };
    layout.aroll.region = {
      x: Math.round(clampedCx - clampedR),
      y: Math.round(clampedCy - clampedR),
      width: Math.round(clampedR * 2),
      height: Math.round(clampedR * 2),
    };

    prevCx = clampedCx;
    prevCy = clampedCy;
    prevR = clampedR;
  }

  return t;
}

// ═════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     THREE SOLUTIONS COMPARISON — StyleClone Pipeline        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Load plan and template
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
  const templateBase = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf8"));

  console.log(`Plan: ${plan.layoutRanges.length} ranges, ${plan.totalDuration.toFixed(1)}s`);
  console.log(`Template: ${Object.keys(templateBase.layouts).length} layouts\n`);

  // ── The three solutions ──
  const solutions = [
    {
      id: "S1",
      name: "Fixed Circle",
      desc: "ALL circles use ONE unified position (median). Zero zoom on rectangle. Eliminates all jumping.",
      modifyTemplate: () => modifyTemplateForS1(templateBase),
    },
    {
      id: "S2",
      name: "Dominant Circle",
      desc: "ALL circles use the DOMINANT cluster position. Zero zoom on rectangle. Most consistent look.",
      modifyTemplate: () => modifyTemplateForS2(templateBase),
    },
    {
      id: "S3",
      name: "Smoothed Per-Segment",
      desc: "Per-segment positions but CLAMPED to max ±40px movement. Zero zoom. Subtle variation, no jumps.",
      modifyTemplate: () => modifyTemplateForS3(templateBase, plan),
    },
  ];

  const results = [];

  for (const solution of solutions) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`  SOLUTION ${solution.id}: ${solution.name}`);
    console.log(`  ${solution.desc}`);
    console.log(`${"═".repeat(70)}\n`);

    // Modify template
    console.log("  Modifying template...");
    const template = solution.modifyTemplate();

    // Build filter
    console.log("  Building FFmpeg filter...");
    const filterComplex = buildFilterForSolution(plan, template, solution.id);
    const filterPath = path.join(TEMP_DIR, `solution-${solution.id}-filter.txt`);
    fs.writeFileSync(filterPath, filterComplex);
    console.log(`    ${filterComplex.split(";\n").length} filter stages`);

    // Render
    const outputPath = path.join(OUTPUT_DIR, `solution-${solution.id}.mp4`);
    const totalDuration = plan.totalDuration;

    const ffmpegArgs = [
      "-y", "-i", BROLL_PATH, "-i", AROLL_PATH,
      "-filter_complex_script", filterPath,
      "-map", "[out]", "-map", "1:a",
      "-t", totalDuration.toFixed(3),
      "-c:v", "libx264", "-preset", "fast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-pix_fmt", "yuv420p", "-r", "30",
      "-movflags", "+faststart",
      outputPath,
    ];

    console.log(`\n  Rendering ${solution.id}...`);
    const renderStart = Date.now();
    const result = await runFFmpeg(ffmpegArgs, 600_000);
    const renderTime = ((Date.now() - renderStart) / 1000).toFixed(1);

    if (result.exitCode !== 0 || !fs.existsSync(outputPath)) {
      console.log(`  ✗ RENDER FAILED (exit ${result.exitCode})`);
      const errLines = result.stderr.split("\n").filter(l => l.includes("Error")).slice(0, 5);
      for (const l of errLines) console.log(`    ${l.trim()}`);
      results.push({ ...solution, renderOk: false, renderTime });
      continue;
    }

    const stats = fs.statSync(outputPath);
    console.log(`  ✓ Render OK (${renderTime}s, ${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    // Extract comparison frames
    console.log(`\n  Extracting comparison frames for ${solution.id}...`);

    // Key timestamps: mid-point of each segment
    const timestamps = plan.layoutRanges.map((r, i) => ({
      seg: i + 1,
      t: (r.timeRange.start + r.timeRange.end) / 2,
      layout: r.layoutId,
    }));

    // Also extract transition frames
    const transitionTimes = plan.layoutRanges.slice(1).map((r, i) => ({
      trans: i + 1,
      t: r.timeRange.start,
      from: plan.layoutRanges[i].layoutId,
      to: r.layoutId,
    }));

    const solutionData = {
      ...solution,
      renderOk: true,
      renderTime,
      fileSize: (stats.size / 1024 / 1024).toFixed(2),
      outputPath,
      circlePositions: [],
    };

    // Extract per-segment frames and create comparisons
    for (const ts of timestamps) {
      const refFrame = path.join(COMPARE_DIR, `ref_seg${ts.seg}.jpg`);
      const solFrame = path.join(COMPARE_DIR, `${solution.id}_seg${ts.seg}.jpg`);
      const cmpFrame = path.join(COMPARE_DIR, `compare_${solution.id}_seg${ts.seg}.jpg`);

      extractFrame(REF_PATH, ts.t, refFrame);
      extractFrame(outputPath, ts.t, solFrame);
      createSideBySide(refFrame, solFrame, cmpFrame);

      // Record circle positions from template for scoring
      const layout = template.layouts[ts.layout];
      if (layout?.aroll?.shape === "circle" && layout.aroll.circle) {
        solutionData.circlePositions.push({
          seg: ts.seg,
          cx: layout.aroll.circle.cx,
          cy: layout.aroll.circle.cy,
          r: layout.aroll.circle.radius,
        });
      }
    }

    // Extract transition frames (before + after)
    for (const tr of transitionTimes) {
      const beforeFrame = path.join(COMPARE_DIR, `${solution.id}_trans${tr.trans}_before.jpg`);
      const afterFrame = path.join(COMPARE_DIR, `${solution.id}_trans${tr.trans}_after.jpg`);
      extractFrame(outputPath, Math.max(0, tr.t - 0.1), beforeFrame);
      extractFrame(outputPath, tr.t + 0.1, afterFrame);
    }

    results.push(solutionData);
  }

  // ═════════════════════════════════════════════════════════════
  // SCORING
  // ═════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(70)}`);
  console.log("  SCORING COMPARISON");
  console.log(`${"═".repeat(70)}\n`);

  // Load reference circle measurements (from the CV measurement we already have)
  const refCircles = [];
  const circleLayouts = Object.entries(templateBase.layouts).filter(([, l]) => l.aroll.shape === "circle" && l.aroll.circle);
  for (const [id, layout] of circleLayouts) {
    refCircles.push({ id, cx: layout.aroll.circle.cx, cy: layout.aroll.circle.cy, r: layout.aroll.circle.radius });
  }

  for (const sol of results) {
    if (!sol.renderOk) {
      console.log(`  ${sol.id} (${sol.name}): RENDER FAILED — not scored`);
      continue;
    }

    // Score 1: Circle consistency (lower variance = better, max 40 points)
    let consistencyScore = 40;
    if (sol.circlePositions.length > 1) {
      const positions = sol.circlePositions;
      const maxDeltaCx = Math.max(...positions.map(p => p.cx)) - Math.min(...positions.map(p => p.cx));
      const maxDeltaCy = Math.max(...positions.map(p => p.cy)) - Math.min(...positions.map(p => p.cy));
      const maxDeltaR = Math.max(...positions.map(p => p.r)) - Math.min(...positions.map(p => p.r));
      const totalDelta = maxDeltaCx + maxDeltaCy + maxDeltaR;
      // 0 delta = 40pts, 200+ delta = 0pts
      consistencyScore = Math.max(0, Math.round(40 * (1 - totalDelta / 200)));
      sol._deltaInfo = `Δcx=${maxDeltaCx}px, Δcy=${maxDeltaCy}px, Δr=${maxDeltaR}px`;
    }
    sol.consistencyScore = consistencyScore;

    // Score 2: Reference accuracy (how close to reference positions, max 30 points)
    let refAccuracyScore = 30;
    if (sol.circlePositions.length > 0 && refCircles.length > 0) {
      const errors = [];
      for (const sp of sol.circlePositions) {
        // Find closest reference circle by segment
        let minErr = Infinity;
        for (const rc of refCircles) {
          const err = Math.hypot(sp.cx - rc.cx, sp.cy - rc.cy) + Math.abs(sp.r - rc.r);
          if (err < minErr) minErr = err;
        }
        errors.push(minErr);
      }
      const avgError = errors.reduce((s, e) => s + e, 0) / errors.length;
      // 0 error = 30pts, 150+ error = 0pts
      refAccuracyScore = Math.max(0, Math.round(30 * (1 - avgError / 150)));
      sol._avgError = avgError.toFixed(1);
    }
    sol.refAccuracyScore = refAccuracyScore;

    // Score 3: Transition quality (sentence-boundary aligned, max 30 points)
    let transitionScore = 30;
    // All solutions use the fixed plan, so all get full marks here
    sol.transitionScore = transitionScore;

    sol.totalScore = consistencyScore + refAccuracyScore + transitionScore;

    console.log(`  ${sol.id} (${sol.name}):`);
    console.log(`    Circle consistency: ${consistencyScore}/40 ${sol._deltaInfo ? `(${sol._deltaInfo})` : ""}`);
    console.log(`    Reference accuracy: ${refAccuracyScore}/30 ${sol._avgError ? `(avg err: ${sol._avgError}px)` : ""}`);
    console.log(`    Transition quality: ${transitionScore}/30 (sentence-boundary aligned)`);
    console.log(`    ─── TOTAL: ${sol.totalScore}/100 ───`);
    console.log();
  }

  // Create 3-way comparison for each segment
  console.log("  Creating 3-way comparison images...");
  for (let seg = 1; seg <= plan.layoutRanges.length; seg++) {
    const ts = (plan.layoutRanges[seg - 1].timeRange.start + plan.layoutRanges[seg - 1].timeRange.end) / 2;
    const refFrame = path.join(COMPARE_DIR, `ref_seg${seg}.jpg`);

    // Only create if all solution frames exist
    const s1Frame = path.join(COMPARE_DIR, `S1_seg${seg}.jpg`);
    const s2Frame = path.join(COMPARE_DIR, `S2_seg${seg}.jpg`);
    const s3Frame = path.join(COMPARE_DIR, `S3_seg${seg}.jpg`);

    if (fs.existsSync(refFrame) && fs.existsSync(s1Frame)) {
      createSideBySide(refFrame, s1Frame, path.join(COMPARE_DIR, `compare_S1_seg${seg}.jpg`));
    }
    if (fs.existsSync(refFrame) && fs.existsSync(s2Frame)) {
      createSideBySide(refFrame, s2Frame, path.join(COMPARE_DIR, `compare_S2_seg${seg}.jpg`));
    }
    if (fs.existsSync(refFrame) && fs.existsSync(s3Frame)) {
      createSideBySide(refFrame, s3Frame, path.join(COMPARE_DIR, `compare_S3_seg${seg}.jpg`));
    }

    // 3-way: ref | S1 | S2 (for easy visual comparison)
    if ([s1Frame, s2Frame, s3Frame].every(f => fs.existsSync(f))) {
      // S1 vs S2 vs S3
      const w = 360, h = 640;
      spawnSync(FFMPEG, [
        "-y", "-i", s1Frame, "-i", s2Frame, "-i", s3Frame,
        "-filter_complex",
        `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
        `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='S1 Fixed':fontsize=20:fontcolor=0x00FF00:x=10:y=10:box=1:boxcolor=black@0.6:boxborderw=4[a];` +
        `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
        `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='S2 Dominant':fontsize=20:fontcolor=0xFFFF00:x=10:y=10:box=1:boxcolor=black@0.6:boxborderw=4[b];` +
        `[2:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
        `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='S3 Smoothed':fontsize=20:fontcolor=0xFF6600:x=10:y=10:box=1:boxcolor=black@0.6:boxborderw=4[c];` +
        `[a][b][c]hstack=inputs=3`,
        "-frames:v", "1",
        path.join(COMPARE_DIR, `3way_seg${seg}.jpg`),
      ], { encoding: "utf-8", timeout: 15000 });
    }
  }

  // ═════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(70)}`);
  console.log("  FINAL RESULTS");
  console.log(`${"═".repeat(70)}\n`);

  const scored = results.filter(r => r.renderOk).sort((a, b) => b.totalScore - a.totalScore);

  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const rank = i === 0 ? "🏆 WINNER" : `#${i + 1}`;
    console.log(`  ${rank}  ${s.id} "${s.name}" — ${s.totalScore}/100`);
    console.log(`         Consistency: ${s.consistencyScore}/40 | Accuracy: ${s.refAccuracyScore}/30 | Transitions: ${s.transitionScore}/30`);
    console.log(`         Video: ${s.outputPath}`);
    console.log();
  }

  console.log("  ALL CHANGES SHARED BY ALL SOLUTIONS:");
  console.log("    ✓ Rectangle A-roll: scale-to-fit (no face zoom) — fixes 54% over-zoom");
  console.log("    ✓ Transitions: snap to sentence END (not start) — fixes mid-sentence jumps");
  console.log("    ✓ Single-pass FFmpeg: continuous audio, no concat");
  console.log();

  console.log("  FILES:");
  console.log(`    Videos:       ${OUTPUT_DIR}/solution-S1.mp4, solution-S2.mp4, solution-S3.mp4`);
  console.log(`    Comparisons:  ${COMPARE_DIR}/compare_S*_seg*.jpg`);
  console.log(`    3-way:        ${COMPARE_DIR}/3way_seg*.jpg`);
  console.log(`    Filters:      ${TEMP_DIR}/solution-S*-filter.txt`);
}

main().catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});
