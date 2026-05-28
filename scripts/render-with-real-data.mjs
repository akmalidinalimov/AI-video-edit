/**
 * Standalone render script using REAL cached pipeline data.
 *
 * Mimics the API pipeline exactly:
 *   1. Load cached blueprint (same as getCached unwraps .data)
 *   2. Extract face info → generate template
 *   3. Build editing plan
 *   4. Generate FFmpeg filter via plan-renderer logic
 *   5. Save filter for inspection
 *   6. Render video
 *   7. Extract verification frames
 *
 * This bypasses the Next.js server entirely — runs the same logic as pure JS.
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";

const CWD = process.cwd();

// ═══════════════════════════════════════════
// STEP 1: Load cached blueprint (unwrap .data)
// ═══════════════════════════════════════════
console.log("═══ STEP 1: Load cached blueprint ═══");
const bpRaw = JSON.parse(
  fs.readFileSync("public/analysis/.cache/278b7f948b1f1d35-visual_blueprint.json", "utf8")
);
const blueprint = bpRaw.data;
console.log("  Canvas:", JSON.stringify(blueprint.canvas));
console.log("  Segments:", blueprint.reference.segments.length);
console.log("  A-roll face center:", JSON.stringify(blueprint.aroll.recommendedCrop.circle));
console.log("  A-roll resolution:", JSON.stringify(blueprint.aroll.resolution));

// ═══════════════════════════════════════════
// STEP 2: Extract face info (same as route.ts)
// ═══════════════════════════════════════════
console.log("\n═══ STEP 2: Extract face info ═══");
const rc = blueprint.aroll.recommendedCrop;
const faceInfo = {
  center: { x: rc.circle.centerX, y: rc.circle.centerY },
  sourceResolution: blueprint.aroll.resolution,
};
console.log("  Face info:", JSON.stringify(faceInfo));

// ═══════════════════════════════════════════
// STEP 3: Build template (inline — key parts)
// ═══════════════════════════════════════════
console.log("\n═══ STEP 3: Build template ═══");

const canvas = { width: 1080, height: 1920 };
const fps = 30;
const faceCropCenter = { x: faceInfo.center.x, y: faceInfo.center.y };

// Median helper
function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const segs = blueprint.reference.segments;

// Seg_1: rectangle, full-width
const seg1 = segs[0];
const rectAroll = seg1.aroll.boundingBox;
const rectBroll = seg1.broll.boundingBox;

// Seg 2-5: circle PIPs
const circleSegs = segs.slice(1);
const circleArollBoxes = circleSegs.map((s) => s.aroll.boundingBox);
const circleAroll = {
  x: Math.round(median(circleArollBoxes.map((b) => b.x))),
  y: Math.round(median(circleArollBoxes.map((b) => b.y))),
  width: Math.round(median(circleArollBoxes.map((b) => b.width))),
  height: Math.round(median(circleArollBoxes.map((b) => b.height))),
};

console.log("  Rectangle A-roll region:", JSON.stringify(rectAroll));
console.log("  Circle A-roll region (median):", JSON.stringify(circleAroll));
console.log("  faceCropCenter:", JSON.stringify(faceCropCenter));

// Build template object
const template = {
  id: "diag_template",
  layouts: {
    fullscreen_aroll: {
      id: "fullscreen_aroll",
      aroll: {
        region: rectAroll,
        shape: "rectangle",
        circle: null,
        border: null,
        faceCropCenter,
      },
      broll: {
        region: rectBroll,
        isBackground: false,
      },
      headerZone: {
        region: { x: 0, y: 0, width: 1080, height: 220 },
        textSlots: [
          {
            id: "headline_1",
            anchor: { x: 340, y: 100 },
            maxWidth: 600,
            defaultFontSize: 50,
            defaultFontColor: "0xFDD835",
            defaultFont: "C\\:/Windows/Fonts/GeorgiaPro-BoldItalic.ttf",
          },
          {
            id: "headline_2",
            anchor: { x: 540, y: 170 },
            maxWidth: 940,
            defaultFontSize: 45,
            defaultFontColor: "0xFFFFFF",
            defaultFont: "C\\:/Windows/Fonts/arialbd.ttf",
            defaultBgColor: "0xE91E63",
            defaultBgPadding: 10,
          },
        ],
      },
    },
    circle_pip_top_right: {
      id: "circle_pip_top_right",
      aroll: {
        region: circleAroll,
        shape: "circle",
        circle: {
          cx: circleAroll.x + circleAroll.width / 2,
          cy: circleAroll.y + circleAroll.height / 2,
          radius: Math.round(Math.min(circleAroll.width, circleAroll.height) / 2),
        },
        border: { width: 4, color: "0xFFFFFF@0.6" },
        faceCropCenter,
      },
      broll: {
        region: { x: 0, y: 0, width: 1080, height: 1920 },
        isBackground: true,
      },
      headerZone: null,
    },
  },
};

// ═══════════════════════════════════════════
// STEP 4: Build editing plan (same as plan JSON)
// ═══════════════════════════════════════════
console.log("\n═══ STEP 4: Build editing plan ═══");

// Use the same plan structure as the saved dynamic-plan.json but with our template
const plan = {
  canvas,
  fps: 30,
  sources: {
    aroll: "public/uploads/IMG_6108.MOV",
    broll: "public/uploads/IMG_6163.MP4",
  },
  totalDuration: 24.333333333333332,
  totalFrames: 730,
  layoutRanges: [
    {
      id: "range_1",
      layoutId: "fullscreen_aroll",
      timeRange: { start: 0, end: 3.966666666666667 },
      enableExpr: "between(t,0.0000,3.9500)",
      startFrame: 0,
      endFrame: 119,
      textOverlays: [
        {
          slotId: "headline_1",
          text: "2026 yil SMM",
          fontSize: 50,
          fontColor: "0xFDD835",
        },
        {
          slotId: "headline_2",
          text: "mutaxassis kerak emas!",
          fontSize: 45,
          fontColor: "0xFFFFFF",
          bgColor: "0xE91E63",
        },
      ],
    },
    {
      id: "range_2",
      layoutId: "circle_pip_top_right",
      timeRange: { start: 3.966666666666667, end: 24.333333333333332 },
      enableExpr: "between(t,3.9500,24.5000)",
      startFrame: 119,
      endFrame: 730,
      textOverlays: [],
    },
  ],
  transitions: [
    {
      time: 3.966666666666667,
      frame: 119,
      from: "fullscreen_aroll",
      to: "circle_pip_top_right",
    },
  ],
  sentences: blueprint.reference.transcription.sentences || [],
};

console.log("  Ranges:", plan.layoutRanges.length);
console.log("  Range 1:", plan.layoutRanges[0].layoutId, "0 →", plan.layoutRanges[0].timeRange.end.toFixed(2) + "s");
console.log("  Range 2:", plan.layoutRanges[1].layoutId, plan.layoutRanges[1].timeRange.start.toFixed(2) + "s →", plan.layoutRanges[1].timeRange.end.toFixed(2) + "s");

// ═══════════════════════════════════════════
// STEP 5: Build filter (mimicking plan-renderer.ts)
// ═══════════════════════════════════════════
console.log("\n═══ STEP 5: Build FFmpeg filter ═══");

const sourceW = 1920,
  sourceH = 1080;

function computeFaceCropFn(targetW, targetH, fcX, fcY, srcW, srcH) {
  const scaleW = targetW / srcW;
  const scaleH = targetH / srcH;
  const baseScale = Math.max(scaleW, scaleH);

  const faceFractionX = fcX / srcW;
  const faceFractionY = fcY / srcH;

  const fxClamped = Math.max(0.1, Math.min(0.9, faceFractionX));
  const fyClamped = Math.max(0.1, Math.min(0.9, faceFractionY));

  const neededScaleForX = targetW / (2 * Math.min(fxClamped, 1 - fxClamped) * srcW);
  const neededScaleForY = targetH / (2 * Math.min(fyClamped, 1 - fyClamped) * srcH);

  let faceScale = Math.min(
    baseScale * 2,
    Math.max(baseScale, neededScaleForX, neededScaleForY)
  );

  const scaledW = Math.round(srcW * faceScale);
  const scaledH = Math.round(srcH * faceScale);
  const evenScaledW = scaledW + (scaledW % 2);
  const evenScaledH = scaledH + (scaledH % 2);

  const faceX = Math.round(fcX * faceScale);
  const faceY = Math.round(fcY * faceScale);

  const cropX = Math.max(0, Math.min(faceX - Math.round(targetW / 2), evenScaledW - targetW));
  const cropY = Math.max(0, Math.min(faceY - Math.round(targetH / 2), evenScaledH - targetH));

  return { scaledW: evenScaledW, scaledH: evenScaledH, cropX, cropY, faceX, faceY, faceScale };
}

// ── Rectangle A-roll ──
const rectLayout = template.layouts.fullscreen_aroll;
const rectRegion = rectLayout.aroll.region;

// V5.1 aspect ratio fix
let rectTargetW = rectRegion.width;
let rectTargetH = rectRegion.height;
if (rectRegion.width >= canvas.width * 0.9) {
  const sourceAspect = sourceW / sourceH;
  const aspectH = Math.round(rectRegion.width / sourceAspect);
  rectTargetH = aspectH + (aspectH % 2);
  console.log(`  V5.1 rect: target height ${rectRegion.height} → ${rectTargetH} (preserving ${sourceW}:${sourceH} aspect)`);
}

const rectCrop = computeFaceCropFn(rectTargetW, rectTargetH, faceCropCenter.x, faceCropCenter.y, sourceW, sourceH);
console.log(`  Rect A-roll crop: scale=${rectCrop.scaledW}:${rectCrop.scaledH}, crop=${rectTargetW}:${rectTargetH}:${rectCrop.cropX}:${rectCrop.cropY}`);
console.log(`  Face in rect crop: (${rectCrop.faceX - rectCrop.cropX}, ${rectCrop.faceY - rectCrop.cropY}) / ${rectTargetW}×${rectTargetH}`);
console.log(`  Face center%: (${((rectCrop.faceX - rectCrop.cropX) / rectTargetW * 100).toFixed(1)}%, ${((rectCrop.faceY - rectCrop.cropY) / rectTargetH * 100).toFixed(1)}%)`);

// ── Circle A-roll ──
const circleLayout = template.layouts.circle_pip_top_right;
const circleRegion = circleLayout.aroll.region;
const circleCrop = computeFaceCropFn(circleRegion.width, circleRegion.height, faceCropCenter.x, faceCropCenter.y, sourceW, sourceH);
console.log(`\n  Circle A-roll crop: scale=${circleCrop.scaledW}:${circleCrop.scaledH}, crop=${circleRegion.width}:${circleRegion.height}:${circleCrop.cropX}:${circleCrop.cropY}`);
console.log(`  Face in circle crop: (${circleCrop.faceX - circleCrop.cropX}, ${circleCrop.faceY - circleCrop.cropY}) / ${circleRegion.width}×${circleRegion.height}`);
console.log(`  Face center%: (${((circleCrop.faceX - circleCrop.cropX) / circleRegion.width * 100).toFixed(1)}%, ${((circleCrop.faceY - circleCrop.cropY) / circleRegion.height * 100).toFixed(1)}%)`);

// ── Build the complete filter ──
const enable1 = "between(t,0.0000,3.9500)";
const enable2 = "between(t,3.9500,24.5000)";

// B-roll layers
const brollRectRegion = rectLayout.broll.region;
const brollCircleRegion = circleLayout.broll.region;

const isRectBrollFullCanvas = brollRectRegion.x <= 1 && brollRectRegion.y <= 1 &&
  brollRectRegion.width >= canvas.width - 2 && brollRectRegion.height >= canvas.height - 2;
const isCircleBrollFullCanvas = brollCircleRegion.x <= 1 && brollCircleRegion.y <= 1 &&
  brollCircleRegion.width >= canvas.width - 2 && brollCircleRegion.height >= canvas.height - 2;

console.log(`\n  Rect B-roll: (${brollRectRegion.x},${brollRectRegion.y}) ${brollRectRegion.width}×${brollRectRegion.height} fullCanvas=${isRectBrollFullCanvas}`);
console.log(`  Circle B-roll: (${brollCircleRegion.x},${brollCircleRegion.y}) ${brollCircleRegion.width}×${brollCircleRegion.height} fullCanvas=${isCircleBrollFullCanvas}`);

// Header zone
const hdrRegion = rectLayout.headerZone.region;
const arollBottom = rectRegion.y + rectTargetH; // Use adjusted height
const coverHeight = rectRegion.y + rectTargetH; // For all-broll-full-canvas path, cover up to A-roll bottom

console.log(`\n  Header zone: ${hdrRegion.width}×${hdrRegion.height}`);
console.log(`  Rect A-roll overlay at y=${rectRegion.y}, adjusted height=${rectTargetH}`);
console.log(`  Header+aroll cover height (for bg): ${coverHeight}`);

// Circle border
const border = circleLayout.aroll.border;
const bw = border.width;
const borderW = circleRegion.width + bw * 2;
const borderH = circleRegion.height + bw * 2;
const borderR = Math.min(borderW, borderH) / 2;
const borderCx = borderW / 2;
const borderCy = borderH / 2;

// Build filter lines
const circleR = Math.min(circleRegion.width, circleRegion.height) / 2;
const circleMaskCx = circleRegion.width / 2;
const circleMaskCy = circleRegion.height / 2;

const allBrollFullCanvas = isRectBrollFullCanvas && isCircleBrollFullCanvas;

let filterLines = [];

if (allBrollFullCanvas) {
  // Fast path: single full-canvas B-roll
  filterLines.push(
    `[0:v]setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},setsar=1[bg]`
  );
} else {
  // Layout-aware B-roll path
  filterLines.push(
    `color=black:s=${canvas.width}x${canvas.height}:r=${fps}:d=999,setpts=PTS-STARTPTS[bg_base]`
  );
  filterLines.push(
    `[0:v]setpts=PTS-STARTPTS,split=2[broll_rect_src][broll_circle_src]`
  );
  filterLines.push(
    `[broll_rect_src]scale=${brollRectRegion.width}:${brollRectRegion.height}:force_original_aspect_ratio=increase,crop=${brollRectRegion.width}:${brollRectRegion.height},setsar=1[broll_rect]`
  );
  filterLines.push(
    `[broll_circle_src]scale=${brollCircleRegion.width}:${brollCircleRegion.height}:force_original_aspect_ratio=increase,crop=${brollCircleRegion.width}:${brollCircleRegion.height},setsar=1[broll_circle]`
  );
  filterLines.push(
    `[bg_base][broll_rect]overlay=${brollRectRegion.x}:${brollRectRegion.y}:enable='${enable1}'[step1]`
  );
  filterLines.push(
    `[step1][broll_circle]overlay=${brollCircleRegion.x}:${brollCircleRegion.y}:enable='${enable2}'[step2]`
  );
  filterLines.push(`[step2]copy[bg]`);
}

let lastLabel = "bg";
let stepNum = allBrollFullCanvas ? 1 : 3;

// A-roll split and crop
filterLines.push(
  `[1:v]setpts=PTS-STARTPTS,split=2[aroll_rect_src][aroll_circle_src]`
);

// Rectangle A-roll
filterLines.push(
  `[aroll_rect_src]scale=${rectCrop.scaledW}:${rectCrop.scaledH},crop=${rectTargetW}:${rectTargetH}:${rectCrop.cropX}:${rectCrop.cropY},setsar=1[aroll_rect]`
);

// Circle A-roll with mask
filterLines.push(
  `[aroll_circle_src]scale=${circleCrop.scaledW}:${circleCrop.scaledH},crop=${circleRegion.width}:${circleRegion.height}:${circleCrop.cropX}:${circleCrop.cropY},setsar=1[aroll_circle_raw]`
);
filterLines.push(
  `[aroll_circle_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${circleMaskCx},2)+pow(Y-${circleMaskCy},2),pow(${circleR},2)),255,0)'[aroll_circle]`
);

// Header zone overlay
if (!allBrollFullCanvas) {
  const hdrCoverH = hdrRegion.height; // Just the header zone height when layout-aware
  filterLines.push(
    `color=black:s=${canvas.width}x${hdrCoverH}:r=${fps}:d=999,setpts=PTS-STARTPTS[hdr_rect]`
  );
} else {
  // Full-canvas: header covers up to bottom of A-roll
  filterLines.push(
    `color=black:s=${canvas.width}x${coverHeight}:r=${fps}:d=999,setpts=PTS-STARTPTS[hdr_rect]`
  );
}
filterLines.push(
  `[${lastLabel}][hdr_rect]overlay=0:0:enable='${enable1}'[step${stepNum}]`
);
lastLabel = `step${stepNum}`;
stepNum++;

// Rectangle A-roll overlay
filterLines.push(
  `[${lastLabel}][aroll_rect]overlay=${rectRegion.x}:${rectRegion.y}:enable='${enable1}'[step${stepNum}]`
);
lastLabel = `step${stepNum}`;
stepNum++;

// Text overlays for rect layout
const slot1 = rectLayout.headerZone.textSlots[0];
const slot2 = rectLayout.headerZone.textSlots[1];

filterLines.push(
  `[${lastLabel}]drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='2026 yil SMM':fontsize=50:fontcolor=0xFDD835:x=${slot1.anchor.x}-(tw/2):y=${slot1.anchor.y}-(th/2):enable='${enable1}'[step${stepNum}]`
);
lastLabel = `step${stepNum}`;
stepNum++;

filterLines.push(
  `[${lastLabel}]drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='mutaxassis kerak emas!':fontsize=45:fontcolor=0xFFFFFF:x=${slot2.anchor.x}-(tw/2):y=${slot2.anchor.y}-(th/2):box=1:boxcolor=0xE91E63:boxborderw=10:enable='${enable1}'[step${stepNum}]`
);
lastLabel = `step${stepNum}`;
stepNum++;

// Circle border overlay
filterLines.push(
  `color=${border.color}:s=${borderW}x${borderH}:r=${fps}:d=999,setpts=PTS-STARTPTS[bdr_circle_color]`
);
filterLines.push(
  `[bdr_circle_color]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderR},2)),255,0)'[bdr_circle]`
);
filterLines.push(
  `[${lastLabel}][bdr_circle]overlay=${circleRegion.x - bw}:${circleRegion.y - bw}:enable='${enable2}':format=auto[step${stepNum}]`
);
lastLabel = `step${stepNum}`;
stepNum++;

// Circle A-roll overlay
filterLines.push(
  `[${lastLabel}][aroll_circle]overlay=${circleRegion.x}:${circleRegion.y}:enable='${enable2}':format=auto[step${stepNum}]`
);
lastLabel = `step${stepNum}`;
stepNum++;

// Final
filterLines.push(`[${lastLabel}]copy[out]`);

const filterComplex = filterLines.join(";\n");

// Save filter
const filterPath = "public/exports/sp-temp/diag-filter.txt";
fs.writeFileSync(filterPath, filterComplex);
console.log(`\n  Filter saved to: ${filterPath}`);
console.log(`  Filter (${filterLines.length} lines):`);
for (const line of filterLines) {
  console.log(`    ${line}`);
}

// ═══════════════════════════════════════════
// STEP 6: Render video
// ═══════════════════════════════════════════
console.log("\n═══ STEP 6: Render ═══");
const outputPath = "public/exports/diag-render.mp4";
const ffmpegPath = path.join(CWD, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");

const ffmpegArgs = [
  "-y",
  "-i", "public/uploads/IMG_6163.MP4",
  "-i", "public/uploads/IMG_6108.MOV",
  "-filter_complex_script", filterPath,
  "-map", "[out]",
  "-map", "1:a",
  "-t", "24.333",
  "-c:v", "libx264",
  "-preset", "fast",
  "-crf", "23",
  "-c:a", "aac",
  "-b:a", "128k",
  "-pix_fmt", "yuv420p",
  "-r", "30",
  "-movflags", "+faststart",
  outputPath,
];

console.log("  FFmpeg command:");
console.log(`  ${ffmpegPath} ${ffmpegArgs.join(" ")}`);

const result = spawnSync(ffmpegPath, ffmpegArgs, {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
  timeout: 180000,
});

if (result.status !== 0) {
  console.error("\n  FFmpeg FAILED!");
  console.error("  stderr:", result.stderr?.toString().slice(-500));
  process.exit(1);
}
console.log("  ✅ Render complete:", outputPath);

// ═══════════════════════════════════════════
// STEP 7: Extract verification frames
// ═══════════════════════════════════════════
console.log("\n═══ STEP 7: Extract verification frames ═══");
const framesDir = "public/exports/sp-temp/diag-frames";
if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

// Key frames:
// - frame 30 (1.0s) — rectangle layout, check face centering
// - frame 90 (3.0s) — rectangle layout, last moment before transition
// - frame 119 (3.97s) — exact transition frame
// - frame 120 (4.0s) — first circle frame
// - frame 150 (5.0s) — circle layout, check face centering
const keyFrames = [
  { frame: 30, label: "1.0s_rect" },
  { frame: 90, label: "3.0s_rect_before_transition" },
  { frame: 118, label: "3.93s_last_rect" },
  { frame: 119, label: "3.97s_transition" },
  { frame: 120, label: "4.0s_first_circle" },
  { frame: 150, label: "5.0s_circle" },
];

for (const kf of keyFrames) {
  const outFrame = path.join(framesDir, `frame_${kf.frame}_${kf.label}.png`);
  const extractResult = spawnSync(ffmpegPath, [
    "-y",
    "-i", outputPath,
    "-vf", `select='eq(n\\,${kf.frame})'`,
    "-vframes", "1",
    "-vsync", "vfr",
    outFrame,
  ], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });

  if (extractResult.status === 0) {
    console.log(`  ✅ ${kf.label}: ${outFrame}`);
  } else {
    console.log(`  ❌ ${kf.label}: FAILED`);
  }
}

console.log("\n═══ DONE ═══");
console.log("Check frames in:", framesDir);
console.log("Check filter in:", filterPath);
