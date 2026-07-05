/**
 * aroll-prep.mjs — Stage 0: A-roll preparation (the clean spine).
 *
 * Cuts silences (leading / trailing / long internal gaps) from the raw A-roll
 * clips, concatenates the speech into ONE clean A-roll, and writes an EDL
 * document of exactly what was kept/cut and why. The clean A-roll's length
 * becomes the final video length (when the speech ends, the video ends).
 *
 * Rules (from user feedback):
 *  - Always cut leading + trailing dead-air.
 *  - Cut internal silences longer than MIN_INTERNAL_CUT (a real gap).
 *  - KEEP short within-speech pauses (don't cut mid-thought).
 *  - (Stage 0b, next: Gemini pass to drop false-starts / repeated takes.)
 *
 * Usage: node scripts/aroll-prep.mjs <out_dir> <clip1> [clip2 ...]
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FFMPEG = path.join(process.cwd(), "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const NOISE_DB = -30;          // silence threshold
const MIN_SILENCE = 0.35;      // silencedetect min duration to report
const EDGE_TOL = 0.15;         // a silence within this of clip edge = leading/trailing
const MIN_INTERNAL_CUT = 0.5;  // internal silence longer than this is cut (else kept)

const outDir = process.argv[2];
const clips = process.argv.slice(3);
if (!outDir || clips.length === 0) {
  console.error("usage: node scripts/aroll-prep.mjs <out_dir> <clip1> [clip2 ...]");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

function probeDuration(file) {
  const r = spawnSync(FFMPEG, ["-i", file], { encoding: "utf8" });
  const m = (r.stderr || "").match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!m) throw new Error(`no duration for ${file}`);
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

function detectSilences(file) {
  const r = spawnSync(FFMPEG, ["-i", file, "-af", `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SILENCE}`, "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], { encoding: "utf8" });
  const txt = r.stderr || "";
  const sil = [];
  let curStart = null;
  for (const line of txt.split("\n")) {
    const s = line.match(/silence_start:\s*([\d.eE+-]+)/);
    const e = line.match(/silence_end:\s*([\d.eE+-]+)/);
    if (s) curStart = parseFloat(s[1]);
    if (e && curStart !== null) { sil.push([Math.max(0, curStart), parseFloat(e[1])]); curStart = null; }
  }
  return sil;
}

/** keep-segments = clip minus the cuttable silences */
function keepSegments(dur, silences) {
  const cuts = [];
  for (const [s, e] of silences) {
    const leading = s <= EDGE_TOL;
    const trailing = e >= dur - EDGE_TOL;
    const internalLong = (e - s) >= MIN_INTERNAL_CUT;
    if (leading || trailing || internalLong) cuts.push([s, e]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const keep = [];
  let pos = 0;
  for (const [s, e] of cuts) {
    if (s - pos > 0.05) keep.push([+pos.toFixed(3), +s.toFixed(3)]);
    pos = Math.max(pos, e);
  }
  if (dur - pos > 0.05) keep.push([+pos.toFixed(3), +dur.toFixed(3)]);
  return { keep, cuts };
}

// ── analyze each clip ──
const edl = { clips: [], totalRawSec: 0, totalCleanSec: 0, savedSec: 0 };
const filterParts = [];
const concatLabels = [];
let segIdx = 0;
clips.forEach((clip, ci) => {
  const dur = probeDuration(clip);
  const sil = detectSilences(clip);
  const { keep, cuts } = keepSegments(dur, sil);
  const cleanSec = keep.reduce((s, [a, b]) => s + (b - a), 0);
  edl.clips.push({ clip: path.basename(clip), durationSec: +dur.toFixed(2), silences: sil.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]), cuts: cuts.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]), keep, cleanSec: +cleanSec.toFixed(2) });
  edl.totalRawSec += dur; edl.totalCleanSec += cleanSec;
  for (const [a, b] of keep) {
    filterParts.push(`[${ci}:v]trim=${a}:${b},setpts=PTS-STARTPTS[v${segIdx}];[${ci}:a]atrim=${a}:${b},asetpts=PTS-STARTPTS[a${segIdx}]`);
    concatLabels.push(`[v${segIdx}][a${segIdx}]`);
    segIdx++;
  }
});
edl.savedSec = +(edl.totalRawSec - edl.totalCleanSec).toFixed(2);
edl.totalRawSec = +edl.totalRawSec.toFixed(2);
edl.totalCleanSec = +edl.totalCleanSec.toFixed(2);

// ── render the clean A-roll ──
const cleanPath = path.join(outDir, "aroll-clean.mp4");
const filter = filterParts.join(";") + ";" + concatLabels.join("") + `concat=n=${segIdx}:v=1:a=1[v][a]`;
const args = ["-y", "-loglevel", "error"];
for (const c of clips) args.push("-i", c);
args.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", cleanPath);
execFileSync(FFMPEG, args, { stdio: "pipe" });

fs.writeFileSync(path.join(outDir, "aroll-edl.json"), JSON.stringify(edl, null, 2));
console.log(`A-roll prep: raw ${edl.totalRawSec}s -> clean ${edl.totalCleanSec}s (cut ${edl.savedSec}s of silence across ${segIdx} segments)`);
for (const c of edl.clips) console.log(`  ${c.clip}: keep ${JSON.stringify(c.keep)}  | cut ${JSON.stringify(c.cuts)}`);
console.log(`clean A-roll: ${cleanPath}`);
console.log(`EDL doc: ${path.join(outDir, "aroll-edl.json")}`);
