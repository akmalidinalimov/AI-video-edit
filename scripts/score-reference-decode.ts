/**
 * score-reference-decode.ts — decode a reference into the CANONICAL decode and SCORE its
 * style-accuracy component by component. This is the "evaluate again" gate for the 99% target.
 *
 * Usage: node (bundled) — decodes public/uploads/<ref> with Gemini semantics, prints the
 * provenance table + the style-accuracy scorecard + the weakest links.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { analyzeLayout } from "../src/lib/analysis/layout-analyzer.ts";
import { decodeReference, decodeProvenance } from "../src/lib/analysis/reference-decode.ts";
import { scoreDecodeAccuracy } from "../src/lib/analysis/decode-accuracy.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ref = positional[0] || `${process.cwd()}/public/uploads/1782174583392_target_2split.mp4`;
const withSemantics = !process.argv.includes("--no-semantics");
console.log(`\nDecoding: ${ref}\nSemantics (VLM): ${withSemantics}\n`);

const layout = analyzeLayout(ref);
if (!layout) { console.log("FAIL: analyzeLayout null"); process.exit(1); }

const decode = await decodeReference(ref, { withSemantics });
if (!decode) { console.log("FAIL: decodeReference null"); process.exit(1); }

// ── canonical decode provenance ──
console.log("── CANONICAL DECODE (single source of truth) ──");
console.log("field".padEnd(26), "value".padEnd(30), "source".padEnd(8), "conf");
for (const r of decodeProvenance(decode)) {
  console.log(r.field.padEnd(26), String(r.value).slice(0, 29).padEnd(30), r.source.padEnd(8), r.confidence.toFixed(2));
}
console.log(`\nrolled-up decodeConfidence: ${decode.decodeConfidence}`);

// ── decode SELF-CONSISTENCY (is the decode internally trustworthy? — NOT style-reproduction) ──
const score = scoreDecodeAccuracy(ref, layout, decode);
console.log(`\n── DECODE SELF-CONSISTENCY (trust check — NOT style-reproduction accuracy) ──`);
console.log(`  independently VERIFIED: ${score.verifiedPct}%   |   SELF-REPORTED (uncross-checked): ${score.selfReportedPct}%`);
console.log("\ncomponent".padEnd(23), "score".padEnd(7), "wt".padEnd(6), "kind    check");
for (const c of score.components) {
  const kind = c.independent ? "[VERIF]" : "[self ]";
  console.log(` ${c.name.padEnd(21)}`, `${(c.score * 100).toFixed(0)}%`.padEnd(7), c.weight.toFixed(2).padEnd(6), kind, c.method);
}
if (score.external) {
  const e = score.external;
  console.log(`\nexternal anchor — shot-boundary F1 vs FFmpeg: F1=${e.shotF1} (P=${e.precision} R=${e.recall}) | analyzer=${e.analyzerShots} ffmpeg=${e.ffmpegShots} cuts ±${e.toleranceSec}s${e.note ? " [" + e.note + "]" : ""}`);
}
console.log(`\nWEAKEST LINKS (fix next):`);
for (const c of score.weakest) console.log(`  ${(c.score * 100).toFixed(0)}%  ${c.name} ${c.independent ? "" : "(self-reported) "}— ${c.detail}`);

// persist for inspection
const outPath = `${process.cwd()}/public/exports/sp-temp/reference-decode.json`;
writeFileSync(outPath, JSON.stringify({ decode, accuracy: score }, null, 2));
console.log(`\nsaved: ${outPath}`);

// ── light assertions (the schema + scorer must be well-formed) ──
let fails = 0; const ok = (n: string, c: boolean) => { if (!c) { console.log(`FAIL ${n}`); fails++; } };
ok("every field has a source+confidence", decodeProvenance(decode).every((r) => r.source && r.confidence >= 0));
ok("verified+selfReported in 0..100", score.verifiedPct >= 0 && score.verifiedPct <= 100 && score.selfReportedPct >= 0 && score.selfReportedPct <= 100);
ok("weights sum to ~1", Math.abs(score.components.reduce((s, c) => s + c.weight, 0) - 1) < 0.001);
ok("geometry owns layout.type (cv)", decode.layout.type.source === "cv");
ok("VLM owns style keywords", decode.style.keywords.source === "vlm");
ok("type is NOT counted as independently verified", !score.components.find((c) => c.name === "layout.type")!.independent);
console.log(fails === 0 ? "\n✅ decode + scorer well-formed" : `\n❌ ${fails} assertion(s) failed`);
process.exit(fails === 0 ? 0 : 1);
