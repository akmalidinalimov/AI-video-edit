/**
 * reel2-cut-check.mjs — no black-flash at segment cuts (the "glitch" gate).
 *
 * v3.1 faded every segment in from opacity 0 over the black root canvas, so each hard cut
 * showed a black frame + 3-frame fade-up (the ~3.37s glitch the user caught). This verifies
 * the RENDERED output has NO near-black dip at any segment boundary: for each boundary it
 * measures mean brightness of the last frame BEFORE the cut and the first 2 frames AT/AFTER it,
 * and FAILs if an at/after frame collapses to near-black relative to its neighbours.
 *
 * Mirrors reel-1's "no black frames between contiguous ranges" rule, for the Remotion path.
 *
 * Usage: node scripts/reel2-cut-check.mjs [path-to-mp4]   (default public/exports/reel2/reel2.mp4)
 * Exit 0 if all boundaries are clean, else 1.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REEL2 = path.join(ROOT, "public", "exports", "reel2");
const PROPS = path.join(REEL2, "reel2-props.json");
const VIDEO = process.argv[2] || path.join(REEL2, "reel2.mp4");

const ABS_BLACK = 16;     // a frame this dark (0-255) at a cut is a hard black-flash → always fail
const REL_DROP = 0.5;     // or a drop below 50% of the min neighbour brightness → fade-from-black

/** Mean luma (0-255) of one frame at time t. */
function brightness(t) {
  const tmp = path.join(REEL2, `_cut_probe.png`);
  execFileSync(FFMPEG, ["-y", "-ss", t.toFixed(4), "-i", VIDEO, "-frames:v", "1",
    "-vf", "scale=1:1,format=gray", tmp, "-loglevel", "error"], { stdio: "pipe" });
  // read the single gray pixel via ffmpeg raw out
  const raw = execFileSync(FFMPEG, ["-i", tmp, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  try { fs.unlinkSync(tmp); } catch {}
  return raw.length ? raw[0] : 0;
}

function main() {
  const props = JSON.parse(fs.readFileSync(PROPS, "utf-8"));
  const fps = props.fps || 30;
  const segs = props.segments;
  const fd = 1 / fps;
  console.log(`Cut-glitch check on ${path.basename(VIDEO)} — ${segs.length - 1} boundaries\n`);

  let allOk = true;
  for (let i = 1; i < segs.length; i++) {
    const cutFrame = segs[i].startFrame;
    const tBefore = (cutFrame - 1) * fd + fd * 0.5;   // last frame of prev segment
    const tAt = cutFrame * fd + fd * 0.5;              // first frame of this segment
    const tAfter = (cutFrame + 1) * fd + fd * 0.5;     // second frame
    const bBefore = brightness(tBefore);
    const bAt = brightness(tAt);
    const bAfter = brightness(tAfter);
    // reference = the darker neighbour (so a genuinely dark scene on one side doesn't false-trigger)
    const neighbourMin = Math.min(bBefore, bAfter);
    const blackFlash = bAt <= ABS_BLACK && neighbourMin > ABS_BLACK * 2;
    const fadeDip = neighbourMin > 0 && bAt < neighbourMin * REL_DROP;
    const ok = !blackFlash && !fadeDip;
    if (!ok) allOk = false;
    console.log(`  cut@f${cutFrame} (${(cutFrame * fd).toFixed(3)}s): before=${bBefore} at=${bAt} after=${bAfter}  ${ok ? "OK" : "FAIL ← black/fade dip at cut"}`);
  }
  console.log(`\n  Overall: ${allOk ? "PASS — no black-flash at any cut (continuous)" : "FAIL — black/fade dip at one or more cuts"}`);
  process.exit(allOk ? 0 : 1);
}
main();
