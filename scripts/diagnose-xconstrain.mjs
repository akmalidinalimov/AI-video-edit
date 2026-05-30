/**
 * Test tighter x-constraint [580,900] + yMin=200 to exclude:
 *  - cx≈74-83 left-edge artifacts from VIRALE sidebar (seg_2/seg_4)
 *  - cx≈912 right-side false cluster (seg_5)
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

const { measureReferenceCircles } = await import("@/lib/analysis/reference-measurer");
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

const CONFIGS = [
  { label: "x=[580,900] yMin=200", xMin: 580, xMax: 900, yMin: 200, yMax: Math.round(CANVAS.height * 0.50) },
  { label: "x=[580,900] yMin=300", xMin: 580, xMax: 900, yMin: 300, yMax: Math.round(CANVAS.height * 0.50) },
  { label: "x=[600,900] yMin=200", xMin: 600, xMax: 900, yMin: 200, yMax: Math.round(CANVAS.height * 0.50) },
  { label: "x=[580,880] yMin=200", xMin: 580, xMax: 880, yMin: 200, yMax: Math.round(CANVAS.height * 0.50) },
];

for (const cfg of CONFIGS) {
  console.log(`\n=== ${cfg.label} r=[200,230] 30fps ===`);
  const measured = await measureReferenceCircles({
    ffmpegPath: FFMPEG,
    refVideoPath: REF,
    canvas: CANVAS,
    segments: SEGMENTS,
    tmpDir: path.join(ROOT, "public", "exports", "diag-xconstrain"),
    centerRegion: { xMin: cfg.xMin, xMax: cfg.xMax, yMin: cfg.yMin, yMax: cfg.yMax },
    radiusRange: { min: 200, max: 230 },
    framesPerSegment: 30,
    useTemporalClustering: true,
  });

  let within50 = 0, within30 = 0;
  for (const seg of SEGMENTS) {
    const m = measured.get(seg.id);
    const ref = REF_CORRECT[seg.id];
    if (!m) { console.log(`  ${seg.id}: NO DET`); continue; }
    const dx = Math.abs(m.cx - ref.cx), dy = Math.abs(m.cy - ref.cy);
    const gate = dx <= 30 && dy <= 30 ? "PASS30" : dx <= 50 && dy <= 50 ? "PASS50" : "FAIL";
    if (gate === "PASS30") { within30++; within50++; }
    else if (gate === "PASS50") within50++;
    console.log(`  ${seg.id}: meas=(${m.cx},${m.cy},r=${m.radius}) n=${m.samples} ref=(${ref.cx},${ref.cy},r=${ref.r}) dx=${dx} dy=${dy} ${gate}`);
  }
  console.log(`  Result: ${within30}/4 PASS30  ${within50}/4 PASS50`);
}

process.exit(0);
