/**
 * Diagnose circle detection — runs the temporal-persistence clustering for all
 * 4 circle segments of ref.MOV and prints the full cluster breakdown so we can
 * see which circles the Hough detector is finding vs which one wins.
 *
 * Run: node --loader tsx/esm scripts/diagnose-circles.mjs
 * Or:  npx tsx scripts/diagnose-circles.mjs
 */

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── Load .env.local ──
import fs from "fs";
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

// ── Import pipeline module (tsx handles TS→JS) ──
// Uses dynamic import so tsx transpiles on the fly
const { measureReferenceCircles } = await import("@/lib/analysis/reference-measurer");

const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF_VIDEO = path.join(ROOT, "public", "uploads", "references", "ref.MOV");
const TMP_DIR = path.join(ROOT, "public", "exports", "diag-circles");
fs.mkdirSync(TMP_DIR, { recursive: true });

// Canvas: 1080×1920 (portrait 9:16)
const CANVAS = { width: 1080, height: 1920 };

// Segments from the blueprint
const SEGMENTS = [
  { id: "seg_2", start: 3.0,  end: 9.2,  shape: "circle" },
  { id: "seg_3", start: 9.2,  end: 12.8, shape: "circle" },
  { id: "seg_4", start: 12.8, end: 17.9, shape: "circle" },
  { id: "seg_5", start: 17.9, end: 24.1, shape: "circle" },
];

// Known correct positions for reference
const REF_CORRECT = {
  seg_2: { cx: 745, cy: 565, r: 205 },
  seg_3: { cx: 793, cy: 518, r: 218 },
  seg_4: { cx: 755, cy: 485, r: 215 },
  seg_5: { cx: 685, cy: 275, r: 215 },
};

// medianLlmR = 215 (from neutral placeholders r=215 for all 4 segs)
const MEDIAN_LLM_R = 215;

// --- Test multiple radius range configs ---
const CONFIGS = [
  { label: "v4b (0.78–1.42)", minMul: 0.78, maxMul: 1.42 },
  { label: "v4c (0.88–1.18)", minMul: 0.88, maxMul: 1.18 },
  { label: "tight (0.93–1.07)", minMul: 0.93, maxMul: 1.07 },
];

for (const cfg of CONFIGS) {
  const rMin = Math.max(60, Math.round(MEDIAN_LLM_R * cfg.minMul));
  const rMax = Math.round(MEDIAN_LLM_R * cfg.maxMul);
  console.log(`\n${"═".repeat(70)}`);
  console.log(`CONFIG: ${cfg.label}  →  rRange=[${rMin}, ${rMax}]  yMax=${Math.round(CANVAS.height * 0.50)}`);
  console.log(`${"═".repeat(70)}`);

  const measured = await measureReferenceCircles({
    ffmpegPath: FFMPEG,
    refVideoPath: REF_VIDEO,
    canvas: CANVAS,
    segments: SEGMENTS,
    tmpDir: TMP_DIR,
    centerRegion: {
      xMin: 0,
      xMax: CANVAS.width,
      yMin: 0,
      yMax: Math.round(CANVAS.height * 0.50),
    },
    radiusRange: { min: rMin, max: rMax },
    framesPerSegment: 30,
    useTemporalClustering: true,
  });

  let within30 = 0;
  for (const seg of SEGMENTS) {
    const m = measured.get(seg.id);
    const ref = REF_CORRECT[seg.id];
    if (!m) { console.log(`  ${seg.id}: NO DETECTION`); continue; }
    const dx = Math.abs(m.cx - ref.cx);
    const dy = Math.abs(m.cy - ref.cy);
    const dr = Math.abs(m.radius - ref.r);
    const gate = dx <= 30 && dy <= 30 ? "PASS" : "FAIL";
    if (gate === "PASS") within30++;
    console.log(
      `  ${seg.id}: meas=(${m.cx},${m.cy},r=${m.radius}) samples=${m.samples}` +
      `  ref=(${ref.cx},${ref.cy},r=${ref.r})  dx=${dx} dy=${dy} dr=${dr}  ${gate}` +
      (m.confident ? "" : " [uncertain]")
    );
  }
  console.log(`  Result: ${within30}/4 within 30px gate`);
}

process.exit(0);
