/**
 * test-scene-kb.ts — SceneKB unit tests (match / dedup / thresholds / gates / coverage).
 * Pure + zero-cost: synthetic scenes, temp-dir store, no video/Gemini/render.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSceneKB, sceneDistance, KNOWN_DISTANCE, LEARN_SCORE_MIN,
  type DecodedScene, type SceneExemplar,
} from "../src/lib/knowledge/scene-kb";
import { windowDecode } from "../src/lib/analysis/window-decode";
import type { ReferenceDecode, DecodedField, DecodedRegion } from "../src/lib/analysis/reference-decode";

const F = <T>(value: T): DecodedField<T> => ({ value, source: "cv", confidence: 0.9, method: "test" });

function makeDecode(regions: DecodedRegion[], layoutClass: string): ReferenceDecode {
  return {
    schemaVersion: 2, sourceFile: "test.mp4",
    meta: { duration: F(20), fps: F(30), dims: F([1080, 1920] as [number, number]), aspectRatio: F("9:16") },
    layout: {
      type: F("split"), arollSide: F("bottom" as const), dividerFraction: F<number | null>(0.56),
      arollRegion: F({ x: 0, y: 1077, width: 1080, height: 843 }), brollRegion: F({ x: 0, y: 0, width: 1080, height: 1077 }),
      brollAspect: F(1.0), archetype: F<string | null>(null), layoutClass: F(layoutClass), regions: F(regions),
    },
    pacing: { shotCount: F(10), avgShotSec: F(2.0), cutFrequency: F("medium"), shotBoundaries: F([2, 4, 6, 8, 10, 12, 14, 16, 18] as number[]) },
    transitions: { dominant: F("cut"), distribution: F({ cut: 9 } as Record<string, number>) },
    motion: { dominant: F("static"), distribution: F({ static: 8, push_in: 2 } as Record<string, number>) },
    captions: { present: F(true), bandFraction: F<[number, number] | null>(null), position: F<string | null>("bottom"), style: F<string | null>(null), animation: F<string | null>(null) },
    overlays: F([] as Array<{ kind: string; description: string }>),
    style: { keywords: F([] as string[]), summary: F("") },
    decodeConfidence: 0.85,
  };
}

const SPLIT_REGIONS: DecodedRegion[] = [
  { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.56 }, shape: "rectangle", zIndex: 0, persistent: false },
  { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.56, w: 1, h: 0.44 }, shape: "rectangle", zIndex: 0, persistent: true },
];

function makeScene(overrides?: Partial<DecodedScene>): DecodedScene {
  const decode = makeDecode(SPLIT_REGIONS, "two_region_split");
  return {
    window: { t0: 0, t1: 20 },
    layoutClass: "two_region_split",
    regions: SPLIT_REGIONS,
    decode: windowDecode(decode, 0, 20),
    referenceHash: "hashA",
    ...overrides,
  };
}

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scene-kb-test-"));
// seed the temp store with the real families.json
fs.copyFileSync(path.join(process.cwd(), ".knowledge", "scene-kb", "families.json"), path.join(tmp, "families.json"));
const kb = new FileSceneKB(tmp);

// 1. EMPTY LIBRARY: a known-family scene with no exemplars ⇒ family_new.
{
  const m = kb.matchScene(makeScene());
  ok("known family, no exemplars ⇒ family_new", m.kind === "family_new" && m.family === "two_region_split", m);
}

// 2. NOVEL: a layoutClass with no family ⇒ novel (never auto-admitted).
{
  const m = kb.matchScene(makeScene({ layoutClass: "triple_diagonal_wipe" }));
  ok("unknown layoutClass ⇒ novel", m.kind === "novel" && m.family === null, m);
  const p = kb.proposeFamily(makeScene({ layoutClass: "triple_diagonal_wipe" }));
  ok("proposeFamily drafts a proposal (human queue)", p.layoutClass === "triple_diagonal_wipe" && p.proposedId.startsWith("proposed_"), p.proposedId);
}

// 3. LEARN GATES: score < 95 rejected; cvVlmAgree=false rejected; novel family rejected.
{
  const low = kb.learnExemplar({ scene: makeScene(), closedLoopScore: 94.9, cvVlmAgree: true });
  ok("score < 95 ⇒ NOT learned", !low.learned && low.reason.includes("score"), low);
  const noAgree = kb.learnExemplar({ scene: makeScene(), closedLoopScore: 97, cvVlmAgree: false });
  ok("CV/VLM disagreement ⇒ NOT learned", !noAgree.learned, noAgree);
  const novel = kb.learnExemplar({ scene: makeScene({ layoutClass: "triple_diagonal_wipe" }), closedLoopScore: 99, cvVlmAgree: true });
  ok("novel family ⇒ NEVER auto-admitted", !novel.learned && novel.reason.includes("novel"), novel);
}

// 4. LEARN + KNOWN MATCH: a passing exemplar is admitted; the same scene then matches KNOWN with distance ≈ 0.
{
  const learned = kb.learnExemplar({ scene: makeScene(), closedLoopScore: 96.5, cvVlmAgree: true, renderParams: { targetShotSec: 2.0 } });
  ok("gated exemplar learned", learned.learned && !!learned.exemplarId, learned);
  const m = kb.matchScene(makeScene());
  ok("same scene ⇒ KNOWN", m.kind === "known" && m.family === "two_region_split", m.kind);
  ok("distance ≈ 0 for the identical scene", m.distance <= 0.005, m.distance);
  ok("match carries the exemplar (recipe injection source)", m.exemplar?.renderParams?.targetShotSec === 2.0, m.exemplar?.renderParams);
}

// 5. DEDUP by (referenceHash, window): re-learning the same scene is a no-op.
{
  const dup = kb.learnExemplar({ scene: makeScene(), closedLoopScore: 99, cvVlmAgree: true });
  ok("duplicate (referenceHash, window) ⇒ NOT learned", !dup.learned && dup.reason.includes("duplicate"), dup);
  const other = kb.learnExemplar({ scene: makeScene({ referenceHash: "hashB" }), closedLoopScore: 96, cvVlmAgree: true });
  ok("different referenceHash ⇒ learned", other.learned, other);
}

// 6. KNOWN THRESHOLD 0.12: a geometry-drifted scene beyond the threshold ⇒ family_new.
{
  const drifted: DecodedRegion[] = [
    { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.30 }, shape: "rectangle", zIndex: 0, persistent: false },
    { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.30, w: 1, h: 0.70 }, shape: "rectangle", zIndex: 0, persistent: true },
  ];
  const scene = makeScene({ regions: drifted, decode: windowDecode(makeDecode(drifted, "two_region_split"), 0, 20), referenceHash: "hashC" });
  const m = kb.matchScene(scene);
  ok("large geometry drift ⇒ distance > 0.12 ⇒ family_new", m.kind === "family_new" && m.distance > KNOWN_DISTANCE, { kind: m.kind, distance: m.distance });
}

// 7. sceneDistance weighting sanity: geometry drift moves the distance more than caption drift.
{
  const base = kb.matchScene(makeScene({ referenceHash: "hashD" }));
  const ex = base.exemplar as SceneExemplar;
  const capDrift = makeScene({ referenceHash: "hashD" });
  capDrift.decode.captions.present = { ...capDrift.decode.captions.present, value: false };
  const geoDrift = makeScene({
    referenceHash: "hashD",
    regions: [
      { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.40 }, shape: "rectangle", zIndex: 0, persistent: false },
      { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.40, w: 1, h: 0.60 }, shape: "rectangle", zIndex: 0, persistent: true },
    ],
  });
  ok("geometry drift outweighs caption drift (0.5 vs 0.15)", sceneDistance(geoDrift, ex) > sceneDistance(capDrift, ex),
    { geo: sceneDistance(geoDrift, ex), cap: sceneDistance(capDrift, ex) });
}

// 8. COVERAGE REPORT: per-family exemplar counts + avg score.
{
  const cov = kb.coverageReport();
  ok("coverage lists the learned family", (cov.perFamily["two_region_split"]?.exemplars ?? 0) >= 2, cov.perFamily);
  ok("avgScore ≥ LEARN_SCORE_MIN (only gated exemplars exist)", cov.perFamily["two_region_split"].avgScore >= LEARN_SCORE_MIN, cov.perFamily["two_region_split"].avgScore);
}

// 9. getRecipe: family recipe resolves; exemplarId merges renderParams.
{
  const plain = kb.getRecipe("two_region_split");
  ok("getRecipe returns the family renderRecipe", plain?.renderRecipe.compositor === "src/lib/pipeline/plan-renderer.ts", plain?.renderRecipe.compositor);
  const m = kb.matchScene(makeScene());
  const withEx = kb.getRecipe("two_region_split", m.exemplar?.id);
  ok("getRecipe(exemplarId) carries the exemplar renderParams", withEx?.renderParams?.targetShotSec === 2.0, withEx?.renderParams);
  ok("getRecipe on an unknown family ⇒ null", kb.getRecipe("nope") === null);
}

// 10. NEAR-BOUNDARY: calibration test — SMALL drift stays KNOWN, MODERATE drift is NOT known.
// Exemplar has dividerFraction 0.56; test small vs moderate shifts to anchor the ×K constant.
{
  // Learn an exemplar at divider 0.56 (baseline)
  const baselineScene = makeScene({ referenceHash: "hashBase" });
  const baselineResult = kb.learnExemplar({
    scene: baselineScene,
    closedLoopScore: 96.5,
    cvVlmAgree: true,
    renderParams: { dividerFraction: 0.56 },
  });
  ok("baseline exemplar learned at divider 0.56", baselineResult.learned, baselineResult);

  // Test (a): SMALL drift — divider 0.575 (1.5% shift from 0.56) should stay KNOWN (≤ 0.12)
  {
    const smallDrift: DecodedRegion[] = [
      { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.575 }, shape: "rectangle", zIndex: 0, persistent: false },
      { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.575, w: 1, h: 0.425 }, shape: "rectangle", zIndex: 0, persistent: true },
    ];
    const smallScene = makeScene({
      regions: smallDrift,
      decode: windowDecode(makeDecode(smallDrift, "two_region_split"), 0, 20),
      referenceHash: "hashSmallDrift",
    });
    const m = kb.matchScene(smallScene);
    ok("small drift (1.5% rect shift) ⇒ KNOWN (distance ≤ 0.12)", m.kind === "known" && m.distance <= KNOWN_DISTANCE,
      { kind: m.kind, distance: m.distance });
  }

  // Test (b): MODERATE drift — divider 0.66 (10% shift from 0.56) should be family_new (> 0.12)
  {
    const modDrift: DecodedRegion[] = [
      { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.66 }, shape: "rectangle", zIndex: 0, persistent: false },
      { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.66, w: 1, h: 0.34 }, shape: "rectangle", zIndex: 0, persistent: true },
    ];
    const modScene = makeScene({
      regions: modDrift,
      decode: windowDecode(makeDecode(modDrift, "two_region_split"), 0, 20),
      referenceHash: "hashModDrift",
    });
    const m = kb.matchScene(modScene);
    ok("moderate drift (10% rect shift) ⇒ family_new (distance > 0.12)", m.kind === "family_new" && m.distance > KNOWN_DISTANCE,
      { kind: m.kind, distance: m.distance });
  }
}

// 11. COMBINED GATES: novel family that passes score+agree ⇒ rejected with novel reason.
//     Then all gates pass ⇒ admitted; second learn of same (hash, window) ⇒ duplicate rejected.
{
  const novelLayout = "diagonal_sweep";

  // Learn a novel-family exemplar with high score and agreement — should be REJECTED (not novel in family list).
  {
    const novelCandidate = kb.learnExemplar({
      scene: makeScene({ layoutClass: novelLayout, referenceHash: "hashNovel1" }),
      closedLoopScore: 96.0,
      cvVlmAgree: true,
      renderParams: { targetShotSec: 2.0 },
    });
    ok("novel family + high score + agree ⇒ NOT learned (novel gate override)",
      !novelCandidate.learned && novelCandidate.reason.includes("novel"),
      novelCandidate.reason);
  }

  // Now test all gates passing on a KNOWN family: high score, agreement, fresh (hash, window).
  {
    const allGates = kb.learnExemplar({
      scene: makeScene({ referenceHash: "hashAllGates", layoutClass: "two_region_split" }),
      closedLoopScore: 98.5,
      cvVlmAgree: true,
      renderParams: { targetShotSec: 2.0 },
    });
    ok("all gates pass ⇒ admitted (known family, score 98.5, agree, fresh hash)",
      allGates.learned && !!allGates.exemplarId,
      allGates);

    // Second learn of the SAME (referenceHash, window) ⇒ duplicate rejected.
    const duplicate = kb.learnExemplar({
      scene: makeScene({ referenceHash: "hashAllGates", layoutClass: "two_region_split" }),
      closedLoopScore: 99.0,
      cvVlmAgree: true,
      renderParams: { targetShotSec: 2.5 },
    });
    ok("same (referenceHash, window) on second learn ⇒ duplicate rejected",
      !duplicate.learned && duplicate.reason.includes("duplicate"),
      duplicate.reason);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? "\n✅ scene-kb unit tests ALL PASS" : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
