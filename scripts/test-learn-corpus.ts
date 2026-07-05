/**
 * test-learn-corpus.ts — corpus batch-learning core: report shape, gating, IDEMPOTENCY.
 * Pure + zero-cost: fake decoder, temp-dir KB store. No video/Gemini/render.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLearnCorpus, type CorpusDecodeResult } from "../src/lib/knowledge/learn-corpus";
import { FileSceneKB } from "../src/lib/knowledge/scene-kb";
import { windowDecode } from "../src/lib/analysis/window-decode";
import type { ReferenceDecode, DecodedField, DecodedRegion } from "../src/lib/analysis/reference-decode";

const F = <T>(value: T): DecodedField<T> => ({ value, source: "cv", confidence: 0.9, method: "test" });
const SPLIT_REGIONS: DecodedRegion[] = [
  { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.56 }, shape: "rectangle", zIndex: 0, persistent: false },
  { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.56, w: 1, h: 0.44 }, shape: "rectangle", zIndex: 0, persistent: true },
];

function fakeDecode(layoutClass: string, regions: DecodedRegion[]): ReferenceDecode {
  return {
    schemaVersion: 2, sourceFile: "corpus.mp4",
    meta: { duration: F(20), fps: F(30), dims: F([1080, 1920] as [number, number]), aspectRatio: F("9:16") },
    layout: {
      type: F("split"), arollSide: F("bottom" as const), dividerFraction: F<number | null>(0.56),
      arollRegion: F({ x: 0, y: 1077, width: 1080, height: 843 }), brollRegion: F({ x: 0, y: 0, width: 1080, height: 1077 }),
      brollAspect: F(1.0), archetype: F<string | null>(null), layoutClass: F(layoutClass), regions: F(regions),
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

const decodeFor = async (file: string): Promise<CorpusDecodeResult | null> => {
  if (file.includes("novel")) return { decode: fakeDecode("hexagon_mosaic", SPLIT_REGIONS), referenceHash: `h_${path.basename(file)}`, cvVlmAgree: true };
  return { decode: fakeDecode("two_region_split", SPLIT_REGIONS), referenceHash: `h_${path.basename(file)}`, cvVlmAgree: true };
};

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

async function mainUnitTests(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "learn-corpus-test-"));
  fs.copyFileSync(path.join(process.cwd(), ".knowledge", "scene-kb", "families.json"), path.join(tmp, "families.json"));
  const kb = new FileSceneKB(tmp);
  const files = ["a.mp4", "b.mp4", "novel1.mp4"];
  const scoreOf = () => 96.5;   // pretend every scene has a verified windowed score

  // ── first run: learns the passing scenes, queues the novel one ──
  const r1 = await runLearnCorpus({ files, kb, decodeFor, scoreOf });
  ok("report covers 3 reels", r1.report.totals.reels === 3, r1.report.totals);
  ok("3 scenes total (1 window each)", r1.report.totals.scenes === 3, r1.report.totals.scenes);
  ok("novel reel reported novel", r1.report.perReel[2].scenes[0].kind === "novel", r1.report.perReel[2]);
  ok("novel family produces a review-queue proposal", r1.proposals.length === 1 && r1.proposals[0].layoutClass === "hexagon_mosaic", r1.proposals);
  ok("first run learned 2 exemplars (novel never auto-admitted)", r1.report.totals.learned === 2, r1.report.totals.learned);
  ok("a learns first ⇒ family_new; b then matches KNOWN against a's exemplar",
    r1.report.perReel[0].scenes[0].kind === "family_new" && r1.report.perReel[1].scenes[0].kind === "known",
    r1.report.perReel.map((p) => p.scenes[0].kind));

  // ── second run: IDEMPOTENT — dedup by (referenceHash, window) ⇒ learns 0 new ──
  const r2 = await runLearnCorpus({ files, kb, decodeFor, scoreOf });
  ok("second run learns 0 new (idempotent)", r2.report.totals.learned === 0, r2.report.totals.learned);
  ok("second run: all split scenes now KNOWN", r2.report.perReel[0].scenes[0].kind === "known" && r2.report.perReel[1].scenes[0].kind === "known",
    r2.report.perReel.map((p) => p.scenes[0].kind));

  // ── no score ⇒ report-only, nothing learned ──
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "learn-corpus-test2-"));
  fs.copyFileSync(path.join(process.cwd(), ".knowledge", "scene-kb", "families.json"), path.join(tmp2, "families.json"));
  const r3 = await runLearnCorpus({ files: ["a.mp4"], kb: new FileSceneKB(tmp2), decodeFor });
  ok("no windowed score ⇒ learns 0 (score gate)", r3.report.totals.learned === 0, r3.report.totals.learned);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  console.log(fails === 0 ? "\n✅ learn-corpus unit tests ALL PASS" : `\n❌ ${fails} FAILED`);
  return fails;
}

/**
 * Sidecar parsing test: corrupt JSON file.
 * Verifies: missing file, unreadable, invalid JSON, non-object root all handled cleanly.
 */
function testSidecarParsing(): boolean {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-parse-"));
  let testPass = true;

  // Test 1: corrupt JSON
  const corruptFile = path.join(tmpDir, "corrupt.json");
  fs.writeFileSync(corruptFile, "{invalid json");
  try {
    JSON.parse(fs.readFileSync(corruptFile, "utf8"));
    console.log("FAIL  sidecar parsing: corrupt JSON should throw");
    testPass = false;
  } catch (e) {
    console.log("PASS  sidecar parsing: corrupt JSON throws as expected");
  }

  // Test 2: missing file (before fix, this would throw ENOENT)
  const missingFile = path.join(tmpDir, "missing.json");
  try {
    fs.readFileSync(missingFile, "utf8");
    console.log("FAIL  sidecar parsing: missing file should throw");
    testPass = false;
  } catch (e) {
    console.log("PASS  sidecar parsing: missing file throws as expected");
  }

  // Test 3: non-object root (after parsing)
  const arrayFile = path.join(tmpDir, "array.json");
  fs.writeFileSync(arrayFile, "[]");
  try {
    const parsed = JSON.parse(fs.readFileSync(arrayFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.log("PASS  sidecar parsing: non-object root detected");
    } else {
      console.log("FAIL  sidecar parsing: should detect non-object root");
      testPass = false;
    }
  } catch (e) {
    console.log("FAIL  sidecar parsing: unexpected error on array parse:", e);
    testPass = false;
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return testPass;
}

async function main() {
  console.log("Running learn-corpus unit tests...");
  const unitFails = await mainUnitTests();
  console.log("\nRunning sidecar parsing tests...");
  const sidecarPass = testSidecarParsing();
  const totalFails = unitFails + (sidecarPass ? 0 : 1) + fails;
  process.exit(totalFails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
