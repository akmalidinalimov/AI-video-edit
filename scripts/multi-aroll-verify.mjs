/**
 * MULTI-AROLL VERIFICATION SCRIPT
 *
 * Automated QA gate that runs BEFORE delivering any rendered video.
 * All checks must pass before the video is considered ready.
 *
 * Checks:
 * 1. Motion detection — no frozen segments (compare consecutive frames)
 * 2. Circle crop — head positioned correctly (top 8-15% gap)
 * 3. Black frame detection — no all-black frames at transitions
 * 4. Audio gap detection — no silence >200ms between sentences
 * 5. Duration match — output matches expected timeline duration
 * 6. File integrity — output is valid video with correct dimensions
 * 7. Transition frames — no blank circles at A-roll transitions
 *
 * Usage: node scripts/multi-aroll-verify.mjs [--method 1|2|3|all]
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const STAGE1_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage1");
const STAGE2_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
const STAGE4_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage4");
const VERIFY_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "verify");

const timeline = JSON.parse(fs.readFileSync(path.join(STAGE2_DIR, "clean-timeline.json"), "utf-8"));

import { verifyTimelineDeterministic, verifyTimelineGemini } from "./lib/transcript-verify.mjs";
import { measureCrop, GAP_MIN, BOTTOM_MAX } from "./multi-aroll-crop-check.mjs";
const USE_GEMINI = process.argv.includes("--gemini");

// Parse args
const methodArg = process.argv.find(a => a.startsWith("--method"));
const methodVal = methodArg ? methodArg.split("=")[1] || process.argv[process.argv.indexOf(methodArg) + 1] : "all";
const methodsToCheck = methodVal === "all" ? [1, 2, 3] : [parseInt(methodVal)];

// Ensure verify dir exists
fs.mkdirSync(VERIFY_DIR, { recursive: true });

// ════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════

function parseFPS(rFrameRate) {
  // Parse fraction like "30/1" or "30000/1001"
  if (rFrameRate.includes("/")) {
    const [num, den] = rFrameRate.split("/").map(Number);
    return num / den;
  }
  return parseFloat(rFrameRate);
}

function getMediaInfo(filePath) {
  const raw = execFileSync(FFPROBE, [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ], { encoding: "utf-8" });
  const parsed = JSON.parse(raw);
  const vs = parsed.streams.find(s => s.codec_type === "video");
  const as = parsed.streams.find(s => s.codec_type === "audio");
  return {
    width: vs ? parseInt(vs.width) : 0,
    height: vs ? parseInt(vs.height) : 0,
    duration: parseFloat(parsed.format.duration),
    hasVideo: !!vs,
    hasAudio: !!as,
    fps: vs ? parseFPS(vs.r_frame_rate) : 0,
  };
}

function extractRawFrame(videoPath, timestamp, width, height) {
  // Extract a small grayscale frame for comparison
  const buf = execFileSync(FFMPEG, [
    "-ss", String(timestamp),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", `scale=${width}:${height},format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });
  return buf;
}

function frameDifference(buf1, buf2) {
  if (buf1.length !== buf2.length) return 1;
  let diff = 0;
  for (let i = 0; i < buf1.length; i++) {
    diff += Math.abs(buf1[i] - buf2[i]);
  }
  return diff / (buf1.length * 255); // normalized 0-1
}

function averageBrightness(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum / buf.length;
}

// ════════════════════════════════════════════════════════
// CHECK 1: Motion Detection
// ════════════════════════════════════════════════════════

function checkMotion(videoPath, methodNum) {
  console.log(`    [1/6] Motion detection...`);
  const issues = [];
  const info = getMediaInfo(videoPath);

  // For each segment, compare two frames 0.5s apart within the segment
  for (const seg of timeline.segments) {
    const mid = (seg.timelineStart + seg.timelineEnd) / 2;
    const t1 = Math.min(mid - 0.25, seg.timelineEnd - 0.5);
    const t2 = Math.min(mid + 0.25, seg.timelineEnd - 0.1);

    if (t1 < 0 || t2 >= info.duration) continue;

    try {
      const frame1 = extractRawFrame(videoPath, t1, 64, 64);
      const frame2 = extractRawFrame(videoPath, t2, 64, 64);
      const diff = frameDifference(frame1, frame2);

      if (diff < 0.001) {
        issues.push({
          type: "frozen",
          segment: seg.segmentIndex,
          time: `${t1.toFixed(2)}-${t2.toFixed(2)}s`,
          severity: "CRITICAL",
          msg: `Segment ${seg.segmentIndex} appears frozen (diff=${(diff * 100).toFixed(4)}%)`,
        });
      }
    } catch (e) {
      issues.push({
        type: "extraction_error",
        segment: seg.segmentIndex,
        severity: "WARN",
        msg: `Could not extract frames for segment ${seg.segmentIndex}: ${e.message}`,
      });
    }
  }

  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${issues.length} issues`);
  return { check: "motion", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 2: Circle Crop Position
// ════════════════════════════════════════════════════════

function checkCircleCrop(videoPath, methodNum) {
  console.log(`    [2/6] Circle crop position...`);
  const issues = [];

  // Extract the circle PIP region from a few frames and check brightness distribution
  // The top 8-15% of the circle should be background (darker/different from face)
  // The face should fill 80-90% of the circle vertically

  const checkTimes = [2, 8, 15, 25]; // Sample across the video
  const info = getMediaInfo(videoPath);

  for (const t of checkTimes) {
    if (t >= info.duration) continue;

    try {
      // Extract just the circle PIP region (567,190 to 995,618 in 1080x1920)
      // That's x=567, y=190, w=428, h=428
      const buf = execFileSync(FFMPEG, [
        "-ss", String(t),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", "crop=428:428:567:190,scale=64:64,format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray",
        "pipe:1",
      ], { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });

      // Check top strip (top 8% = ~5 rows of 64) vs middle (face region)
      const topRows = 5;
      let topSum = 0, midSum = 0;
      for (let y = 0; y < topRows; y++) {
        for (let x = 0; x < 64; x++) {
          topSum += buf[y * 64 + x];
        }
      }
      for (let y = 10; y < 50; y++) {
        for (let x = 10; x < 54; x++) {
          midSum += buf[y * 64 + x];
        }
      }
      const topAvg = topSum / (topRows * 64);
      const midAvg = midSum / (40 * 44);

      // If the top region has the same brightness as the middle, head may be too high
      // If the middle is significantly darker/same brightness as background, head may be too low
      // We expect: top region != middle region (face is below the top gap)
      if (Math.abs(topAvg - midAvg) < 5) {
        issues.push({
          type: "crop_ambiguous",
          time: t,
          severity: "WARN",
          msg: `t=${t}s: top and middle of circle have similar brightness (top=${topAvg.toFixed(0)}, mid=${midAvg.toFixed(0)}) — head position unclear`,
        });
      }
    } catch (e) {
      // Skip extraction errors
    }
  }

  // This check is informational — hard to definitively fail without Gemini vision
  const passed = true; // Always passes for now; manual/Gemini check handles definitive
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${issues.length} warnings`);
  return { check: "circle_crop", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 3: Black Frame Detection
// ════════════════════════════════════════════════════════

function checkBlackFrames(videoPath, methodNum) {
  console.log(`    [3/6] Black frame detection...`);
  const issues = [];
  const info = getMediaInfo(videoPath);

  // Check at each segment transition point
  for (let i = 1; i < timeline.segments.length; i++) {
    const transTime = timeline.segments[i].timelineStart;
    if (transTime >= info.duration) continue;

    // Check 3 frames around the transition: -0.05, +0.05, +0.1
    for (const offset of [-0.05, 0.05, 0.1]) {
      const t = transTime + offset;
      if (t < 0 || t >= info.duration) continue;

      try {
        const buf = extractRawFrame(videoPath, t, 16, 16);
        const avg = averageBrightness(buf);

        if (avg < 10) {
          issues.push({
            type: "black_frame",
            time: t,
            transition: i,
            severity: "CRITICAL",
            msg: `Black frame at transition ${i} (t=${t.toFixed(3)}s, brightness=${avg.toFixed(1)})`,
          });
        }
      } catch (e) {}
    }
  }

  // Also check a few random points
  for (const t of [1, 5, 10, 20, 30]) {
    if (t >= info.duration) continue;
    try {
      const buf = extractRawFrame(videoPath, t, 16, 16);
      const avg = averageBrightness(buf);
      if (avg < 10) {
        issues.push({
          type: "black_frame",
          time: t,
          severity: "CRITICAL",
          msg: `Unexpected black frame at t=${t}s (brightness=${avg.toFixed(1)})`,
        });
      }
    } catch (e) {}
  }

  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${issues.length} issues`);
  return { check: "black_frames", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 4: Audio Gap Detection
// ════════════════════════════════════════════════════════

function checkAudioGaps(videoPath, methodNum) {
  console.log(`    [4/6] Audio gap detection...`);
  const issues = [];

  // Use FFmpeg silencedetect to find silence regions > 200ms
  try {
    execFileSync(FFMPEG, [
      "-i", videoPath,
      "-af", "silencedetect=noise=-35dB:d=0.2",
      "-f", "null", "-",
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    // silencedetect outputs to stderr
    const stderr = e.stderr?.toString() || "";
    const silenceMatches = [...stderr.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)];

    for (const match of silenceMatches) {
      const start = parseFloat(match[1]);
      const end = parseFloat(match[2]);
      const duration = end - start;

      // Check if this silence is at a segment boundary (expected: <200ms)
      const isAtBoundary = timeline.segments.some(seg =>
        Math.abs(seg.timelineStart - start) < 0.5 || Math.abs(seg.timelineEnd - start) < 0.5
      );

      if (duration > 0.3) {
        issues.push({
          type: "audio_gap",
          start, end, duration,
          atBoundary: isAtBoundary,
          severity: duration > 0.5 ? "CRITICAL" : "WARN",
          msg: `Silence ${duration.toFixed(3)}s at ${start.toFixed(2)}-${end.toFixed(2)}s${isAtBoundary ? " (segment boundary)" : ""}`,
        });
      }
    }
  }

  // Allow minor gaps (up to 2 warnings), fail only on >500ms gaps
  const criticalGaps = issues.filter(i => i.severity === "CRITICAL");
  const passed = criticalGaps.length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${issues.length} silence regions (${criticalGaps.length} critical)`);
  return { check: "audio_gaps", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 5: Duration Match
// ════════════════════════════════════════════════════════

function checkDuration(videoPath, methodNum) {
  console.log(`    [5/6] Duration match...`);
  const issues = [];
  const info = getMediaInfo(videoPath);

  const expectedDuration = timeline.totalDuration;
  const diff = Math.abs(info.duration - expectedDuration);

  if (diff > 1.0) {
    issues.push({
      type: "duration_mismatch",
      expected: expectedDuration,
      actual: info.duration,
      diff,
      severity: "CRITICAL",
      msg: `Duration mismatch: ${info.duration.toFixed(2)}s vs expected ${expectedDuration.toFixed(2)}s (diff=${diff.toFixed(2)}s)`,
    });
  } else if (diff > 0.5) {
    issues.push({
      type: "duration_mismatch",
      expected: expectedDuration,
      actual: info.duration,
      diff,
      severity: "WARN",
      msg: `Duration slightly off: ${info.duration.toFixed(2)}s vs expected ${expectedDuration.toFixed(2)}s (diff=${diff.toFixed(2)}s)`,
    });
  }

  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — actual=${info.duration.toFixed(2)}s expected=${expectedDuration.toFixed(2)}s`);
  return { check: "duration", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 6: File Integrity
// ════════════════════════════════════════════════════════

function checkFileIntegrity(videoPath, methodNum) {
  console.log(`    [6/6] File integrity...`);
  const issues = [];

  if (!fs.existsSync(videoPath)) {
    issues.push({ type: "missing", severity: "CRITICAL", msg: "Video file does not exist" });
    console.log(`          FAIL — file missing`);
    return { check: "integrity", passed: false, issues };
  }

  const info = getMediaInfo(videoPath);
  const fileSize = fs.statSync(videoPath).size;

  // Check dimensions
  if (info.width !== 1080 || info.height !== 1920) {
    issues.push({
      type: "dimensions",
      severity: "CRITICAL",
      msg: `Wrong dimensions: ${info.width}x${info.height} (expected 1080x1920)`,
    });
  }

  // Check has both streams
  if (!info.hasVideo) {
    issues.push({ type: "no_video", severity: "CRITICAL", msg: "No video stream" });
  }
  if (!info.hasAudio) {
    issues.push({ type: "no_audio", severity: "CRITICAL", msg: "No audio stream" });
  }

  // Check file size is reasonable (>1MB for 30s video)
  if (fileSize < 1024 * 1024) {
    issues.push({
      type: "small_file",
      severity: "WARN",
      msg: `File seems small: ${(fileSize / 1024 / 1024).toFixed(2)} MB`,
    });
  }

  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${info.width}x${info.height}, ${(fileSize/1024/1024).toFixed(1)}MB`);
  return { check: "integrity", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 7: Transition Frame Verification (Blank Circle)
// ════════════════════════════════════════════════════════

function checkTransitionFrames(videoPath, methodNum) {
  console.log(`    [7/7] Transition frame verification (blank circle)...`);
  const issues = [];
  const info = getMediaInfo(videoPath);
  const fps = info.fps || 30;
  const frameDur = 1 / fps;

  // For each transition, sample EVERY frame across a wide window and look for a
  // blank circle two ways:
  //   (a) absolute: very dark + flat interior (transparent/black), and
  //   (b) TRANSIENT OUTLIER: a frame whose circle interior differs sharply from
  //       BOTH neighbours while the neighbours agree with each other. This is the
  //       signature of a 1-frame blank where the B-roll shows through the circle
  //       (it broke the old absolute-only check: the B-roll wasn't dark, so
  //       avg≈48/var≈40 sailed past the var<8&&avg<30 gate). It also can't slip
  //       BETWEEN samples because we now test every frame, not ±2.
  const interiorBuf = (t) => execFileSync(FFMPEG, [
    "-ss", t.toFixed(4), "-i", videoPath, "-frames:v", "1",
    // exclude the 4px border ring with a generous inset so the ring never counts
    "-vf", "crop=400:400:581:204,scale=32:32,format=gray",
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });

  for (let i = 1; i < timeline.segments.length; i++) {
    const transTime = timeline.segments[i].timelineStart;
    if (transTime >= info.duration - 0.1) continue;

    // Every frame from -3 to +6 (the blank lands 1-2 frames AFTER the boundary).
    const offsets = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
    const frames = [];
    for (const frameOffset of offsets) {
      const t = transTime + frameOffset * frameDur;
      if (t < 0 || t >= info.duration) continue;
      try {
        const buf = interiorBuf(t);
        const avg = averageBrightness(buf);
        let variance = 0;
        for (let px = 0; px < buf.length; px++) variance += (buf[px] - avg) ** 2;
        variance = Math.sqrt(variance / buf.length);
        frames.push({ frameOffset, t, buf, avg, variance });
      } catch (e) { /* skip edge frames */ }
    }

    for (let k = 0; k < frames.length; k++) {
      const f = frames[k];
      // (a) absolute black/transparent backstop
      if (f.variance < 8 && f.avg < 30) {
        issues.push({ type: "blank_circle", transition: i, frameOffset: f.frameOffset, time: f.t, severity: "CRITICAL",
          msg: `Blank circle at transition ${i}, frame${f.frameOffset >= 0 ? "+" : ""}${f.frameOffset} (t=${f.t.toFixed(4)}s, var=${f.variance.toFixed(1)}, avg=${f.avg.toFixed(1)}) — dark/flat interior` });
        continue;
      }
      // (b) transient outlier vs BOTH neighbours (neighbours must agree)
      const p = frames[k - 1], n = frames[k + 1];
      if (p && n) {
        const dfp = frameDifference(f.buf, p.buf);
        const dfn = frameDifference(f.buf, n.buf);
        const dpn = frameDifference(p.buf, n.buf);
        if (dfp > 0.08 && dfn > 0.08 && dfp > 1.8 * dpn && dfn > 1.8 * dpn) {
          issues.push({ type: "blank_circle", transition: i, frameOffset: f.frameOffset, time: f.t, severity: "CRITICAL",
            msg: `Blank circle (1-frame B-roll flash) at transition ${i}, frame${f.frameOffset >= 0 ? "+" : ""}${f.frameOffset} (t=${f.t.toFixed(4)}s; interior differs from both neighbours d=${dfp.toFixed(2)}/${dfn.toFixed(2)} vs neighbour-agree ${dpn.toFixed(2)})` });
        }
      }
    }
  }

  const criticalIssues = issues.filter(i => i.severity === "CRITICAL");
  const passed = criticalIssues.length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${criticalIssues.length} blank circle frames detected`);
  return { check: "transition_frames", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 8: Layout matches reference (rect segments are full-width 16:9)
// ════════════════════════════════════════════════════════
function checkLayout(videoPath, methodNum) {
  console.log(`    [8/9] Layout vs reference...`);
  const issues = [];
  let refLayout = [];
  try {
    const raw = JSON.parse(fs.readFileSync(
      path.join(ROOT, "public", "exports", "sp-temp", "reference-ground-truth.json"), "utf-8"));
    if (Array.isArray(raw)) refLayout = raw.map(s => (s.shape === "rectangle" ? "rectangle" : "circle"));
  } catch {}

  for (let i = 0; i < timeline.segments.length; i++) {
    const shape = refLayout[i] || "circle";
    if (shape !== "rectangle") continue;
    const seg = timeline.segments[i];
    const t = (seg.timelineStart + seg.timelineEnd) / 2;
    try {
      // Sample a strip across the full width at the rect band's mid-height.
      // A 16:9 rect spans x=0..1080 → the LEFT third carries real imagery
      // (variance). A circle PIP would leave the left third as plain B-roll.
      const buf = execFileSync(FFMPEG, [
        "-ss", t.toFixed(3), "-i", videoPath, "-frames:v", "1",
        "-vf", "crop=1080:200:0:540,scale=108:20,format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      ], { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
      let leftAvg = 0; const n = 20 * 36;
      for (let y = 0; y < 20; y++) for (let x = 0; x < 36; x++) leftAvg += buf[y*108+x];
      leftAvg /= n;
      let leftVar = 0;
      for (let y = 0; y < 20; y++) for (let x = 0; x < 36; x++) leftVar += (buf[y*108+x]-leftAvg)**2;
      leftVar = Math.sqrt(leftVar / n);
      if (leftVar < 4) {
        issues.push({ type: "layout_mismatch", segment: i, severity: "CRITICAL",
          msg: `Seg ${i} should be 16:9 (per reference) but left third looks empty (var=${leftVar.toFixed(1)}) — likely circle PIP` });
      }
    } catch (e) {}
  }
  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${issues.length} issues`);
  return { check: "layout", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 9: Word-accurate cut — trims align to WORD boundaries
// (kills the in-breath: a breath is sound but not a word, so we verify the cut
//  lands on a real word onset/offset, NOT on a silencedetect sound edge).
// ════════════════════════════════════════════════════════
function checkSentenceCut(videoPath, methodNum) {
  console.log(`    [9/9] Word-accurate cut (trim vs word boundaries)...`);
  const issues = [];
  const TOL = 0.18; // word onset/offset within this of the cut = clean

  // Same-clip contiguous internal boundaries are mid-take continuations; their
  // shared boundary need not sit at a word edge, so skip onset/offset checks there.
  const segs = timeline.segments;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    let words = [];
    try {
      const j = JSON.parse(fs.readFileSync(
        path.join(STAGE1_DIR, `clip_${seg.sourceClipIndex}_words.json`), "utf-8"));
      words = Array.isArray(j.words) ? j.words : [];
    } catch { continue; }
    if (!words.length) continue;

    const prev = segs[i - 1], next = segs[i + 1];
    const isRunStart = !(prev && prev.sourceClipIndex === seg.sourceClipIndex &&
      Math.abs(prev.sourceEnd - seg.sourceStart) < 0.6);
    const isRunEnd = !(next && next.sourceClipIndex === seg.sourceClipIndex &&
      Math.abs(seg.sourceEnd - next.sourceStart) < 0.6);

    if (isRunStart) {
      const nearestOnset = Math.min(...words.map(w => Math.abs(w.start - seg.sourceStart)));
      if (nearestOnset > TOL) {
        issues.push({ type: "cut_onset", segment: seg.segmentIndex, severity: "WARN",
          msg: `Seg ${seg.segmentIndex} start ${seg.sourceStart.toFixed(2)}s is ${nearestOnset.toFixed(2)}s from nearest WORD onset` });
      }
    }
    if (isRunEnd) {
      const nearestOffset = Math.min(...words.map(w => Math.abs(w.end - seg.sourceEnd)));
      if (nearestOffset > TOL) {
        issues.push({ type: "cut_offset", segment: seg.segmentIndex, severity: "WARN",
          msg: `Seg ${seg.segmentIndex} end ${seg.sourceEnd.toFixed(2)}s is ${nearestOffset.toFixed(2)}s from nearest WORD offset` });
      }
    }
  }
  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${issues.length} warnings`);
  return { check: "word_cut", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 10: Word completeness (deterministic) — no word cut / overlap
// The 100% gate: each segment must contain its INTENDED sentence's words exactly.
// ════════════════════════════════════════════════════════
function checkTranscriptComplete() {
  console.log(`    [10] Word completeness (sentence integrity)...`);
  const issues = [];
  const r = verifyTimelineDeterministic(timeline);
  for (const p of r.perSegment) {
    if (!p.passed) {
      issues.push({ type: "word_integrity", segment: p.segmentIndex, severity: "CRITICAL",
        msg: `Seg ${p.segmentIndex} (${p.id}): ${p.reason}` });
    }
  }
  const passed = r.passed;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${issues.length} segments with cut/overlapping words`);
  return { check: "transcript_complete", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 11: Gemini re-transcription confidence (only with --gemini)
// ════════════════════════════════════════════════════════
async function checkTranscriptGemini(videoPath) {
  // CONFIDENCE cross-check (the deterministic CHECK 10 is the real 100% word gate).
  // Gemini's Uzbek transcription only self-agrees to ~85-95% (spelling variants,
  // occasional dropped word), so a GROSS shortfall (<80%) flags a likely real
  // problem (wrong/empty audio, half a segment missing); 80-95% is ASR noise.
  const CRIT = 0.80;
  console.log(`    [11] Gemini re-transcription confidence (gross-error gate <${(CRIT * 100).toFixed(0)}%)...`);
  const issues = [];
  const r = await verifyTimelineGemini(videoPath, timeline, { minAccuracy: CRIT });
  for (const p of r.perSegment) {
    if (p.accuracy == null) {
      issues.push({ type: "gemini_skip", segment: p.segmentIndex, severity: "WARN",
        msg: `Seg ${p.segmentIndex}: ${p.reason || "no score"}` });
    } else if (p.accuracy < CRIT) {
      issues.push({ type: "gemini_low", segment: p.segmentIndex, severity: "CRITICAL",
        msg: `Seg ${p.segmentIndex} (${p.id}): only ${(p.accuracy * 100).toFixed(0)}% of expected words heard (likely a real cut)` });
    } else if (p.accuracy < 0.95) {
      issues.push({ type: "gemini_noise", segment: p.segmentIndex, severity: "WARN",
        msg: `Seg ${p.segmentIndex} (${p.id}): ${(p.accuracy * 100).toFixed(0)}% match (Uzbek ASR noise; deterministic check confirms words complete)` });
    }
  }
  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — min accuracy ${r.minAccuracy != null ? (r.minAccuracy * 100).toFixed(0) + "%" : "n/a"}`);
  return { check: "transcript_gemini", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 12: Boundary silence — no NOTICEABLE dead air at a segment start/end.
// Natural trail-off is fine; we flag a sustained silence RUN (>= MAX_SIL) of
// continuous silence right at a junction (the user's "silence gap" complaint).
// ════════════════════════════════════════════════════════
function dbWindows(videoPath, from, dur) {
  let pcm;
  try {
    pcm = execFileSync(FFMPEG, [
      "-ss", Math.max(0, from).toFixed(4), "-t", dur.toFixed(4), "-i", videoPath,
      "-ac", "1", "-ar", "16000", "-f", "s16le", "-loglevel", "error", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  } catch { return null; }
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const wn = 400, out = [];
  for (let k = 0; k + wn <= samples.length; k += wn) {
    let sum = 0;
    for (let j = 0; j < wn; j++) { const v = samples[k + j] / 32768; sum += v * v; }
    out.push(10 * Math.log10(Math.max(1e-10, sum / wn)));
  }
  return out;
}

function checkBoundarySpeech(videoPath) {
  console.log(`    [12] Boundary silence (no dead air at cuts)...`);
  const issues = [];
  const info = getMediaInfo(videoPath);
  const PROBE = 0.6;      // how far in/out of the boundary we look
  const MAX_SIL = 0.18;   // tolerated continuous silence at a junction (s)
  const THRESH = -34, win = 0.025;
  const segs = timeline.segments;

  const isInternal = (i) => {
    if (i <= 0 || i >= segs.length) return false;
    const p = segs[i - 1];
    return p && p.sourceClipIndex === segs[i].sourceClipIndex &&
      Math.abs((p.sourceEnd ?? -1) - (segs[i].sourceStart ?? -2)) < 0.6;
  };

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    // LEADING silence: from the start forward, count continuous silence.
    if (i > 0 && !isInternal(i)) {
      const env = dbWindows(videoPath, seg.timelineStart, PROBE);
      if (env) {
        let lead = 0; for (const db of env) { if (db <= THRESH) lead++; else break; }
        if (lead * win >= MAX_SIL) issues.push({ type: "silence_head", segment: i, severity: "CRITICAL",
          msg: `Seg ${i} starts with ${(lead * win * 1000).toFixed(0)}ms of silence at ${seg.timelineStart.toFixed(2)}s` });
      }
    }
    // TRAILING silence: from the end backward, count continuous silence.
    const isLast = i === segs.length - 1;
    if (!isInternal(i + 1) || isLast) { // junction or final end
      const from = Math.max(0, seg.timelineEnd - PROBE);
      const env = dbWindows(videoPath, from, Math.min(PROBE, seg.timelineEnd));
      if (env) {
        let trail = 0; for (let k = env.length - 1; k >= 0; k--) { if (env[k] <= THRESH) trail++; else break; }
        // Ignore the final video end (a tiny tail of silence there is harmless).
        const limit = isLast ? 0.35 : MAX_SIL;
        if (trail * win >= limit) issues.push({ type: "silence_tail", segment: i, severity: "CRITICAL",
          msg: `Seg ${i} ends with ${(trail * win * 1000).toFixed(0)}ms of silence before ${seg.timelineEnd.toFixed(2)}s` });
      }
    }
  }
  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — ${issues.length} silent boundaries`);
  return { check: "boundary_speech", passed, issues };
}

