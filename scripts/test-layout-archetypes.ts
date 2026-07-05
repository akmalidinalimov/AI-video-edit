/** Verify Stage 10: archetype matching, novelty flagging, and calibration re-centering. */
import { analyzeLayout } from "../src/lib/analysis/layout-analyzer.ts";
import {
  loadLibrary, matchArchetype, scoreAgainst, proposeNovelArchetype, recenter as _r,
} from "../src/lib/analysis/layout-archetypes.ts";

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

const lib = loadLibrary();
ok("library loads", !!lib && lib.archetypes.length >= 5);

// 1) The reference must match split_aroll_bottom strongly (known archetype → auto, not novel).
const ref = `${process.cwd()}/public/uploads/1782174583392_target_2split.mp4`;
const r = analyzeLayout(ref);
if (!r) { console.log("FAIL  analyzer null"); process.exit(1); }
const m = matchArchetype(r.layout, lib);
console.log(`\nmatch: ${m?.id} score=${m?.matchScore} novel=${m?.novel}`);
console.log("ranked:", JSON.stringify(m?.ranked));
ok("reference matches split_aroll_bottom", m?.id === "split_aroll_bottom", m?.id);
ok("match score high (≥0.9)", (m?.matchScore ?? 0) >= 0.9, m?.matchScore);
ok("NOT flagged novel (known archetype)", m?.novel === false);

// 2) An INVERTED layout (A-roll top) must score LOWER on split_aroll_bottom (side discrimination).
const bottomArch = lib!.archetypes.find((a) => a.id === "split_aroll_bottom")!;
const invertedTop = { ...r.layout, arollSide: "top" as const };
const sBottom = scoreAgainst(r.layout, bottomArch);
const sTop = scoreAgainst(invertedTop, bottomArch);
console.log(`\nside discrimination: bottom=${sBottom.toFixed(3)} top=${sTop.toFixed(3)}`);
ok("A-roll side is discriminative (bottom > top on the bottom archetype)", sBottom > sTop + 0.15, { sBottom, sTop });

// 3) A genuinely novel layout (circle PIP-like but with weird divider) → low best score → flagged novel.
const weird = { ...r.layout, type: "hexagon_pip", shape: "hexagon", arollSide: "top" as const, dividerFraction: 0.91, brollAspect: 2.3 };
const mNovel = matchArchetype(weird as typeof r.layout, lib);
console.log(`\nnovel test: best=${mNovel?.id} score=${mNovel?.matchScore} novel=${mNovel?.novel}`);
ok("unknown layout flagged NOVEL", mNovel?.novel === true, mNovel);
const proposal = proposeNovelArchetype(weird as typeof r.layout, "synthetic-test");
ok("proposeNovelArchetype drafts an entry", proposal.id.startsWith("novel_") && !!proposal.signature.type);

// 4) Calibration: feeding two exemplars re-centers the divider range around them (in-memory, no disk write).
const sandbox = JSON.parse(JSON.stringify(bottomArch));
sandbox.exemplars = [{ dividerFraction: 0.55, brollAspect: 1.0 }, { dividerFraction: 0.59, brollAspect: 1.05 }];
_r(sandbox);
console.log(`\ncalibrated dividerRange: ${JSON.stringify(sandbox.signature.dividerRange)}`);
const [lo, hi] = sandbox.signature.dividerRange;
ok("calibration brackets the exemplars", lo <= 0.55 && hi >= 0.59, sandbox.signature.dividerRange);

// 5) UNIVERSAL-1 Wave 1b: N-region archetypes (unified-decode signatures).
{
  const multiArch = lib!.archetypes.find((a) => a.id === "multi_region_stack")!;
  const pipArch = lib!.archetypes.find((a) => a.id === "pip_over_fullscreen")!;
  ok("library has multi_region_stack + pip_over_fullscreen", !!multiArch && !!pipArch);

  // R2-shaped unified input: 4-band stack, aroll at the bottom.
  const stackInput = {
    layoutClass: "multi_region_stack",
    regions: [
      { role: "header_title", rect: { x: 0, y: 0, w: 1, h: 0.10 }, persistent: true },
      { role: "broll", rect: { x: 0, y: 0.10, w: 1, h: 0.40 }, persistent: false },
      { role: "screen_recording", rect: { x: 0, y: 0.50, w: 1, h: 0.15 }, persistent: false },
      { role: "aroll", rect: { x: 0, y: 0.65, w: 1, h: 0.35 }, persistent: true },
    ],
  };
  const mStack = matchArchetype(stackInput, lib);
  console.log(`\nstack match: ${mStack?.id} score=${mStack?.matchScore} novel=${mStack?.novel}`);
  ok("4-band stack matches multi_region_stack", mStack?.id === "multi_region_stack", mStack?.id);
  ok("stack match not novel", mStack?.novel === false, mStack);
  ok("stack scores 0 on the plain-split archetype", scoreAgainst(stackInput, bottomArch) === 0);

  // R3-shaped unified input: full-frame background + persistent centered PIP aroll.
  const pipInput = {
    layoutClass: "pip_over_fullscreen",
    regions: [
      { role: "broll", rect: { x: 0, y: 0, w: 1, h: 1 }, persistent: false },
      { role: "aroll", rect: { x: 0.2, y: 0.55, w: 0.6, h: 0.35 }, persistent: true },
    ],
  };
  const mPip = matchArchetype(pipInput, lib);
  console.log(`pip match: ${mPip?.id} score=${mPip?.matchScore} novel=${mPip?.novel}`);
  ok("PIP input matches pip_over_fullscreen", mPip?.id === "pip_over_fullscreen", mPip?.id);
  ok("PIP scores 0 on the plain-split archetype", scoreAgainst(pipInput, bottomArch) === 0);

  // And vice versa: a plain split (with its unified class) never matches the N-region archetypes.
  const splitUnified = { ...r.layout, layoutClass: "two_region_split" };
  ok("plain split scores 0 on multi_region_stack", scoreAgainst(splitUnified, multiArch) === 0);
  ok("plain split scores 0 on pip_over_fullscreen", scoreAgainst(splitUnified, pipArch) === 0);
  const mSplit = matchArchetype(splitUnified, lib);
  ok("plain split (unified) still matches split_aroll_bottom", mSplit?.id === "split_aroll_bottom", mSplit?.id);
}

console.log(fails === 0 ? "\nALL PASS — archetype library (match + novelty + calibration) working" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
