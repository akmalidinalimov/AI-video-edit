/**
 * compare-to-reference.mjs — side-by-side fidelity comparison (the iterate loop).
 *
 * Detects scene changes in BOTH the reference and the produced output, extracts a
 * frame per scene, and stitches REFERENCE | OUTPUT side-by-side per scene so you can
 * inspect layout / position / crop / stretch and iterate toward 95%+ fidelity.
 *
 * Usage:
 *   node scripts/compare-to-reference.mjs <reference.mp4> <output.mp4> [outDir] [sceneThr]
 *
 * Output (in outDir, default public/exports/compare-<ts>/):
 *   ref/f_###.png   — reference scene frames (first frame + each scene change)
 *   out/f_###.png   — output scene frames
 *   pairs/pair_###.png — REFERENCE (left) | OUTPUT (right), paired by scene index
 *   contact-ref.png / contact-out.png — the full scene sequence as a grid
 *
 * Left = reference (target), Right = output (produced). Paired by scene index.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FFMPEG = path.join(
  process.cwd(), "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe"
);

const ref = process.argv[2];
const out = process.argv[3];
const outDir = process.argv[4] || path.join(process.cwd(), "public", "exports", `compare-${Date.now()}`);
const sceneThr = process.argv[5] || "0.3";

if (!ref || !out) {
  console.error("usage: node scripts/compare-to-reference.mjs <reference.mp4> <output.mp4> [outDir] [sceneThr]");
  process.exit(2);
}
for (const f of [ref, out]) {
  if (!fs.existsSync(f)) { console.error(`not found: ${f}`); process.exit(2); }
}

const refDir = path.join(outDir, "ref");
const outFrDir = path.join(outDir, "out");
const pairDir = path.join(outDir, "pairs");
for (const d of [refDir, outFrDir, pairDir]) fs.mkdirSync(d, { recursive: true });

const ff = (args) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: "pipe" });

/** Extract first frame + each scene-change frame, scaled to height 480. */
function extractScenes(video, dir) {
  ff([
    "-i", video,
    "-vf", `select='eq(n\\,0)+gt(scene\\,${sceneThr})',scale=-2:480,setsar=1`,
    "-vsync", "vfr",
    "-frames:v", "60",
    path.join(dir, "f_%03d.png"),
  ]);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
}

console.log("Extracting scene frames...");
const refFrames = extractScenes(ref, refDir);
const outFrames = extractScenes(out, outFrDir);
console.log(`  reference: ${refFrames.length} scenes  |  output: ${outFrames.length} scenes`);

// Pair by scene index; stitch ref (left) | white gap | out (right).
const n = Math.min(refFrames.length, outFrames.length);
for (let i = 0; i < n; i++) {
  const a = path.join(refDir, refFrames[i]);
  const b = path.join(outFrDir, outFrames[i]);
  ff([
    "-i", a, "-i", b,
    "-filter_complex", "[0:v]pad=iw+12:ih:0:0:white[l];[l][1:v]hstack=inputs=2",
    path.join(pairDir, `pair_${String(i + 1).padStart(3, "0")}.png`),
  ]);
}

// Contact sheets (full sequence as a grid) for each video.
const tileCols = 4;
function contact(dir, frames, file) {
  if (!frames.length) return;
  const rows = Math.ceil(frames.length / tileCols);
  try {
    ff([
      "-i", path.join(dir, "f_%03d.png"),
      "-filter_complex", `scale=-2:240,tile=${tileCols}x${rows}:margin=6:padding=6:color=white`,
      "-frames:v", "1",
      path.join(outDir, file),
    ]);
  } catch { /* tile can be finicky on odd counts; pairs are the main output */ }
}
contact(refDir, refFrames, "contact-ref.png");
contact(outFrDir, outFrames, "contact-out.png");

console.log(`\nDone. ${n} side-by-side pairs (REF | OUT) in:\n  ${pairDir}`);
if (refFrames.length !== outFrames.length) {
  console.log(`NOTE: scene counts differ (ref ${refFrames.length} vs out ${outFrames.length}) — pairing by index up to ${n}.`);
}
console.log(`Contact sheets: contact-ref.png / contact-out.png in ${outDir}`);
