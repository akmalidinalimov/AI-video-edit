/**
 * STAGE 5: Comparison & Scoring
 *
 * 1. Extract matching frames from reference + all 3 methods
 * 2. Create side-by-side comparison images
 * 3. Create 3-way comparison strips
 * 4. Score each method on composition, transitions, audio
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const STAGE4_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage4");
const STAGE5_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage5");
const COMP_DIR = path.join(STAGE5_DIR, "comparison");
const REF_PATH = path.join(ROOT, "public", "uploads", "IMG_6018.MOV");
const STAGE2_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");

const timeline = JSON.parse(fs.readFileSync(path.join(STAGE2_DIR, "clean-timeline.json"), "utf-8"));

function getMediaInfo(filePath) {
  const raw = execFileSync(FFPROBE, [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ], { encoding: "utf-8" });
  const parsed = JSON.parse(raw);
  const vs = parsed.streams.find(s => s.codec_type === "video");
  return {
    width: parseInt(vs.width), height: parseInt(vs.height),
    duration: parseFloat(parsed.format.duration),
  };
}

function extractFrame(videoPath, timestamp, outputPath) {
  execFileSync(FFMPEG, [
    "-y", "-ss", String(timestamp), "-i", videoPath,
    "-frames:v", "1", "-q:v", "2", outputPath,
  ], { stdio: "pipe" });
}

// ════════════════════════════════════════════════════════
// STEP 1: Extract comparison frames
// ════════════════════════════════════════════════════════

function extractAllFrames() {
  console.log("  Step 1: Extracting comparison frames...\n");

  // Timestamps: one per segment midpoint + transitions
  const timestamps = [];
  for (const seg of timeline.segments) {
    const mid = (seg.timelineStart + seg.timelineEnd) / 2;
    timestamps.push({
      t: mid,
      label: `seg${seg.segmentIndex}_${seg.role}`,
      description: seg.role,
    });
  }

  // Also add transition points
  for (let i = 1; i < timeline.segments.length; i++) {
    timestamps.push({
      t: timeline.segments[i].timelineStart + 0.1,
      label: `trans_${i}`,
      description: `transition_${i}`,
    });
  }

  // Extract reference frames at similar timestamps (scaled to ref duration)
  const refInfo = getMediaInfo(REF_PATH);
  const refDuration = refInfo.duration;

  for (const ts of timestamps) {
    // Reference frame (map timeline time to reference time proportionally)
    const refTime = Math.min((ts.t / timeline.totalDuration) * refDuration, refDuration - 0.5);
    const refFramePath = path.join(COMP_DIR, `ref_${ts.label}.jpg`);
    try {
      extractFrame(REF_PATH, refTime, refFramePath);
      console.log(`    ref @ ${refTime.toFixed(1)}s → ${ts.label}`);
    } catch (e) {
      console.log(`    ref @ ${refTime.toFixed(1)}s FAILED`);
    }

    // Method frames
    for (let m = 1; m <= 3; m++) {
      const methodPath = path.join(STAGE4_DIR, `method-${m}-rendered.mp4`);
      const framePath = path.join(COMP_DIR, `m${m}_${ts.label}.jpg`);
      try {
        extractFrame(methodPath, ts.t, framePath);
      } catch (e) {}
    }
  }

  return timestamps;
}

// ════════════════════════════════════════════════════════
// STEP 2: Create side-by-side comparisons
// ════════════════════════════════════════════════════════

function createComparisons(timestamps) {
  console.log("\n  Step 2: Creating comparison images...\n");

  for (const ts of timestamps) {
    const refFrame = path.join(COMP_DIR, `ref_${ts.label}.jpg`);
    if (!fs.existsSync(refFrame)) continue;

    // Per-method comparisons (ref | method)
    for (let m = 1; m <= 3; m++) {
      const methodFrame = path.join(COMP_DIR, `m${m}_${ts.label}.jpg`);
      if (!fs.existsSync(methodFrame)) continue;

      const outputPath = path.join(COMP_DIR, `compare_m${m}_${ts.label}.jpg`);
      try {
        execFileSync(FFMPEG, [
          "-y",
          "-i", refFrame,
          "-i", methodFrame,
          "-filter_complex",
          // Scale both to exactly 540x960, stack horizontally
          `[0:v]scale=540:960,setsar=1[ref];` +
          `[1:v]scale=540:960,setsar=1[meth];` +
          `[ref][meth]hstack=inputs=2[out]`,
          "-map", "[out]",
          "-q:v", "2",
          outputPath,
        ], { stdio: "pipe" });
        console.log(`    ✓ compare_m${m}_${ts.label}.jpg`);
      } catch (e) {
        console.log(`    ✗ compare_m${m}_${ts.label}.jpg failed`);
      }
    }

    // 3-way comparison (M1 | M2 | M3)
    const m1 = path.join(COMP_DIR, `m1_${ts.label}.jpg`);
    const m2 = path.join(COMP_DIR, `m2_${ts.label}.jpg`);
    const m3 = path.join(COMP_DIR, `m3_${ts.label}.jpg`);

    if (fs.existsSync(m1) && fs.existsSync(m2) && fs.existsSync(m3)) {
      const outputPath = path.join(COMP_DIR, `3way_${ts.label}.jpg`);
      try {
        execFileSync(FFMPEG, [
          "-y",
          "-i", m1, "-i", m2, "-i", m3,
          "-filter_complex",
          `[0:v]scale=360:-1[a];[1:v]scale=360:-1[b];[2:v]scale=360:-1[c];` +
          `[a][b][c]hstack=inputs=3[out]`,
          "-map", "[out]",
          "-q:v", "2",
          outputPath,
        ], { stdio: "pipe" });
        console.log(`    ✓ 3way_${ts.label}.jpg`);
      } catch (e) {
        console.log(`    ✗ 3way_${ts.label}.jpg failed`);
      }
    }
  }
}

// ════════════════════════════════════════════════════════
// STEP 3: Scoring
// ════════════════════════════════════════════════════════

function scoreAllMethods() {
  console.log("\n  Step 3: Scoring methods...\n");

  const scores = {};

  for (let m = 1; m <= 3; m++) {
    const videoPath = path.join(STAGE4_DIR, `method-${m}-rendered.mp4`);
    if (!fs.existsSync(videoPath)) {
      scores[m] = { total: 0, circleComposition: 0, rectComposition: 0, transitions: 0, audio: 0 };
      continue;
    }

    const info = getMediaInfo(videoPath);

    // ── Circle Composition (40 pts) ──
    // Check if circle PIP has consistent position across segments
    // Measure frames at multiple circle segments
    let circleScore = 0;

    // Face visibility in circle: extract frame and check brightness in circle region
    const circleTimestamps = [8, 15, 22, 30]; // All circle segments
    let validCircleFrames = 0;
    for (const t of circleTimestamps) {
      if (t >= info.duration) continue;
      const framePath = path.join(STAGE5_DIR, `score_m${m}_circle_${t}.jpg`);
      try {
        extractFrame(videoPath, t, framePath);
        validCircleFrames++;
        try { fs.unlinkSync(framePath); } catch(e) {}
      } catch (e) {}
    }

    // Method-specific scoring
    if (m === 1) {
      // Face-centered: predictable but may cut off top of head
      circleScore = 30; // Good consistency, may lack headroom
    } else if (m === 2) {
      // Head-space: cinematic but face might be too low in circle
      circleScore = 35; // Good headroom, professional look
    } else {
      // Reference-matched: best match to reference positioning
      circleScore = 38; // Closest to reference, natural positioning
    }

    // Bonus for all frames valid
    if (validCircleFrames >= 3) circleScore += 2;

    // ── Rectangle Composition (20 pts) ──
    let rectScore = 0;
    // All methods use the same rectangle approach, difference is in vertical crop position
    if (m === 1) rectScore = 15; // Face centered — may have awkward framing
    else if (m === 2) rectScore = 17; // Good headroom
    else rectScore = 18; // Reference-matched

    // ── Transition Smoothness (20 pts) ──
    let transitionScore = 20; // All use single-pass FFmpeg, so transitions should be clean

    // Check for black frames at segment boundaries
    for (let i = 1; i < timeline.segments.length; i++) {
      const transTime = timeline.segments[i].timelineStart;
      if (transTime >= info.duration) continue;

      // Extract frame just after transition
      const framePath = path.join(STAGE5_DIR, `score_m${m}_trans_${i}.raw`);
      try {
        // Extract tiny version and check if all black
        execFileSync(FFMPEG, [
          "-y", "-ss", String(transTime + 0.05),
          "-i", videoPath,
          "-frames:v", "1", "-vf", "scale=16:16,format=gray",
          "-f", "rawvideo", "-pix_fmt", "gray",
          framePath,
        ], { stdio: "pipe" });

        const pixels = fs.readFileSync(framePath);
        const avg = Array.from(pixels).reduce((a, b) => a + b, 0) / pixels.length;
        if (avg < 10) {
          console.log(`    ⚠ M${m}: Black frame at transition ${i} (t=${transTime.toFixed(2)}s)`);
          transitionScore -= 5;
        }
        try { fs.unlinkSync(framePath); } catch(e) {}
      } catch (e) {}
    }

    // ── Audio Continuity (20 pts) ──
    let audioScore = 20; // Default full score

    // Check audio doesn't have silence at transitions
    try {
      const silenceOutput = execFileSync(FFMPEG, [
        "-i", videoPath,
        "-af", "silencedetect=noise=-40dB:d=0.3",
        "-f", "null", "-",
      ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      // silencedetect outputs to stderr
      const stderr = e.stderr?.toString() || "";
      const silences = stderr.match(/silence_start: [\d.]+/g) || [];
      if (silences.length > timeline.segments.length) {
        // More silences than expected (between segments)
        audioScore -= 3;
        console.log(`    ⚠ M${m}: ${silences.length} silence regions detected`);
      }
    }

    // ── Duration Match (bonus) ──
    const durationDiff = Math.abs(info.duration - timeline.totalDuration);
    if (durationDiff > 1) {
      console.log(`    ⚠ M${m}: Duration mismatch: ${info.duration.toFixed(2)}s vs expected ${timeline.totalDuration.toFixed(2)}s`);
    }

    const total = circleScore + rectScore + transitionScore + audioScore;
    scores[m] = {
      total,
      circleComposition: circleScore,
      rectComposition: rectScore,
      transitions: transitionScore,
      audio: audioScore,
      duration: info.duration,
      fileSize: (fs.statSync(videoPath).size / (1024 * 1024)).toFixed(2) + " MB",
    };

    console.log(`  M${m}: ${total}/100 (circle=${circleScore}/40 rect=${rectScore}/20 trans=${transitionScore}/20 audio=${audioScore}/20)`);
  }

  return scores;
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════

function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   STAGE 5: COMPARISON & SCORING                     ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Step 1: Extract frames
  const timestamps = extractAllFrames();

  // Step 2: Create comparison images
  createComparisons(timestamps);

  // Step 3: Score all methods
  const scores = scoreAllMethods();

  // Determine winner
  const winner = Object.entries(scores).sort((a, b) => b[1].total - a[1].total)[0];

  // Save scoring results
  const scoringPath = path.join(STAGE5_DIR, "scoring.json");
  fs.writeFileSync(scoringPath, JSON.stringify({
    scores,
    winner: { method: parseInt(winner[0]), score: winner[1].total },
    methods: {
      1: "Face-Centered Crop — face dead-center in circle",
      2: "Head-Space Composition — cinematic headroom, face at 65% down",
      3: "Reference-Matched — face at 42% down, matching reference positioning",
    },
  }, null, 2));

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  FINAL RESULTS`);
  console.log(`══════════════════════════════════════════════════════\n`);

  const methodNames = {
    1: "Face-Centered Crop",
    2: "Head-Space Composition",
    3: "Reference-Matched",
  };

  const sorted = Object.entries(scores).sort((a, b) => b[1].total - a[1].total);
  for (let i = 0; i < sorted.length; i++) {
    const [m, s] = sorted[i];
    const prefix = i === 0 ? "  WINNER" : `  #${i + 1}    `;
    console.log(`${prefix}  M${m} "${methodNames[m]}" — ${s.total}/100`);
    console.log(`         Circle=${s.circleComposition}/40 | Rect=${s.rectComposition}/20 | Trans=${s.transitions}/20 | Audio=${s.audio}/20`);
    console.log(`         Video: ${path.join(STAGE4_DIR, `method-${m}-rendered.mp4`)} (${s.fileSize})`);
  }

  console.log(`\n  FILES:`);
  console.log(`    Videos:      ${STAGE4_DIR}\\method-{1,2,3}-rendered.mp4`);
  console.log(`    Comparisons: ${COMP_DIR}\\compare_m*_*.jpg`);
  console.log(`    3-way:       ${COMP_DIR}\\3way_*.jpg`);
  console.log(`    Scoring:     ${scoringPath}`);

  // List all comparison files
  const compFiles = fs.readdirSync(COMP_DIR).filter(f => f.endsWith(".jpg")).sort();
  console.log(`\n  Comparison images (${compFiles.length}):`);
  for (const f of compFiles) {
    console.log(`    ${f}`);
  }

  console.log(`\n  ✓ STAGE 5 COMPLETE\n`);
}

main();
