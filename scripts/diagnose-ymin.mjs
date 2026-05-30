/**
 * Test yMin constraint to exclude phantom circle-centers above canvas
 * caused by outer-direction voting from the inner ring boundary.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF = path.join(ROOT, "public", "uploads", "references", "ref.MOV");

function extractFrame(t, fp) {
  if (fs.existsSync(fp)) return true;
  const r = spawnSync(FFMPEG, ["-y", "-ss", String(t), "-i", REF, "-frames:v", "1", "-vf", `scale=${CANVAS.width}:${CANVAS.height}`, fp], { encoding: "utf-8" });
  return r.status === 0 && fs.existsSync(fp);
}

const REF_CORRECT = {
  seg_2: { cx: 745, cy: 565, r: 205 },
  seg_3: { cx: 793, cy: 518, r: 218 },
  seg_4: { cx: 755, cy: 485, r: 215 },
  seg_5: { cx: 685, cy: 275, r: 215 },
};

// Test different yMin values for seg_2 t=6.0 (hardest case)
const SEG2_FRAME = path.join(TMP, "frame_seg_2_6.jpg");
extractFrame(6.0, SEG2_FRAME);

console.log("=== seg_2 t=6.0: varying yMin with xMin=580 r=[200,230] ===");
for (const yMin of [0, 100, 200, 250, 300, 350, 400]) {
  const det = await measureCircleFromFrame({
    framePath: SEG2_FRAME, canvas: CANVAS, downscale: 3,
    radiusRange: { min: 200, max: 230 },
    centerRegion: { xMin: 580, xMax: 920, yMin, yMax: 800 },
  });
  if (!det) { console.log(`  yMin=${yMin}: NO DET`); continue; }
  const ref = REF_CORRECT.seg_2;
  const dx = Math.abs(det.cx - ref.cx), dy = Math.abs(det.cy - ref.cy);
  const gate = dx <= 50 && dy <= 50 ? "PASS50" : dx <= 100 && dy <= 100 ? "PASS100" : "FAIL";
  console.log(`  yMin=${yMin}: (${det.cx},${det.cy},r=${det.radius}) dx=${dx} dy=${dy} ${gate} sup=${det.support.toFixed(3)}`);
}

// Now test temporal clustering with yMin=300
console.log("\n=== Temporal clustering test with yMin=300, tight radius r=[200,230] ===");
const { measureReferenceCircles } = await import("@/lib/analysis/reference-measurer");
const SEGMENTS = [
  { id: "seg_2", start: 3.0,  end: 9.2,  shape: "circle" },
  { id: "seg_3", start: 9.2,  end: 12.8, shape: "circle" },
  { id: "seg_4", start: 12.8, end: 17.9, shape: "circle" },
  { id: "seg_5", start: 17.9, end: 24.1, shape: "circle" },
];

const measured = await measureReferenceCircles({
  ffmpegPath: FFMPEG,
  refVideoPath: REF,
  canvas: CANVAS,
  segments: SEGMENTS,
  tmpDir: path.join(ROOT, "public", "exports", "diag-ymin"),
  centerRegion: { xMin: 0, xMax: CANVAS.width, yMin: 200, yMax: Math.round(CANVAS.height * 0.50) },
  radiusRange: { min: 200, max: 230 },
  framesPerSegment: 30,
  useTemporalClustering: true,
});

let within50 = 0;
for (const seg of SEGMENTS) {
  const m = measured.get(seg.id);
  const ref = REF_CORRECT[seg.id];
  if (!m) { console.log(`  ${seg.id}: NO DET`); continue; }
  const dx = Math.abs(m.cx - ref.cx), dy = Math.abs(m.cy - ref.cy);
  const gate = dx <= 50 && dy <= 50 ? "PASS50" : "FAIL";
  if (gate === "PASS50") within50++;
  console.log(`  ${seg.id}: meas=(${m.cx},${m.cy},r=${m.radius}) n=${m.samples} ref=(${ref.cx},${ref.cy},r=${ref.r}) dx=${dx} dy=${dy} ${gate}`);
}
console.log(`  Result: ${within50}/4 within 50px gate`);

process.exit(0);
