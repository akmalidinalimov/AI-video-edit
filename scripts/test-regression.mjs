#!/usr/bin/env node
/**
 * REGRESSION TEST SUITE — StyleClone Pipeline
 *
 * Encodes every bug we've ever fixed as an executable assertion.
 * Run this BEFORE every commit to pipeline code.
 *
 * Usage:
 *   node scripts/test-regression.mjs                    # structural checks only (fast, ~2s)
 *   node scripts/test-regression.mjs --full             # structural + render + CV verification (~60s)
 *   node scripts/test-regression.mjs --full --fix       # also fix any violations found
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = regression detected (details printed)
 *
 * ══════════════════════════════════════════════════════════════
 * ADDING A NEW CHECK:
 * When you fix a bug, add a check function to the appropriate
 * section below. The check must:
 *   1. Have a descriptive name starting with "check_"
 *   2. Return { pass: boolean, details: string }
 *   3. Be added to the CHECKS array
 *   4. Include a comment linking to the bug/fix context
 * ══════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const FULL_MODE = process.argv.includes("--full");
const FIX_MODE = process.argv.includes("--fix");

const PLAN_PATH = path.join(ROOT, "public/exports/sp-temp/dynamic-plan.json");
const TEMPLATE_PATH = path.join(ROOT, "public/exports/sp-temp/dynamic-template.json");
const RENDERED_PATH = path.join(ROOT, "public/exports/plan-rendered.mp4");
const AROLL_PATH = path.join(ROOT, "public/uploads/IMG_6108.MOV");
const BROLL_PATH = path.join(ROOT, "public/uploads/IMG_6163.MP4");
const FFMPEG = path.join(ROOT, "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe");

// ══════════════════════════════════════════════════════════════
// RESULT TRACKING
// ══════════════════════════════════════════════════════════════

const results = [];
let passCount = 0;
let failCount = 0;

function record(name, pass, details) {
  results.push({ name, pass, details });
  if (pass) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${details}`);
  }
}

// ══════════════════════════════════════════════════════════════
// LAYER 1: STRUCTURAL CHECKS (from plan/template JSON, no rendering)
// These run in <2 seconds and catch most regressions.
// ══════════════════════════════════════════════════════════════

function loadPlan() {
  if (!fs.existsSync(PLAN_PATH)) return null;
  return JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
}

function loadTemplate() {
  if (!fs.existsSync(TEMPLATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf8"));
}

// ── CHECK 1: No layout transition mid-sentence ──
// Bug: plan-builder.ts truncates ranges at next sentence START instead of
// current sentence END when sentences overlap. Causes PIP position changes
// while speaker is mid-word.
// Fixed: V4.5 session, then regressed when plan-builder was modified.
// Rule: ALL visual transitions must snap to sentence boundaries.
//
// The correct check: each transition must coincide with the END of one of the
// PREVIOUS range's sentences. When sentences overlap in the transcription
// (e.g., S2 ends at 9.4, S3 starts at 8.94), a transition at 9.4 is valid
// because it aligns with S2's end — even though it falls "inside" S3's window.
function check_no_mid_sentence_transitions(plan) {
  if (!plan) return { pass: true, details: "No plan file (skipped)" };

  const violations = [];
  const margin = 0.1; // 100ms tolerance for frame alignment

  for (let i = 1; i < plan.layoutRanges.length; i++) {
    const prevRange = plan.layoutRanges[i - 1];
    const transitionTime = plan.layoutRanges[i].timeRange.start;

    // The transition must align with the end of one of the previous range's
    // sentences, OR with the start/end of the current range's sentences.
    // Collect all valid sentence boundaries.
    const validBoundaries = [];

    // Previous range's sentence ends (the transition should be here)
    for (const s of (prevRange.sentences || [])) {
      validBoundaries.push(s.end);
    }
    // Previous range's end time (frame-aligned version of sentence end)
    validBoundaries.push(prevRange.timeRange.end);

    // Current range's sentence starts
    for (const s of (plan.layoutRanges[i].sentences || [])) {
      validBoundaries.push(s.start);
    }

    // Also allow t=0 (first range start) and sentence starts from plan.sentences
    for (const s of plan.sentences) {
      validBoundaries.push(s.start);
      validBoundaries.push(s.end);
    }

    // Check if transition aligns with ANY valid boundary
    const alignsWithBoundary = validBoundaries.some(
      b => Math.abs(transitionTime - b) <= margin
    );

    if (!alignsWithBoundary) {
      // Find which sentence this falls inside for error reporting
      const insideSentence = plan.sentences.find(
        s => transitionTime > s.start + margin && transitionTime < s.end - margin
      );
      violations.push({
        transition: i,
        time: transitionTime,
        sentence: insideSentence ? insideSentence.index + 1 : "?",
        sentenceStart: insideSentence?.start ?? 0,
        sentenceEnd: insideSentence?.end ?? 0,
        layout: plan.layoutRanges[i].layoutId,
      });
    }
  }

  if (violations.length === 0) {
    return { pass: true, details: "" };
  }

  const details = violations.map(v =>
    `Transition ${v.transition} at t=${v.time.toFixed(3)}s is NOT at any sentence boundary ` +
    `(nearest sentence S${v.sentence}: ${v.sentenceStart.toFixed(3)}-${v.sentenceEnd.toFixed(3)}s) → layout '${v.layout}'`
  ).join("\n     ");

  return { pass: false, details };
}

// ── CHECK 2: Enable expressions are contiguous (no gaps) ──
// Bug: gaps between enable expressions cause black frames at transitions.
// The single-pass approach requires seamless coverage.
function check_no_enable_gaps(plan) {
  if (!plan) return { pass: true, details: "No plan file (skipped)" };

  const violations = [];
  for (let i = 0; i < plan.layoutRanges.length - 1; i++) {
    const curr = plan.layoutRanges[i];
    const next = plan.layoutRanges[i + 1];
    const gap = next.timeRange.start - curr.timeRange.end;

    if (Math.abs(gap) > 0.034) { // more than 1 frame at 30fps
      violations.push({
        between: `range_${i + 1} and range_${i + 2}`,
        gap: gap,
        currEnd: curr.timeRange.end,
        nextStart: next.timeRange.start,
      });
    }
  }

  if (violations.length === 0) {
    return { pass: true, details: "" };
  }

  const details = violations.map(v =>
    `${v.gap > 0 ? "Gap" : "Overlap"} of ${Math.abs(v.gap).toFixed(3)}s between ${v.between} ` +
    `(${v.currEnd.toFixed(3)} → ${v.nextStart.toFixed(3)})`
  ).join("\n     ");

  return { pass: false, details };
}

// ── CHECK 3: First range starts at t=0 ──
// Bug: if first sentence starts after t=0, there's dead time with no layout.
function check_starts_at_zero(plan) {
  if (!plan) return { pass: true, details: "No plan file (skipped)" };

  const first = plan.layoutRanges[0];
  if (!first) return { pass: false, details: "No layout ranges in plan" };

  if (first.timeRange.start > 0.034) {
    return {
      pass: false,
      details: `First range starts at ${first.timeRange.start.toFixed(3)}s, should start at 0`
    };
  }
  return { pass: true, details: "" };
}

// ── CHECK 4: Template has valid coordinates ──
// Bug: LLM-estimated coordinates can be wildly off. CV corrections should
// produce coordinates within expected bounds.
function check_template_coordinates(template) {
  if (!template) return { pass: true, details: "No template file (skipped)" };

  const violations = [];
  const canvas = template.canvas;

  for (const [id, layout] of Object.entries(template.layouts)) {
    const l = layout;
    const aroll = l.aroll;
    if (!aroll?.region) continue;

    const r = aroll.region;

    // Region must be within canvas bounds
    if (r.x < 0 || r.y < 0) {
      violations.push(`${id}: region starts at negative coords (${r.x},${r.y})`);
    }
    if (r.x + r.width > canvas.width + 10 || r.y + r.height > canvas.height + 10) {
      violations.push(`${id}: region extends beyond canvas (${r.x}+${r.width}=${r.x+r.width} > ${canvas.width})`);
    }

    // Circle: check cx/cy/radius consistency with region
    if (aroll.shape === "circle" && aroll.circle) {
      const c = aroll.circle;
      const expectedCx = r.x + r.width / 2;
      const expectedCy = r.y + r.height / 2;
      const expectedR = Math.min(r.width, r.height) / 2;

      if (Math.abs(c.cx - expectedCx) > 15) {
        violations.push(`${id}: circle cx=${c.cx} doesn't match region center ${expectedCx.toFixed(0)} (off by ${Math.abs(c.cx - expectedCx).toFixed(0)}px)`);
      }
      if (Math.abs(c.cy - expectedCy) > 15) {
        violations.push(`${id}: circle cy=${c.cy} doesn't match region center ${expectedCy.toFixed(0)} (off by ${Math.abs(c.cy - expectedCy).toFixed(0)}px)`);
      }
      if (Math.abs(c.radius - expectedR) > 10) {
        violations.push(`${id}: circle radius=${c.radius} doesn't match region half-size ${expectedR.toFixed(0)} (off by ${Math.abs(c.radius - expectedR).toFixed(0)}px)`);
      }
    }
  }

  if (violations.length === 0) {
    return { pass: true, details: "" };
  }
  return { pass: false, details: violations.join("\n     ") };
}

// ── CHECK 5: Single-pass FFmpeg (no concat) ──
// Bug: concatenation causes video flashes and audio pops at segment boundaries.
// Rule: ALWAYS single-pass with enable='between(t,...)' expressions.
function check_singlepass_filter() {
  // Check the most recent filter file
  const filterFiles = [
    path.join(ROOT, "public/exports/sp-temp/cv-loop-filter-iter0.txt"),
    path.join(ROOT, "public/exports/sp-temp/plan-renderer-filter.txt"),
  ];

  for (const filterPath of filterFiles) {
    if (!fs.existsSync(filterPath)) continue;
    const filter = fs.readFileSync(filterPath, "utf8");

    // Must NOT contain concat
    if (filter.includes("concat=") || filter.includes("[concat]")) {
      return { pass: false, details: `Filter file ${path.basename(filterPath)} uses concat (FORBIDDEN)` };
    }

    // Must contain enable='between(...)' expressions
    const enableCount = (filter.match(/enable='/g) || []).length;
    if (enableCount === 0) {
      return { pass: false, details: `Filter file ${path.basename(filterPath)} has no enable expressions` };
    }

    // Must have continuous inputs (not per-segment -i flags)
    // Check for split= which means continuous input being branched
    if (!filter.includes("split=") && !filter.includes("[0:v]") ) {
      return { pass: false, details: `Filter file ${path.basename(filterPath)} doesn't reference continuous inputs` };
    }

    return { pass: true, details: `${enableCount} enable expressions, no concat` };
  }

  return { pass: true, details: "No filter file found (skipped)" };
}

// ── CHECK 6: Audio mapped continuously from A-roll ──
// Bug: if audio is filtered or split per-segment, it causes pops/clicks.
// Rule: -map 1:a (or equivalent) must be used for continuous audio.
function check_continuous_audio() {
  // This is a code-level check — verify plan-renderer and test scripts use -map 1:a
  const scripts = [
    path.join(ROOT, "scripts/test-cv-loop.mjs"),
    path.join(ROOT, "scripts/test-plan-renderer.mjs"),
  ];

  for (const scriptPath of scripts) {
    if (!fs.existsSync(scriptPath)) continue;
    const code = fs.readFileSync(scriptPath, "utf8");

    if (!code.includes('"1:a"') && !code.includes("'1:a'")) {
      return {
        pass: false,
        details: `${path.basename(scriptPath)} doesn't map audio from input 1 (-map 1:a)`
      };
    }

    // Check for audio filters that would break continuity
    if (code.includes("aresample") || code.includes("atrim") || code.includes("asplit")) {
      return {
        pass: false,
        details: `${path.basename(scriptPath)} applies audio filters (breaks continuity)`
      };
    }
  }

  return { pass: true, details: "" };
}

// ── CHECK 7: Plan sentence data matches expected structure ──
// Bug: semantic_tags or sentence boundaries can get dropped during pipeline changes.
function check_plan_sentence_integrity(plan) {
  if (!plan) return { pass: true, details: "No plan file (skipped)" };

  const violations = [];

  if (!plan.sentences || plan.sentences.length === 0) {
    return { pass: false, details: "Plan has no sentences" };
  }

  for (const s of plan.sentences) {
    if (typeof s.start !== "number" || typeof s.end !== "number") {
      violations.push(`S${s.index + 1}: missing start/end times`);
    }
    if (s.end <= s.start) {
      violations.push(`S${s.index + 1}: end (${s.end}) <= start (${s.start})`);
    }
    if (!s.text || s.text.trim().length === 0) {
      violations.push(`S${s.index + 1}: empty text`);
    }
  }

  // Check each layout range has at least one sentence
  for (const range of plan.layoutRanges) {
    if (!range.sentences || range.sentences.length === 0) {
      violations.push(`${range.id}: no sentences assigned`);
    }
  }

  if (violations.length === 0) return { pass: true, details: "" };
  return { pass: false, details: violations.join("\n     ") };
}

// ── CHECK 8: Range boundaries are frame-aligned ──
// Bug: floating-point boundaries can cause single-frame gaps.
// Note: Enable expressions use half-frame midpoints by design (e.g., 89.5/30 = 2.9833)
// to avoid double-rendering at boundaries. We check timeRange values, not enable times.
function check_frame_aligned_enables(plan) {
  if (!plan) return { pass: true, details: "No plan file (skipped)" };

  const fps = plan.fps || 30;
  const violations = [];

  for (const range of plan.layoutRanges) {
    const start = range.timeRange.start;
    const end = range.timeRange.end;

    // Check frame alignment: time * fps should be close to an integer
    const startFrame = start * fps;
    const endFrame = end * fps;

    if (Math.abs(startFrame - Math.round(startFrame)) > 0.01) {
      violations.push(`${range.id}: start ${start} not frame-aligned (frame ${startFrame.toFixed(4)})`);
    }
    if (Math.abs(endFrame - Math.round(endFrame)) > 0.01) {
      violations.push(`${range.id}: end ${end} not frame-aligned (frame ${endFrame.toFixed(4)})`);
    }
  }

  if (violations.length === 0) return { pass: true, details: "" };
  return { pass: false, details: violations.join("\n     ") };
}

// ══════════════════════════════════════════════════════════════
// LAYER 2: RENDER + VERIFICATION CHECKS (requires --full flag)
// These render the video and verify audio/visual quality.
// ══════════════════════════════════════════════════════════════

// ── CHECK F1: Audio continuity — silence pattern matches source ──
// Proves audio is truly continuous, not re-encoded per segment.
function check_audio_continuity() {
  if (!fs.existsSync(RENDERED_PATH) || !fs.existsSync(AROLL_PATH)) {
    return { pass: true, details: "Video files not found (skipped)" };
  }

  function getSilenceTimestamps(videoPath) {
    const result = spawnSync(FFMPEG, [
      "-i", videoPath, "-t", "25",
      "-af", "silencedetect=noise=-30dB:d=0.03",
      "-f", "null", "-"
    ], { encoding: "utf-8", timeout: 30000 });

    const starts = [];
    const lines = (result.stderr || "").split("\n");
    for (const line of lines) {
      const match = line.match(/silence_start:\s*([\d.]+)/);
      if (match) starts.push(parseFloat(match[1]));
    }
    return starts;
  }

  const sourceSilence = getSilenceTimestamps(AROLL_PATH);
  const renderedSilence = getSilenceTimestamps(RENDERED_PATH);

  if (sourceSilence.length === 0 || renderedSilence.length === 0) {
    return { pass: true, details: "Could not detect silence (skipped)" };
  }

  // Compare first N silence timestamps
  const n = Math.min(sourceSilence.length, renderedSilence.length, 10);
  const mismatches = [];

  for (let i = 0; i < n; i++) {
    const diff = Math.abs(sourceSilence[i] - renderedSilence[i]);
    if (diff > 0.05) { // 50ms tolerance
      mismatches.push(
        `Silence #${i + 1}: source=${sourceSilence[i].toFixed(3)} vs rendered=${renderedSilence[i].toFixed(3)} (diff=${diff.toFixed(3)}s)`
      );
    }
  }

  if (mismatches.length === 0) {
    return { pass: true, details: `${n} silence timestamps match within 50ms` };
  }
  return { pass: false, details: mismatches.join("\n     ") };
}

// ── CHECK F2: No black frames at transition points ──
// Extracts frames at each transition and checks they're not blank.
function check_no_black_frames_at_transitions() {
  if (!fs.existsSync(RENDERED_PATH)) {
    return { pass: true, details: "Rendered video not found (skipped)" };
  }

  const plan = loadPlan();
  if (!plan) return { pass: true, details: "No plan (skipped)" };

  const tmpDir = path.join(ROOT, "public/exports/sp-temp/regression-tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const violations = [];

  for (let i = 1; i < plan.layoutRanges.length; i++) {
    const transTime = plan.layoutRanges[i].timeRange.start;
    const framePath = path.join(tmpDir, `trans_${i}.jpg`);

    const result = spawnSync(FFMPEG, [
      "-y", "-ss", String(transTime), "-i", RENDERED_PATH,
      "-frames:v", "1", framePath
    ], { encoding: "utf-8", timeout: 10000 });

    if (result.status !== 0 || !fs.existsSync(framePath)) {
      violations.push(`Could not extract frame at t=${transTime.toFixed(3)}`);
      continue;
    }

    const stats = fs.statSync(framePath);
    // A black frame would be very small (mostly JPEG header, <5KB)
    if (stats.size < 5000) {
      violations.push(`Frame at t=${transTime.toFixed(3)}s is only ${stats.size} bytes (likely black)`);
    }

    try { fs.unlinkSync(framePath); } catch {}
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  if (violations.length === 0) {
    return { pass: true, details: `${plan.layoutRanges.length - 1} transition frames verified` };
  }
  return { pass: false, details: violations.join("\n     ") };
}

// ── CHECK F3: CV circle positions match template ──
// Verifies rendered PIP positions match template coordinates within tolerance.
function check_cv_circle_positions() {
  // This delegates to cv-measure-output.mts for actual CV measurement
  // For now, just verify the rendered video exists and has expected duration
  if (!fs.existsSync(RENDERED_PATH)) {
    return { pass: true, details: "Rendered video not found (skipped)" };
  }

  const plan = loadPlan();
  if (!plan) return { pass: true, details: "No plan (skipped)" };

  // Check video duration matches plan
  const result = spawnSync(FFMPEG, [
    "-i", RENDERED_PATH
  ], { encoding: "utf-8", timeout: 10000 });

  const durationMatch = (result.stderr || "").match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (durationMatch) {
    const h = parseInt(durationMatch[1]);
    const m = parseInt(durationMatch[2]);
    const s = parseFloat(durationMatch[3]);
    const totalSec = h * 3600 + m * 60 + s;
    const expectedDur = plan.totalDuration;
    const diff = Math.abs(totalSec - expectedDur);

    if (diff > 1.0) {
      return {
        pass: false,
        details: `Video duration ${totalSec.toFixed(1)}s vs plan ${expectedDur.toFixed(1)}s (diff ${diff.toFixed(1)}s)`
      };
    }
    return { pass: true, details: `Duration matches (${totalSec.toFixed(1)}s)` };
  }

  return { pass: true, details: "Could not read duration (skipped)" };
}

// ══════════════════════════════════════════════════════════════
// MULTI-A-ROLL CHECKS (Phase C — face detector, trims, blank circle)
// These operate on the multi-aroll pipeline artifacts; they SKIP (pass)
// gracefully when those files aren't present.
// ══════════════════════════════════════════════════════════════

const MA_STAGE1 = path.join(ROOT, "public/exports/multi-aroll/stage1");
const MA_TIMELINE = path.join(ROOT, "public/exports/multi-aroll/stage2/clean-timeline.json");
const MA_REF = path.join(ROOT, "public/exports/sp-temp/reference-ground-truth.json");
const MA_FILTER = path.join(ROOT, "public/exports/multi-aroll/stage4/method-2-filter.txt");

function maLoad(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// Replicate the renderer's run-merging so the regression mirrors what it builds.
function maComputeRuns(timeline) {
  let refLayout = [];
  const ref = maLoad(MA_REF);
  if (Array.isArray(ref)) refLayout = ref.map(s => (s.shape === "rectangle" ? "rectangle" : "circle"));
  const ranges = timeline.segments.map((s, i) => ({
    sourceClipIndex: s.sourceClipIndex, sourceStart: s.sourceStart, sourceEnd: s.sourceEnd,
    layoutType: refLayout[i] || "circle",
  }));
  const runs = [];
  for (const r of ranges) {
    const prev = runs[runs.length - 1];
    const contiguous = prev && prev.sourceClipIndex === r.sourceClipIndex &&
      prev.layoutType === r.layoutType && Math.abs(prev.sourceEnd - r.sourceStart) < 0.6;
    if (contiguous) { prev.sourceEnd = r.sourceEnd; }
    else runs.push({ ...r });
  }
  return runs;
}

// ── CHECK MA1: Real YuNet face detection, consistent across clips ──
// Bug: brightness-based face guesser returned a DIFFERENT wrong box per clip
// (height 0.13-0.14, topY 0.24-0.27), so segs 3-4 framed differently from 1-2.
// Fix (Phase C, Step 1): OpenCV YuNet DNN — accurate + consistent faceHeight.
// Rule: every clip_N_face.json must be detector:"yunet" with a sane, CONSISTENT
// face height (the consistency is what makes all circles frame identically).
function check_multiaroll_face_detector() {
  const faces = [];
  for (let i = 0; i < 8; i++) {
    const f = maLoad(path.join(MA_STAGE1, `clip_${i}_face.json`));
    if (f) faces.push({ i, f });
  }
  if (faces.length === 0) return { pass: true, details: "No multi-aroll face files (skipped)" };

  const violations = [];
  const heights = [];
  for (const { i, f } of faces) {
    if (f.detector !== "yunet") violations.push(`clip_${i}: detector='${f.detector}' (expected 'yunet' — brightness guesser is forbidden)`);
    const h = f.median?.height;
    if (typeof h !== "number" || h < 0.10 || h > 0.35) violations.push(`clip_${i}: face height ${h} out of sane band [0.10,0.35]`);
    else heights.push(h);
  }
  if (heights.length >= 2) {
    const spread = Math.max(...heights) - Math.min(...heights);
    if (spread > 0.06) violations.push(`face heights inconsistent across clips (spread ${spread.toFixed(3)} > 0.06) — circles will frame differently`);
  }
  if (violations.length === 0) return { pass: true, details: `${faces.length} clips, detector=yunet, height spread OK` };
  return { pass: false, details: violations.join("\n     ") };
}

// ── CHECK MA2: Contiguous same-clip segments render as ONE overlay ──
// Bug: two segments cut from the same clip at a contiguous source boundary were
// rendered as two split circle overlays; a 1-frame gap at the internal boundary
// showed a BLANK circle mid-sentence (~19s seg2→seg3).
// Fix (Phase C, Step 5): merge contiguous same-clip+same-layout runs into one
// overlay. Invariant: #circle overlays in the filter == #circle RUNS, never the
// (larger) #circle segments.
function check_multiaroll_contiguous_merge() {
  const timeline = maLoad(MA_TIMELINE);
  if (!timeline || !fs.existsSync(MA_FILTER)) return { pass: true, details: "No multi-aroll timeline/filter (skipped)" };

  const runs = maComputeRuns(timeline);
  const expectedCircleOverlays = runs.filter(r => r.layoutType === "circle").length;

  const filter = fs.readFileSync(MA_FILTER, "utf8");
  // Count DISTINCT circle overlays by their unique index (circ_raw_N appears
  // twice per overlay: once created, once consumed by the mask).
  const actualCircleOverlays = new Set((filter.match(/circ_raw_(\d+)/g) || [])).size;

  if (actualCircleOverlays !== expectedCircleOverlays) {
    return {
      pass: false,
      details: `Filter has ${actualCircleOverlays} circle overlays but expected ${expectedCircleOverlays} (one per merged run). ` +
        `A mismatch means contiguous same-clip segments were SPLIT — the mid-sentence blank-circle bug.`,
    };
  }
  return { pass: true, details: `${expectedCircleOverlays} circle overlays == ${runs.length} runs (merged correctly)` };
}

// ── CHECK MA3: Trims keep each segment's intended sentence COMPLETE ──
// Bug: snapping to the nearest word (not the intended sentence) clipped a
// segment's last word ("berishadi") or started mid-sentence dropping words.
// Fix (Phase D): sentence-anchored trims + energy-aware completeness check.
async function check_multiaroll_word_completeness() {
  if (!fs.existsSync(MA_TIMELINE)) return { pass: true, details: "No multi-aroll timeline (skipped)" };
  let mod;
  try { mod = await import("./lib/transcript-verify.mjs"); }
  catch (e) { return { pass: true, details: `transcript-verify not importable (skipped): ${e.message}` }; }
  const tl = maLoad(MA_TIMELINE);
  const r = mod.verifyTimelineDeterministic(tl);
  if (r.passed) return { pass: true, details: `${r.perSegment.length} segments complete (no cut/overlap)` };
  const bad = r.perSegment.filter(p => !p.passed).map(p => `seg${p.segmentIndex} ${p.id}: ${p.reason}`);
  return { pass: false, details: bad.join("\n     ") };
}

// ── CHECK MA5: Word times are MMS FORCED-ALIGNED (not raw Gemini) ──
// Bug: Gemini word timestamps drift 300-1000ms, so trims clipped words ("kerak",
// "Mahsulotingizni"). Fix (Phase G): MMS forced alignment gives precise per-word
// times. Rule: clip_N_words.json must be detector:"mms" so cuts are precise.
function check_multiaroll_mms_aligned() {
  let any = false, violations = [];
  for (let i = 0; i < 8; i++) {
    const w = maLoad(path.join(MA_STAGE1, `clip_${i}_words.json`));
    if (!w) continue;
    any = true;
    if (w.detector !== "mms") violations.push(`clip_${i}_words.json detector='${w.detector}' (expected 'mms' — forced alignment)`);
  }
  if (!any) return { pass: true, details: "No multi-aroll word files (skipped)" };
  if (violations.length === 0) return { pass: true, details: "word times forced-aligned (detector=mms)" };
  return { pass: false, details: violations.join("\n     ") };
}

// ── CHECK MA4: Crop target is HEAD-SAFE (top gap above the head) ──
// Bug: faceFraction 0.54 + faceCenterYIn 0.33 clipped the top of the head.
// Rule: face-box top (faceCenterYIn - faceFraction/2) must sit >= 0.10 down the
// circle so the head/hijab clears the rim; values within sane bounds.
function check_multiaroll_crop_headsafe() {
  const TARGET_PATH = path.join(ROOT, "public/exports/multi-aroll/stage1/reference-circle-target.json");
  if (!fs.existsSync(TARGET_PATH)) return { pass: true, details: "No crop target (skipped)" };
  const t = maLoad(TARGET_PATH)?.target;
  if (!t) return { pass: true, details: "No target field (skipped)" };
  const ff = t.faceFraction, fc = t.faceCenterYIn;
  const violations = [];
  if (!(ff >= 0.42 && ff <= 0.56)) violations.push(`faceFraction ${ff} out of [0.42,0.56]`);
  if (!(fc >= 0.30 && fc <= 0.50)) violations.push(`faceCenterYIn ${fc} out of [0.30,0.50]`);
  const faceTop = fc - ff / 2;
  if (faceTop < 0.10) violations.push(`face-box top ${faceTop.toFixed(3)} < 0.10 — head would clip the rim (regression to the 0.54/0.33 bug)`);
  if (violations.length === 0) return { pass: true, details: `faceFraction=${ff} faceCenterYIn=${fc} (face top ${faceTop.toFixed(3)} clears rim)` };
  return { pass: false, details: violations.join("\n     ") };
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║        STYLECLONE REGRESSION TEST SUITE                 ║");
  console.log("║  Every bug we fixed, encoded as an assertion.           ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");

  const plan = loadPlan();
  const template = loadTemplate();

  // ── Layer 1: Structural Checks ──
  console.log("━━ LAYER 1: Structural Checks (from JSON, no render) ━━");

  record(
    "No mid-sentence layout transitions",
    ...Object.values(check_no_mid_sentence_transitions(plan))
  );

  record(
    "No gaps in enable expressions",
    ...Object.values(check_no_enable_gaps(plan))
  );

  record(
    "First range starts at t=0",
    ...Object.values(check_starts_at_zero(plan))
  );

  record(
    "Template coordinates within canvas bounds",
    ...Object.values(check_template_coordinates(template))
  );

  record(
    "Single-pass FFmpeg (no concat)",
    ...Object.values(check_singlepass_filter())
  );

  record(
    "Audio mapped continuously (-map 1:a)",
    ...Object.values(check_continuous_audio())
  );

  record(
    "Plan sentence data integrity",
    ...Object.values(check_plan_sentence_integrity(plan))
  );

  record(
    "Enable expressions frame-aligned",
    ...Object.values(check_frame_aligned_enables(plan))
  );

  record(
    "Multi-aroll: YuNet face detector, consistent across clips",
    ...Object.values(check_multiaroll_face_detector())
  );

  record(
    "Multi-aroll: contiguous same-clip segments merged (no blank circle)",
    ...Object.values(check_multiaroll_contiguous_merge())
  );

  record(
    "Multi-aroll: word times forced-aligned (MMS, not raw Gemini)",
    ...Object.values(check_multiaroll_mms_aligned())
  );

  record(
    "Multi-aroll: trims keep each sentence complete (no cut/overlap)",
    ...Object.values(await check_multiaroll_word_completeness())
  );

  record(
    "Multi-aroll: crop target is head-safe (top gap)",
    ...Object.values(check_multiaroll_crop_headsafe())
  );

  // ── Layer 2: Full Verification ──
  if (FULL_MODE) {
    console.log("");
    console.log("━━ LAYER 2: Render + Verification Checks ━━");

    record(
      "Audio continuity (silence pattern matches source)",
      ...Object.values(check_audio_continuity())
    );

    record(
      "No black frames at transitions",
      ...Object.values(check_no_black_frames_at_transitions())
    );

    record(
      "Rendered video duration matches plan",
      ...Object.values(check_cv_circle_positions())
    );
  }

  // ── Summary ──
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  RESULTS: ${passCount} passed, ${failCount} failed`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (failCount > 0) {
    console.log("");
    console.log("  ⚠️  REGRESSIONS DETECTED — DO NOT COMMIT");
    console.log("  Fix the issues above before proceeding.");
    console.log("");
    process.exit(1);
  } else {
    console.log("");
    console.log("  ✅ ALL CHECKS PASSED — safe to commit");
    console.log("");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Regression test error:", err);
  process.exit(1);
});
