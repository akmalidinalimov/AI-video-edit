/**
 * test-window-decode.ts — unit tests for the WINDOWED decode view (scene-KB build).
 * Pure + zero-cost: synthetic decodes, no video/Gemini/render.
 */
import { windowDecode, compareWindowedStyle } from "../src/lib/analysis/window-decode";
import { compareDecodedStyle } from "../src/lib/analysis/style-compare";
import type { ReferenceDecode, DecodedField, DecodedRegion } from "../src/lib/analysis/reference-decode";

const F = <T>(value: T): DecodedField<T> => ({ value, source: "cv", confidence: 0.9, method: "test" });

/** Minimal valid decode mirroring R1's real shape (same pattern as test-style-compare.ts). */
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
        {
          id: "broll_0", role: "broll", rect: { x: 0, y: 0, w: 1, h: 0.561 }, shape: "rectangle",
          zIndex: 0, persistent: false,
          contentTimeline: [
            { start: 0, end: 10, content: "broll" },
            { start: 10, end: 20, content: "screen_recording" },
            { start: 20, end: 27, content: "diagram_graphic" },
          ],
        },
        { id: "aroll_1", role: "aroll", rect: { x: 0, y: 0.561, w: 1, h: 0.439 }, shape: "rectangle", zIndex: 0, persistent: true },
      ]),
    },
    pacing: {
      shotCount: F(26), avgShotSec: F(1.04), cutFrequency: F("fast"),
      shotBoundaries: F(Array.from({ length: 25 }, (_, i) => (i + 1) * 1.04)),
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

// 1. WINDOW META: duration becomes the window length; boundaries are filtered + rebased.
{
  const w = windowDecode(makeDecode(), 5, 15);
  ok("window duration = 10", Math.abs(w.meta.duration.value - 10) < 1e-6, w.meta.duration.value);
  ok("shotBoundaries all inside (0, 10)", w.pacing.shotBoundaries.value.every((t) => t > 0 && t < 10), w.pacing.shotBoundaries.value);
  ok("shotBoundaries rebased (first ≈ 5.2 - 5 = 0.2)", Math.abs(w.pacing.shotBoundaries.value[0] - 0.2) < 0.02, w.pacing.shotBoundaries.value[0]);
  ok("shotCount = boundaries + 1", w.pacing.shotCount.value === w.pacing.shotBoundaries.value.length + 1, w.pacing.shotCount.value);
  ok("avgShotSec = dur / shotCount", Math.abs(w.pacing.avgShotSec.value - 10 / w.pacing.shotCount.value) < 0.01, w.pacing.avgShotSec.value);
}

// 2. CONTENT TIMELINE: cropped to the window and rebased to window time.
{
  const w = windowDecode(makeDecode(), 5, 15);
  const broll = w.layout.regions.value.find((r) => r.role === "broll")!;
  ok("timeline has 2 windows (0-5 broll, 5-10 screen_recording)",
    broll.contentTimeline?.length === 2 &&
    broll.contentTimeline[0].start === 0 && Math.abs(broll.contentTimeline[0].end - 5) < 1e-6 &&
    broll.contentTimeline[1].content === "screen_recording" && Math.abs(broll.contentTimeline[1].end - 10) < 1e-6,
    broll.contentTimeline);
}

// 3. PURITY: the input decode is NOT mutated.
{
  const d = makeDecode();
  windowDecode(d, 5, 15);
  ok("input decode untouched (duration)", d.meta.duration.value === 27, d.meta.duration.value);
  ok("input decode untouched (boundaries count)", d.pacing.shotBoundaries.value.length === 25);
  ok("input decode untouched (timeline)", d.layout.regions.value[0].contentTimeline?.length === 3);
}

// 4. FULL WINDOW ≈ IDENTITY on the closed-loop metric.
{
  const r = compareWindowedStyle(makeDecode(), makeDecode(), 0, 27);
  ok("full-window self-compare ≥ 99%", r.overallPct >= 99, r.overallPct);
}

// 5. WINDOW ISOLATION: a drift OUTSIDE the window must not change the window's score.
{
  const ref = makeDecode();
  const drifted = makeDecode();
  // add 8 extra shot boundaries AFTER t=20 (outside the [5,15] window) → pacing drift outside only
  drifted.pacing.shotBoundaries = F([...drifted.pacing.shotBoundaries.value, 20.5, 21, 21.5, 22, 22.5, 23, 23.5, 24]);
  drifted.pacing.shotCount = F(34);
  const clean = compareWindowedStyle(ref, makeDecode(), 5, 15).overallPct;
  const withDrift = compareWindowedStyle(ref, drifted, 5, 15).overallPct;
  ok("outside-window drift does NOT change the window score", Math.abs(clean - withDrift) < 1e-6, { clean, withDrift });
  // sanity: the SAME drift inside a window that contains it DOES register
  const covering = compareWindowedStyle(ref, drifted, 15, 27).overallPct;
  ok("the drift DOES register in the window that contains it", covering < 99, covering);
}

// 6. Windowed compare === compareDecodedStyle over windowDecode views (no metric fork).
{
  const a = makeDecode(), b = makeDecode();
  b.motion.dominant = F("static");
  const direct = compareDecodedStyle(windowDecode(a, 5, 15), windowDecode(b, 5, 15)).overallPct;
  const wrapped = compareWindowedStyle(a, b, 5, 15).overallPct;
  ok("compareWindowedStyle is exactly compare(window,window)", direct === wrapped, { direct, wrapped });
}

console.log(fails === 0 ? "\n✅ window-decode unit tests ALL PASS" : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
