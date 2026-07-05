/** Verify Stage 7 (Gemini semantics) on the reference: authoritative captions + per-shot content. */
import { readFileSync, existsSync } from "node:fs";
import { analyzeLayout } from "../src/lib/analysis/layout-analyzer.ts";
import { analyzeLayoutSemantics } from "../src/lib/analysis/layout-semantics.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

const ref = `${process.cwd()}/public/uploads/1782174583392_target_2split.mp4`;
const layout = analyzeLayout(ref);
if (!layout) { console.log("FAIL  CV layout returned null"); process.exit(1); }
console.log(`CV: A-roll ${layout.layout.arollSide}, ${layout.segments.length} shots\n`);

const sem = await analyzeLayoutSemantics(ref, {
  segments: layout.segments,
  arollSide: layout.layout.arollSide,
  dividerFraction: layout.layout.dividerFraction,
});
if (!sem) { console.log("FAIL  semantics returned null (check GEMINI_API_KEY / upload)"); process.exit(1); }

console.log("CAPTIONS:", JSON.stringify(sem.captions, null, 2));
console.log(`\nSHOTS (${sem.shots.length}):`);
for (const s of sem.shots) console.log(`  ${s.start.toFixed(1)}-${s.end.toFixed(1)}s  [${s.role}] ${s.content}`);
console.log(`\nOVERLAYS (${sem.overlays.length}):`, sem.overlays.map((o) => `${o.kind}: ${o.description}`).join(" | ") || "(none)");
console.log(`STYLE: ${sem.styleKeywords.join(", ")}`);
console.log(`SUMMARY: ${sem.summary}`);

let fails = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) fails++; };
ok("shots count matches CV segments (one label per shot)", sem.shots.length === layout.segments.length);
ok("captions detected present (reference has burned-in captions)", sem.captions.present === true);
ok("each shot has non-empty content", sem.shots.every((s) => s.content && s.content !== "unlabeled"));
ok("style keywords extracted", sem.styleKeywords.length >= 2);
ok("summary present", sem.summary.length > 10);
console.log(fails === 0 ? "\nALL PASS — semantics layer working" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
