/**
 * compare-style.ts — the CLOSED LOOP: measure how well a rendered OUTPUT reproduces the
 * reference's editing STYLE. This is the falsifiable "style accuracy" number.
 *
 *   decode(reference) → D_ref ;  decode(output) → D_out ;  compareDecodedStyle(D_ref, D_out)
 *
 * Usage: compare-style.ts <reference.mp4> <output.mp4> [--with-semantics]
 */
import { readFileSync, existsSync } from "node:fs";
import { decodeReference } from "../src/lib/analysis/reference-decode.ts";
import { compareDecodedStyle } from "../src/lib/analysis/style-compare.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const pos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const refPath = pos[0] || `${process.cwd()}/public/uploads/1782174583392_target_2split.mp4`;
const outPath = pos[1] || `${process.cwd()}/public/exports/verify-corrected.mp4`;
const withSemantics = process.argv.includes("--with-semantics");

console.log(`\nREFERENCE: ${refPath}\nOUTPUT:    ${outPath}\nsemantics: ${withSemantics}\n`);
if (!existsSync(refPath) || !existsSync(outPath)) { console.log("FAIL: missing input"); process.exit(1); }

// Sequential (not parallel): each decode now runs ffmpeg-crop + PySceneDetect + optional
// Gemini; running two in parallel contends and can time the CV subprocess out.
const dRef = await decodeReference(refPath, { withSemantics });
const dOut = await decodeReference(outPath, { withSemantics });
if (!dRef || !dOut) { console.log("FAIL: decode null"); process.exit(1); }

const cmp = compareDecodedStyle(dRef, dOut);
console.log(`── STYLE REPRODUCTION: ${cmp.overallPct}% ──  (how well the OUTPUT matches the REFERENCE style)\n`);
console.log("field".padEnd(26), "match".padEnd(7), "wt".padEnd(6), "reference  →  output");
for (const f of cmp.fields) {
  console.log(` ${f.field.padEnd(24)}`, `${(f.match * 100).toFixed(0)}%`.padEnd(7), f.weight.toFixed(2).padEnd(6),
    `${f.refValue.slice(0, 20)}  →  ${f.outValue.slice(0, 20)}`);
}
console.log(`\nBIGGEST STYLE DRIFT (output vs reference):`);
for (const f of cmp.mismatches) console.log(`  ${(f.match * 100).toFixed(0)}%  ${f.field}: ref=${f.refValue.slice(0, 24)} out=${f.outValue.slice(0, 24)}  (${f.note})`);

let fails = 0; const ok = (n: string, c: boolean) => { if (!c) { console.log(`FAIL ${n}`); fails++; } };
ok("overall in 0..100", cmp.overallPct >= 0 && cmp.overallPct <= 100);
ok("layout.arollSide compared (the inversion guard)", cmp.fields.some((f) => f.field === "layout.arollSide"));
ok("weights ~sum to 1", Math.abs(cmp.fields.reduce((s, f) => s + f.weight, 0) - 1) < 0.02);
console.log(fails === 0 ? "\n✅ style comparator well-formed" : `\n❌ ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
