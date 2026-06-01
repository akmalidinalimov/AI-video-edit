/**
 * aroll-clips.mjs — the single source of truth for "which A-roll clips exist".
 *
 * The pipeline is GENERIC over the number of A-rolls. Stage 1 discovers every
 * video in public/uploads/arolls/ and records them in stage1-summary.json
 * (clipCount + clips[]). Everything downstream (align, select/order, render)
 * reads the clip list from here instead of hardcoding a count or filenames.
 */
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const STAGE1 = path.join(ROOT, "public", "exports", "multi-aroll", "stage1");
const AROLL_DIR = path.join(ROOT, "public", "uploads", "arolls");

/** Clip registry: [{ clipIndex, clipName, clipPath, ... }]. */
export function getClips() {
  const summary = path.join(STAGE1, "stage1-summary.json");
  if (fs.existsSync(summary)) {
    try {
      const s = JSON.parse(fs.readFileSync(summary, "utf-8"));
      if (Array.isArray(s.clips) && s.clips.length) return s.clips;
    } catch { /* fall through */ }
  }
  // Fallback: count clip_N_transcription.json, or list the arolls folder.
  const trs = [];
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(STAGE1, `clip_${i}_transcription.json`))) {
      trs.push({ clipIndex: i, clipName: `clip_${i}`, clipPath: null });
    } else if (trs.length) break;
  }
  if (trs.length) return trs;
  if (fs.existsSync(AROLL_DIR)) {
    return fs.readdirSync(AROLL_DIR)
      .filter(f => /\.(mov|mp4|m4v|webm)$/i.test(f)).sort()
      .map((f, i) => ({ clipIndex: i, clipName: f, clipPath: path.join(AROLL_DIR, f) }));
  }
  return [];
}

/** Number of A-roll clips. */
export function getClipCount() {
  return getClips().length;
}
