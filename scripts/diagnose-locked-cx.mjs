/**
 * Locked-CX test: constrain x=[580,920] r=[200,230], scan only CY
 * to see if the speaker's PIP circle is detectable with known CX/R.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const { measureCircleFromFrame } = await import("@/lib/analysis/coordinate-measurer");
const CANVAS = { width: 1080, height: 1920 };
const TMP = path.join(ROOT, "public", "exports", "diag-sf");

const REF_CORRECT = {
  seg_2: { cx: 745, cy: 565, r: 205 },
  seg_3: { cx: 793, cy: 518, r: 218 },
  seg_4: { cx: 755, cy: 485, r: 215 },
  seg_5: { cx: 685, cy: 275, r: 215 },
};

const TESTS = [
  { seg: "seg_2", t: 6.0 },
  { seg: "seg_2", t: 5.5 },
  { seg: "seg_2", t: 7.5 },
  { seg: "seg_3", t: 10.5 },
  { seg: "seg_4", t: 14.5 },
  { seg: "seg_5", t: 21.0 },
];

console.log("=== Locked CX=[580,920] R=[200,230] CY=[0,780] ===");
for (const test of TESTS) {
  const fp = path.join(TMP, `frame_${test.seg}_${test.t}.jpg`);
  if (!fs.existsSync(fp)) { console.log(`${test.seg} t=${test.t}: NO FRAME (not extracted)`); continue; }

  const det = await measureCircleFromFrame({
    framePath: fp,
    canvas: CANVAS,
    downscale: 3,
    radiusRange: { min: 200, max: 230 },
    centerRegion: { xMin: 580, xMax: 920, yMin: 0, yMax: 780 },
  });

  const ref = REF_CORRECT[test.seg];
  if (!det) { console.log(`${test.seg} t=${test.t}: NO DETECTION`); continue; }
  const dx = Math.abs(det.cx - ref.cx), dy = Math.abs(det.cy - ref.cy);
  const gate = dx <= 50 && dy <= 50 ? "PASS50" : dx <= 100 && dy <= 100 ? "PASS100" : "FAIL";
  console.log(
    `${test.seg} t=${test.t}: (${det.cx},${det.cy},r=${det.radius}) ` +
    `ref=(${ref.cx},${ref.cy},r=${ref.r}) dx=${dx} dy=${dy} ${gate} sup=${det.support.toFixed(3)}`
  );
}

// Also extract seg_3 t=10.5 if not present
import { spawnSync } from "child_process";
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF = path.join(ROOT, "public", "uploads", "references", "ref.MOV");

for (const test of TESTS) {
  const fp = path.join(TMP, `frame_${test.seg}_${test.t}.jpg`);
  if (!fs.existsSync(fp)) {
    spawnSync(FFMPEG, ["-y", "-ss", String(test.t), "-i", REF, "-frames:v", "1", "-vf", `scale=${CANVAS.width}:${CANVAS.height}`, fp], { encoding: "utf-8" });
    if (fs.existsSync(fp)) {
      console.log(`Extracted ${test.seg} t=${test.t}`);
      const det2 = await measureCircleFromFrame({
        framePath: fp, canvas: CANVAS, downscale: 3,
        radiusRange: { min: 200, max: 230 },
        centerRegion: { xMin: 580, xMax: 920, yMin: 0, yMax: 780 },
      });
      const ref = REF_CORRECT[test.seg];
      if (!det2) { console.log(`  ${test.seg} t=${test.t}: NO DETECTION`); continue; }
      const dx = Math.abs(det2.cx - ref.cx), dy = Math.abs(det2.cy - ref.cy);
      const gate = dx <= 50 && dy <= 50 ? "PASS50" : dx <= 100 && dy <= 100 ? "PASS100" : "FAIL";
      console.log(
        `  ${test.seg} t=${test.t}: (${det2.cx},${det2.cy},r=${det2.radius}) ` +
        `ref=(${ref.cx},${ref.cy},r=${ref.r}) dx=${dx} dy=${dy} ${gate} sup=${det2.support.toFixed(3)}`
      );
    }
  }
}

process.exit(0);
