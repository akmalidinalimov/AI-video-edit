#!/usr/bin/env node
/**
 * motion-library-check.mjs — render-test the 16 motion-library patterns (Step B of
 * docs/NEXT-SESSION-HANDOFF.md).
 *
 * Renders the SELF-CONTAINED `MotionLibraryProbe` composition (no external media) to a temp
 * mp4, then probes per-segment brightness (the ffmpeg single-gray-pixel technique from
 * scripts/reel2-cut-check.mjs). FAILS if the render errors OR any pattern segment is fully
 * black / empty — i.e. if a motion-library pattern doesn't render visible content.
 *
 * Each pattern occupies SEG_FRAMES frames; we sample a few frames inside each segment and
 * require the MAX brightness across the samples to clear a floor (so a momentarily-dark frame
 * mid-animation — e.g. a transition's fade midpoint — doesn't false-fail a visible pattern).
 *
 * Usage: node scripts/motion-library-check.mjs
 * Exit 0 if all 16 patterns render with visible content; exit 1 on any render error / black segment.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const ENTRY = path.join(ROOT, "src", "remotion", "entry.tsx");
const COMP_ID = "MotionLibraryProbe";

// Mirror the probe's manifest so per-segment labels line up with the render.
// (Kept in sync with src/remotion/compositions/MotionLibraryProbe.tsx PATTERNS / SEG_FRAMES.)
const SEG_FRAMES = 36;
const FPS = 30;
const PATTERNS = [
  "push-in / pull-out", "camera-pan", "orbit", "parallax",
  "draw-on", "scale-pop", "slide-in", "mask-reveal", "number-counter",
  "kinetic-typography", "word-highlight", "typewriter", "lower-third",
  "whip-pan", "match-cut", "cross-dissolve",
];

const BRIGHT_FLOOR = 8; // mean luma (0-255); below this across ALL samples = black/empty segment

/** Mean luma (0-255) of a 1x1 downscale of the frame at time t (seconds). */
function brightness(video, t) {
  const tmp = path.join(os.tmpdir(), `_ml_probe_${process.pid}.png`);
  execFileSync(FFMPEG, ["-y", "-ss", t.toFixed(4), "-i", video, "-frames:v", "1",
    "-vf", "scale=1:1,format=gray", tmp, "-loglevel", "error"], { stdio: "pipe" });
  const raw = execFileSync(FFMPEG, ["-i", tmp, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { stdio: ["pipe", "pipe", "pipe"] });
  try { fs.unlinkSync(tmp); } catch {}
  return raw.length ? raw[0] : 0;
}

function renderProbe(out) {
  const bin = path.join(ROOT, "node_modules", ".bin",
    process.platform === "win32" ? "remotion.cmd" : "remotion");
  const args = ["render", ENTRY, COMP_ID, out, "--concurrency=2", "--timeout=120000"];
  console.log(`Rendering ${COMP_ID} → ${out}\n  ${path.basename(bin)} ${args.join(" ")}\n`);
  const r = spawnSync(bin, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0 && fs.existsSync(out);
}

function main() {
  const out = path.join(os.tmpdir(), `motion-library-probe-${Date.now()}.mp4`);

  if (!renderProbe(out)) {
    console.error("\n❌ FAIL — MotionLibraryProbe did not render (remotion render errored).");
    process.exit(1);
  }

  console.log(`\nProbing per-segment brightness (${PATTERNS.length} patterns × ${SEG_FRAMES}f)\n`);
  const fd = 1 / FPS;
  let allOk = true;

  for (let i = 0; i < PATTERNS.length; i++) {
    const startF = i * SEG_FRAMES;
    // sample at ~25%, 50%, 75% of the segment; take the brightest (robust to fade midpoints)
    const sampleFs = [0.25, 0.5, 0.75].map((p) => Math.floor(startF + p * SEG_FRAMES));
    const samples = sampleFs.map((f) => brightness(out, f * fd + fd * 0.5));
    const maxB = Math.max(...samples);
    const ok = maxB >= BRIGHT_FLOOR;
    if (!ok) allOk = false;
    const label = `${String(i + 1).padStart(2, "0")} ${PATTERNS[i]}`.padEnd(28);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} maxLuma=${maxB} (samples ${samples.join(",")})`
      + (ok ? "" : "  ← black/empty segment"));
  }

  console.log(`\n  Overall: ${allOk ? "PASS — all 16 patterns render with visible content" : "FAIL — one or more patterns rendered black/empty"}`);
  try { fs.unlinkSync(out); } catch {}
  process.exit(allOk ? 0 : 1);
}

main();
