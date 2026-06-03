/**
 * multi-aroll-broll-match.mjs — CONTENT-AWARE per-segment B-roll selection.
 *
 * The reference reel's B-roll CHANGES per narrative phase (app demo → features →
 * trends → CTA) behind the circle PIP. Our verified renderer used ONE static
 * window of the app screencast. This picks the RIGHT window of the B-roll for each
 * A-roll segment by what the speaker is saying.
 *
 * "Gemini proposes, we verify": Gemini watches the B-roll (a continuous app
 * screencast, no hard cuts → semantic segmentation) and reads each segment's
 * speech, returning the best B-roll [start,end] window per segment. The closed
 * loop later re-checks the rendered output and the boundary-guard-style relevance
 * gate flags weak matches for generation.
 *
 *   node scripts/multi-aroll-broll-match.mjs [broll.mp4]
 * Output: public/exports/multi-aroll/stage2/broll-plan.json
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const ROOT = process.cwd();
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const STAGE2 = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
const REF_GT = path.join(ROOT, "public", "exports", "sp-temp", "reference-ground-truth.json");
const broll = process.argv[2] || "public/uploads/IMG_6163.MP4";

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim();
  }
  return process.env.GEMINI_API_KEY;
}
const brollDuration = () => {
  const raw = execFileSync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_format", path.resolve(ROOT, broll)], { encoding: "utf-8" });
  return parseFloat(JSON.parse(raw).format.duration);
};

async function main() {
  const key = loadKey();
  if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  const tl = JSON.parse(fs.readFileSync(path.join(STAGE2, "clean-timeline.json"), "utf-8"));
  const refLayout = (() => { try { return JSON.parse(fs.readFileSync(REF_GT, "utf-8")).map(s => s.shape); } catch { return []; } })();
  const bdur = brollDuration();

  // Segments that SHOW b-roll (circle layout). The hook (rectangle/fullscreen A-roll) shows none.
  const segs = tl.segments.map((s, i) => ({
    i, role: s.role, dur: +(s.sourceDuration).toFixed(2), text: s.text,
    layout: (refLayout[i] === "rectangle" ? "fullscreen_aroll" : "circle"),
  }));

  const abs = path.resolve(ROOT, broll);
  console.log(`Uploading B-roll ${path.basename(abs)} (${bdur.toFixed(1)}s)...`);
  const fm = new GoogleAIFileManager(key);
  const up = await fm.uploadFile(abs, { mimeType: "video/mp4", displayName: path.basename(abs) });
  let file = await fm.getFile(up.file.name);
  while (file.state === "PROCESSING") { await new Promise(r => setTimeout(r, 2000)); file = await fm.getFile(up.file.name); }
  if (file.state !== "ACTIVE") { console.error("upload failed:", file.state); process.exit(1); }

  const segList = segs.filter(s => s.layout === "circle")
    .map(s => `  seg${s.i} (${s.role}, needs ${s.dur}s of b-roll): "${s.text}"`).join("\n");
  const prompt = `You are a video editor choosing B-ROLL for a vertical reel. The B-ROLL is a continuous ${bdur.toFixed(1)}s screen-recording of an app (no hard cuts) — treat it as a walkthrough where different SCREENS/features appear at different times.

For EACH segment below, pick the B-roll time WINDOW [startSec, endSec] whose on-screen content best ILLUSTRATES what the speaker says. The window length should be >= the segment's needed duration (we may slow it down). Different segments should prefer DIFFERENT parts of the walkthrough (variety, like the reference). Describe what screen is shown and why it fits.

Segments (Uzbek speech about an AI service that helps create attention-grabbing product content for Instagram sales):
${segList}

Return ONLY JSON:
{ "brollScenes": [ {"startSec":n,"endSec":n,"screen":"...","concepts":["..."]} ],   // the distinct screens you saw, in order
  "assignments": [ {"seg":<index>,"brollStartSec":n,"brollEndSec":n,"screen":"...","reason":"...","relevance":0..100} ] }`;

  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0.1, responseMimeType: "application/json" } });
  console.log("Asking Gemini to match B-roll windows to segments...\n");
  const res = await model.generateContent([{ fileData: { mimeType: "video/mp4", fileUri: file.uri } }, { text: prompt }]);
  const out = JSON.parse(res.response.text());

  // Build the plan: every circle segment gets a b-roll window (clamped to b-roll duration).
  const plan = { brollSource: broll, brollDuration: +bdur.toFixed(2), scenes: out.brollScenes || [], segments: [] };
  for (const s of segs) {
    if (s.layout !== "circle") { plan.segments.push({ seg: s.i, broll: null, note: "fullscreen A-roll (no b-roll)" }); continue; }
    const a = (out.assignments || []).find(x => x.seg === s.i);
    // Fallback for any segment Gemini left unassigned: use the LAST/richest scene
    // (the scrolling content feed), tail-anchored so it stays inside the b-roll.
    const fallbackStart = Math.max(0, bdur - s.dur);
    let start = a ? Math.max(0, Math.min(a.brollStartSec, bdur - s.dur)) : +fallbackStart.toFixed(2);
    const lastScene = plan.scenes[plan.scenes.length - 1];
    plan.segments.push({
      seg: s.i, role: s.role, neededDur: s.dur,
      brollStartSec: +start.toFixed(2),
      screen: a?.screen || lastScene?.screen || "content feed",
      relevance: a?.relevance ?? (a ? null : 60),
      reason: a?.reason || "fallback: tail of the content-feed scroll (no explicit Gemini match)",
    });
  }
  fs.writeFileSync(path.join(STAGE2, "broll-plan.json"), JSON.stringify(plan, null, 2));
  console.log(`Wrote broll-plan.json (${plan.scenes.length} scenes detected):`);
  for (const p of plan.segments) {
    if (!p.brollStartSec && p.broll === null) console.log(`  seg${p.seg}: (fullscreen A-roll, no b-roll)`);
    else console.log(`  seg${p.seg} [${p.role}] -> b-roll @${p.brollStartSec}s  rel=${p.relevance}  "${p.screen}"`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
