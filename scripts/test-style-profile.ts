/**
 * B1 adapter test — run with: npx tsx scripts/test-style-profile.ts
 * Verifies both legacy schemas adapt into a valid StyleProfile 2.0,
 * and that the output is content-free (no caption/transcript text leaks).
 */
import { fromVisualBlueprint, fromLegacyStyleProfile } from "../src/lib/style-profile/adapters";
import { StyleProfileSchema } from "../src/lib/style-profile/style-profile";

// ── sample VisualBlueprint (pipeline A) ──
const bp: any = {
  canvas: { width: 1080, height: 1920 },
  reference: {
    duration: 30,
    fps: 30,
    segments: [
      {
        id: "s1", start: 0, end: 5, layout: "full_screen",
        aroll: { boundingBox: { x: 0, y: 0, width: 1080, height: 1920 }, shape: "rectangle", hasBorder: false, isCropped: false },
        broll: { boundingBox: { x: 0, y: 0, width: 1080, height: 1920 }, contentType: "video", isCropped: false, hasScrollMotion: false },
        texts: [{ text: "HELLO WORLD", boundingBox: { x: 200, y: 1500, width: 680, height: 80 }, isHeadline: true, estimatedFontSize: 60, color: "#FFFFFF", backgroundColor: "#000000", fontWeight: "bold" }],
        blackRegions: [],
      },
      {
        id: "s2", start: 5, end: 30, layout: "pip_overlay",
        aroll: { boundingBox: { x: 740, y: 60, width: 280, height: 280 }, shape: "circle", hasBorder: true, borderColor: "#FFFFFF", borderWidth: 4, isCropped: true },
        broll: { boundingBox: { x: 0, y: 0, width: 1080, height: 1920 }, contentType: "screen_recording", isCropped: false, hasScrollMotion: true },
        texts: [], blackRegions: [],
      },
    ],
    transcription: { full_text: "hello", language: "en", words: [], sentences: [] },
    syncMap: [], styleFingerprint: {},
  },
  aroll: { videoPath: "", duration: 30, resolution: { width: 1080, height: 1920 }, transcription: { full_text: "", language: "en", words: [], sentences: [] }, faceFrames: [], recommendedCrop: { circle: { centerX: 0, centerY: 0, radius: 0 }, rectangle: { x: 0, y: 0, width: 0, height: 0 } }, silenceRegions: [], editPoints: [], speechRatio: 1 },
  broll: [],
  confidence: { segmentBoundaries: 0.9, coordinates: 0.9, transcription: 0.9, overall: 0.9 },
  conflicts: [],
};

// ── sample legacy StyleProfile (pipeline B) ──
const legacy: any = {
  version: "1.0",
  source: { duration: 30, fps: 30, resolution: "1080x1920" },
  segments: [
    {
      id: "s1", start: 0, end: 6, layout: "pip_overlay",
      aroll: { position: [740, 60], size: [280, 280], shape: "circle", border: { color: "#FFFFFF", width: 4 }, animation: null },
      broll: { position: [0, 0], size: [1080, 1920], crop: null, scroll: null },
      text_overlays: [{ text: "Build faster", position: [540, 1500], style: { fontSize: 56, fontWeight: "bold", color: "#FFD700", backgroundColor: "#000000", padding: 12, borderRadius: 8 }, animation: { type: "pop" } }],
      other_elements: [{ type: "cta", position: [540, 1700], size: [400, 80], style: {} }],
      transition_in: "fade", transition_out: "cut", description: "ZZ_CONTENT_MARKER_ZZ",
    },
  ],
  color_grade: { brightness: 1.05, saturation: 1.1, contrast: 1.02, temperature: "warm" },
  pip_style: { shape: "circle", typical_size: 280, border: { color: "#FFFFFF", width: 4 } },
  editing_rhythm: { avg_segment_duration: 3, total_segments: 1, cut_style: "hard_cut", pacing: "fast" },
};

let allOk = true;
function check(name: string, fn: () => unknown, forbidden: string[]) {
  try {
    const out = fn();
    const res = StyleProfileSchema.safeParse(out);
    if (!res.success) {
      allOk = false;
      console.error(`FAIL ${name}: schema invalid →`, JSON.stringify(res.error.issues.slice(0, 6), null, 2));
      return;
    }
    const json = JSON.stringify(out);
    const leaks = forbidden.filter((w) => json.includes(w));
    if (leaks.length) {
      allOk = false;
      console.error(`FAIL ${name}: content leaked into style profile → ${leaks.join(", ")}`);
      return;
    }
    const p = res.data;
    console.log(`PASS ${name}: valid 2.0 · patterns=${p.layout.patterns.length} · captions.present=${p.captions.present} · temp=${p.color.temperature} · transitions=[${p.transitions.dominant.join(",")}] · content-free ✓`);
  } catch (e) {
    allOk = false;
    console.error(`THROW ${name}:`, (e as Error).message);
  }
}

console.log("\nB1 StyleProfile adapter test\n");
check("fromVisualBlueprint", () => fromVisualBlueprint(bp), ["HELLO WORLD", "hello"]);
check("fromLegacyStyleProfile", () => fromLegacyStyleProfile(legacy), ["Build faster", "ZZ_CONTENT_MARKER_ZZ"]);
console.log(`\n${allOk ? "ALL PASS ✓" : "FAILURES ✗"}\n`);
process.exit(allOk ? 0 : 1);
