/**
 * reel2-closed-loop.mjs — the Remotion-path CLOSED LOOP: run EVERY reel-2 gate on a rendered mp4 and
 * declare READY only if all pass. One command to verify a reel-2 render before presenting it — the
 * Remotion analog of `multi-aroll-closed-loop.mjs` (the FFmpeg circle-PIP path).
 *
 * Gates (deterministic, ALWAYS run): head-safe crop, cut continuity (no black-flash), audio continuity.
 * Optional (need GEMINI_API_KEY): --transcribe (output transcript), --fidelity --ref <id> (style score).
 *
 * Usage:
 *   node scripts/reel2-closed-loop.mjs [mp4]                         # deterministic gates (fast)
 *   node scripts/reel2-closed-loop.mjs [mp4] --transcribe            # + output transcript
 *   node scripts/reel2-closed-loop.mjs [mp4] --fidelity --ref img6298
 * Default mp4 = public/exports/reel2/reel2.mp4. Exit 0 only if every RUN gate passed.
 *
 * IMPORTANT: passing gates are NECESSARY but NOT SUFFICIENT. The style/fidelity score is BLIND to audio
 * and to per-frame motion nuance (2026-06-03: a silent + zoom-cropped turn scored "76/100"). ALWAYS, as
 * the final step, WATCH the video and LISTEN to it. See the A-ROLL DEFINITION OF DONE in
 * docs/aroll-pipeline.md and docs/NEXT-SESSION-HANDOFF.md §6.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MP4 = args.find((a) => !a.startsWith("--") && /\.mp4$/i.test(a)) || "public/exports/reel2/reel2.mp4";

function runGate(name, scriptRel, extra = []) {
  const script = path.join(ROOT, scriptRel);
  if (!fs.existsSync(script)) { console.log(`  ⚠️  ${name}  (skipped — ${scriptRel} not found)`); return null; }
  const r = spawnSync("node", [script, MP4, ...extra], { cwd: ROOT, encoding: "utf8" });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  const tail = out.split("\n").filter(Boolean).slice(-1)[0] || "";
  const pass = r.status === 0;
  console.log(`  ${pass ? "✅" : "❌"} ${name.padEnd(16)} ${tail.slice(0, 150)}`);
  return pass;
}

console.log(`\n=== reel-2 CLOSED LOOP on ${path.basename(MP4)} ===\n`);
const results = [];
results.push(runGate("crop head-safe", "scripts/reel2-crop-check.mjs"));
results.push(runGate("cut continuity", "scripts/reel2-cut-check.mjs"));
results.push(runGate("audio continuity", "scripts/reel2-audio-check.mjs"));
if (has("--transcribe")) results.push(runGate("output transcript", "scripts/reel2-transcribe.mjs"));
if (has("--fidelity")) results.push(runGate("style-fidelity", "scripts/style-fidelity.mjs", ["--ref", argv("--ref", "img6298")]));

const ran = results.filter((r) => r !== null);
const allPass = ran.length > 0 && ran.every(Boolean);
console.log(`\n  ${allPass ? "✅ READY — every gate passed" : "❌ NOT READY — fix the failed gate(s) above"}`);
console.log(`  Gates are necessary, NOT sufficient — WATCH + LISTEN to the output before presenting.\n`);
process.exit(allPass ? 0 : 1);
