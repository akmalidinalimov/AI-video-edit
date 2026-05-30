/**
 * Validate CV circle detection against the reference video.
 *
 * For several timestamps, detect the circle PIP from the actual pixels and
 * draw the DETECTED circle (green) plus the BLUEPRINT box (red) on the frame,
 * so we can see whether CV measurement beats Gemini's estimate.
 *
 * Usage: npx tsx scripts/test-circle-detection.ts
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { measureCircleRobust } from "@/lib/analysis/coordinate-measurer";

const ROOT = process.cwd();
const FF = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF = path.join(ROOT, "public", "uploads", "IMG_6018.MOV");
const OUT = path.join(ROOT, "public", "exports", "diagnosis");
const CANVAS = { width: 1080, height: 1920 };

fs.mkdirSync(OUT, { recursive: true });

// Reference state time-range → blueprint circle box (canvas space).
// We sample several frames across each state and take the median detection.
const CASES = [
  { range: [3.0, 9.0], mid: 6, label: "state1", blueprint: { x: 442, y: 195, w: 460, h: 460 } },
  { range: [9.3, 12.6], mid: 11, label: "state2", blueprint: { x: 576, y: 251, w: 388, h: 388 } },
  { range: [13.0, 17.3], mid: 14, label: "state3", blueprint: { x: 579, y: 171, w: 424, h: 424 } },
  { range: [17.7, 23.9], mid: 20, label: "state4", blueprint: { x: 579, y: 83, w: 432, h: 432 } },
];

function sampleTimestamps(start: number, end: number, n: number): number[] {
  const ts: number[] = [];
  for (let i = 0; i < n; i++) ts.push(start + ((end - start) * (i + 0.5)) / n);
  return ts;
}

function extractFrame(t: number, outPath: string) {
  const r = spawnSync(
    FF,
    ["-y", "-ss", String(t), "-i", REF, "-frames:v", "1", "-vf", `scale=${CANVAS.width}:${CANVAS.height}`, outPath],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`ffmpeg extract failed: ${r.stderr?.slice(-300)}`);
}

function drawOverlay(srcFrame: string, outPath: string, det: { cx: number; cy: number; radius: number } | null, bp: { x: number; y: number; w: number; h: number }) {
  // Red = blueprint box; Green = detected circle bounding box + crosshair
  const filters: string[] = [
    `drawbox=x=${bp.x}:y=${bp.y}:w=${bp.w}:h=${bp.h}:color=red@1:t=4`,
  ];
  if (det) {
    const gx = det.cx - det.radius;
    const gy = det.cy - det.radius;
    const d = det.radius * 2;
    filters.push(`drawbox=x=${gx}:y=${gy}:w=${d}:h=${d}:color=lime@1:t=4`);
    // crosshair at detected center
    filters.push(`drawbox=x=${det.cx - 2}:y=${gy}:w=4:h=${d}:color=lime@0.6:t=fill`);
  }
  const r = spawnSync(
    FF,
    ["-y", "-i", srcFrame, "-vf", filters.join(","), outPath],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`ffmpeg overlay failed: ${r.stderr?.slice(-300)}`);
}

async function main() {
  console.log("═".repeat(60));
  console.log("  CV CIRCLE DETECTION TEST (green=detected, red=blueprint)");
  console.log("═".repeat(60));

  const N = 12; // frames sampled per state
  for (const c of CASES) {
    const ts = sampleTimestamps(c.range[0], c.range[1], N);
    const framePaths: string[] = [];
    ts.forEach((t, idx) => {
      const fp = path.join(OUT, `f_${c.label}_${idx}.jpg`);
      extractFrame(t, fp);
      framePaths.push(fp);
    });

    const det = await measureCircleRobust({
      framePaths,
      canvas: CANVAS,
      downscale: 3,
      // Confident detections show radius is ~constant (~256). Constrain tightly.
      radiusRange: { min: 235, max: 280 },
      // Circle x is ~constant (~782); it only slides vertically. Constrain x
      // tightly and search y broadly — this rejects UI-clutter false peaks.
      centerRegion: { xMin: 690, xMax: 870, yMin: 300, yMax: 680 },
    });

    const bpCx = c.blueprint.x + c.blueprint.w / 2;
    const bpCy = c.blueprint.y + c.blueprint.h / 2;
    const bpR = c.blueprint.w / 2;

    if (det) {
      const dCx = Math.round(det.cx - bpCx);
      const dCy = Math.round(det.cy - bpCy);
      const dR = Math.round(det.radius - bpR);
      console.log(`\n  ${c.label} (${c.range[0]}-${c.range[1]}s, ${det.samples}/${N} frames):`);
      console.log(`    Blueprint: center(${Math.round(bpCx)},${Math.round(bpCy)}) r=${Math.round(bpR)}`);
      console.log(`    Detected : center(${det.cx},${det.cy}) r=${det.radius}  support=${(det.support * 100).toFixed(0)}% spread(cx${det.spread.cx},cy${det.spread.cy},r${det.spread.radius})`);
      console.log(`    Δ vs BP  : center(${dCx >= 0 ? "+" : ""}${dCx},${dCy >= 0 ? "+" : ""}${dCy}) r(${dR >= 0 ? "+" : ""}${dR})`);
    } else {
      console.log(`\n  ${c.label}: NO CIRCLE DETECTED`);
    }

    // Draw overlay on the mid frame
    const midFrame = path.join(OUT, `frame_${c.label}.jpg`);
    extractFrame(c.mid, midFrame);
    const overlay = path.join(OUT, `detect_${c.label}.jpg`);
    drawOverlay(midFrame, overlay, det, c.blueprint);
    console.log(`    → ${path.relative(ROOT, overlay)}`);

    // Cleanup sampled frames
    framePaths.forEach((fp) => { try { fs.unlinkSync(fp); } catch {} });
  }

  console.log("\n  Done. Compare detect_*.jpg (green=CV, red=Gemini blueprint).");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
