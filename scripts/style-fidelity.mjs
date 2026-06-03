/**
 * style-fidelity.mjs — the CLOSED LOOP that closes the reference→output gap (output side).
 *
 * Compares our RENDERED output against the reference, shot-by-shot, on editing-STYLE dimensions
 * (layout, color grade, typography, motion language, composition, pacing) — NOT content (our
 * subjects differ on purpose). Emits a fidelity SCORE + a PRIORITIZED punch-list of exactly what
 * doesn't match, so we iterate the Remotion build until it matches. Pair with `reference-decoder`.
 *
 * Usage:
 *   node scripts/style-fidelity.mjs <output.mp4> --ref <refId|refVideo> \
 *        [--pairs "outSec:refSec,outSec:refSec,..."] [--votes 2] [--out <dir>]
 *   (no --pairs → 6 points sampled proportionally across both clips)
 *
 * Writes <out>/style-fidelity-report.json + prints a summary + punch-list.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";

const ROOT = process.cwd();
const FF = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const out = process.argv[2];
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
if (!out || out.startsWith("--")) { console.error('usage: node scripts/style-fidelity.mjs <output.mp4> --ref <refId|refVideo> [--pairs "outSec:refSec,..."] [--votes 2]'); process.exit(1); }
const refArg = arg("--ref", "");
const VOTES = Number(arg("--votes", "2"));
const OUTDIR = path.resolve(ROOT, arg("--out", path.dirname(path.resolve(ROOT, out))));
const TMP = path.join(OUTDIR, "_fidelity_tmp"); fs.mkdirSync(TMP, { recursive: true });

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) { const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim(); }
  return process.env.GEMINI_API_KEY;
}
const dur = (abs) => { try { return +execFileSync(FFPROBE, ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", abs], { encoding: "utf-8" }).trim(); } catch { return 0; } };
function frame(abs, t, tag) { const p = path.join(TMP, `${tag}.jpg`); execFileSync(FF, ["-y", "-ss", String(t), "-i", abs, "-frames:v", "1", "-vf", "scale=540:-1", "-q:v", "3", p, "-loglevel", "error"], { stdio: "pipe" }); return p; }
const b64 = (p) => fs.readFileSync(p).toString("base64");

// resolve --ref to a reference VIDEO path (via refId recipe, or a direct path)
function resolveRefVideo(ref) {
  const recipePath = path.join(ROOT, "public", "exports", "refanalysis", ref, "recipe.json");
  if (fs.existsSync(recipePath)) {
    const r = JSON.parse(fs.readFileSync(recipePath, "utf-8"));
    return { video: path.resolve(ROOT, r.sourceVideo), recipe: r };
  }
  const direct = path.resolve(ROOT, ref);
  if (fs.existsSync(direct)) return { video: direct, recipe: null };
  return null;
}

const DIMS = ["layout", "colorGrade", "typography", "motionLanguage", "composition", "pacing"];
const RUBRIC = `You are a senior video-editing director judging STYLE-MATCH between a REFERENCE frame (image 1) and OUR RENDERED frame (image 2). Judge ONLY the editing/design STYLE, NOT the subject matter — our characters/content deliberately differ. Score 0-100 how closely OURS matches the REFERENCE on each dimension, and list concrete mismatches.
Return STRICT JSON only:
{ "scores": { "layout": n, "colorGrade": n, "typography": n, "motionLanguage": n, "composition": n, "pacing": n },
  "mismatches": ["<specific, actionable: e.g. 'wire color too blue vs reference teal', 'title font too bold', 'node cards too glassy vs flat', 'missing minimap bottom-right'>"],
  "note": "<one line>" }
Dimensions: layout=where elements sit + UI chrome; colorGrade=palette/contrast/grade; typography=fonts/weight/case/pill/color of text; motionLanguage=implied motion style (camera, draw-on, parallax) consistency; composition=framing/negative space/scale; pacing=density/feel for that moment. Be strict and specific — vague praise is useless.`;

async function judge(model, refImg, ourImg) {
  for (let r = 0; r < 3; r++) {
    try {
      const res = await model.generateContent([
        { text: RUBRIC },
        { text: "REFERENCE frame:" }, { inlineData: { mimeType: "image/jpeg", data: b64(refImg) } },
        { text: "OUR rendered frame:" }, { inlineData: { mimeType: "image/jpeg", data: b64(ourImg) } },
      ]);
      return JSON.parse(res.response.text());
    } catch (e) { await new Promise(z => setTimeout(z, 2500)); }
  }
  return null;
}

async function main() {
  const key = loadKey(); if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  const absOut = path.resolve(ROOT, out);
  const ref = resolveRefVideo(refArg);
  if (!ref) { console.error("--ref must be a refId (decoded) or a video path"); process.exit(1); }
  const outDur = dur(absOut), refDur = dur(ref.video);
  console.log(`=== style-fidelity: ${path.basename(absOut)} (${outDur}s) vs ${path.basename(ref.video)} (${refDur}s) ===`);

  // build compare pairs
  let pairs = [];
  const pairsArg = arg("--pairs", "");
  if (pairsArg) pairs = pairsArg.split(",").map(p => { const [o, r] = p.split(":").map(Number); return { outSec: o, refSec: r }; });
  else { const N = 6; for (let i = 0; i < N; i++) { const f = (i + 0.5) / N; pairs.push({ outSec: +(f * outDur).toFixed(1), refSec: +(f * refDur).toFixed(1) }); } }

  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { temperature: 0.2, responseMimeType: "application/json" } });
  const results = [];
  for (let i = 0; i < pairs.length; i++) {
    const { outSec, refSec } = pairs[i];
    const refImg = frame(ref.video, refSec, `ref_${i}`), ourImg = frame(absOut, outSec, `our_${i}`);
    const votes = [];
    for (let v = 0; v < VOTES; v++) { const j = await judge(model, refImg, ourImg); if (j) votes.push(j); }
    if (!votes.length) { console.log(`  pair ${i} (our ${outSec}s / ref ${refSec}s): no verdict`); continue; }
    const avg = {}; for (const d of DIMS) avg[d] = Math.round(votes.reduce((s, v) => s + (v.scores?.[d] || 0), 0) / votes.length);
    const mismatches = [...new Set(votes.flatMap(v => v.mismatches || []))];
    const mean = Math.round(DIMS.reduce((s, d) => s + avg[d], 0) / DIMS.length);
    results.push({ ...pairs[i], scores: avg, mean, mismatches });
    console.log(`  pair ${i} (our ${outSec}s / ref ${refSec}s): ${mean}/100  ${JSON.stringify(avg)}`);
  }

  const overall = results.length ? Math.round(results.reduce((s, r) => s + r.mean, 0) / results.length) : 0;
  const dimAvg = {}; for (const d of DIMS) dimAvg[d] = results.length ? Math.round(results.reduce((s, r) => s + r.scores[d], 0) / results.length) : 0;
  // prioritized punch-list: count mismatch frequency
  const freq = {}; for (const r of results) for (const m of r.mismatches) freq[m] = (freq[m] || 0) + 1;
  const punchList = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ issue: m, seenInShots: n }));

  const report = { output: path.relative(ROOT, absOut), reference: path.relative(ROOT, ref.video), overall, dimAvg, pairs: results, punchList };
  const rp = path.join(OUTDIR, "style-fidelity-report.json");
  fs.writeFileSync(rp, JSON.stringify(report, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log(`\n=== FIDELITY ${overall}/100 ===  ${JSON.stringify(dimAvg)}`);
  console.log(`Lowest dimensions: ${DIMS.slice().sort((a, b) => dimAvg[a] - dimAvg[b]).slice(0, 2).map(d => `${d}=${dimAvg[d]}`).join(", ")}`);
  console.log(`\nPUNCH-LIST (most frequent mismatches first):`);
  punchList.slice(0, 12).forEach((p, i) => console.log(`  ${i + 1}. [${p.seenInShots}x] ${p.issue}`));
  console.log(`\n  report: ${path.relative(ROOT, rp)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
