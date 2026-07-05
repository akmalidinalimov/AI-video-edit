/**
 * test-style-compare.ts — unit test for the CLOSED-LOOP GATE METRIC (compareDecodedStyle).
 * The milestone gates on this number (≥90% [D]); until now nothing tested the comparison
 * code itself. Pure + zero-cost: builds synthetic decodes, no video/Gemini/render.
 */
import { compareDecodedStyle } from "../src/lib/analysis/style-compare.ts";
import type { ReferenceDecode, DecodedField, DecodedRegion } from "../src/lib/analysis/reference-decode.ts";

const F = <T>(value: T): DecodedField<T> => ({ value, source: "cv", confidence: 0.9, method: "test" });

/** Minimal valid decode mirroring R1's real shape. */
function makeDecode(): ReferenceDecode {
  return {
    schemaVersion: 2,
    sourceFile: "test.mp4",
    meta: { duration: F(27), fps: F(30), dims: F([1080, 1920] as [number, number]), aspectRatio: F("9:16") },
    layout: {
      type: F("split"),
      arollSide: F("bottom" as const),
      dividerFraction: F<number | null>(0.561),
      arollRegion: F({ x: 0, y: 1077, width: 1080, height: 843 }),
      brollRegion: F({ x: 0, y: 0, width: 1080, height: 1077 }),
      brollAspect: F(1.003),
      archetype: F<string | null>("split_aroll_bottom"),
      layoutClass: F("two_region_split"),
      regions: F<DecodedRegion[]>([
        { id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.561 }, shape: "rectangle", zIndex: 0, persistent: false },
        { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.561, w: 1, h: 0.439 }, shape: "rectangle", zIndex: 0, persistent: true },
      ]),
    },
    pacing: {
      shotCount: F(26), avgShotSec: F(1.04), cutFrequency: F("fast"),
      shotBoundaries: F([1, 2, 3, 4, 5].map((n) => n * 1.04)),
    },
    transitions: { dominant: F("cut"), distribution: F({ cut: 20, crossfade: 5 } as Record<string, number>) },
    motion: { dominant: F("push_in"), distribution: F({ push_in: 11, static: 2, pull_out: 3 } as Record<string, number>) },
    captions: {
      present: F(true), bandFraction: F<[number, number] | null>([0.6, 0.66]),
      position: F<string | null>("below-divider"), style: F<string | null>("bold white"), animation: F<string | null>("word-pop-in"),
    },
    overlays: F([] as Array<{ kind: string; description: string }>),
    style: { keywords: F(["split-screen", "fast-cut"]), summary: F("test") },
    decodeConfidence: 0.85,
  };
}

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

// 1. IDENTITY: a decode compared with itself must score ~100%.
{
  const d = makeDecode();
  const r = compareDecodedStyle(d, makeDecode());
  ok("identity ⇒ ≥99%", r.overallPct >= 99, r.overallPct);
  ok("identity ⇒ no mismatches below 0.99", r.mismatches.length === 0, r.mismatches.map((m) => m.field));
  void d;
}

// 2. INVERTED SIDE: flipping arollSide must drop the score by ≥ the side weight (0.18).
{
  const out = makeDecode();
  out.layout.arollSide = F("top" as const);
  const r = compareDecodedStyle(makeDecode(), out);
  ok("inverted arollSide ⇒ ≤ 82.5%", r.overallPct <= 82.5, r.overallPct);
  ok("inverted arollSide is the top mismatch", r.mismatches[0]?.field === "layout.arollSide", r.mismatches[0]?.field);
}

// 3. WRONG TYPE: split vs fullscreen must drop by ≥ the type weight (0.16).
{
  const out = makeDecode();
  out.layout.type = F("fullscreen");
  const r = compareDecodedStyle(makeDecode(), out);
  ok("wrong layout type ⇒ ≤ 84.5%", r.overallPct <= 84.5, r.overallPct);
}

// 4. PACING DRIFT: halving the shot count must hurt but not zero the score.
{
  const out = makeDecode();
  out.pacing.shotCount = F(13);
  const r = compareDecodedStyle(makeDecode(), out);
  ok("halved shotCount ⇒ between 85% and 96%", r.overallPct >= 85 && r.overallPct <= 96, r.overallPct);
}

// 5. DIVIDER TOLERANCE: a 0.01 divider difference should be nearly free; 0.15 should cost the full field.
{
  const near = makeDecode(); near.layout.dividerFraction = F<number | null>(0.571);
  const far = makeDecode(); far.layout.dividerFraction = F<number | null>(0.711);
  const rNear = compareDecodedStyle(makeDecode(), near);
  const rFar = compareDecodedStyle(makeDecode(), far);
  ok("divider +0.01 ⇒ ≥ 98.5%", rNear.overallPct >= 98.5, rNear.overallPct);
  ok("divider +0.15 ⇒ strictly worse than +0.01", rFar.overallPct < rNear.overallPct - 5, { near: rNear.overallPct, far: rFar.overallPct });
}

// 6. CAPTIONS DROPPED: present true→false must register.
{
  const out = makeDecode();
  out.captions.present = F(false);
  const r = compareDecodedStyle(makeDecode(), out);
  ok("captions dropped ⇒ ≤ 95%", r.overallPct <= 95, r.overallPct);
}

// 7. WEIGHTS: field weights must still ~sum to 1 (guards accidental re-weighting).
{
  const r = compareDecodedStyle(makeDecode(), makeDecode());
  const w = r.fields.reduce((s, f) => s + f.weight, 0);
  ok("weights sum ≈ 1", Math.abs(w - 1) < 0.02, w);
}

console.log(fails === 0 ? "\n✅ style-compare metric unit tests ALL PASS" : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
