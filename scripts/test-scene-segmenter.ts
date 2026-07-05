/**
 * test-scene-segmenter.ts — scene segmentation unit tests + R1/R2/R3 gate.
 * Pure parts are zero-cost synthetic decodes. The R1/R2/R3 gate reads CACHED
 * layout_regions artifacts via getCached (test-unified-decode pattern) and runs
 * the free CV analyzeLayout — NO fresh Gemini call ever (cache miss ⇒ SKIP + warn).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { segmentScenes, MIN_SCENE_SEC, type SceneWindow } from "../src/lib/analysis/scene-segmenter";
import { getCached } from "../src/lib/analysis/analysisCache";
import { analyzeLayout } from "../src/lib/analysis/layout-analyzer";
import { decodeReference } from "../src/lib/analysis/reference-decode";
import type { RegionLayout, StructureWindow, RegionBand } from "../src/lib/analysis/layout-regions";
import type { ReferenceDecode, DecodedField, DecodedRegion } from "../src/lib/analysis/reference-decode";

const F = <T>(value: T): DecodedField<T> => ({ value, source: "cv", confidence: 0.9, method: "test" });

function makeDecode(duration = 27): ReferenceDecode {
  return {
    schemaVersion: 2,
    sourceFile: "test.mp4",
    meta: { duration: F(duration), fps: F(30), dims: F([1080, 1920] as [number, number]), aspectRatio: F("9:16") },
    layout: {
      type: F("split"), arollSide: F("bottom" as const), dividerFraction: F<number | null>(0.561),
      arollRegion: F({ x: 0, y: 1077, width: 1080, height: 843 }),
      brollRegion: F({ x: 0, y: 0, width: 1080, height: 1077 }),
      brollAspect: F(1.003), archetype: F<string | null>(null),
      layoutClass: F("two_region_split"),
      regions: F<DecodedRegion[]>([
        { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.561 }, shape: "rectangle", zIndex: 0, persistent: false },
        { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.561, w: 1, h: 0.439 }, shape: "rectangle", zIndex: 0, persistent: true },
      ]),
    },
    pacing: { shotCount: F(26), avgShotSec: F(1.04), cutFrequency: F("fast"), shotBoundaries: F([5.2, 10.4] as number[]) },
    transitions: { dominant: F("cut"), distribution: F({ cut: 20 } as Record<string, number>) },
    motion: { dominant: F("static"), distribution: F({ static: 5 } as Record<string, number>) },
    captions: { present: F(true), bandFraction: F<[number, number] | null>(null), position: F<string | null>(null), style: F<string | null>(null), animation: F<string | null>(null) },
    overlays: F([] as Array<{ kind: string; description: string }>),
    style: { keywords: F([] as string[]), summary: F("") },
    decodeConfidence: 0.85,
  };
}

const band = (role: string, y0: number, y1: number, persistent = false, x0 = 0, x1 = 1): RegionBand =>
  ({ role, yStart: y0, yEnd: y1, xStart: x0, xEnd: x1, persistent, shape: "rectangle", description: "" });

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

// 1. NO structureTimeline ⇒ ONE window over [0, duration] with the decode's class + regions.
{
  const s = segmentScenes(makeDecode(27));
  ok("stable structure ⇒ 1 window", s.length === 1, s.length);
  ok("window covers [0, 27]", s[0].t0 === 0 && s[0].t1 === 27, s[0]);
  ok("window carries decode layoutClass", s[0].layoutClass === "two_region_split", s[0].layoutClass);
  ok("window carries decode regions", s[0].regions.length === 2, s[0].regions.length);
}

// 2. structureTimeline ⇒ one contiguous window per structure stretch, classes derived per window.
{
  const tl: StructureWindow[] = [
    { start: 0, end: 3, bands: [band("broll", 0, 0.55), band("aroll", 0.55, 1, true)] },
    { start: 3, end: 9, bands: [band("header_title", 0, 0.12, true), band("broll", 0.12, 0.62), band("aroll", 0.62, 1, true)] },
    { start: 9, end: 27, bands: [band("broll", 0, 1), band("aroll", 0.55, 0.9, true, 0.2, 0.8)] },
  ];
  const s = segmentScenes(makeDecode(27), { structureTimeline: tl });
  ok("3 structure windows ⇒ 3 scenes", s.length === 3, s.map((w) => [w.t0, w.t1]));
  ok("contiguous over [0, 27]", s[0].t0 === 0 && s[s.length - 1].t1 === 27 && s.every((w, i) => i === 0 || w.t0 === s[i - 1].t1), s.map((w) => [w.t0, w.t1]));
  ok("2 bands ⇒ two_region_split", s[0].layoutClass === "two_region_split", s[0].layoutClass);
  ok("3 stacked bands ⇒ multi_region_stack", s[1].layoutClass === "multi_region_stack", s[1].layoutClass);
  ok("full-frame band + floating pip ⇒ pip_over_fullscreen", s[2].layoutClass === "pip_over_fullscreen", s[2].layoutClass);
  ok("scene regions come from the window's bands", s[1].regions.length === 3, s[1].regions.map((r) => r.role));
}

// 3. MIN SCENE 0.8s: a 0.5s window is absorbed into its longer neighbor.
{
  const tl: StructureWindow[] = [
    { start: 0, end: 10, bands: [band("broll", 0, 0.55), band("aroll", 0.55, 1, true)] },
    { start: 10, end: 10.5, bands: [band("aroll", 0, 1, true)] },
    { start: 10.5, end: 27, bands: [band("broll", 0, 0.55), band("aroll", 0.55, 1, true)] },
  ];
  const s = segmentScenes(makeDecode(27), { structureTimeline: tl });
  ok("sub-0.8s window absorbed ⇒ 2 scenes", s.length === 2, s.map((w) => [w.t0, w.t1]));
  ok("still contiguous + full coverage", s[0].t0 === 0 && s[1].t1 === 27 && s[1].t0 === s[0].t1, s);
  ok("every scene ≥ MIN_SCENE_SEC", s.every((w) => w.t1 - w.t0 >= MIN_SCENE_SEC), s.map((w) => w.t1 - w.t0));
}

// 4. Timeline that does not reach the duration is extended (last window clamps to dur).
{
  const tl: StructureWindow[] = [
    { start: 0, end: 12, bands: [band("broll", 0, 0.55), band("aroll", 0.55, 1, true)] },
    { start: 12, end: 24, bands: [band("aroll", 0, 1, true)] },
  ];
  const s = segmentScenes(makeDecode(27), { structureTimeline: tl });
  ok("last window extended to duration", s[s.length - 1].t1 === 27, s[s.length - 1]);
  ok("single band ⇒ single_fullscreen", s[1].layoutClass === "single_fullscreen", s[1].layoutClass);
}

// ── R1/R2/R3 GATE (cached artifacts only — no fresh Gemini) ──
const R1 = `${process.cwd()}/public/uploads/1782174583392_target_2split.mp4`;
const R2 = `${process.cwd()}/public/uploads/DownReels_20260701_191828.mp4`;
const R3 = `${process.cwd()}/public/uploads/ref3-aipipeline.mp4`;

async function gate(name: string, video: string, assert: (s: SceneWindow[], rl: RegionLayout | null) => void) {
  if (!existsSync(video)) { console.log(`SKIP  ${name}: ${path.basename(video)} not present`); return; }
  const rl = getCached<RegionLayout>(video, "layout_regions");
  if (!rl) { console.log(`SKIP  ${name}: no cached layout_regions (never call Gemini from this test)`); return; }
  const layout = analyzeLayout(video);
  if (!layout) { console.log(`SKIP  ${name}: analyzeLayout unavailable`); return; }
  const decode = await decodeReference(video, { layout, regionLayout: rl });
  if (!decode) { console.log(`FAIL  ${name}: decodeReference null`); fails++; return; }
  const scenes = segmentScenes(decode, { structureTimeline: rl.structureTimeline ?? null });
  console.log(`  ${name}: ${scenes.map((w) => `[${w.t0}-${w.t1} ${w.layoutClass}]`).join(" ")}`);
  ok(`${name} scenes contiguous over [0, dur]`,
    scenes[0].t0 === 0 && Math.abs(scenes[scenes.length - 1].t1 - decode.meta.duration.value) < 0.05 &&
    scenes.every((w, i) => i === 0 || w.t0 === scenes[i - 1].t1));
  ok(`${name} every scene ≥ ${MIN_SCENE_SEC}s`, scenes.every((w) => w.t1 - w.t0 >= MIN_SCENE_SEC));
  assert(scenes, rl);
}

async function main() {
  console.log("\n── R1/R2/R3 segmentation gate (cached) ──");
  await gate("R1", R1, (s) => ok("R1 ⇒ 1 window (stable split)", s.length === 1, s.length));
  await gate("R2", R2, (s, rl) => {
    const expected = rl?.structureTimeline?.length ?? 1;
    ok(`R2 ⇒ windows per its structureTimeline (≤ ${expected}, ≥ 1 after 0.8s absorption)`,
      s.length >= 1 && s.length <= Math.max(1, expected), { got: s.length, structureWindows: expected });
    if (expected >= 2) ok("R2 with a multi-window structureTimeline ⇒ ≥ 2 scenes", s.length >= 2, s.length);
  });
  await gate("R3", R3, (s) => {
    ok("R3 ⇒ 1 structural window (stable PIP)", s.length === 1, s.length);
    ok("R3 window keeps a multi-class contentTimeline attribute",
      s[0].regions.some((r) => (r.contentTimeline?.length ?? 0) >= 2 && new Set(r.contentTimeline!.map((w) => w.content)).size >= 2),
      s[0].regions.map((r) => r.contentTimeline?.length ?? 0));
  });
  console.log(fails === 0 ? "\n✅ scene-segmenter tests ALL PASS" : `\n❌ ${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
