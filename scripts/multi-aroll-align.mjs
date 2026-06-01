/**
 * multi-aroll-align.mjs — run MMS forced alignment on every A-roll clip to get
 * PRECISE per-word timestamps (replacing Gemini's ~300-1000ms drift). Run this at
 * upload/transcription time, after stage1 produces clip_N_transcription.json.
 *
 *   node scripts/multi-aroll-align.mjs
 *
 * For each clip it calls scripts/python/align_mms.py, which updates
 * clip_N_transcription.json (word + sentence times) and clip_N_words.json in place
 * (backing up the Gemini version once). The ~1GB MMS model is cached under
 * scripts/python/.torch (download it once via PowerShell if missing — see
 * .knowledge/lessons/multi-aroll-qa.md).
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { getClips } from "./lib/aroll-clips.mjs";

const ROOT = process.cwd();
const PY = path.join(ROOT, "scripts", "python", ".venv", "Scripts", "python.exe");
const ALIGN = path.join(ROOT, "scripts", "python", "align_mms.py");
const STAGE1 = path.join(ROOT, "public", "exports", "multi-aroll", "stage1");

const clips = getClips();
if (!clips.length) { console.error("No A-roll clips found (run stage1 first)."); process.exit(1); }

for (const c of clips) {
  const i = c.clipIndex;
  const tr = path.join(STAGE1, `clip_${i}_transcription.json`);
  const words = path.join(STAGE1, `clip_${i}_words.json`);
  const audio = c.clipPath;
  if (!fs.existsSync(tr) || !audio || !fs.existsSync(audio)) { console.log(`skip clip ${i} (missing input)`); continue; }
  console.log(`\n=== aligning clip ${i} (${c.clipName}) ===`);
  try {
    execFileSync(PY, [ALIGN, audio, tr, words], { stdio: "inherit" });
  } catch (e) {
    console.error(`  align failed for clip ${i}: ${e.message}`);
    process.exit(1);
  }
}
console.log(`\n✓ MMS alignment complete for ${clips.length} clips (detector:mms).`);
