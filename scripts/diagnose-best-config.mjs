/**
 * Test xMax=810 to exclude seg_5 false cluster at cx=813
 * and downscale=2 for better circle edge resolution
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const { measureReferenceCircles } = await import("@/lib/analysis/reference-measurer");
const { measureCircleFromFrame } = await import("@/lib/analysis/coordinate-measurer");
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF = path.join(ROOT, "public", "uploads", "references", "ref.MOV");
const CANVAS = { width: 1080, height: 1920 };

const SEGMENTS = [
  { id: "seg_2", start: 3.0,  end: 9.2,  shape: "circle" },
  { id: "seg_3", start: 9.2,  end: 12.8, shape: "circle" },
  { id: "seg_4", start: 12.8, end: 17.9, shape: "circle" },
  { id: "seg_5", start: 17.9, end: 24.1, shape: "circle" },
];

const REF_CORRECT = {
  seg_2: { cx: 745, cy: 565, r: 205 },
  seg_3: { cx: 793, cy: 518, r: 218 },
  seg_4: { cx: 755, cy: 485, r: 215 },
  seg_5: { cx: 685, cy: 275, r: 215 },
};

const TMP = path.join(ROOT, "public", "exports", "diag-sf");

// ── Test 1: xMax=810, yMin=200 (exclude seg_5 false cluster) ──
console.log("\n=== TEST 1: x=[580,810] yMin=200 r=[200,230] 30fps ===");
{
  const measured = await measureReferenceCircles({
    ffmpegPath: FFMPEG, refVideoPath: REF, canvas: CANVAS,
    segments: SEGMENTS,
    tmpDir: path.join(ROOT, "public", "exports", "diag-best"),
    centerRegion: { xMin: 580, xMax: 810, yMin: 200, yMax: Math.round(CANVAS.height * 0.50) },
    radiusRange: { min: 200, max: 230 },
    framesPerSegment: 30,
    useTemporalClustering: true,
  });
  let w50 = 0, w30 = 0;
  for (const seg of SEGMENTS) {
    const m = measured.get(seg.id), ref = REF_CORRECT[seg.id];
    if (!m) { console.log(`  ${seg.id}: NO DET`); continue; }
    const dx = Math.abs(m.cx - ref.cx), dy = Math.abs(m.cy - ref.cy);
    const gate = dx<=30&&dy<=30 ? "PASS30" : dx<=50&&dy<=50 ? "PASS50" : "FAIL";
    if (gate==="PASS30"){w30++;w50++;} else if(gate==="PASS50")w50++;
    console.log(`  ${seg.id}: meas=(${m.cx},${m.cy},r=${m.radius}) n=${m.samples} ref=(${ref.cx},${ref.cy}) dx=${dx} dy=${dy} ${gate}`);
  }
  console.log(`  Result: ${w30}/4 PASS30  ${w50}/4 PASS50`);
}

// ── Test 2: downscale=2 single-frame for seg_2 t=6.0 ──
console.log("\n=== TEST 2: seg_2 t=6.0 downscale=2 with various constraints ===");
const seg2fp = path.join(TMP, "frame_seg_2_6.jpg");
if (fs.existsSync(seg2fp)) {
  for (const [label, cr, ds] of [
    ["ds=3 x=[580,810] y=[350,700]", { xMin:580, xMax:810, yMin:350, yMax:700 }, 3],
    ["ds=2 x=[580,810] y=[350,700]", { xMin:580, xMax:810, yMin:350, yMax:700 }, 2],
    ["ds=2 x=[580,920] y=[350,750]", { xMin:580, xMax:920, yMin:350, yMax:750 }, 2],
    ["ds=2 full-upper y=[200,960]",  { xMin:0,   xMax:1080,yMin:200, yMax:960 }, 2],
    ["ds=3 x=[620,870] y=[200,960]", { xMin:620, xMax:870, yMin:200, yMax:960 }, 3],
  ]) {
    const det = await measureCircleFromFrame({
      framePath: seg2fp, canvas: CANVAS, downscale: ds,
      radiusRange: { min: 200, max: 230 }, centerRegion: cr,
    });
    const ref = REF_CORRECT.seg_2;
    if (!det) { console.log(`  ${label}: NO DET`); continue; }
    const dx=Math.abs(det.cx-ref.cx), dy=Math.abs(det.cy-ref.cy);
    const gate = dx<=50&&dy<=50?"PASS50":"FAIL";
    console.log(`  ${label}: (${det.cx},${det.cy},r=${det.radius}) dx=${dx} dy=${dy} ${gate} sup=${det.support.toFixed(3)}`);
  }
}

// ── Test 3: downscale=2 temporal clustering ──
console.log("\n=== TEST 3: x=[580,810] yMin=200 r=[200,230] downscale=2 30fps ===");
{
  // Note: reference-measurer.ts may not support downscale parameter
  // This uses the existing API which defaults to downscale=3
  // We'll check if we can pass it
  const measured = await measureReferenceCircles({
    ffmpegPath: FFMPEG, refVideoPath: REF, canvas: CANVAS,
    segments: SEGMENTS,
    tmpDir: path.join(ROOT, "public", "exports", "diag-best"),
    centerRegion: { xMin: 580, xMax: 810, yMin: 200, yMax: Math.round(CANVAS.height * 0.50) },
    radiusRange: { min: 200, max: 230 },
    framesPerSegment: 30,
    useTemporalClustering: true,
    downscale: 2, // try passing downscale if supported
  }).catch(() => null);

  if (!measured) {
    console.log("  downscale param not supported by measureReferenceCircles");
  } else {
    let w50 = 0, w30 = 0;
    for (const seg of SEGMENTS) {
      const m = measured.get(seg.id), ref = REF_CORRECT[seg.id];
      if (!m) { console.log(`  ${seg.id}: NO DET`); continue; }
      const dx = Math.abs(m.cx - ref.cx), dy = Math.abs(m.cy - ref.cy);
      const gate = dx<=30&&dy<=30 ? "PASS30" : dx<=50&&dy<=50 ? "PASS50" : "FAIL";
      if (gate==="PASS30"){w30++;w50++;} else if(gate==="PASS50")w50++;
      console.log(`  ${seg.id}: meas=(${m.cx},${m.cy},r=${m.radius}) n=${m.samples} ref=(${ref.cx},${ref.cy}) dx=${dx} dy=${dy} ${gate}`);
    }
    console.log(`  Result: ${w30}/4 PASS30  ${w50}/4 PASS50`);
  }
}

process.exit(0);
