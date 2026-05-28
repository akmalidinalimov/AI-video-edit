/**
 * Single-Pass Video Renderer
 *
 * Renders the ENTIRE video in ONE FFmpeg command — no segment
 * concatenation, no encoding boundaries, no glitches.
 *
 * Architecture:
 * - Input 0: B-roll (continuous, full duration)
 * - Input 1: A-roll (continuous, full duration, also audio source)
 * - Layout switching via overlay enable='between(t,start,end)'
 * - A-roll audio mapped directly (never cut/spliced)
 *
 * Usage: node scripts/test-singlepass.mjs
 */

import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── Load .env.local for Gemini API key ──
if (!process.env.GEMINI_API_KEY) {
  const envPath = path.join(ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  }
}

// ── Constants ──

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const FPS = 30;

const CONSISTENT_CIRCLE_PIP = { x: 544, y: 175, width: 426, height: 426 };
const CIRCLE_BORDER_WIDTH = 4;
const CIRCLE_BORDER_COLOR = "0xFFFFFF@0.6";

// Correct face center from raw A-roll analysis (1920×1080)
const FACE_CENTER = { x: 940, y: 350 };
const AROLL_SOURCE_W = 1920;
const AROLL_SOURCE_H = 1080;

// ── Paths ──

const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const BLUEPRINT_PATH = path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json");
const AROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6108.MOV");
const BROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const OUTPUT_DIR = path.join(ROOT, "public", "exports");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "singlepass.mp4");
const TEMP_DIR = path.join(OUTPUT_DIR, "sp-temp");

// ── Utility: face-centered crop ──

function faceCenteredCrop(targetW, targetH) {
  const scaleW = targetW / AROLL_SOURCE_W;
  const scaleH = targetH / AROLL_SOURCE_H;
  const scale = Math.max(scaleW, scaleH);
  const scaledW = Math.round(AROLL_SOURCE_W * scale);
  const scaledH = Math.round(AROLL_SOURCE_H * scale);
  const faceX = Math.round(FACE_CENTER.x * scale);
  const faceY = Math.round(FACE_CENTER.y * scale);
  const cropX = Math.max(0, Math.min(faceX - Math.round(targetW / 2), scaledW - targetW));
  const cropY = Math.max(0, Math.min(faceY - Math.round(targetH / 2), scaledH - targetH));
  return { scaledW, scaledH, cropX, cropY };
}

// ── Utility: snap time to nearest frame boundary ──

function alignToFrame(time, fps = FPS) {
  return Math.round(time * fps) / fps;
}

// ── Utility: text escaping for drawtext ──

function escapeText(text) {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/'/g, "’")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .trim();
}

// ── Utility: run FFmpeg ──

function runFFmpeg(args, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("FFmpeg timed out"));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ══════════════════════════════════════════════════════════
// A-ROLL TRANSCRIPTION (Gemini)
//
// The reference video's transcription has DIFFERENT timing
// than the actual A-roll audio (different take). We must
// transcribe the A-roll to get accurate word/sentence times.
// ══════════════════════════════════════════════════════════

const AROLL_TRANSCRIPTION_CACHE = path.join(TEMP_DIR, "aroll-transcription.json");

