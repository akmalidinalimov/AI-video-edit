/**
 * test-scene-kb-integration.ts — route-glue unit test: buildSceneMatches (the exact
 * helper analyze-reference calls) segments + windows + matches, and the verify-output
 * learn guard math. Pure: synthetic decode + temp KB. No route run, no Gemini.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSceneMatches, queueNovelProposal } from "../src/lib/knowledge/scene-kb-route";
import { FileSceneKB } from "../src/lib/knowledge/scene-kb";
import type { DecodedScene } from "../src/lib/knowledge/scene-kb";
import type { ReferenceDecode, DecodedField, DecodedRegion } from "../src/lib/analysis/reference-decode";

const F = <T>(value: T): DecodedField<T> => ({ value, source: "cv", confidence: 0.9, method: "test" });
const SPLIT_REGIONS: DecodedRegion[] = [
  { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.56 }, shape: "rectangle", zIndex: 0, persistent: false },
  { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.56, w: 1, h: 0.44 }, shape: "rectangle", zIndex: 0, persistent: true },
];
function makeDecode(): ReferenceDecode {
  return {
    schemaVersion: 2, sourceFile: "test.mp4",
    meta: { duration: F(20), fps: F(30), dims: F([1080, 1920] as [number, number]), aspectRatio: F("9:16") },
    layout: {
      type: F("split"), arollSide: F("bottom" as const), dividerFraction: F<number | null>(0.56),
      arollRegion: F({ x: 0, y: 1077, width: 1080, height: 843 }), brollRegion: F({ x: 0, y: 0, width: 1080, height: 1077 }),
      brollAspect: F(1.0), archetype: F<string | null>(null), layoutClass: F("two_region_split"), regions: F(SPLIT_REGIONS),
    },
    pacing: { shotCount: F(10), avgShotSec: F(2.0), cutFrequency: F("medium"), shotBoundaries: F([2, 4, 6, 8, 10, 12, 14, 16, 18] as number[]) },
    transitions: { dominant: F("cut"), distribution: F({ cut: 9 } as Record<string, number>) },
    motion: { dominant: F("static"), distribution: F({ static: 8 } as Record<string, number>) },
    captions: { present: F(true), bandFraction: F<[number, number] | null>(null), position: F<string | null>("bottom"), style: F<string | null>(null), animation: F<string | null>(null) },
    overlays: F([] as Array<{ kind: string; description: string }>),
    style: { keywords: F([] as string[]), summary: F("") },
    decodeConfidence: 0.85,
  };
}

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scene-kb-route-test-"));
fs.copyFileSync(path.join(process.cwd(), ".knowledge", "scene-kb", "families.json"), path.join(tmp, "families.json"));
const kb = new FileSceneKB(tmp);

// buildSceneMatches: decode + structureTimeline + hash → { sceneWindows, sceneMatches }
const { sceneWindows, sceneMatches } = buildSceneMatches({
  decode: makeDecode(), structureTimeline: null, referenceHash: "routeHashA", kb,
});
ok("one scene window (stable structure)", sceneWindows.length === 1, sceneWindows.length);
ok("sceneMatches index-aligned", sceneMatches.length === 1, sceneMatches.length);
ok("scene decode is WINDOW-scoped (duration 20)", sceneMatches[0].scene.decode.meta.duration.value === 20);
ok("known family, empty store ⇒ family_new", sceneMatches[0].match.kind === "family_new", sceneMatches[0].match);
ok("scene carries the referenceHash (learn dedup key)", sceneMatches[0].scene.referenceHash === "routeHashA");

// learn-after-verify guard math (verify-output): score ≥ 95 admits; < 95 does not.
const learned95 = kb.learnExemplar({ scene: sceneMatches[0].scene, closedLoopScore: 95, cvVlmAgree: true });
ok("verify-output guard: score 95 admits", learned95.learned, learned95);
const rematch = kb.matchScene(sceneMatches[0].scene);
ok("after learning, the same reference scene is KNOWN", rematch.kind === "known", rematch.kind);

// Test: novel scenes are queued for human review (dedup proven)
const novelScene: DecodedScene = {
  window: { t0: 10, t1: 12 },
  layoutClass: "novel_family_never_seen",
  regions: SPLIT_REGIONS,
  decode: makeDecode(),
  referenceHash: "novelRefHash",
};
const novelMatch = kb.matchScene(novelScene);
ok("novel family is matched as kind: novel", novelMatch.kind === "novel", novelMatch.kind);

// First run: queue the novel proposal
const queuePath = path.join(tmp, "review-queue.json");
const prop1 = queueNovelProposal(kb, novelScene, queuePath);
ok("proposeFamily returns a FamilyProposal", prop1.layoutClass === "novel_family_never_seen");

let existing = JSON.parse(fs.readFileSync(queuePath, "utf8"));
ok("review-queue.json has 1 proposal after first run", existing.length === 1, existing.length);

// Second run (identical): dedup prevents duplicate
const prop2 = queueNovelProposal(kb, novelScene, queuePath);
ok("second call also proposes (caller dedupes)", prop2.layoutClass === "novel_family_never_seen");

existing = JSON.parse(fs.readFileSync(queuePath, "utf8"));
ok("review-queue.json still has 1 proposal (dedup proven)", existing.length === 1, existing.length);

// Verify the proposal has the right shape
const proposal = existing[0];
ok("proposal has referenceHash", proposal.referenceHash === "novelRefHash");
ok("proposal has window", proposal.window && proposal.window.t0 === 10 && proposal.window.t1 === 12);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? "\n✅ scene-kb route-glue tests ALL PASS" : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
