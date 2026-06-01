/**
 * multi-aroll-closed-loop.mjs — render -> verify -> auto-fix -> re-render until the
 * edited video passes EVERY quality gate, then declare it ready. The deterministic
 * "watchdog" the user asked for: it never presents a result until the checks pass.
 *
 * Gates (all must pass; words 100%, vision >=95%):
 *   - word completeness  : each segment keeps its intended sentence COMPLETE
 *   - boundary speech     : no silence gap at any segment start/end
 *   - crop head-safety    : head fully inside the circle with a top gap + shoulders
 *   - blank circle / black / duration / layout  (existing QA gate)
 *   - (optional --gemini) : Gemini re-transcription >=95% per segment
 *
 * Auto-fix: the only dimension that needs iteration is the CROP (the speaker moves,
 * so the worst frame may clip) — we tune reference-circle-target.json and re-render.
 * Trim/word/silence are deterministic (fixed up-front); if they fail it's a logic
 * bug, surfaced for a human rather than looped on.
 *
 * Usage: node scripts/multi-aroll-closed-loop.mjs [--method 2] [--gemini] [--max 4]
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { verifyTimelineDeterministic } from "./lib/transcript-verify.mjs";
import { measureCrop, suggestTarget, writeTarget } from "./multi-aroll-crop-check.mjs";
import { checkBoundaryWords } from "./lib/boundary-guard.mjs";

const ROOT = process.cwd();
const STAGE2 = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
const STAGE4 = path.join(ROOT, "public", "exports", "multi-aroll", "stage4");
const TARGET_PATH = path.join(ROOT, "public", "exports", "multi-aroll", "stage1", "reference-circle-target.json");

const method = (() => { const i = process.argv.indexOf("--method"); return i >= 0 ? process.argv[i + 1] : "2"; })();
const maxIter = (() => { const i = process.argv.indexOf("--max"); return i >= 0 ? Number(process.argv[i + 1]) : 4; })();
const useGemini = process.argv.includes("--gemini");
const videoPath = path.join(STAGE4, `method-${method}-rendered.mp4`);

function run(cmdArgs, label) {
  console.log(`\n  $ node ${cmdArgs.join(" ")}`);
  try {
    execFileSync("node", cmdArgs, { stdio: "inherit", cwd: ROOT });
    return true;
  } catch (e) {
    console.log(`  (${label} exited non-zero)`);
    return false;
  }
}

function loadTimeline() {
  return JSON.parse(fs.readFileSync(path.join(STAGE2, "clean-timeline.json"), "utf-8"));
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   MULTI-AROLL CLOSED-LOOP  (render→verify→fix→repeat) ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  // 0. Deterministic trims (sentence-anchored, MMS-precise). Start from a clean
  // slate (drop any boundary-guard extends from a previous run).
  console.log("\n── Step 0: sentence-anchored trims ──");
  const exPath0 = path.join(STAGE2, "trim-extends.json");
  if (fs.existsSync(exPath0)) fs.unlinkSync(exPath0);
  run(["scripts/multi-aroll-validate-trims.mjs"], "validate-trims");

  // Up-front word-completeness gate (deterministic; trims are fixed here).
  const detEarly = verifyTimelineDeterministic(loadTimeline());
  if (!detEarly.passed) {
    console.log("\n  ✗ WORD COMPLETENESS FAILED before rendering (trim-logic bug):");
    for (const p of detEarly.perSegment) if (!p.passed) console.log(`     seg${p.segmentIndex} ${p.id}: ${p.reason}`);
    console.log("  Fix sentence anchoring before continuing. Not presenting.");
    process.exit(1);
  }

  let ready = false;
  for (let iter = 0; iter < maxIter; iter++) {
    console.log(`\n──────────── ITERATION ${iter} ────────────`);
    const target = JSON.parse(fs.readFileSync(TARGET_PATH, "utf-8")).target;
    console.log(`  Crop target: faceFraction=${target.faceFraction} faceCenterYIn=${target.faceCenterYIn}`);

    // 1. Render the target method only.
    console.log("\n── Render ──");
    if (!run(["scripts/multi-aroll-stage3-4.mjs", "--method", String(method)], "render")) {
      console.log("  Render failed — aborting."); process.exit(1);
    }

    // 2. Crop head-safety (the dimension that needs tuning).
    console.log("\n── Crop head-safety ──");
    const crop = measureCrop(videoPath);
    for (const p of crop.perSegment) {
      if (p.error) { console.log(`  seg${p.segment}: ${p.error}`); continue; }
      console.log(`  seg${p.segment}: ${p.passed ? "OK" : "FAIL"} headTop=${p.minHeadTopFrac} faceBottom=${p.maxFaceBottomFrac}`);
    }
    if (!crop.passed) {
      const s = suggestTarget(crop, target, iter);
      if (!s.changed) { console.log("  Crop fails but no further adjustment possible — surfacing."); break; }
      console.log(`  → tune faceFraction ${target.faceFraction}->${s.faceFraction}, faceCenterYIn ${target.faceCenterYIn}->${s.faceCenterYIn}; re-render.`);
      writeTarget(s.faceFraction, s.faceCenterYIn);
      continue; // re-render with the new crop
    }

    // 3. BOUNDARY GUARD — re-transcribe the output; if a boundary word is clipped,
    //    extend that trim and re-render (the user's safety net). Gemini-backed, so
    //    only run once crop is settled.
    console.log("\n── Boundary guard (output re-transcription) ──");
    const guard = await checkBoundaryWords(videoPath, loadTimeline());
    for (const p of guard.perSegment) {
      if (p.skipped) { console.log(`  seg${p.segment}: skipped (${p.skipped})`); continue; }
      console.log(`  seg${p.segment}: first ${p.firstOk ? "OK" : "CLIPPED ("+p.expectedFirst+" vs "+p.heardFirst+")"}, last ${p.lastOk ? "OK" : "CLIPPED ("+p.expectedLast+" vs "+p.heardLast+")"}`);
    }
    if (!guard.passed) {
      const exPath = path.join(STAGE2, "trim-extends.json");
      const extends_ = fs.existsSync(exPath) ? JSON.parse(fs.readFileSync(exPath, "utf-8")) : {};
      for (const p of guard.perSegment) {
        if (p.skipped || (p.firstOk && p.lastOk)) continue;
        const e = extends_[p.segment] || { startExtra: 0, endExtra: 0 };
        if (!p.firstOk) e.startExtra = +(e.startExtra + 0.18).toFixed(3);
        if (!p.lastOk) e.endExtra = +(e.endExtra + 0.18).toFixed(3);
        extends_[p.segment] = e;
      }
      fs.writeFileSync(exPath, JSON.stringify(extends_, null, 2));
      console.log("  → boundary word clipped; extending trims and re-trimming.");
      run(["scripts/multi-aroll-validate-trims.mjs"], "validate-trims");
      continue; // re-render with extended trims
    }

    // 4. Full QA gate (word/silence/blank/black/duration/layout [+gemini]).
    console.log("\n── Full QA gate ──");
    const verifyArgs = ["scripts/multi-aroll-verify.mjs", "--method", String(method)];
    if (useGemini) verifyArgs.push("--gemini");
    const ok = run(verifyArgs, "verify");
    if (ok) { ready = true; break; }
    console.log("  A non-crop gate failed (see above). These are deterministic — surfacing for fix.");
    break;
  }

  console.log("\n══════════════════════════════════════════════════════");
  if (ready) {
    console.log(`  ✅ READY — all gates passed for method ${method}.`);
    console.log(`  Windows path:\n    ${videoPath.replace(/\//g, "\\")}`);
  } else {
    console.log(`  ⚠ NOT READY — a gate is still failing after ${maxIter} iterations.`);
    console.log(`  Review the failing dimension above; do NOT present yet.`);
  }
  console.log("══════════════════════════════════════════════════════\n");
  process.exit(ready ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
