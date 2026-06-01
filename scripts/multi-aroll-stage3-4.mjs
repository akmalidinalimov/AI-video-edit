/**
 * STAGE 3-4: Three Methods Design + Render
 *
 * Reads clean-timeline.json, dynamic-template.json, and reference measurements.
 * Designs 3 cropping methods for multi-A-roll → reference-style video.
 * Renders all 3 as single-pass FFmpeg with enable='between(t,...)'.
 *
 * Method 1: Face-Centered Crop — face dead-center in circle
 * Method 2: Head-Space Composition — cinematic headroom, face in lower 60%
 * Method 3: Reference-Matched — copy exact face positioning from reference video
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
const BROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const REF_PATH = path.join(ROOT, "public", "uploads", "IMG_6018.MOV");

// Load template from existing pipeline
const templatePath = path.join(ROOT, "public", "exports", "sp-temp", "dynamic-template.json");
const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));

// Load clean timeline
const timeline = JSON.parse(fs.readFileSync(path.join(STAGE2_DIR, "clean-timeline.json"), "utf-8"));

// Load face data for ALL clips (generic over clip count — read every contiguous
// clip_N_face.json starting at 0).
const faceData = {};
for (let i = 0; fs.existsSync(path.join(STAGE1_DIR, `clip_${i}_face.json`)); i++) {
  faceData[i] = JSON.parse(fs.readFileSync(path.join(STAGE1_DIR, `clip_${i}_face.json`), "utf-8"));
}

// Canvas size from template
const CANVAS_W = 1080;
const CANVAS_H = 1920;
const FPS = 30;

// ── DATA-DRIVEN circle-framing target (measured with YuNet on the REFERENCE
// video — see stage1/reference-circle-target.json). This is the ONE source of
// truth for how face-dominant the circle is; do NOT hand-guess crop constants.
const CIRCLE_TARGET = (() => {
  const def = { faceFraction: 0.54, faceCenterYIn: 0.33 };
  try {
    const t = JSON.parse(fs.readFileSync(
      path.join(STAGE1_DIR, "reference-circle-target.json"), "utf-8"));
    return { ...def, ...(t.target || {}) };
  } catch {
    return def;
  }
})();

// Per-method tightness offset applied to faceFraction. M2 = the reference-matched
// / user-preferred look; M1 a touch tighter (more face-dominant), M3 a touch
// looser (more shoulders). A LARGER faceFraction = the face fills more of the
// circle = a SMALLER source square.
const METHOD_FF_OFFSET = { 1: +0.04, 2: 0.0, 3: -0.04 };

// Reference circle position (from our S1 unified approach)
const REF_CIRCLE = { cx: 781, cy: 404, r: 214 };
const CIRCLE_REGION = { x: REF_CIRCLE.cx - REF_CIRCLE.r, y: REF_CIRCLE.cy - REF_CIRCLE.r, w: REF_CIRCLE.r * 2, h: REF_CIRCLE.r * 2 };

// Rectangle layout from template
const rectLayout = template.layouts.fullscreen_aroll;
const RECT_REGION = rectLayout ? rectLayout.aroll.region : { x: 0, y: 333, width: 1080, height: 627 };

/**
 * Load the reference video's per-segment layout (shape) from ground truth.
 * Returns an array aligned to narrative segment index:
 *   [{ shape: "rectangle"|"circle" }, ...]
 * Replicating this rhythm is what makes the output match the reference
 * (e.g. hook = 16:9 fullscreen, rest = circle PIP).
 * Falls back to an empty array (→ all circle) if the file is missing.
 */
