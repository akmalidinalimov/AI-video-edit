/** Gate test: the Layout Analyzer must REPRODUCE the verified ground truth of the reference. */
import { existsSync } from "fs";
import { analyzeLayout, layoutAnalyzerAvailable } from "../src/lib/analysis/layout-analyzer.ts";

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

console.log("available:", layoutAnalyzerAvailable());
const ref = `${process.cwd()}/public/uploads/1782174583392_target_2split.mp4`;
const r = analyzeLayout(ref);
if (!r) { console.log("FAIL  analyzer returned null"); process.exit(1); }

console.log(`\nlayout: ${r.layout.type} | A-roll ${r.layout.arollSide} | B-roll ${r.layout.brollRegion.width}x${r.layout.brollRegion.height} (AR ${r.layout.brollAspect}) | divider ${r.layout.dividerFraction} | conf ${r.layout.confidence}`);
console.log(`evidence: faceSide=${r.layout.evidence.face?.side} sideAgree=${r.layout.evidence.sideAgree} | shots=${r.rhythm.shots} avg=${r.rhythm.avgShotSec}s`);

// ── Ground truth (verified earlier by strip-comparison): A-roll BOTTOM, B-roll TOP ~1:1, divider ~0.5625 ──
ok("layout type = split", r.layout.type === "split");
ok("A-roll side = bottom (the inversion-resolving result)", r.layout.arollSide === "bottom", r.layout.arollSide);
ok("B-roll aspect ≈ 1:1 (the real top square)", Math.abs(r.layout.brollAspect - 1.0) <= 0.15, r.layout.brollAspect);
ok("divider ≈ 0.5625", Math.abs(r.layout.dividerFraction - 0.5625) <= 0.05, r.layout.dividerFraction);
ok("face + temporal AGREE on the side (self-verify)", r.layout.evidence.sideAgree === true);
ok("confidence ≥ 0.7", r.layout.confidence >= 0.7, r.layout.confidence);
ok("shot detection sane (18–32 shots — PySceneDetect-calibrated; the reference is a ~1s/shot fast reel)", r.rhythm.shots >= 18 && r.rhythm.shots <= 32, r.rhythm.shots);
ok("rhythm classified", ["fast", "moderate", "slow"].includes(r.rhythm.cutFrequency));
ok("split has a genuine independent side cross-check (sideAgree via fixed thirds)", r.layout.evidence.independentSide === r.layout.arollSide, r.layout.evidence.independentSide);

// ── NEGATIVE coverage: non-split inputs must NOT be force-classified as a split (anti-overfit) ──
const neg = (label: string, p: string) => {
  if (!existsSync(p)) { console.log(`SKIP  ${label} (missing)`); return; }
  const x = analyzeLayout(p);
  if (!x) { ok(`${label} analyzable`, false); return; }
  console.log(`  ${label}: type=${x.layout.type} splitScore=${x.layout.splitScore} conf=${x.layout.confidence}`);
  ok(`${label} NOT classified as split`, x.layout.type !== "split", x.layout.type);
  ok(`${label} splitScore < 0.5`, x.layout.splitScore < 0.5, x.layout.splitScore);
};
neg("fullscreen A-roll (.MOV)", `${process.cwd()}/public/uploads/1782163573224_IMG_6415.MOV`);
neg("single B-roll clip", `${process.cwd()}/public/uploads/generated/broll-s0-hook.mp4`);

console.log(fails === 0 ? "\nALL PASS — analyzer reproduces ground truth + rejects non-splits" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
