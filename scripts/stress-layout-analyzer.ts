/**
 * stress-layout-analyzer.ts — adversarial end-to-end stress test of the Layout Analyzer.
 *
 * Exercises the FULL subsystem (CV core + archetype memory + route integration chain) hard,
 * WITHOUT spending any generation credits:
 *   1. Determinism   — repeat runs must give a STABLE layout (side/divider/aspect/archetype).
 *   2. Edge cases    — missing file, garbage bytes, raw A-roll, single B-roll clip → no crash.
 *   3. Cross-ref     — a different copy of the split reference reproduces the same archetype.
 *   4. Integration   — analyzeLayout → matchArchetype → framingForRegion: the head-cut fix
 *                      (square region → 1:1 waist-up) holds on the measured region.
 */
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { analyzeLayout, layoutAnalyzerAvailable } from "../src/lib/analysis/layout-analyzer.ts";
import { matchArchetype } from "../src/lib/analysis/layout-archetypes.ts";
import { framingForRegion } from "../src/lib/pipeline/broll-framing.ts";

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };
const root = process.cwd();
const REF = `${root}/public/uploads/1782174583392_target_2split.mp4`;

console.log("available:", layoutAnalyzerAvailable(), "\n");

// ─── 1. DETERMINISM: 5 repeat runs must be stable ───
console.log("── 1. Determinism (5 runs) ──");
const runs = Array.from({ length: 5 }, () => analyzeLayout(REF)).filter(Boolean) as NonNullable<ReturnType<typeof analyzeLayout>>[];
ok("all 5 runs returned a result", runs.length === 5);
if (runs.length === 5) {
  const sides = new Set(runs.map((r) => r.layout.arollSide));
  const archs = new Set(runs.map((r) => matchArchetype(r.layout)?.id));
  const divs = runs.map((r) => r.layout.dividerFraction);
  const ars = runs.map((r) => r.layout.brollAspect);
  const shots = runs.map((r) => r.segments.length);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  console.log(`  sides=${[...sides]} archetypes=${[...archs]} divΔ=${spread(divs).toFixed(4)} arΔ=${spread(ars).toFixed(4)} shots=${shots}`);
  ok("A-roll side stable across runs", sides.size === 1, [...sides]);
  ok("archetype stable across runs", archs.size === 1, [...archs]);
  ok("divider fraction stable (Δ ≤ 0.02)", spread(divs) <= 0.02, spread(divs));
  ok("B-roll aspect stable (Δ ≤ 0.05)", spread(ars) <= 0.05, spread(ars));
  ok("shot count stable (Δ ≤ 2)", spread(shots) <= 2, shots);
}

// ─── 2. EDGE CASES: never crash, fail soft to null ───
console.log("\n── 2. Edge cases (must not crash) ──");
ok("missing file → null", analyzeLayout(`${root}/does-not-exist.mp4`) === null);

const garbage = `${root}/public/uploads/__stress_garbage.mp4`;
writeFileSync(garbage, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x10]));
ok("garbage bytes → null (no crash)", analyzeLayout(garbage) === null);
try { unlinkSync(garbage); } catch { /* ignore */ }

// Non-split inputs must NOT be force-classified as a split (the over-confidence fix).
for (const [label, p] of [
  ["raw A-roll .MOV (fullscreen talking head)", `${root}/public/uploads/1782163573224_IMG_6415.MOV`],
  ["single 1:1 B-roll clip", `${root}/public/uploads/generated/broll-s0-hook.mp4`],
] as const) {
  if (!existsSync(p)) { console.log(`  SKIP  ${label} (missing)`); continue; }
  let crashed = false; let res: ReturnType<typeof analyzeLayout> = null;
  try { res = analyzeLayout(p); } catch { crashed = true; }
  ok(`${label} → no crash`, !crashed);
  if (res) {
    const m = matchArchetype(res.layout);
    console.log(`        → type=${res.layout.type} splitScore=${res.layout.splitScore} conf=${res.layout.confidence} | archetype ${m?.id} (novel=${m?.novel})`);
    ok(`${label} → NOT force-classified split`, res.layout.type !== "split", res.layout.type);
    ok(`${label} → low splitScore (<0.5)`, res.layout.splitScore < 0.5, res.layout.splitScore);
  }
}

// ─── 3. CROSS-REFERENCE: another split copy → same archetype ───
console.log("\n── 3. Cross-reference robustness ──");
for (const p of [`${root}/public/uploads/1782163573146_target_2split.mp4`, `${root}/public/uploads/1782165704342_target_2split.mp4`]) {
  if (!existsSync(p)) { console.log(`  SKIP ${p}`); continue; }
  const r = analyzeLayout(p);
  const m = r ? matchArchetype(r.layout) : null;
  console.log(`  ${p.split(/[\\/]/).pop()}: ${r?.layout.type} A-roll ${r?.layout.arollSide} → ${m?.id} (score ${m?.matchScore}, novel ${m?.novel})`);
  ok("split copy classifies as a split A-roll-bottom archetype", m?.id === "split_aroll_bottom" && !m?.novel, m?.id);
}

// ─── 4. INTEGRATION CHAIN: measured region → framing (head-cut fix) ───
console.log("\n── 4. Integration chain (the head-cut fix) ──");
const r = analyzeLayout(REF)!;
const region = r.layout.brollRegion;
const framing = framingForRegion(region, true);
console.log(`  measured B-roll region ${region.width}x${region.height} → framing: ${framing.reason}`);
const ar = region.width / region.height;
ok("measured region is ~1:1 (square)", Math.abs(ar - 1) <= 0.15, ar);
ok("framing picks 1:1 generateAspect for the square region", framing.generateAspect === "1:1", framing.generateAspect);
ok("framing is a wider shot (no tight close-up)", /waist|medium|full-body/i.test(framing.shotType), framing.shotType);
ok("framing direction enforces headroom (no head-cut)", /headroom|head must not be cut/i.test(framing.direction), framing.direction);

console.log(fails === 0 ? "\n✅ STRESS TEST: ALL PASS" : `\n❌ STRESS TEST: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