function loadReferenceLayout() {
  const refPath = path.join(ROOT, "public", "exports", "sp-temp", "reference-ground-truth.json");
  try {
    const raw = JSON.parse(fs.readFileSync(refPath, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw.map(seg => ({
      shape: seg.shape === "rectangle" ? "rectangle" : "circle",
      circle: seg.circle || null,
      rect: seg.rect || null,
    }));
  } catch (e) {
    console.warn(`  ⚠ Could not load reference-ground-truth.json (${e.message}); defaulting all segments to circle.`);
    return [];
  }
}

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

function alignToFrame(t) {
  return Math.round(t * FPS) / FPS;
}

// ════════════════════════════════════════════════════════
// REFERENCE FACE ANALYSIS
// ════════════════════════════════════════════════════════

function analyzeReferenceFace() {
  console.log("  Analyzing reference video face positioning...\n");

  // Extract a frame from the reference circle PIP segment (around 5s)
  const framePath = path.join(STAGE4_DIR, "ref_circle_face.jpg");
  execFileSync(FFMPEG, [
    "-y", "-ss", "5", "-i", REF_PATH, "-frames:v", "1", "-q:v", "2", framePath,
  ], { stdio: "pipe" });

  // Crop just the circle PIP region from the reference frame
  const refInfo = getMediaInfo(REF_PATH);
  // The reference is 1072x1904 and already is the final output
  // The circle PIP in the reference: we know from blueprint cx=792, cy=397, r=214
  // The face within that circle sits at approximately y=35-45% of the circle diameter
  // from top of the circle (based on visual analysis of the existing renders)

  // Use the existing blueprint data: face is typically in the upper portion of the circle
  // In our A-roll source (1072x1920), face center is around y=330-440px (17-23% from top)
  // In the circle PIP (428x428), the face should be positioned similarly

  return {
    // How far down from the top of the circle region the face center sits (as ratio)
    faceCenterRatioY: 0.42, // ~42% down from top of circle = natural headroom
    faceCenterRatioX: 0.50, // centered horizontally
  };
}

// ════════════════════════════════════════════════════════
// CROP CALCULATION FOR 3 METHODS
// ════════════════════════════════════════════════════════

/**
 * Calculate crop parameters for extracting a square region from portrait A-roll
 * to fill a circle PIP.
 *
 * The goal: person should fill 85-90% of the circle with a small gap (8%)
 * between the top of their head and the circle border.
 *
 * @param srcW Source width (1072)
 * @param srcH Source height (1920)
 * @param targetSize Circle diameter (428)
 * @param faceTopY Top of face/head Y as ratio (0-1) in source
 * @param faceHeight Face height as ratio (0-1) in source
 * @param method 1=head-top-anchored, 2=tight-headroom, 3=reference-matched
 */
/**
 * calculateSquareCrop — THE single source of truth for cropping a talking
 * person. Per docs/cropping-rules.md (the user's diagram): ALWAYS produce a 1:1
 * SQUARE showing head + shoulders, small top gap, no default zoom. Both the
 * circle PIP path and the stacked (top/bottom) path consume this.
 *
 * Returns { cropX, cropY, cropSize } — a square region in source pixels.
 *
 * Inputs are RAW YuNet measurements (median.height = face box height, median
 * .centerY = face box center, etc.) — accurate and CONSISTENT across clips, so
 * the same target produces the same framing everywhere. No fragile head-extension
 * guess; the vertical position is set by the reference's measured face-center.
 *
 * Sizing model (data-driven, from stage1/reference-circle-target.json):
 *   squareSize = faceHeightPx / faceFraction
 *     → after scaling the square to the circle, the YuNet face box occupies
 *       `faceFraction` of the circle — matching the reference. Because YuNet
 *       faceHeight is consistent per clip (~0.247-0.250), squareSize is too.
 *   cropY positions the FACE CENTER at `faceCenterYIn` of the square (= of the
 *     circle), reproducing the reference's headroom/shoulder balance.
 */
function calculateSquareCrop(srcW, srcH, faceHeight, faceCenterX, faceCenterY, method, mode) {
  const faceHeightPx = Math.max(1, faceHeight * srcH);
  const faceCenterXPx = (faceCenterX ?? 0.5) * srcW;
  const faceCenterYPx = (faceCenterY ?? 0.42) * srcH;

  let faceFraction, faceCenterYIn;
  if (mode === "stack") {
    // Fullscreen hook square: a touch more face-dominant than the circle so the
    // speaker reads at full canvas width, head + shoulders filling the square.
    faceFraction = 0.40;
    faceCenterYIn = 0.36;
  } else {
    // Circle PIP — reference-matched, with a small per-method tightness offset.
    faceFraction = CIRCLE_TARGET.faceFraction + (METHOD_FF_OFFSET[method] || 0);
    faceCenterYIn = CIRCLE_TARGET.faceCenterYIn;
  }

  // squareSize so the detected face occupies `faceFraction` of the square.
  let squareSize = Math.round(faceHeightPx / faceFraction);
  // Clamp to the source (never exceed frame); the floor guards against a wild
  // under-measure, but YuNet is reliable so this rarely binds.
  squareSize = Math.max(420, Math.min(Math.min(srcW, srcH), squareSize));

  // Vertical: face CENTER sits `faceCenterYIn` of the square below the crop top.
  let cropY = Math.round(faceCenterYPx - squareSize * faceCenterYIn);
  cropY = Math.max(0, Math.min(srcH - squareSize, cropY));

  // Horizontal: center the square on the face, clamped to frame.
  let cropX = Math.round(faceCenterXPx - squareSize / 2);
  cropX = Math.max(0, Math.min(srcW - squareSize, cropX));

  return { cropX, cropY, cropSize: squareSize };
}

/**
 * STACKED layout geometry: the 1:1 square A-roll sits at the TOP of the canvas
 * (1080×1080), B-roll fills the BOTTOM (1080×840). This replaces the old
 * band-stretch "rectangle" — per docs/cropping-rules.md we never stretch a
 * portrait source into a wide band. The A-roll is always a square (from
 * calculateSquareCrop); here we just scale it to canvas width and place it on top.
 */
const STACK_SQUARE = { x: 0, y: 0, size: CANVAS_W }; // 1080×1080 square, top of 1080×1920 canvas


// ════════════════════════════════════════════════════════
// FFmpeg FILTER BUILDER
// ════════════════════════════════════════════════════════

function buildFilterGraph(methodNum, segments) {
  const filters = [];
  let stepNum = 0;
  let lastLabel = "bg";

  // Determine unique source clips needed
  const clipIndices = [...new Set(segments.map(s => s.sourceClipIndex))].sort();
  const clipInputMap = {}; // clipIndex → FFmpeg input index
  // Input 0 = B-roll, then A-roll clips in order
  clipIndices.forEach((ci, idx) => { clipInputMap[ci] = idx + 1; });

  const totalDuration = segments[segments.length - 1].timelineEnd;

  // Build time ranges for each segment
  const ranges = segments.map((seg, i) => {
    const start = alignToFrame(seg.timelineStart);
    const end = alignToFrame(seg.timelineEnd);
    return { ...seg, alignedStart: start, alignedEnd: end, rangeIndex: i };
  });

  // LAYOUT ASSIGNMENT — replicate the REFERENCE video's layout rhythm.
  // The reference (reference-ground-truth.json) defines a shape per segment:
  // seg_1 = rectangle (fullscreen A-roll, 0-5.2s), seg_2..N = circle PIP.
  // We map each timeline segment to the reference segment at the same narrative
  // position (by index). If reference data is missing or has fewer segments,
  // fall back to circle (keeps the speaker visible).
  const refLayout = loadReferenceLayout();
  for (let i = 0; i < ranges.length; i++) {
    const refSeg = refLayout[i];
    ranges[i].layoutType = refSeg ? refSeg.shape : "circle";
  }

  // ── MERGE contiguous same-clip + same-layout segments into RUNS ──
  // Two segments cut from the SAME source clip at a contiguous source boundary
  // (prev.sourceEnd ≈ next.sourceStart) are ONE continuous take. Rendering them
  // as two overlays (split + two enable windows) risked a 1-frame gap at the
  // internal boundary where NEITHER overlay was on → a blank circle MID-SENTENCE
  // (the ~19s seg2→seg3 bug). Merging the run into ONE overlay (single trim,
  // single transparent pad, single enable window) removes the boundary entirely,
  // so there is nothing to mis-abut. We split ONLY where the clip or layout
  // actually changes, or the source is non-contiguous.
  const runs = [];
  for (const r of ranges) {
    const prev = runs[runs.length - 1];
    const contiguous = prev &&
      prev.sourceClipIndex === r.sourceClipIndex &&
      prev.layoutType === r.layoutType &&
      Math.abs(prev.sourceEnd - r.sourceStart) < 0.6; // natural inter-sentence pause = still one take
    if (contiguous) {
      prev.sourceEnd = r.sourceEnd;
      prev.sourceDuration = Math.round((prev.sourceEnd - prev.sourceStart) * 1000) / 1000;
      prev.alignedEnd = r.alignedEnd;
      prev.mergedFrom.push(r.rangeIndex);
    } else {
      runs.push({
        sourceClipIndex: r.sourceClipIndex,
        layoutType: r.layoutType,
        sourceStart: r.sourceStart,
        sourceEnd: r.sourceEnd,
        sourceDuration: r.sourceDuration,
        alignedStart: r.alignedStart,
        alignedEnd: r.alignedEnd,
        mergedFrom: [r.rangeIndex],
      });
    }
  }

  // ── B-ROLL (Input 0): Scale to full canvas ──
  filters.push(`[0:v]setpts=PTS-STARTPTS,scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},setsar=1[bg]`);

  // ── A-ROLL INPUTS: split each clip by the NUMBER OF RUNS that use it ──
  for (const ci of clipIndices) {
    const inputIdx = clipInputMap[ci];
    const nRuns = runs.filter(rn => rn.sourceClipIndex === ci).length;

    if (nRuns === 1) {
      filters.push(`[${inputIdx}:v]setpts=PTS-STARTPTS[aroll_c${ci}_src]`);
    } else {
      const labels = Array.from({ length: nRuns }, (_, j) => `[aroll_c${ci}_s${j}]`).join("");
      filters.push(`[${inputIdx}:v]setpts=PTS-STARTPTS,split=${nRuns}${labels}`);
    }
  }

  // ── PER-RUN OVERLAYS ──
  for (let ri = 0; ri < runs.length; ri++) {
    const range = runs[ri];
    const ci = range.sourceClipIndex;
    const inputIdx = clipInputMap[ci];
    const clipRuns = runs.filter(rn => rn.sourceClipIndex === ci);
    const clipLocalIdx = clipRuns.indexOf(range);

    const srcLabel = clipRuns.length === 1
      ? `aroll_c${ci}_src`
      : `aroll_c${ci}_s${clipLocalIdx}`;

    // Face position for this clip (RAW YuNet measurements).
    const face = faceData[ci];
    const faceHeight = face ? face.median.height : 0.25;
    const faceCenterY = face ? face.median.centerY : 0.45;
    const faceCenterX = face ? face.median.centerX : 0.5;

    // Enable expression: exact frame-aligned boundaries.
    // Adjacent RUNS share the boundary frame — later overlay in chain wins,
    // which is the correct next run. NO half-frame offsets — those caused blank
    // circle frames because pad duration != enable start. Internal segment
    // boundaries no longer exist here (merged away), so there is no mid-run gap.
    const enableStart = range.alignedStart.toFixed(4);
    const enableEnd = ri === runs.length - 1
      ? (range.alignedEnd + 1).toFixed(4) // last run: extend past end
      : range.alignedEnd.toFixed(4);
    const enableExpr = `between(t,${enableStart},${enableEnd})`;

    // Source clip trimming: seek into the source clip for the whole run.
    const seekStart = range.sourceStart;
    const seekDuration = range.sourceDuration;

    if (range.layoutType === "rectangle") {
      // STACKED layout: 1:1 SQUARE A-roll on top (1080×1080) + B-roll below.
      // Crop the SAME square as the circle path (head+shoulders, no stretch),
      // scale to canvas width, place at top. B-roll [bg] shows through bottom 840px.
      const sq = calculateSquareCrop(1072, 1920, faceHeight, faceCenterX, faceCenterY, methodNum, "stack");
      const placeSize = STACK_SQUARE.size; // 1080

      filters.push(
        `[${srcLabel}]trim=start=${seekStart.toFixed(4)}:duration=${seekDuration.toFixed(4)},setpts=PTS-STARTPTS,` +
        `crop=${sq.cropSize}:${sq.cropSize}:${sq.cropX}:${sq.cropY},` +
        `scale=${placeSize}:${placeSize},setsar=1[sqr_${ri}]`
      );

      filters.push(`[${lastLabel}][sqr_${ri}]overlay=${STACK_SQUARE.x}:${STACK_SQUARE.y}:enable='${enableExpr}'[step${stepNum}]`);
      lastLabel = `step${stepNum}`;
      stepNum++;

    } else {
      // Circle PIP — same 1:1 square crop, then masked into a circle.
      const targetSize = CIRCLE_REGION.w;
      const circCrop = calculateSquareCrop(1072, 1920, faceHeight, faceCenterX, faceCenterY, methodNum, "circle");
      const timelineStart = range.alignedStart;

      // GUARD against the pad/enable frame-rounding gap that left a 1-FRAME BLANK
      // circle at clip-change transitions: `color d=timelineStart` rounds UP to
      // whole frames, so the masked content started ~2 frames AFTER its enable
      // window opened — the border ring showed but the interior was still the
      // transparent pad (B-roll showed through). Fix: trim the source GUARD frames
      // early and GUARD frames long on each side, and SHORTEN the pad by the same
      // lead, so the content's PTS still aligns source[seekStart] → timelineStart
      // but the content fully COVERS the enable window with margin on both ends.
      // There is then no frame where the overlay is enabled yet still transparent.
      const GUARD = 3 / FPS;
      const cLead = timelineStart > GUARD + 0.01 ? Math.min(GUARD, seekStart) : 0;
      const cSeekStart = seekStart - cLead;
      const cDuration = seekDuration + cLead + GUARD;
      const padDur = timelineStart - cLead;

      // Trim, crop square, scale to circle diameter, apply circle mask
      filters.push(
        `[${srcLabel}]trim=start=${cSeekStart.toFixed(4)}:duration=${cDuration.toFixed(4)},` +
        `setpts=PTS-STARTPTS,` +
        `crop=${circCrop.cropSize}:${circCrop.cropSize}:${circCrop.cropX}:${circCrop.cropY},` +
        `scale=${targetSize}:${targetSize},setsar=1[circ_raw_${ri}]`
      );

      // Apply circle mask via geq
      const radius = targetSize / 2;
      const cx = targetSize / 2;
      const cy = targetSize / 2;
      filters.push(
        `[circ_raw_${ri}]format=yuva420p,` +
        `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':` +
        `a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${radius},2)),255,0)'[circ_content_${ri}]`
      );

      // CRITICAL FIX for frozen video: Prepend transparent frames to align
      // the overlay stream with the main timeline.
      //
      // Problem: FFmpeg overlay consumes BOTH inputs in sync. Without padding,
      // an overlay with PTS starting at 0 gets consumed during the period before
      // its enable window opens. By the time enable fires, the overlay is partially
      // or fully at EOF → frozen/missing.
      //
      // Solution: Prepend transparent frames of duration=timelineStart. The overlay
      // filter consumes transparent frames during the off period, then real face
      // content becomes available exactly when the enable window opens.
      if (padDur > 0.01) {
        // Transparent pad shortened by cLead so content is ready BEFORE enable.
        filters.push(
          `color=black@0.0:s=${targetSize}x${targetSize}:r=${FPS}:d=${padDur.toFixed(4)},format=yuva420p[circ_pad_${ri}]`
        );
        // Concatenate: transparent pad + face content
        filters.push(
          `[circ_pad_${ri}][circ_content_${ri}]concat=n=2:v=1:a=0[circ_${ri}]`
        );
      } else {
        // First segment starts at t=0, no pad needed
        filters.push(`[circ_content_${ri}]copy[circ_${ri}]`);
      }

      // Border ring (generated color source, never runs out — no pad needed)
      const borderWidth = 4;
      const borderDiameter = targetSize + borderWidth * 2;
      const borderRadius = borderDiameter / 2;
      const borderCx = borderDiameter / 2;
      const borderCy = borderDiameter / 2;
      filters.push(
        `color=white@0.6:s=${borderDiameter}x${borderDiameter}:r=${FPS}:d=999,format=yuva420p,` +
        `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':` +
        `a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderRadius},2)),` +
        `if(gt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderRadius - borderWidth},2)),` +
        `255,0),0)'[border_${ri}]`
      );

      // Overlay border then circle (with eof_action=pass for robustness)
      const overlayX = CIRCLE_REGION.x - borderWidth;
      const overlayY = CIRCLE_REGION.y - borderWidth;
      filters.push(`[${lastLabel}][border_${ri}]overlay=${overlayX}:${overlayY}:enable='${enableExpr}'[step${stepNum}]`);
      lastLabel = `step${stepNum}`;
      stepNum++;

      filters.push(`[${lastLabel}][circ_${ri}]overlay=${CIRCLE_REGION.x}:${CIRCLE_REGION.y}:enable='${enableExpr}':eof_action=pass[step${stepNum}]`);
      lastLabel = `step${stepNum}`;
      stepNum++;
    }
  }

  // Final output label
  filters.push(`[${lastLabel}]null[vout]`);

  return {
    filterStr: filters.join(";\n"),
    clipInputMap,
    clipIndices,
    totalDuration,
  };
}

// ════════════════════════════════════════════════════════
// AUDIO: Stitch A-roll audio segments
// ════════════════════════════════════════════════════════

function buildAudioConcat(segments) {
  // Build audio with ZERO-DELAY transitions between segments.
  // Uses concat filter (no crossfade) for immediate back-to-back playback.
  // Source trims must be precise — trim at exact speech boundaries.
  //
  // A tiny crossfade (1 frame = 33ms) is applied ONLY to prevent digital
  // clicks from abrupt waveform discontinuities. This is imperceptible
  // and does not create any audible delay or gap.
  const audioFilters = [];
  const clipIndices = [...new Set(segments.map(s => s.sourceClipIndex))].sort();

  // Step 1: Trim each segment from its source
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const ci = seg.sourceClipIndex;
    const inputIdx = clipIndices.indexOf(ci) + 1; // +1 because 0 is B-roll

    audioFilters.push(
      `[${inputIdx}:a]atrim=start=${seg.sourceStart.toFixed(4)}:duration=${seg.sourceDuration.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`
    );
  }

  // Step 2: Chain segments with minimal crossfade to prevent clicks.
  // For segments from the SAME source clip with contiguous ranges,
  // use concat (no crossfade) since audio is naturally continuous.
  // For segments from DIFFERENT clips, use tiny crossfade (33ms) to prevent clicks.
  if (segments.length === 1) {
    audioFilters.push(`[a0]anull[aout]`);
  } else {
    const crossfadeDuration = 0.033; // 1 frame at 30fps — anti-click only
    let prevLabel = "a0";
    for (let i = 1; i < segments.length; i++) {
      const outLabel = i === segments.length - 1 ? "aout" : `ax${i}`;
      const prevSeg = segments[i - 1];
      const currSeg = segments[i];

      // Check if same clip with contiguous source range (no crossfade needed)
      const sameClip = prevSeg.sourceClipIndex === currSeg.sourceClipIndex;
      const contiguous = sameClip && Math.abs(prevSeg.sourceEnd - currSeg.sourceStart) < 0.05;

      if (contiguous) {
        // Same clip, contiguous audio — hard concat, no crossfade
        audioFilters.push(
          `[${prevLabel}][a${i}]concat=n=2:v=0:a=1[${outLabel}]`
        );
      } else {
        // Different clips — minimal crossfade to prevent waveform click
        audioFilters.push(
          `[${prevLabel}][a${i}]acrossfade=d=${crossfadeDuration}:c1=tri:c2=tri[${outLabel}]`
        );
      }
      prevLabel = outLabel;
    }
  }

  return audioFilters.join(";\n");
}

// ════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════

function renderMethod(methodNum, methodName) {
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  METHOD ${methodNum}: ${methodName}`);
  console.log(`══════════════════════════════════════════════════════\n`);

  const segments = timeline.segments;
  const { filterStr, clipIndices, totalDuration } = buildFilterGraph(methodNum, segments);
  const audioFilter = buildAudioConcat(segments);

  const fullFilter = filterStr + ";\n" + audioFilter;

  // Save filter for debugging
  const filterPath = path.join(STAGE4_DIR, `method-${methodNum}-filter.txt`);
  fs.writeFileSync(filterPath, fullFilter);
  console.log(`  Filter saved: ${filterPath}`);
  console.log(`  Filter stages: ${fullFilter.split(";\n").length}`);

  // Build FFmpeg command
  const outputPath = path.join(STAGE4_DIR, `method-${methodNum}-rendered.mp4`);
  const args = ["-y"];

  // Input 0: B-roll
  args.push("-i", BROLL_PATH);

  // Inputs 1..N: A-roll clips (in order of clipIndices)
  for (const ci of clipIndices) {
    const seg = segments.find(s => s.sourceClipIndex === ci);
    args.push("-i", seg.sourceClipPath);
  }

  args.push(
    "-filter_complex", fullFilter,
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "128k",
    "-t", totalDuration.toFixed(4),
    "-r", String(FPS),
    "-s", `${CANVAS_W}x${CANVAS_H}`,
    outputPath,
  );

  console.log(`  Rendering (${totalDuration.toFixed(1)}s video)...\n`);

  const startTime = Date.now();
  try {
    execFileSync(FFMPEG, args, { stdio: "pipe", timeout: 600000 });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const fileSize = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
    console.log(`  ✓ Render OK (${elapsed}s, ${fileSize} MB)`);
    console.log(`  Output: ${outputPath}\n`);
    return true;
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`  ✗ Render FAILED (${elapsed}s)`);
    const stderr = err.stderr?.toString() || "";
    // Show last 10 lines of error
    const lines = stderr.split("\n").filter(l => l.trim());
    console.error("  Last error lines:");
    for (const line of lines.slice(-10)) {
      console.error(`    ${line}`);
    }
    return false;
  }
}

// ════════════════════════════════════════════════════════
// FRAME EXTRACTION FOR COMPARISON
// ════════════════════════════════════════════════════════

function extractComparisonFrames(methodNum) {
  const outputPath = path.join(STAGE4_DIR, `method-${methodNum}-rendered.mp4`);
  if (!fs.existsSync(outputPath)) return;

  // Extract frames at each segment boundary + midpoint
  const timestamps = [1, 3, 8, 15, 22, 30];
  for (const t of timestamps) {
    if (t >= timeline.totalDuration) continue;
    const framePath = path.join(STAGE4_DIR, `method-${methodNum}-frame-${t}s.jpg`);
    try {
      execFileSync(FFMPEG, [
        "-y", "-ss", String(t), "-i", outputPath, "-frames:v", "1", "-q:v", "2", framePath,
      ], { stdio: "pipe" });
    } catch (e) {}
  }
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════

function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   STAGE 3-4: THREE METHODS — DESIGN & RENDER        ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log(`  Timeline: ${timeline.segmentCount} segments, ${timeline.totalDuration.toFixed(2)}s`);
  console.log(`  Canvas: ${CANVAS_W}x${CANVAS_H}`);
  console.log(`  Circle PIP: cx=${REF_CIRCLE.cx}, cy=${REF_CIRCLE.cy}, r=${REF_CIRCLE.r}`);
  console.log(`  Rectangle: ${RECT_REGION.x},${RECT_REGION.y} ${RECT_REGION.width}x${RECT_REGION.height}`);

  // Show face data
  console.log("\n  Face positions per clip:");
  for (const [ci, face] of Object.entries(faceData)) {
    const px = face.medianPixels;
    console.log(`    Clip ${ci}: center=(${px.centerX}, ${px.centerY}) topY=${px.topY} faceH=${px.faceHeight}`);
  }

  // Analyze reference
  analyzeReferenceFace();

  // Method descriptions
  const methods = [
    { num: 1, name: "Tight Head-Top (8%)", desc: "Head top at 8% from circle border. Maximum face fill ~90%." },
    { num: 2, name: "Moderate Headroom (12%)", desc: "Head top at 12% from border. Slightly more breathing room." },
    { num: 3, name: "Reference-Matched (10%)", desc: "Head top at 10% from border. Natural balance matching reference." },
  ];

  // Optional single-method filter for fast closed-loop iteration:
  //   node multi-aroll-stage3-4.mjs --method 2   (or METHOD=2 env)
  const methodArgIdx = process.argv.indexOf("--method");
  const onlyMethod = methodArgIdx >= 0 ? Number(process.argv[methodArgIdx + 1])
    : (process.env.METHOD ? Number(process.env.METHOD) : null);
  const methodsToRender = onlyMethod ? methods.filter(m => m.num === onlyMethod) : methods;

  console.log("\n  Methods:");
  for (const m of methodsToRender) {
    console.log(`    M${m.num}: ${m.name} — ${m.desc}`);
  }

  // Render
  const results = [];
  for (const m of methodsToRender) {
    const success = renderMethod(m.num, m.name);
    results.push({ ...m, success });
    if (success) {
      extractComparisonFrames(m.num);
    }
  }

  // Save method designs
  const designPath = path.join(ROOT, "public", "exports", "multi-aroll", "stage3", "method-designs.json");
  fs.writeFileSync(designPath, JSON.stringify({ methods, results }, null, 2));

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  STAGE 3-4 RESULTS");
  console.log("══════════════════════════════════════════════════════\n");

  for (const r of results) {
    console.log(`  M${r.num} ${r.name}: ${r.success ? "✓ RENDERED" : "✗ FAILED"}`);
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`\n  ${successCount}/${methodsToRender.length} methods rendered successfully`);
  console.log("\n  ✓ STAGE 3-4 COMPLETE\n");
}

main();