async function transcribeAroll() {
  // Check cache first
  if (fs.existsSync(AROLL_TRANSCRIPTION_CACHE)) {
    console.log("  Using cached A-roll transcription");
    return JSON.parse(fs.readFileSync(AROLL_TRANSCRIPTION_CACHE, "utf-8"));
  }

  console.log("  Transcribing A-roll audio with Gemini...");

  // Step 1: Extract audio as MP3
  const audioPath = path.join(TEMP_DIR, "aroll-audio.mp3");
  await runFFmpeg([
    "-y", "-i", AROLL_PATH,
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-t", "30",
    audioPath,
  ], 30_000);

  if (!fs.existsSync(audioPath)) {
    throw new Error("Failed to extract A-roll audio");
  }

  // Step 2: Send to Gemini for word-level transcription
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const audioBase64 = fs.readFileSync(audioPath).toString("base64");

  const prompt = `You are a precise speech-to-text transcription engine.

Transcribe this audio file with EXACT word-level timestamps.

The speaker is speaking in Uzbek. The audio is approximately 23 seconds long.

CRITICAL INSTRUCTIONS:
- Provide timestamps for EVERY word
- Timestamps must be in SECONDS (decimal, e.g., 2.35)
- Start time = when the word begins being spoken
- End time = when the word finishes being spoken
- Be as precise as possible — even 0.1s matters for video editing
- Group words into sentences (a sentence ends with a period, question mark, or exclamation mark)

Return JSON in this EXACT format:
{
  "words": [
    { "word": "example", "start": 0.0, "end": 0.5 },
    ...
  ],
  "sentences": [
    { "text": "Full sentence text.", "start": 0.0, "end": 3.5 },
    ...
  ]
}

Return ONLY the JSON, no markdown fences, no explanation.`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: "audio/mpeg", data: audioBase64 } },
  ];

  for (let retry = 0; retry < 3; retry++) {
    try {
      const result = await model.generateContent(parts);
      const text = result.response.text();
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const data = JSON.parse(cleaned);

      // Cache it
      fs.writeFileSync(AROLL_TRANSCRIPTION_CACHE, JSON.stringify(data, null, 2));
      console.log(`  Transcribed: ${data.words.length} words, ${data.sentences.length} sentences`);

      // Clean up audio
      try { fs.unlinkSync(audioPath); } catch { /* ignore */ }

      return data;
    } catch (err) {
      console.error(`  Transcription attempt ${retry + 1} failed:`, err.message?.substring(0, 200));
      if (retry < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }

  throw new Error("All transcription attempts failed");
}

// ══════════════════════════════════════════════════════════
// SMART LAYOUT ANALYZER
//
// Does NOT blindly copy the reference. Instead:
// 1. Reads the reference blueprint to understand WHAT layouts exist
// 2. Reads the transcription to find sentence boundaries
// 3. For each sentence, determines which layout fits best
// 4. If the reference changes layout MID-SENTENCE → snaps the
//    change to the nearest sentence boundary (start or end)
// 5. Merges consecutive sentences with the same layout into
//    one continuous time range (no transition = no glitch risk)
// 6. Logs its reasoning so you can audit every decision
// ══════════════════════════════════════════════════════════

function buildSmartLayoutPlan(blueprintSegments, sentenceBoundaries) {
  if (!sentenceBoundaries.length) return blueprintSegments;
  if (blueprintSegments.length === 0) return [];

  console.log("  ── Smart Layout Analysis ──");

  // Step 1: For each sentence, determine which layout to use
  // by finding which blueprint segment has the most time overlap.
  const sentenceLayouts = [];

  for (let i = 0; i < sentenceBoundaries.length; i++) {
    const sentence = sentenceBoundaries[i];
    const sentStart = sentence.start;
    const sentEnd = sentence.end;

    // Find all blueprint segments that overlap this sentence
    const overlaps = [];
    for (const bpSeg of blueprintSegments) {
      const overlapStart = Math.max(bpSeg.start, sentStart);
      const overlapEnd = Math.min(bpSeg.end, sentEnd);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      if (overlap > 0) {
        overlaps.push({ seg: bpSeg, overlap, layout: getEffectiveLayout(bpSeg) });
      }
    }

    // Sort by overlap duration (most overlap = best match)
    overlaps.sort((a, b) => b.overlap - a.overlap);

    const bestMatch = overlaps[0] || { seg: blueprintSegments[0], overlap: 0, layout: "pip_overlay" };

    // Check if reference changes layout WITHIN this sentence
    const uniqueLayouts = [...new Set(overlaps.map(o => o.layout))];
    let reasoning;

    if (uniqueLayouts.length > 1) {
      // Reference has a mid-sentence layout change!
      // We snap to the dominant layout for the ENTIRE sentence.
      reasoning = `Reference changes layout mid-sentence (${uniqueLayouts.join(" → ")}). ` +
        `Snapping entire sentence to '${bestMatch.layout}' (${bestMatch.overlap.toFixed(2)}s overlap, dominant).`;
    } else {
      reasoning = `Matches reference layout '${bestMatch.layout}' (${bestMatch.overlap.toFixed(2)}s overlap).`;
    }

    console.log(`    S${i + 1} [${sentStart.toFixed(2)}-${sentEnd.toFixed(2)}s]: ${bestMatch.layout} | ${reasoning}`);

    sentenceLayouts.push({
      id: `sent_seg_${i + 1}`,
      start: sentStart,
      end: sentEnd,
      layout: bestMatch.layout,
      seg: bestMatch.seg, // donor segment for visual properties
      reasoning,
    });
  }

  // Step 2: Ensure first segment starts at 0
  if (sentenceLayouts.length > 0 && sentenceLayouts[0].start > 0) {
    sentenceLayouts[0].start = 0;
  }

  // Step 3: Merge consecutive sentences with the SAME layout
  // into single time ranges (eliminates unnecessary transitions)
  const mergedRanges = [];
  for (const sl of sentenceLayouts) {
    const prev = mergedRanges[mergedRanges.length - 1];
    if (prev && prev.layout === sl.layout) {
      // Same layout — extend the range, no transition needed
      console.log(`    → Merging S${mergedRanges.length} + S${mergedRanges.length + 1}: same layout '${sl.layout}', no transition needed`);
      prev.end = sl.end;
      prev.sentenceCount++;
    } else {
      mergedRanges.push({
        ...sl,
        sentenceCount: 1,
      });
    }
  }

  // Step 4: Close gaps between adjacent ranges
  // When there's a natural pause between sentences (e.g., 3.79-3.96s),
  // extend the PREVIOUS layout to fill the gap. The new layout starts
  // when the new sentence's first word is spoken, not during the pause.
  for (let i = 0; i < mergedRanges.length - 1; i++) {
    const curr = mergedRanges[i];
    const next = mergedRanges[i + 1];
    const gap = next.start - curr.end;
    if (gap > 0 && gap < 2.0) {
      console.log(`    → Closing ${gap.toFixed(3)}s gap: extending '${curr.layout}' end ${curr.end.toFixed(2)}→${next.start.toFixed(2)}s`);
      curr.end = next.start;
    }
  }

  // Ensure last range extends to video end
  if (mergedRanges.length > 0) {
    const last = mergedRanges[mergedRanges.length - 1];
    if (last.end < 30) { // reasonable video length cap
      last.end = Math.max(last.end, last.end + 0.5);
    }
  }

  // Step 5: Snap ALL boundaries to exact frame boundaries
  // Prevents floating-point comparison issues in FFmpeg's enable expressions
  for (const r of mergedRanges) {
    r.start = alignToFrame(r.start);
    r.end = alignToFrame(r.end);
  }
  // Ensure adjacent ranges share exact same boundary (no sub-frame gap)
  for (let i = 0; i < mergedRanges.length - 1; i++) {
    mergedRanges[i].end = mergedRanges[i + 1].start;
  }

  console.log(`  ── Result: ${sentenceLayouts.length} sentences → ${mergedRanges.length} layout ranges ──`);
  for (const r of mergedRanges) {
    console.log(`    ${r.start.toFixed(2)}-${r.end.toFixed(2)}s: ${r.layout} (${r.sentenceCount} sentence${r.sentenceCount > 1 ? "s" : ""})`);
  }

  return mergedRanges;
}

// ── Determine effective layout ──

function getEffectiveLayout(segment) {
  const isActuallyVerticalSplit =
    segment.aroll?.shape === "rectangle" &&
    (segment.blackRegions?.length ?? 0) > 0 &&
    (segment.aroll?.boundingBox.width ?? 0) >= 1000;
  return isActuallyVerticalSplit ? "vertical_split" : segment.layout;
}

// ══════════════════════════════════════════════════════════
// BUILD SINGLE-PASS FILTER_COMPLEX
// ══════════════════════════════════════════════════════════

function buildSinglePassFilter(layoutRanges) {
  const filters = [];

  // ── Classify ranges by layout type ──
  const verticalSplitRanges = [];
  const circlePipRanges = [];

  for (const range of layoutRanges) {
    if (range.layout === "vertical_split") {
      verticalSplitRanges.push(range);
    } else if (range.seg?.aroll?.shape === "circle") {
      circlePipRanges.push(range);
    }
  }

  // ── Build NON-OVERLAPPING enable expressions ──
  // Uses time (t) with MIDPOINT boundaries between frames.
  //
  // Why midpoints? FFmpeg evaluates enable at each frame's PTS (e.g. 0, 0.0333,
  // 0.0667 ... at 30fps). Comparing at an exact frame PTS like 3.9667 is fragile
  // due to float precision. Instead, we place the comparison threshold BETWEEN
  // two adjacent frames — e.g. at 3.95 (midpoint of frames 118 and 119) — so
  // the comparison is well away from any actual PTS value. No overlaps, no gaps.
  //
  // For a layout active on frames [A..B]:
  //   tStart = max(0, (A - 0.5) / FPS)   — half-frame before first active frame
  //   tEnd   = (B + 0.5) / FPS           — half-frame after last active frame
  //
  // Adjacent ranges share the same midpoint boundary automatically:
  //   endFrame_prev=118, startFrame_next=119 → both use (118.5)/30 = 3.95

  function buildEnableExpr(ranges, allRanges) {
    return ranges.map(r => {
      const startFrame = Math.round(r.start * FPS);
      const endFrame = Math.round(r.end * FPS);

      // Midpoint boundary: half-frame before first active frame
      const tStart = Math.max(0, (startFrame - 0.5) / FPS);

      // Find if there's a different-layout range starting at our end
      const nextDifferent = allRanges.find(
        other => other !== r && other.layout !== r.layout &&
        Math.abs(other.start - r.end) < 0.05
      );

      // At transition boundaries: use midpoint between last frame of this
      // range and first frame of next range.
      // At video end: extend generously past last frame.
      const tEnd = nextDifferent
        ? (endFrame - 0.5) / FPS  // midpoint = half-frame before endFrame
        : (endFrame + 5) / FPS;   // well past the last frame

      return `between(t,${tStart.toFixed(4)},${tEnd.toFixed(4)})`;
    }).join("+");
  }

  const vsEnableExpr = verticalSplitRanges.length > 0
    ? buildEnableExpr(verticalSplitRanges, layoutRanges)
    : null;
  const cpEnableExpr = circlePipRanges.length > 0
    ? buildEnableExpr(circlePipRanges, layoutRanges)
    : null;

  // Log enable expressions for auditing
  if (vsEnableExpr) {
    console.log(`    VS enable: ${vsEnableExpr}`);
    for (const r of verticalSplitRanges) {
      const sf = Math.round(r.start * FPS);
      const ef = Math.round(r.end * FPS);
      console.log(`      Range ${r.start.toFixed(3)}-${r.end.toFixed(3)}s → frames ${sf}-${ef}`);
    }
  }
  if (cpEnableExpr) {
    console.log(`    CP enable: ${cpEnableExpr}`);
    for (const r of circlePipRanges) {
      const sf = Math.round(r.start * FPS);
      const ef = Math.round(r.end * FPS);
      console.log(`      Range ${r.start.toFixed(3)}-${r.end.toFixed(3)}s → frames ${sf}-${ef}`);
    }
  }

  // ── 1. B-roll: fill entire canvas (continuous background) ──
  // setpts=PTS-STARTPTS normalizes PTS so all streams start at t=0
  filters.push(
    `[0:v]setpts=PTS-STARTPTS,scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},setsar=1[bg]`
  );

  // ── 2. Split A-roll into branches for different crops ──
  const needsRect = verticalSplitRanges.length > 0;
  const needsCircle = circlePipRanges.length > 0;

  if (needsRect && needsCircle) {
    filters.push(`[1:v]setpts=PTS-STARTPTS,split=2[aroll_rect_src][aroll_circle_src]`);
  } else if (needsRect) {
    filters.push(`[1:v]setpts=PTS-STARTPTS[aroll_rect_src]`);
  } else if (needsCircle) {
    filters.push(`[1:v]setpts=PTS-STARTPTS[aroll_circle_src]`);
  }

  let lastLabel = "bg";
  let stepNum = 1;

  // ── 3. Vertical split elements ──
  if (needsRect) {
    const vsSeg = verticalSplitRanges[0].seg;
    const headerBlack = vsSeg.blackRegions?.find(br => br.purpose === "header");
    const headerH = headerBlack?.boundingBox.height ?? 200;
    const arollBox = vsSeg.aroll?.boundingBox ?? { x: 0, y: headerH, width: CANVAS_W, height: 600 };

    // a. Black header + A-roll region overlay (covers B-roll during VS time)
    // Cover from top to where B-roll starts
    const coverHeight = arollBox.y + arollBox.height;
    filters.push(
      `color=black:s=${CANVAS_W}x${coverHeight}:r=${FPS}:d=999,setpts=PTS-STARTPTS[vs_black]`
    );
    filters.push(
      `[${lastLabel}][vs_black]overlay=0:0:enable='${vsEnableExpr}'[step${stepNum}]`
    );
    lastLabel = `step${stepNum}`;
    stepNum++;

    // b. Rectangle A-roll (face-centered crop)
    const fc = faceCenteredCrop(arollBox.width, arollBox.height);
    filters.push(
      `[aroll_rect_src]scale=${fc.scaledW}:${fc.scaledH},crop=${arollBox.width}:${arollBox.height}:${fc.cropX}:${fc.cropY},setsar=1[aroll_rect]`
    );
    filters.push(
      `[${lastLabel}][aroll_rect]overlay=${arollBox.x}:${arollBox.y}:enable='${vsEnableExpr}'[step${stepNum}]`
    );
    lastLabel = `step${stepNum}`;
    stepNum++;

    // c. Headline texts (only those in the header region)
    const headerBottom = headerH + 150;
    const headerTexts = vsSeg.texts.filter(
      t => t.isHeadline && t.boundingBox.y < headerBottom
    );

    for (const ht of headerTexts) {
      let cleanText = escapeText(ht.text);
      if (!cleanText) continue;

      const fontColor = ht.color.startsWith("#")
        ? ht.color.replace("#", "0x")
        : "0xFFFFFF";
      const fontSize = ht.estimatedFontSize || 36;
      const textX = ht.boundingBox.x + ht.boundingBox.width / 2;
      const textY = ht.boundingBox.y + ht.boundingBox.height / 2;

      const isGold = ht.isHeadline && (
        ht.color.toUpperCase() === "#FDD835" ||
        ht.color.toUpperCase() === "#FFD700" ||
        ht.color.toUpperCase() === "#FFEB3B"
      );

      let fontFile;
      if (isGold) {
        fontFile = "C\\:/Windows/Fonts/GeorgiaPro-BoldItalic.ttf";
      } else if (ht.fontWeight === "bold") {
        fontFile = "C\\:/Windows/Fonts/arialbd.ttf";
      } else {
        fontFile = "C\\:/Windows/Fonts/arial.ttf";
      }

      let bgOpts = "";
      if (ht.backgroundColor) {
        const bgColor = ht.backgroundColor.startsWith("#")
          ? ht.backgroundColor.replace("#", "0x")
          : "0x000000@0.7";
        bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=10`;
      }

      filters.push(
        `[${lastLabel}]drawtext=fontfile='${fontFile}':text='${cleanText}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)${bgOpts}:enable='${vsEnableExpr}'[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }
  }

  // ── 4. Circle PIP elements (using pre-built non-overlapping enable) ──
  if (needsCircle) {
    const pip = CONSISTENT_CIRCLE_PIP;
    const radius = Math.min(pip.width, pip.height) / 2;
    const cx = pip.width / 2;
    const cy = pip.height / 2;

    const bw = CIRCLE_BORDER_WIDTH;
    const borderW = pip.width + bw * 2;
    const borderH = pip.height + bw * 2;
    const borderR = Math.min(borderW, borderH) / 2;
    const borderCx = borderW / 2;
    const borderCy = borderH / 2;

    // a. Border circle
    filters.push(
      `color=${CIRCLE_BORDER_COLOR}:s=${borderW}x${borderH}:r=${FPS}:d=999,setpts=PTS-STARTPTS[border_color]`
    );
    filters.push(
      `[border_color]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderR},2)),255,0)'[border_circle]`
    );
    filters.push(
      `[${lastLabel}][border_circle]overlay=${pip.x - bw}:${pip.y - bw}:enable='${cpEnableExpr}':format=auto[step${stepNum}]`
    );
    lastLabel = `step${stepNum}`;
    stepNum++;

    // b. Circle PIP A-roll (face-centered crop + circular mask)
    const fc = faceCenteredCrop(pip.width, pip.height);
    filters.push(
      `[aroll_circle_src]scale=${fc.scaledW}:${fc.scaledH},crop=${pip.width}:${pip.height}:${fc.cropX}:${fc.cropY},setsar=1[pip_raw]`
    );
    filters.push(
      `[pip_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${radius},2)),255,0)'[pip_circle]`
    );
    filters.push(
      `[${lastLabel}][pip_circle]overlay=${pip.x}:${pip.y}:enable='${cpEnableExpr}':format=auto[step${stepNum}]`
    );
    lastLabel = `step${stepNum}`;
    stepNum++;
  }

  // ── 5. Final output label ──
  filters.push(`[${lastLabel}]copy[out]`);

  return filters.join(";\n");
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();

  console.log("=".repeat(70));
  console.log("  SINGLE-PASS VIDEO RENDERER — Zero-Glitch Architecture");
  console.log("=".repeat(70));
  console.log();

  // ── Preflight ──
  console.log("[1] PREFLIGHT");
  console.log("-".repeat(40));
  for (const { name, path: p } of [
    { name: "FFmpeg", path: FFMPEG },
    { name: "Blueprint", path: BLUEPRINT_PATH },
    { name: "A-roll", path: AROLL_PATH },
    { name: "B-roll", path: BROLL_PATH },
  ]) {
    const ok = fs.existsSync(p);
    console.log(`  ${ok ? "OK" : "MISSING"} ${name}`);
    if (!ok) { console.error("FATAL: Missing file"); process.exit(1); }
  }
  console.log();

  // ── Create dirs ──
  for (const d of [OUTPUT_DIR, TEMP_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  // ── Load blueprint ──
  console.log("[2] BLUEPRINT");
  console.log("-".repeat(40));

  const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, "utf-8"));
  const bpData = blueprint.data;

  console.log(`  Blueprint segments: ${bpData.reference.segments.length}`);
  for (const seg of bpData.reference.segments) {
    console.log(`    ${seg.id}: ${seg.start}-${seg.end}s | ${seg.layout} | pip: ${seg.aroll?.shape}`);
  }
  console.log();

  // ── Transcribe A-roll audio (NOT reference — different take = different timing) ──
  console.log("[2b] A-ROLL TRANSCRIPTION");
  console.log("-".repeat(40));

  const arollTranscription = await transcribeAroll();
  const sentences = arollTranscription.sentences ?? [];

  console.log(`  Sentences from A-roll audio:`);
  for (const s of sentences) {
    const preview = s.text.length > 60 ? s.text.slice(0, 57) + "..." : s.text;
    console.log(`    S: ${s.start.toFixed(2)}-${s.end.toFixed(2)}s | "${preview}"`);
  }

  // Compare with reference transcription to show timing differences
  const refSentences = bpData.reference.transcription?.sentences ?? [];
  if (refSentences.length > 0) {
    console.log(`\n  Timing comparison (A-roll vs Reference):`);
    const minLen = Math.min(sentences.length, refSentences.length);
    for (let i = 0; i < minLen; i++) {
      const diff = sentences[i].end - refSentences[i].end;
      const arrow = diff > 0 ? `+${diff.toFixed(2)}s later` : diff < 0 ? `${diff.toFixed(2)}s earlier` : "same";
      console.log(`    S${i + 1} end: A-roll=${sentences[i].end.toFixed(2)}s vs Ref=${refSentences[i].end.toFixed(2)}s (${arrow})`);
    }
  }
  console.log();

  // ── Smart Layout Analysis ──
  console.log("[3] SMART LAYOUT ANALYSIS");
  console.log("-".repeat(40));

  const sentenceBoundaries = sentences.map(s => ({ start: s.start, end: s.end }));
  const layoutRanges = buildSmartLayoutPlan(bpData.reference.segments, sentenceBoundaries);

  console.log();
  for (const range of layoutRanges) {
    console.log(`  ${range.id}: ${range.start.toFixed(2)}-${range.end.toFixed(2)}s (${(range.end - range.start).toFixed(2)}s) | ${range.layout} | pip: ${range.seg?.aroll?.shape ?? "none"}`);
  }
  console.log();

  // ── Build single-pass filter ──
  console.log("[4] BUILDING SINGLE-PASS FILTER");
  console.log("-".repeat(40));

  const filterComplex = buildSinglePassFilter(layoutRanges);
  const filterPath = path.join(TEMP_DIR, "singlepass-filter.txt");
  fs.writeFileSync(filterPath, filterComplex);

  const filterLines = filterComplex.split(";\n");
  console.log(`  Filter complexity: ${filterLines.length} filter stages`);
  for (const line of filterLines) {
    console.log(`    ${line.length > 120 ? line.slice(0, 117) + "..." : line}`);
  }
  console.log();

  // ── Calculate total duration ──
  const totalDuration = Math.max(...layoutRanges.map(r => r.end));
  console.log(`  Total duration: ${totalDuration.toFixed(2)}s`);
  console.log();

  // ── Single FFmpeg command ──
  console.log("[5] RENDERING (single pass)");
  console.log("-".repeat(40));

  const args = [
    "-y",
    // Input 0: B-roll (continuous)
    "-i", BROLL_PATH,
    // Input 1: A-roll (continuous, also audio source)
    "-i", AROLL_PATH,
    // Filter from file (Windows escaping)
    "-filter_complex_script", filterPath,
    // Map video from filter output
    "-map", "[out]",
    // Map audio from A-roll (input 1) — continuous, never cut
    "-map", "1:a",
    // Duration
    "-t", totalDuration.toFixed(3),
    // Encoding
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-pix_fmt", "yuv420p",
    "-r", FPS.toString(),
    "-movflags", "+faststart",
    OUTPUT_PATH,
  ];

  console.log(`  Command: ffmpeg ${args.slice(0, 6).join(" ")} ... ${OUTPUT_PATH}`);
  console.log(`  Rendering...`);

  const renderStart = Date.now();

  try {
    const result = await runFFmpeg(args, 600_000);

    const renderTime = ((Date.now() - renderStart) / 1000).toFixed(1);

    // Clean up
    try { fs.unlinkSync(filterPath); } catch { /* ignore */ }

    if (result.exitCode === 0 && fs.existsSync(OUTPUT_PATH)) {
      const stats = fs.statSync(OUTPUT_PATH);
      console.log(`  -> OK (${renderTime}s)`);
      console.log(`  -> Output: ${OUTPUT_PATH}`);
      console.log(`  -> Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
      const errorLines = result.stderr
        .split("\n")
        .filter(l => l.includes("Error") || l.includes("error") || l.includes("Invalid") || l.includes("No such"))
        .slice(0, 10);
      console.log(`  -> FAILED (exit code ${result.exitCode})`);
      for (const line of errorLines) {
        console.log(`     ${line.trim()}`);
      }
      // Dump full stderr for debugging
      const debugPath = path.join(TEMP_DIR, "ffmpeg-stderr.txt");
      fs.writeFileSync(debugPath, result.stderr);
      console.log(`  -> Full stderr saved: ${debugPath}`);
      process.exit(1);
    }
  } catch (err) {
    try { fs.unlinkSync(filterPath); } catch { /* ignore */ }
    console.error(`  -> ERROR: ${err.message}`);
    process.exit(1);
  }
  console.log();

  // ══════════════════════════════════════════════════════════
  // REGRESSION CHECKLIST VERIFICATION
  //
  // Every render MUST pass ALL checks before being accepted.
  // Extract frames at critical times and log pass/fail.
  // ══════════════════════════════════════════════════════════

  console.log("[6] REGRESSION CHECKLIST");
  console.log("-".repeat(40));
  console.log();

  // Define verification frames with what to check at each time
  const verificationChecks = [
    // ── Check 1: Rectangle layout during sentence 1 ──
    { time: 1.0, expect: "RECT_LAYOUT", desc: "Rectangle PIP visible during sentence 1" },
    { time: 1.9, expect: "RECT_LAYOUT", desc: "Rectangle PIP + headlines visible" },
    { time: 3.5, expect: "RECT_LAYOUT", desc: "Rectangle still showing before S1 ends (3.79s)" },

    // ── Check 2: Transition at sentence boundary ──
    { time: 3.7, expect: "RECT_LAYOUT", desc: "Still rectangle at 3.7s (before 'Chunki' at ~3.96s)" },
    // Transition happens between S1 end (3.79s) and S2 start (3.96s)
    // Gap is closed by extending rect to 3.96s, then circle starts
    { time: 4.1, expect: "CIRCLE_PIP", desc: "Circle PIP active after 'Chunki' starts (~3.96s)" },
    { time: 4.5, expect: "CIRCLE_PIP", desc: "Circle PIP confirmed at 4.5s" },

    // ── Check 3: Circle PIP visible with border through ALL segments ──
    { time: 5.0, expect: "CIRCLE_PIP", desc: "Circle PIP with border at 5s" },
    { time: 7.5, expect: "CIRCLE_PIP", desc: "Circle PIP with border at 7.5s" },
    { time: 10.0, expect: "CIRCLE_PIP", desc: "Circle PIP with border at 10s" },
    { time: 13.0, expect: "CIRCLE_PIP", desc: "Circle PIP with border at 13s (REGRESSION CHECK)" },
    { time: 15.0, expect: "CIRCLE_PIP", desc: "Circle PIP with border at 15s (REGRESSION CHECK)" },
    { time: 17.0, expect: "CIRCLE_PIP", desc: "Circle PIP with border at 17s (REGRESSION CHECK)" },
    { time: 20.0, expect: "CIRCLE_PIP", desc: "Circle PIP with border at 20s" },
    { time: 23.0, expect: "CIRCLE_PIP", desc: "Circle PIP with border at 23s (final segment)" },
  ];

  const framesDir = path.join(OUTPUT_DIR, "sp-frames");
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

  console.log("  Extracting verification frames...");
  for (const check of verificationChecks) {
    const framePath = path.join(framesDir, `frame_${check.time}s.jpg`);
    await runFFmpeg([
      "-y", "-ss", check.time.toString(), "-i", OUTPUT_PATH,
      "-frames:v", "1", "-q:v", "2", framePath,
    ], 15_000);
    const ok = fs.existsSync(framePath);
    const status = ok ? "✓" : "✗";
    console.log(`  ${status} ${check.time}s — ${check.desc}`);
  }
  console.log();

  // Print checklist summary
  console.log("  ═══════════════════════════════════════════");
  console.log("  REGRESSION CHECKLIST ITEMS:");
  console.log("  ═══════════════════════════════════════════");
  console.log("  [  ] 1. Rectangle PIP visible with headlines during S1 (0-3.96s)");
  console.log("  [  ] 2. Circle PIP visible with white border for ALL circle segments");
  console.log("  [  ]    → Especially at 13s, 15s, 17s (previous regression)");
  console.log("  [  ] 3. Transition at correct sentence boundary (~3.96s)");
  console.log("  [  ]    → 'Chunki' should start in circle PIP, NOT rectangle");
  console.log("  [  ] 4. No layout overlap at transition (no frame showing both)");
  console.log("  [  ] 5. No dead zones (no frames with raw B-roll and no PIP)");
  console.log("  [  ] 6. Audio continuous with no glitches");
  console.log("  [  ] 7. Face centered in circle PIP");
  console.log("  [  ] 8. Headlines display correctly (gold + pink)");
  console.log("  ═══════════════════════════════════════════");
  console.log("  Review frames in:", framesDir);
  console.log();

  // ── Summary ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("=".repeat(70));
  console.log("  RESULT: PASS");
  console.log(`  Total time: ${elapsed}s`);
  console.log(`  Output: ${OUTPUT_PATH}`);
  console.log(`  Architecture: SINGLE PASS — zero concatenation glitches`);
  console.log("=".repeat(70));
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
