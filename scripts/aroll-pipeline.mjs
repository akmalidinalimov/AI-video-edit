/**
 * aroll-pipeline.mjs — the ONE general A-roll editing pipeline. Reference-agnostic
 * and generic over the number of A-rolls. This is the executable form of the rule
 * in docs/aroll-pipeline.md — run it for ANY uploaded A-roll set.
 *
 *   node scripts/aroll-pipeline.mjs [--full] [--gemini] [--from <stage>]
 *
 *   stages (in order):  ingest -> align -> select -> edit
 *     ingest  (multi-aroll-stage1.mjs)        transcribe + face-detect each clip
 *     align   (multi-aroll-align.mjs)         MMS forced alignment -> precise word times
 *     select  (multi-aroll-stage2.mjs)        pick + order complete sentences (no false starts)
 *     edit    (multi-aroll-closed-loop.mjs)   trim -> render -> verify -> auto-fix -> READY
 *
 *   --full        run from ingest (re-transcribes; costs Gemini). Default starts at align.
 *   --from <s>    start at a specific stage (ingest|align|select|edit).
 *   --gemini      pass through to the closed loop (Gemini boundary-guard + confidence).
 *
 * Each stage is its own script so they stay independently runnable/testable; this
 * just chains them in the canonical order and stops on the first failure.
 */
import path from "path";
import { execFileSync } from "child_process";
import { getClips } from "./lib/aroll-clips.mjs";

const ROOT = process.cwd();
const STAGES = [
  { name: "ingest", script: "scripts/multi-aroll-stage1.mjs" },
  { name: "align", script: "scripts/multi-aroll-align.mjs" },
  { name: "select", script: "scripts/multi-aroll-stage2.mjs" },
  { name: "edit", script: "scripts/multi-aroll-closed-loop.mjs" },
];

const argv = process.argv.slice(2);
const useGemini = argv.includes("--gemini");
const fromIdx = (() => {
  if (argv.includes("--full")) return 0;
  const f = argv.indexOf("--from");
  if (f >= 0) { const i = STAGES.findIndex(s => s.name === argv[f + 1]); if (i >= 0) return i; }
  return 1; // default: start at align (assume ingest already ran)
})();

function run(script, extra = []) {
  console.log(`\n┌─ ${path.basename(script)} ${extra.join(" ")}`);
  execFileSync("node", [script, ...extra], { stdio: "inherit", cwd: ROOT });
}

console.log("╔══════════════════════════════════════════════════════╗");
console.log("║   A-ROLL EDITING PIPELINE  (general, reference-agnostic) ║");
console.log("╚══════════════════════════════════════════════════════╝");
console.log(`  Clips: ${getClips().length} | starting at: ${STAGES[fromIdx].name}${useGemini ? " | +gemini" : ""}`);

try {
  for (let i = fromIdx; i < STAGES.length; i++) {
    const s = STAGES[i];
    run(s.script, s.name === "edit" && useGemini ? ["--gemini"] : []);
  }
  console.log("\n✓ A-ROLL PIPELINE COMPLETE — see the closed-loop verdict above for READY status.");
} catch (e) {
  console.error(`\n✗ Pipeline stopped (a stage failed). Fix the failing stage, then re-run with --from <stage>.`);
  process.exit(1);
}