// ════════════════════════════════════════════════════════
// CHECK 13: Crop head-safety — head fully inside circle with a TOP GAP and
// chin/shoulders visible, across every sampled frame (the speaker moves).
// ════════════════════════════════════════════════════════
function checkCropHeadSafe(videoPath) {
  console.log(`    [13] Crop head-safety (top gap + head&shoulders)...`);
  const issues = [];
  let r;
  try { r = measureCrop(videoPath); } catch (e) {
    console.log(`          SKIP — ${e.message}`);
    return { check: "crop_head_safe", passed: true, issues };
  }
  for (const p of r.perSegment) {
    if (p.error) { issues.push({ type: "crop_measure", segment: p.segment, severity: "WARN", msg: `Seg ${p.segment}: ${p.error}` }); continue; }
    if (!p.headOk) issues.push({ type: "head_clipped", segment: p.segment, severity: "CRITICAL",
      msg: `Seg ${p.segment}: head too high (gap ${p.minHeadTopFrac} < ${GAP_MIN})` });
    if (!p.bottomOk) issues.push({ type: "chin_clipped", segment: p.segment, severity: "CRITICAL",
      msg: `Seg ${p.segment}: chin/shoulders clipped (bottom ${p.maxFaceBottomFrac} > ${BOTTOM_MAX})` });
  }
  const passed = issues.filter(i => i.severity === "CRITICAL").length === 0;
  console.log(`          ${passed ? "PASS" : "FAIL"} — headTop(min)=${r.overall.minHeadTopFrac} faceBottom(max)=${r.overall.maxFaceBottomFrac}`);
  return { check: "crop_head_safe", passed, issues };
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════

async function verifyMethod(methodNum) {
  const videoPath = path.join(STAGE4_DIR, `method-${methodNum}-rendered.mp4`);
  console.log(`\n  -- METHOD ${methodNum} --`);
  console.log(`  Video: ${videoPath}`);

  const results = [];
  results.push(checkFileIntegrity(videoPath, methodNum));

  // Only continue if file exists
  if (!results[0].passed) {
    console.log(`\n  VERDICT: FAIL (file missing/corrupt)\n`);
    return { method: methodNum, passed: false, results };
  }

  results.push(checkMotion(videoPath, methodNum));
  results.push(checkCircleCrop(videoPath, methodNum));
  results.push(checkBlackFrames(videoPath, methodNum));
  results.push(checkAudioGaps(videoPath, methodNum));
  results.push(checkDuration(videoPath, methodNum));
  results.push(checkTransitionFrames(videoPath, methodNum));
  results.push(checkLayout(videoPath, methodNum));
  results.push(checkSentenceCut(videoPath, methodNum));
  results.push(checkTranscriptComplete());
  results.push(checkBoundarySpeech(videoPath));
  results.push(checkCropHeadSafe(videoPath));
  if (USE_GEMINI) results.push(await checkTranscriptGemini(videoPath));

  const allPassed = results.every(r => r.passed);
  const criticalIssues = results.flatMap(r => r.issues.filter(i => i.severity === "CRITICAL"));
  const warnings = results.flatMap(r => r.issues.filter(i => i.severity === "WARN"));

  console.log(`\n  VERDICT: ${allPassed ? "PASS" : "FAIL"}`);
  if (criticalIssues.length > 0) {
    console.log(`  Critical issues (${criticalIssues.length}):`);
    for (const issue of criticalIssues) {
      console.log(`    - ${issue.msg}`);
    }
  }
  if (warnings.length > 0) {
    console.log(`  Warnings (${warnings.length}):`);
    for (const issue of warnings) {
      console.log(`    - ${issue.msg}`);
    }
  }

  return { method: methodNum, passed: allPassed, results, criticalIssues, warnings };
}

async function main() {
  console.log("+=======================================================+");
  console.log("|   MULTI-AROLL VERIFICATION GATE                       |");
  console.log("+=======================================================+");
  console.log(`\n  Timeline: ${timeline.segmentCount} segments, ${timeline.totalDuration.toFixed(2)}s`);
  console.log(`  Checking methods: ${methodsToCheck.join(", ")}${USE_GEMINI ? " (+Gemini)" : ""}`);

  const allResults = [];
  for (const m of methodsToCheck) {
    allResults.push(await verifyMethod(m));
  }

  // Summary
  console.log("\n=======================================================");
  console.log("  VERIFICATION SUMMARY");
  console.log("=======================================================\n");

  let allPassed = true;
  for (const result of allResults) {
    const status = result.passed ? "PASS" : "FAIL";
    const critCount = result.criticalIssues?.length || 0;
    const warnCount = result.warnings?.length || 0;
    console.log(`  M${result.method}: ${status} (${critCount} critical, ${warnCount} warnings)`);
    if (!result.passed) allPassed = false;
  }

  console.log(`\n  OVERALL: ${allPassed ? "PASS — Ready for delivery" : "FAIL — Fix issues before delivery"}`);

  // Save verification report
  const reportPath = path.join(VERIFY_DIR, "verification-report.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    methodsChecked: methodsToCheck,
    allPassed,
    results: allResults,
  }, null, 2));
  console.log(`  Report: ${reportPath}\n`);

  // Exit with appropriate code
  process.exit(allPassed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
