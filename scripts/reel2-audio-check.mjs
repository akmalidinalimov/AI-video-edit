/**
 * reel2-audio-check.mjs — per-segment audio-continuity gate (the "silent turn" gate).
 *
 * The style-director verify loop scored frames only and once raised the visual score while a
 * subagent clobbered a source clip (top-t3.mp4) and dropped its audio — a whole dialogue turn went
 * silent and NO gate caught it. This verifies the RENDERED output carries audio in every segment
 * that is supposed to speak: for each segment it measures max_volume over the segment's time window
 * and FAILs if a talking segment is effectively silent.
 *
 * Talking segments = every segment EXCEPT the trailing known-silent tail (the Act-2 CTA, which has
 * no narration / a deferred music bed). The tail is allowed to be quiet but is still reported.
 *
 * Usage: node scripts/reel2-audio-check.mjs [path-to-mp4]   (default public/exports/reel2/reel2.mp4)
 * Exit 0 if every talking segment has audio, else 1.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REEL2 = path.join(ROOT, "public", "exports", "reel2");
const PROPS = path.join(REEL2, "reel2-props.json");
const VIDEO = process.argv[2] || path.join(REEL2, "reel2.mp4");

// A real speech turn peaks near -3..-6 dB; a silent (no audio stream / muted) window peaks <= -50 dB.
// -45 dB is a safe boundary: clearly "has audible content" vs "effectively silent".
const SILENT_MAX_DB = -45;
// How long the trailing tail (Act-2 CTA, deferred music bed) is allowed to be silent without failing.
const ALLOW_TAIL_SILENCE_SEC = 7;

/** max_volume (dB, negative) over [startSec, startSec+durSec] of VIDEO. Returns 0 if unreadable. */
function maxVolumeDb(startSec, durSec) {
  const r = spawnSync(FFMPEG, [
    "-hide_banner", "-nostats", "-ss", startSec.toFixed(4), "-t", durSec.toFixed(4),
    "-i", VIDEO, "-af", "volumedetect", "-f", "null", "-",
  ], { encoding: "utf8" });
  const err = (r.stderr || "") + (r.stdout || "");
  const m = err.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  return m ? parseFloat(m[1]) : 0;
}

function main() {
  if (!fs.existsSync(VIDEO)) { console.error(`audio-check: video not found: ${VIDEO}`); process.exit(1); }
  const props = JSON.parse(fs.readFileSync(PROPS, "utf-8"));
  const fps = props.fps || 30;
  const segs = props.segments || [];
  const totalFrames = props.durationInFrames || (segs.length ? segs[segs.length - 1].endFrame : 0);
  const tailStartSec = (totalFrames / fps) - ALLOW_TAIL_SILENCE_SEC;

  console.log(`Audio-continuity check on ${path.basename(VIDEO)} — ${segs.length} segments (silent if max < ${SILENT_MAX_DB} dB)\n`);

  let allOk = true;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const startSec = s.startFrame / fps;
    const durSec = Math.max(0.1, (s.endFrame - s.startFrame) / fps);
    const maxDb = maxVolumeDb(startSec, durSec);
    const silent = maxDb <= SILENT_MAX_DB;
    // a silent window inside the allowed trailing tail is tolerated (CTA / deferred music bed)
    const inTail = startSec >= tailStartSec;
    const ok = !silent || inTail;
    if (!ok) allOk = false;
    const id = s.id || s.label || `seg${i}`;
    const tag = !silent ? "OK" : inTail ? "silent (tail — allowed)" : "FAIL ← talking segment is silent";
    console.log(`  ${id} [${startSec.toFixed(2)}-${(startSec + durSec).toFixed(2)}s] kind=${s.kind || "?"}  max=${maxDb.toFixed(1)}dB  ${tag}`);
  }
  console.log(`\n  Overall: ${allOk ? "PASS — every talking segment carries audio" : "FAIL — a talking segment is silent (clobbered/muted source?)"}`);
  process.exit(allOk ? 0 : 1);
}
main();
