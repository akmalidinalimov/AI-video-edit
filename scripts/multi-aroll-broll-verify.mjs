/**
 * multi-aroll-broll-verify.mjs — CLOSED-LOOP B-ROLL RELEVANCE GATE.
 *
 * Mirrors the A-roll "never present unverified" rigor (boundary-guard re-checks the
 * OUTPUT, not the plan) for B-roll. After render, it samples the actual background
 * frame at each circle segment's midpoint FROM THE RENDERED MP4, asks Gemini what
 * app screen is shown and how well it illustrates that segment's speech, and gates
 * on a relevance threshold. Catches mis-seeks/drift and surfaces weak matches for
 * re-match or generation — quantifying B-roll content fidelity, not just geometry.
 *
 *   node scripts/multi-aroll-broll-verify.mjs [--method 2] [--threshold 50]
 * Output: public/exports/multi-aroll/verify/broll-relevance-report.json
 * Exit 0 = all segments >= threshold; exit 2 = at least one below (gap to fill).
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const STAGE2 = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
const STAGE4 = path.join(ROOT, "public", "exports", "multi-aroll", "stage4");
const VERIFY = path.join(ROOT, "public", "exports", "multi-aroll", "verify");
const REF_GT = path.join(ROOT, "public", "exports", "sp-temp", "reference-ground-truth.json");

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const METHOD = arg("--method", "2");
const THRESHOLD = +arg("--threshold", "50");

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim();
  }
  return process.env.GEMINI_API_KEY;
}

async function main() {
  const key = loadKey();
  if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  fs.mkdirSync(VERIFY, { recursive: true });
  const output = path.join(STAGE4, `method-${METHOD}-rendered.mp4`);
  if (!fs.existsSync(output)) { console.error("No rendered output:", output); process.exit(1); }

  const tl = JSON.parse(fs.readFileSync(path.join(STAGE2, "clean-timeline.json"), "utf-8"));
  const refLayout = (() => { try { return JSON.parse(fs.readFileSync(REF_GT, "utf-8")).map(s => s.shape); } catch { return []; } })();
  const model = new GoogleGenerativeAI(key).getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  });

  console.log(`B-ROLL RELEVANCE GATE (method ${METHOD}, threshold ${THRESHOLD})\n`);
  const results = [];
  for (let i = 0; i < tl.segments.length; i++) {
    const s = tl.segments[i];
    const isCircle = (refLayout[i] || "circle") !== "rectangle"; // hook = no full B-roll
    if (!isCircle) { results.push({ seg: i, role: s.role, skipped: "hook (no b-roll)" }); continue; }

    // Sample MULTIPLE frames across the segment (the background may CHANGE over the
    // segment — e.g. a generated clip that animates form→submit). Judging a single
    // midpoint frame is brittle; send 3 representative frames and let Gemini rate the
    // segment's B-roll overall. (Mirrors how a viewer perceives the whole beat, not one
    // freeze.)
    const dur = s.timelineEnd - s.timelineStart;
    const samples = [0.25, 0.5, 0.75].map(f => s.timelineStart + dur * f);
    const parts = [];
    samples.forEach((t, k) => {
      const frame = path.join(VERIFY, `broll-seg${i}-${k}.jpg`);
      execFileSync(FFMPEG, ["-y", "-ss", t.toFixed(2), "-i", output, "-frames:v", "1", "-q:v", "3", frame], { stdio: "pipe" });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: fs.readFileSync(frame).toString("base64") } });
    });

    const prompt = `These ${parts.length} frames are sampled in order across ONE segment of a vertical reel; the BACKGROUND may change across them. Ignore the circular talking-head inset (top-right) — judge only the BACKGROUND footage.
The speaker is saying (Uzbek, about an AI service whose students make attention-grabbing product content for Instagram, with a profile link + application form to sign up):
"${s.text}"
Rate how well the background footage (across these frames) ILLUSTRATES what the speaker says.
Return ONLY JSON: {"screen":"<what is shown across the frames>","relevance":0-100,"reason":"<why it does/doesn't illustrate the speech>"}`;
    // A single Gemini relevance call is NOISY (±10-15 on identical footage), which
    // made the gate flip-flop across runs. AVERAGE N independent calls to stabilise
    // the score so the gate is trustworthy (and reproducible enough to act on).
    const N_VOTES = 3;
    const rels = [];
    let parsed = null;
    for (let v = 0; v < N_VOTES; v++) {
      let p = null;
      for (let attempt = 0; attempt < 2 && !p; attempt++) {
        try {
          const res = await model.generateContent([...parts, { text: prompt }]);
          p = JSON.parse(res.response.text());
        } catch (e) { if (v === 0 && attempt === 1) console.error(`  seg${i} gemini error:`, e.message); }
      }
      if (p) { rels.push(p.relevance ?? 0); if (!parsed) parsed = p; }
    }
    const rel = rels.length ? Math.round(rels.reduce((a, b) => a + b, 0) / rels.length) : 0;
    const pass = rel >= THRESHOLD;
    results.push({ seg: i, role: s.role, atSec: +((s.timelineStart + s.timelineEnd) / 2).toFixed(2), screen: parsed?.screen || "?", relevance: rel, votes: rels, pass, reason: parsed?.reason || "" });
    console.log(`  seg${i} [${s.role}] rel=${rel} [${rels.join("/")}] ${pass ? "PASS" : "LOW "} "${(parsed?.screen || "?").slice(0, 70)}"`);
  }

  const checked = results.filter(r => !r.skipped);
  const failed = checked.filter(r => !r.pass);
  const avg = checked.length ? Math.round(checked.reduce((a, r) => a + r.relevance, 0) / checked.length) : 0;
  const report = { method: METHOD, threshold: THRESHOLD, avgRelevance: avg, segmentsChecked: checked.length, belowThreshold: failed.map(r => r.seg), results };
  fs.writeFileSync(path.join(VERIFY, "broll-relevance-report.json"), JSON.stringify(report, null, 2));

  console.log(`\n  avg relevance ${avg}/100 · ${checked.length - failed.length}/${checked.length} >= ${THRESHOLD}`);
  if (failed.length) {
    console.log(`  ⚠ below threshold: ${failed.map(r => `seg${r.seg}(${r.relevance})`).join(", ")} → re-match or generate`);
    console.log(`  Report: ${path.join(VERIFY, "broll-relevance-report.json")}`);
    process.exit(2);
  }
  console.log(`  ✅ All B-roll segments depict their speech (>= ${THRESHOLD}).`);
  console.log(`  Report: ${path.join(VERIFY, "broll-relevance-report.json")}`);
}
main().catch(e => { console.error(e); process.exit(1); });
