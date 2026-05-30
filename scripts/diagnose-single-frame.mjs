/**
 * Single-frame Hough diagnostic: extract ONE frame and search with tight
 * spatial constraints to see if the true circle is detectable at all.
 *
 * Run: npx tsx scripts/diagnose-single-frame.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

import { spawnSync } from "child_process";
const { loadGray, detectCircle } = await import("@/lib/analysis/coordinate-measurer");
// loadGray and detectCircle may not be exported; use measureCircleFromFrame instead
const { measureCircleFromFrame } = await import("@/lib/analysis/coordinate-measurer");

const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF = path.join(ROOT, "public", "uploads", "references", "ref.MOV");
const TMP = path.join(ROOT, "public", "exports", "diag-sf");
fs.mkdirSync(TMP, { recursive: true });

const CANVAS = { width: 1080, height: 1920 };

function extractFrame(t, out) {
  const r = spawnSync(FFMPEG, ["-y", "-ss", String(t), "-i", REF, "-frames:v", "1", "-vf", `scale=${CANVAS.width}:${CANVAS.height}`, out], { encoding: "utf-8" });
  return r.status === 0 && fs.existsSync(out);
}

// Known correct positions for reference
const REF_CORRECT = {
  seg_2: { cx: 745, cy: 565, r: 205 },
  seg_3: { cx: 793, cy: 518, r: 218 },
  seg_4: { cx: 755, cy: 485, r: 215 },
  seg_5: { cx: 685, cy: 275, r: 215 },
};

// Test cases: [segId, timestamp, constraint config]
const TESTS = [
  { seg: "seg_2", t: 6.0, label: "t=6.0 full-upper-half",   cx: undefined, cy: undefined },
  { seg: "seg_2", t: 6.0, label: "t=6.0 tight-right",        cxMin: 550, cxMax: 950, cyMin: 250, cyMax: 850 },
  { seg: "seg_2", t: 5.5, label: "t=5.5 full-upper-half",   cx: undefined, cy: undefined },
  { seg: "seg_2", t: 5.5, label: "t=5.5 tight-right",        cxMin: 550, cxMax: 950, cyMin: 250, cyMax: 850 },
  { seg: "seg_2", t: 7.5, label: "t=7.5 tight-right",        cxMin: 550, cxMax: 950, cyMin: 250, cyMax: 850 },
  { seg: "seg_4", t: 14.5, label: "t=14.5 full-upper-half", cx: undefined, cy: undefined },
  { seg: "seg_4", t: 14.5, label: "t=14.5 tight-right",      cxMin: 550, cxMax: 950, cyMin: 200, cyMax: 750 },
  { seg: "seg_5", t: 21.0, label: "t=21.0 tight-right",      cxMin: 400, cxMax: 900, cyMin: 50, cyMax: 600 },
];

const radiusRange = { min: 190, max: 235 };

for (const test of TESTS) {
  const fp = path.join(TMP, `frame_${test.seg}_${test.t}.jpg`);
  if (!fs.existsSync(fp)) {
    if (!extractFrame(test.t, fp)) { console.log(`${test.label}: EXTRACT FAILED`); continue; }
  }

  const cr = test.cxMin !== undefined
    ? { xMin: test.cxMin, xMax: test.cxMax, yMin: test.cyMin, yMax: test.cyMax }
    : { xMin: 0, xMax: CANVAS.width, yMin: 0, yMax: Math.round(CANVAS.height * 0.50) };

  const det = await measureCircleFromFrame({
    framePath: fp,
    canvas: CANVAS,
    downscale: 3,
    radiusRange,
    centerRegion: cr,
  });

  const ref = REF_CORRECT[test.seg];
  if (!det) {
    console.log(`${test.label}: NO DETECTION`);
    continue;
  }
  const dx = Math.abs(det.cx - ref.cx), dy = Math.abs(det.cy - ref.cy), dr = Math.abs(det.radius - ref.r);
  const gate = dx <= 50 && dy <= 50 ? "PASS50" : dx <= 100 && dy <= 100 ? "PASS100" : "FAIL";
  console.log(
    `${test.label}: det=(${det.cx},${det.cy},r=${det.radius}) ` +
    `ref=(${ref.cx},${ref.cy},r=${ref.r}) dx=${dx} dy=${dy} dr=${dr} ${gate} sup=${det.support.toFixed(3)}`
  );
}

process.exit(0);
// This block was added inline — run separate script for locked-cx test
