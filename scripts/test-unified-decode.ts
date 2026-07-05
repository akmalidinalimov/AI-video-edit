/**
 * test-unified-decode.ts — GATE for UNIVERSAL-1 Wave 1b: ONE canonical decode path.
 *
 * Decodes R1/R2/R3 through the UNIFIED path (decodeReference with regions) and asserts:
 *   R1 ⇒ layoutClass two_region_split; legacy fields identical to a direct analyzeLayout
 *        run (side bottom, divider ±0.005 of 0.561); regions.length === 2.
 *   R2 ⇒ multi_region_stack; 4 regions; roles header_title/broll/screen_recording/aroll;
 *        aroll rect.y within ±0.07 of 0.65.
 *   R3 ⇒ pip_over_fullscreen (canonical, normalized); aroll region xStart>0.02, xEnd<0.98,
 *        rounded_rect; a region with a ≥2-class contentTimeline.
 * Plus a pure-TS unit test of the seam-snap function (synthetic edge profile, no video).
 *
 * Run (esbuild-bundle pattern):
 *   node_modules/.bin/esbuild scripts/test-unified-decode.ts --bundle --platform=node \
 *     --format=cjs --alias:@=./src --outfile=.tmp/test-unified-decode.cjs
 *   node .tmp/test-unified-decode.cjs
 * VLM flake policy: analyzeLayoutRegions is retried up to 2x per reference when the result
 * is structurally unusable (known ~1/3 contentTimeline flake on R3). Flake counts reported.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { analyzeLayout, type LayoutAnalysis } from "../src/lib/analysis/layout-analyzer";
import { analyzeLayoutRegions, type RegionLayout } from "../src/lib/analysis/layout-regions";
import { getCached, setCache } from "../src/lib/analysis/analysisCache";
import {
  decodeReference, snapBandBoundaries, type DecodedRegion,
} from "../src/lib/analysis/reference-decode";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}

const R1 = `${process.cwd()}/public/uploads/1782174583392_target_2split.mp4`;
const R2 = `${process.cwd()}/public/uploads/DownReels_20260701_191828.mp4`;
const R3 = `${process.cwd()}/public/uploads/ref3-aipipeline.mp4`;

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++;
};

// ════════════════════════════════════════════════════════════════════════
// 0. SEAM-SNAP unit test — synthetic edge profile, pure TS, no video.
// ════════════════════════════════════════════════════════════════════════
{
  console.log("\n── seam-snap unit test (synthetic profile) ──");
  const N = 101;
  const profile = Array.from({ length: N }, () => 0.05);
  profile[56] = 1.0; profile[55] = 0.5; profile[57] = 0.5;   // strong seam at y=0.56
  const bands = [
    { role: "broll", yStart: 0, yEnd: 0.52, xStart: 0, xEnd: 1, persistent: false, shape: "rectangle", description: "" },
    { role: "aroll", yStart: 0.52, yEnd: 1, xStart: 0, xEnd: 1, persistent: true, shape: "rectangle", description: "" },
  ];
  const snapped = snapBandBoundaries(bands, profile);
  ok("boundary 0.52 snaps to the seam at 0.56", Math.abs(snapped[0].yEnd - 0.56) < 0.006, snapped[0].yEnd);
  ok("bands stay contiguous after snapping", snapped[0].yEnd === snapped[1].yStart, snapped);
  ok("outer extents untouched (0 and 1)", snapped[0].yStart === 0 && snapped[1].yEnd === 1);

  // no decisive maximum in the window → leave unsnapped
  const flat = Array.from({ length: N }, () => 0.3);
  const un = snapBandBoundaries(bands, flat);
  ok("flat profile ⇒ boundary left unsnapped", un[0].yEnd === 0.52, un[0].yEnd);

  // a seam OUTSIDE ±0.06 must not attract the boundary
  const far = Array.from({ length: N }, () => 0.05); far[80] = 1.0;
  const unFar = snapBandBoundaries(bands, far);
  ok("seam outside ±0.06 window ⇒ unsnapped", unFar[0].yEnd === 0.52, unFar[0].yEnd);

  // overlay (floating PIP) bands are never snapped
  const withPip = [
    { role: "broll", yStart: 0, yEnd: 1, xStart: 0, xEnd: 1, persistent: false, shape: "rectangle", description: "" },
    { role: "aroll", yStart: 0.55, yEnd: 0.9, xStart: 0.2, xEnd: 0.8, persistent: true, shape: "rounded_rect", description: "" },
  ];
  const pipSnapped = snapBandBoundaries(withPip, profile);
  ok("overlay PIP band untouched by the snap", pipSnapped[1].yStart === 0.55 && pipSnapped[1].yEnd === 0.9, pipSnapped[1]);
}

// ════════════════════════════════════════════════════════════════════════
// VLM region layout with retry (cached; retries bypass a structurally-bad cache).
// ════════════════════════════════════════════════════════════════════════
const flakes: Record<string, number> = {};
async function getRegionLayout(video: string, validate: (rl: RegionLayout) => boolean): Promise<RegionLayout | null> {
  const name = path.basename(video);
  const cached = getCached<RegionLayout>(video, "layout_regions");
  if (cached && validate(cached)) { console.log(`[cache] layout_regions hit for ${name}`); return cached; }
  if (cached) console.log(`[cache] layout_regions for ${name} is structurally unusable — re-running VLM`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rl = await analyzeLayoutRegions(video);
    if (rl && validate(rl)) {
      setCache(video, "layout_regions", rl);
      return rl;
    }
    flakes[name] = (flakes[name] ?? 0) + 1;
    console.log(`[flake] ${name} attempt ${attempt} unusable (${rl ? `class=${rl.layoutClass}` : "null"}) — ${attempt < 3 ? "retrying" : "giving up"}`);
  }
  return null;
}

const hasTimeline = (rl: RegionLayout) => rl.bands.some((b) =>
  (b.contentTimeline?.length ?? 0) >= 2 && new Set(b.contentTimeline!.map((w) => w.content)).size >= 2);

async function main() {
  // ════════════════════════════════════════════════════════════════════
  // R1 — 2-region split: unified path must be a NO-OP on the legacy view.
  // ════════════════════════════════════════════════════════════════════
  console.log("\n── R1 (two_region_split) ──");
  const direct = analyzeLayout(R1);
  if (!direct) { console.log("FAIL  analyzeLayout(R1) null"); process.exit(1); }
  const rl1 = await getRegionLayout(R1, (rl) => rl.layoutClass === "two_region_split");
  const d1 = await decodeReference(R1, { layout: direct, regionLayout: rl1 });
  if (!d1) { console.log("FAIL  decodeReference(R1) null"); process.exit(1); }
  ok("R1 layoutClass = two_region_split", d1.layout.layoutClass.value === "two_region_split", d1.layout.layoutClass.value);
  ok("R1 legacy type identical to direct CV run", d1.layout.type.value === direct.layout.type, d1.layout.type.value);
  ok("R1 arollSide = bottom (identical to direct)", d1.layout.arollSide.value === "bottom" && direct.layout.arollSide === "bottom", d1.layout.arollSide.value);
  ok("R1 divider within ±0.005 of 0.561", Math.abs((d1.layout.dividerFraction.value ?? 99) - 0.561) <= 0.005, d1.layout.dividerFraction.value);
  ok("R1 divider identical to direct CV run", d1.layout.dividerFraction.value === direct.layout.dividerFraction, { unified: d1.layout.dividerFraction.value, direct: direct.layout.dividerFraction });
  ok("R1 regions identical to direct CV run (arollRegion)", JSON.stringify(d1.layout.arollRegion.value) === JSON.stringify(direct.layout.arollRegion));
  ok("R1 brollAspect identical to direct CV run", d1.layout.brollAspect.value === direct.layout.brollAspect);
  ok("R1 regions.length === 2", d1.layout.regions.value.length === 2, d1.layout.regions.value.length);
  ok("R1 type NOT flagged uncertain", d1.layout.type.uncertain !== true, d1.layout.type);
  ok("R1 archetype still split_aroll_bottom", d1.layout.archetype.value === "split_aroll_bottom", d1.layout.archetype.value);

  // ════════════════════════════════════════════════════════════════════
  // R2 — 4-layer stack.
  // ════════════════════════════════════════════════════════════════════
  console.log("\n── R2 (multi_region_stack) ──");
  const cv2 = analyzeLayout(R2);
  if (!cv2) { console.log("FAIL  analyzeLayout(R2) null"); process.exit(1); }
  const rl2 = await getRegionLayout(R2, (rl) => rl.layoutClass === "multi_region_stack" && rl.bands.length === 4);
  const d2 = await decodeReference(R2, { layout: cv2, regionLayout: rl2 });
  if (!d2) { console.log("FAIL  decodeReference(R2) null"); process.exit(1); }
  const regs2 = d2.layout.regions.value;
  console.log(regs2.map((r) => `  ${r.id} ${r.role} y=${r.rect.y} h=${r.rect.h} z=${r.zIndex}`).join("\n"));
  ok("R2 layoutClass = multi_region_stack", d2.layout.layoutClass.value === "multi_region_stack", d2.layout.layoutClass.value);
  ok("R2 has 4 regions", regs2.length === 4, regs2.length);
  const ROLES = ["header_title", "broll", "screen_recording", "aroll"];
  ok(`R2 roles = ${ROLES.join("/")}`, regs2.length === 4 && regs2.every((r, i) => r.role === ROLES[i]), regs2.map((r) => r.role));
  const aroll2 = regs2.find((r) => r.role === "aroll");
  ok("R2 aroll rect.y within ±0.07 of 0.65", !!aroll2 && Math.abs(aroll2.rect.y - 0.65) <= 0.07, aroll2?.rect.y);

  // ════════════════════════════════════════════════════════════════════
  // R3 — PIP over fullscreen (canonical class, normalized).
  // ════════════════════════════════════════════════════════════════════
  console.log("\n── R3 (pip_over_fullscreen) ──");
  const cv3 = analyzeLayout(R3);
  if (!cv3) { console.log("FAIL  analyzeLayout(R3) null"); process.exit(1); }
  const rl3 = await getRegionLayout(R3, (rl) =>
    ["multi_region_stack", "circle_pip", "pip_over_fullscreen", "pip"].includes(rl.layoutClass) && hasTimeline(rl));
  const d3 = await decodeReference(R3, { layout: cv3, regionLayout: rl3 });
  if (!d3) { console.log("FAIL  decodeReference(R3) null"); process.exit(1); }
  const regs3 = d3.layout.regions.value;
  console.log(regs3.map((r) => `  ${r.id} ${r.role} x=${r.rect.x} y=${r.rect.y} w=${r.rect.w} h=${r.rect.h} z=${r.zIndex} ${r.shape}${r.contentTimeline ? ` timeline(${r.contentTimeline.length})` : ""}`).join("\n"));
  ok("R3 layoutClass = pip_over_fullscreen (canonical, normalized)", d3.layout.layoutClass.value === "pip_over_fullscreen", d3.layout.layoutClass.value);
  const aroll3 = regs3.find((r) => r.role === "aroll" && r.zIndex > 0) ?? regs3.find((r) => r.role === "aroll");
  ok("R3 has an aroll PIP region", !!aroll3);
  ok("R3 aroll xStart > 0.02", !!aroll3 && aroll3.rect.x > 0.02, aroll3?.rect.x);
  ok("R3 aroll xEnd < 0.98", !!aroll3 && aroll3.rect.x + aroll3.rect.w < 0.98, aroll3 ? aroll3.rect.x + aroll3.rect.w : null);
  ok("R3 aroll shape = rounded_rect", aroll3?.shape === "rounded_rect", aroll3?.shape);
  const tlRegion = regs3.find((r: DecodedRegion) =>
    (r.contentTimeline?.length ?? 0) >= 2 && new Set(r.contentTimeline!.map((w) => w.content)).size >= 2);
  ok("R3 a region carries a ≥2-class contentTimeline", !!tlRegion, regs3.map((r) => r.contentTimeline?.length ?? 0));

  const totalFlakes = Object.values(flakes).reduce((s, n) => s + n, 0);
  console.log(`\nVLM flake count: ${totalFlakes}${totalFlakes ? ` (${JSON.stringify(flakes)})` : ""}`);
  console.log(fails === 0 ? "\n✅ UNIFIED DECODE gate: ALL PASS" : `\n❌ ${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
