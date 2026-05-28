/**
 * End-to-End Test for StyleClone v2.0
 *
 * Tests the full pipeline:
 * 1. Calls the demo API to get test data
 * 2. Calls the match API to generate a timeline
 * 3. Validates the timeline against the reference style profile
 * 4. Checks every detail: shapes, positions, layouts, transitions, color grade, continuity
 * 5. NEW: Validates B-roll position/size per layout, text overlays, B-roll temporal cutting
 */

const BASE_URL = "http://localhost:3000";

// Reference expectations from test-results.json
const REFERENCE = {
  segments: [
    {
      id: "seg_1", layout: "vertical_split",
      aroll: { position: [0, 200], size: [1080, 760], shape: "rectangle" },
      broll: { position: [0, 960], size: [1080, 960] },
      textOverlayCount: 2,
    },
    {
      id: "seg_2", layout: "pip_overlay",
      aroll: { position: [340, 100], size: [400, 400], shape: "circle" },
      broll: { position: [0, 0], size: [1080, 1920] },
      textOverlayCount: 3,
    },
    {
      id: "seg_3", layout: "pip_overlay",
      aroll: { position: [340, 100], size: [400, 400], shape: "circle" },
      broll: { position: [0, 0], size: [1080, 1920] },
      textOverlayCount: 1,
    },
    {
      id: "seg_4", layout: "pip_overlay",
      aroll: { position: [340, 100], size: [400, 400], shape: "circle" },
      broll: { position: [0, 0], size: [1080, 1920] },
      textOverlayCount: 0,
    },
    {
      id: "seg_5", layout: "pip_overlay",
      aroll: { position: [340, 100], size: [400, 400], shape: "circle" },
      broll: { position: [0, 0], size: [1080, 1920] },
      textOverlayCount: 0,
    },
    {
      id: "seg_6", layout: "pip_overlay",
      aroll: { position: [340, 100], size: [400, 400], shape: "circle" },
      broll: { position: [0, 0], size: [1080, 1920] },
      textOverlayCount: 0,
    },
  ],
  colorGrade: { temperature: "neutral", brightness: 0.7, saturation: 0.8 },
  cutStyle: "hard_cut",
  segmentCount: 6,
  duration: 24.9,
  fps: 30,
};

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ❌ ${message}`);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message} (expected: ${expected}, got: ${actual}, diff: ${diff})`);
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  StyleClone v2.0 — End-to-End Test");
  console.log("═══════════════════════════════════════════════════\n");

  // ─── Step 1: Load Demo Data ───────────────────────────────────
  console.log("Step 1: Loading demo data...");
  const demoRes = await fetch(`${BASE_URL}/api/demo`);
  assert(demoRes.ok, `Demo API returns 200 (got ${demoRes.status})`);
  const demoData = await demoRes.json();

  assert(!!demoData.styleProfile, "Demo returns styleProfile");
  assert(!!demoData.arollAnalysis, "Demo returns arollAnalysis");
  assert(!!demoData.brollCatalog, "Demo returns brollCatalog");
  assert(demoData.brollCatalog.length > 0, "Demo has B-roll catalog entries");

  const { styleProfile } = demoData;
  assert(styleProfile.segments.length === 6, `Style profile has 6 segments (got ${styleProfile.segments.length})`);
  assert(styleProfile.editing_rhythm.cut_style === "hard_cut", `Cut style is hard_cut (got ${styleProfile.editing_rhythm.cut_style})`);

  console.log("");

  // ─── Step 2: Build match request ──────────────────────────────
  console.log("Step 2: Generating edit via match API...");

  const arollClip = {
    fileId: "demo_aroll",
    fileName: "IMG_6108.MOV",
    analysis: demoData.arollAnalysis,
    order: 0,
  };

  // Apply post-processing (silence detection)
  if (arollClip.analysis.silence_segments && arollClip.analysis.silence_segments.length > 0) {
    const usable = [];
    let lastEnd = 0;
    for (const silence of arollClip.analysis.silence_segments) {
      if (silence.start > lastEnd + 0.5) {
        usable.push({ start: lastEnd, end: silence.start, duration: silence.start - lastEnd });
      }
      lastEnd = silence.end;
    }
    if (lastEnd < arollClip.analysis.duration - 0.5) {
      usable.push({ start: lastEnd, end: arollClip.analysis.duration, duration: arollClip.analysis.duration - lastEnd });
    }
    if (usable.length > 0) {
      arollClip.usableSegments = usable;
    }
  }

  const matchReq = {
    styleProfile,
    arollAnalyses: [arollClip],
    arollSequence: null,
    brollCatalog: demoData.brollCatalog,
  };

  const matchRes = await fetch(`${BASE_URL}/api/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(matchReq),
  });

  assert(matchRes.ok, `Match API returns 200 (got ${matchRes.status})`);
  const matchData = await matchRes.json();

  assert(!!matchData.timeline, "Match returns timeline");
  assert(!!matchData.verification, "Match returns verification data");

  console.log("");

  // ─── Step 3: Verify Verification Score ────────────────────────
  console.log("Step 3: Checking verification score...");
  const { verification, timeline } = matchData;

  assert(verification.score >= 95, `Verification score ≥ 95% (got ${verification.score}%)`);
  assert(verification.passed === true, `Verification passed threshold`);
  console.log(`  📊 Score: ${verification.score}/100, Iterations: ${verification.iterations}, Fixes: ${verification.fixesApplied?.length ?? 0}`);

  if (verification.dimensions) {
    console.log("  📊 Dimensions:");
    for (const dim of verification.dimensions) {
      const pct = ((dim.score / dim.max) * 100).toFixed(0);
      console.log(`     ${dim.name}: ${dim.score}/${dim.max} (${pct}%)`);
    }
  }
  console.log("");

  // ─── Step 4: Validate Segment Count ───────────────────────────
  console.log("Step 4: Validating segment structure...");
  assert(timeline.segments.length === REFERENCE.segmentCount,
    `Segment count matches reference (expected ${REFERENCE.segmentCount}, got ${timeline.segments.length})`);
  assert(timeline.fps === REFERENCE.fps, `FPS matches (expected ${REFERENCE.fps}, got ${timeline.fps})`);

  console.log("");

  // ─── Step 5: Validate Per-Segment Layout & Shape ──────────────
  console.log("Step 5: Validating per-segment layouts, shapes, and A-roll...");

  for (let i = 0; i < Math.min(timeline.segments.length, REFERENCE.segments.length); i++) {
    const seg = timeline.segments[i];
    const ref = REFERENCE.segments[i];

    console.log(`  Segment ${i} (${seg.id}):`);

    // Layout
    assert(seg.layout === ref.layout,
      `  seg[${i}] layout: expected "${ref.layout}", got "${seg.layout}"`);

    // A-roll shape
    if (ref.aroll && seg.aroll) {
      assert(seg.aroll.shape === ref.aroll.shape,
        `  seg[${i}] shape: expected "${ref.aroll.shape}", got "${seg.aroll.shape}"`);

      // A-roll position (allow some tolerance for auto-fix adjustments)
      assertApprox(seg.aroll.position[0], ref.aroll.position[0], 100,
        `  seg[${i}] position X`);
      assertApprox(seg.aroll.position[1], ref.aroll.position[1], 100,
        `  seg[${i}] position Y`);

      // A-roll size
      assertApprox(seg.aroll.size[0], ref.aroll.size[0], 100,
        `  seg[${i}] size W`);
      assertApprox(seg.aroll.size[1], ref.aroll.size[1], 100,
        `  seg[${i}] size H`);
    } else if (ref.aroll) {
      assert(false, `  seg[${i}] missing A-roll (expected ${ref.aroll.shape})`);
    }
  }
  console.log("");

  // ─── Step 5B: Validate Per-Segment B-Roll Position & Size ─────
  console.log("Step 5B: Validating B-roll position and size per layout...");

  for (let i = 0; i < Math.min(timeline.segments.length, REFERENCE.segments.length); i++) {
    const seg = timeline.segments[i];
    const ref = REFERENCE.segments[i];

    if (ref.broll && seg.broll) {
      const brollPos = seg.broll.position ?? [0, 0];
      const brollSize = seg.broll.size ?? [1080, 1920];

      // B-roll position
      assertApprox(brollPos[0], ref.broll.position[0], 50,
        `  seg[${i}] broll position X`);
      assertApprox(brollPos[1], ref.broll.position[1], 100,
        `  seg[${i}] broll position Y`);

      // B-roll size
      assertApprox(brollSize[0], ref.broll.size[0], 100,
        `  seg[${i}] broll size W`);
      assertApprox(brollSize[1], ref.broll.size[1], 200,
        `  seg[${i}] broll size H`);
    }
  }

  // Special check: vertical_split B-roll must NOT be full screen
  const firstSeg = timeline.segments[0];
  if (firstSeg.layout === "vertical_split") {
    const brollH = firstSeg.broll.size?.[1] ?? 1920;
    assert(brollH < 1920,
      `  vertical_split B-roll is NOT full height (got ${brollH}px, must be < 1920)`);
    const brollY = firstSeg.broll.position?.[1] ?? 0;
    assert(brollY > 0,
      `  vertical_split B-roll is positioned below A-roll (Y=${brollY})`);
  }
  console.log("");

  // ─── Step 5C: Validate Text Overlays ──────────────────────────
  console.log("Step 5C: Validating text overlays...");

  for (let i = 0; i < Math.min(timeline.segments.length, REFERENCE.segments.length); i++) {
    const seg = timeline.segments[i];
    const ref = REFERENCE.segments[i];

    if (ref.textOverlayCount > 0) {
      assert(seg.text_overlays.length >= ref.textOverlayCount,
        `  seg[${i}] has ${ref.textOverlayCount}+ text overlays (got ${seg.text_overlays.length})`);

      // Check that text overlays have valid content
      for (let j = 0; j < seg.text_overlays.length; j++) {
        const overlay = seg.text_overlays[j];
        assert(overlay.text && overlay.text.length > 0,
          `  seg[${i}] overlay[${j}] has text ("${overlay.text?.slice(0, 30)}")`);
        assert(overlay.position && overlay.position.length === 2,
          `  seg[${i}] overlay[${j}] has position [${overlay.position}]`);
      }
    }
  }

  // Specific check: segment 0 should have 2 title-style text overlays
  const seg0overlays = timeline.segments[0]?.text_overlays ?? [];
  assert(seg0overlays.length >= 2,
    `  Segment 0 has ≥ 2 text overlays for title card (got ${seg0overlays.length})`);
  console.log("");

  // ─── Step 6: Validate Segment Continuity (No Gaps) ────────────
  console.log("Step 6: Checking segment continuity (no black gaps)...");

  for (let i = 1; i < timeline.segments.length; i++) {
    const prev = timeline.segments[i - 1];
    const curr = timeline.segments[i];
    const gap = curr.start_frame - prev.end_frame;

    assert(Math.abs(gap) <= 1,
      `  No gap between seg[${i-1}] and seg[${i}] (gap: ${gap} frames)`);
  }

  // Check first segment starts at 0
  assert(timeline.segments[0].start_frame === 0,
    `  First segment starts at frame 0 (got ${timeline.segments[0].start_frame})`);

  // Check A-roll source is consistent (ONE continuous video)
  const arollSrcs = [...new Set(timeline.segments.filter(s => s.aroll?.src).map(s => s.aroll.src))];
  assert(arollSrcs.length <= 1,
    `  Single A-roll source (got ${arollSrcs.length}: ${arollSrcs.join(", ")})`);

  // Check B-roll source exists for all segments
  const brollSrcs = timeline.segments.filter(s => s.broll?.src);
  assert(brollSrcs.length === timeline.segments.length,
    `  All segments have B-roll (${brollSrcs.length}/${timeline.segments.length})`);

  console.log("");

  // ─── Step 6B: Validate B-Roll Temporal Cutting (No Repetition) ─
  console.log("Step 6B: Checking B-roll temporal cutting (no repetition)...");

  const brollStartTimes = timeline.segments
    .filter(s => s.broll?.startFrom !== undefined && s.broll?.startFrom !== null)
    .map((s, i) => ({ index: i, startFrom: s.broll.startFrom }));

  console.log(`  ℹ B-roll startFrom values: [${brollStartTimes.map(b => b.startFrom.toFixed(1)).join(", ")}]`);

  // Check that startFrom values are all different (no repetition)
  const uniqueStartTimes = new Set(brollStartTimes.map(b => Math.round(b.startFrom * 10) / 10));
  assert(uniqueStartTimes.size === brollStartTimes.length,
    `  All B-roll startFrom values are unique (${uniqueStartTimes.size}/${brollStartTimes.length})`);

  // Check that startFrom values generally increase (showing sequential steps)
  let isMonotonic = true;
  for (let i = 1; i < brollStartTimes.length; i++) {
    if (brollStartTimes[i].startFrom < brollStartTimes[i - 1].startFrom - 0.5) {
      isMonotonic = false;
      break;
    }
  }
  assert(isMonotonic,
    `  B-roll startFrom times increase monotonically (sequential steps)`);

  // Check minimum spacing between B-roll start times (at least 1s apart)
  let minSpacing = Infinity;
  for (let i = 1; i < brollStartTimes.length; i++) {
    const spacing = Math.abs(brollStartTimes[i].startFrom - brollStartTimes[i - 1].startFrom);
    minSpacing = Math.min(minSpacing, spacing);
  }
  if (brollStartTimes.length > 1) {
    assert(minSpacing >= 1.0,
      `  B-roll segments are ≥ 1s apart (min spacing: ${minSpacing.toFixed(1)}s)`);
  }
  console.log("");

  // ─── Step 6C: Validate B-Roll Scroll/Motion ───────────────────
  console.log("Step 6C: Checking B-roll scroll/motion...");

  // Vertical split segment should have scroll data
  if (timeline.segments[0].layout === "vertical_split") {
    const seg0scroll = timeline.segments[0].broll.scroll;
    assert(!!seg0scroll,
      `  vertical_split seg[0] has scroll data`);
    if (seg0scroll) {
      assert(seg0scroll.speed > 0,
        `  seg[0] scroll speed > 0 (got ${seg0scroll.speed})`);
      assert(seg0scroll.maxOffset > 0,
        `  seg[0] scroll maxOffset > 0 (got ${seg0scroll.maxOffset})`);
    }
  }

  // Check that most segments have either scroll or motion (not static)
  const hasMotionOrScroll = timeline.segments.filter(
    s => s.broll?.scroll || s.broll?.motion
  ).length;
  console.log(`  ℹ Segments with motion/scroll: ${hasMotionOrScroll}/${timeline.segments.length}`);
  assert(hasMotionOrScroll >= Math.ceil(timeline.segments.length * 0.5),
    `  At least 50% of segments have B-roll motion (${hasMotionOrScroll}/${timeline.segments.length})`);
  console.log("");

  // ─── Step 7: Validate Transitions (Hard Cut) ──────────────────
  console.log("Step 7: Checking transitions match reference (hard_cut)...");

  const nonCutTransitions = timeline.segments.filter(s =>
    s.transition_in &&
    s.transition_in.type !== "none" &&
    s.transition_in.type !== "cut"
  );

  assert(nonCutTransitions.length === 0,
    `  No non-cut transitions (found ${nonCutTransitions.length})`);

  if (nonCutTransitions.length > 0) {
    for (const s of nonCutTransitions) {
      console.log(`     ⚠ seg ${s.id}: transition_in.type = "${s.transition_in.type}"`);
    }
  }
  console.log("");

  // ─── Step 8: Validate Color Grade ─────────────────────────────
  console.log("Step 8: Checking color grade...");

  assert(timeline.color_grade.temperature === REFERENCE.colorGrade.temperature,
    `  Temperature: expected "${REFERENCE.colorGrade.temperature}", got "${timeline.color_grade.temperature}"`);
  assertApprox(timeline.color_grade.brightness, REFERENCE.colorGrade.brightness, 0.2,
    `  Brightness`);
  assertApprox(timeline.color_grade.saturation, REFERENCE.colorGrade.saturation, 0.2,
    `  Saturation`);

  console.log("");

  // ─── Step 9: Validate Captions ────────────────────────────────
  console.log("Step 9: Checking captions...");

  assert(timeline.captions.lines.length > 0,
    `  Has caption lines (${timeline.captions.lines.length})`);

  // Check caption timing covers most of the video
  if (timeline.captions.lines.length > 0) {
    const firstCaptionStart = timeline.captions.lines[0].start_frame;
    const lastCaptionEnd = timeline.captions.lines[timeline.captions.lines.length - 1].end_frame;
    const captionCoverage = (lastCaptionEnd - firstCaptionStart) / (timeline.fps * timeline.duration);

    assert(captionCoverage > 0.5,
      `  Caption coverage > 50% of video (${(captionCoverage * 100).toFixed(0)}%)`);

    // Check for word-level timing
    const linesWithWords = timeline.captions.lines.filter(l => l.words && l.words.length > 0);
    assert(linesWithWords.length > 0,
      `  Has word-level timing (${linesWithWords.length}/${timeline.captions.lines.length} lines)`);
  }
  console.log("");

  // ─── Step 10: Validate Audio Continuity ───────────────────────
  console.log("Step 10: Checking audio continuity...");

  // Audio comes from the A-roll video (OffthreadVideo, not muted).
  // Verify: single continuous A-roll src exists across all segments.
  const arollSrc = timeline.segments.find(s => s.aroll?.src)?.aroll?.src;
  assert(!!arollSrc, `  A-roll video source exists (${arollSrc ?? "MISSING"})`);

  // Verify all segments with aroll reference the same source (continuous playback)
  const allArollSrcs = timeline.segments
    .filter(s => s.aroll?.src)
    .map(s => s.aroll.src);
  const uniqueArollSrcs = [...new Set(allArollSrcs)];
  assert(uniqueArollSrcs.length === 1,
    `  Single A-roll audio source (${uniqueArollSrcs.length} unique)`);

  // The audio array may contain tracks OR be empty (composition uses OffthreadVideo for audio)
  const audioTracks = timeline.audio?.filter(t => t.type === "aroll_voice") ?? [];
  console.log(`  ℹ Audio tracks in timeline.audio: ${audioTracks.length} (audio comes from A-roll video, not separate tracks)`);

  console.log("");

  // ─── Step 11: Validate Render Descriptions ────────────────────
  console.log("Step 11: Checking render descriptions...");

  assert(!!matchData.renderDescriptions, "Has render descriptions");
  if (matchData.renderDescriptions) {
    assert(matchData.renderDescriptions.length === timeline.segments.length,
      `  One render description per segment (${matchData.renderDescriptions.length}/${timeline.segments.length})`);
  }
  console.log("");

  // ─── Results ──────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════");

  if (failed > 0) {
    console.log("\n  ❌ FAILURES:");
    for (const f of failures) {
      console.log(`     - ${f}`);
    }
  } else {
    console.log("\n  🎉 ALL TESTS PASSED!");
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});
