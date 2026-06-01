/**
 * STAGE 1: Transcription & Visual Analysis
 *
 * For each of 4 A-roll clips:
 *   1. Extract audio → send to Gemini for word-level transcription
 *   2. Extract keyframes → detect face position via pixel brightness analysis
 *   3. Output: transcription JSON + face position JSON per clip
 *
 * NOTE: This is a standalone test script (not production code).
 * All inputs are hardcoded paths — no user-supplied data flows to exec.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const AROLL_DIR = path.join(ROOT, "public", "uploads", "arolls");
const OUTPUT_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage1");

// Load .env.local
if (!process.env.GEMINI_API_KEY) {
  const envPath = path.join(ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim();
    }
  }
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ════════════════════════════════════════════════════════
// HELPERS — all use execFileSync (no shell injection risk)
// ════════════════════════════════════════════════════════

function parseFPS(fpsStr) {
  // Parse "30/1" or "60/1" style frame rates safely
  const parts = fpsStr.split("/");
  if (parts.length === 2) {
    return parseInt(parts[0]) / parseInt(parts[1]);
  }
  return parseFloat(fpsStr);
}

function getMediaInfo(filePath) {
  const raw = execFileSync(FFPROBE, [
    "-v", "quiet", "-print_format", "json",
    "-show_format", "-show_streams", filePath,
  ], { encoding: "utf-8" });
  const parsed = JSON.parse(raw);
  const vs = parsed.streams.find(s => s.codec_type === "video");
  return {
    width: parseInt(vs.width),
    height: parseInt(vs.height),
    duration: parseFloat(parsed.format.duration),
    fps: parseFPS(vs.r_frame_rate),
  };
}

function extractAudio(videoPath, outputPath) {
  execFileSync(FFMPEG, [
    "-y", "-i", videoPath,
    "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-q:a", "2",
    outputPath,
  ], { stdio: "pipe" });
}

function extractFrame(videoPath, timestamp, outputPath) {
  execFileSync(FFMPEG, [
    "-y", "-ss", String(timestamp),
    "-i", videoPath,
    "-frames:v", "1", "-q:v", "2",
    outputPath,
  ], { stdio: "pipe" });
}

function extractSmallGray(framePath, outputPath, w, h) {
  execFileSync(FFMPEG, [
    "-y", "-i", framePath,
    "-vf", `scale=${w}:${h},format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray",
    outputPath,
  ], { stdio: "pipe" });
}

// Simple face detection using pixel brightness rows
function detectFaceRegion(framePath) {
  try {
    const smallPath = framePath.replace(".jpg", "_small.raw");
    const w = 108, h = 192;
    extractSmallGray(framePath, smallPath, w, h);

    const pixels = fs.readFileSync(smallPath);

    // Find face region: brightest concentrated area in upper 70% of frame
    const rowBrightness = [];
    for (let y = 0; y < h; y++) {
      let sum = 0;
      let skinPixels = 0;
      for (let x = 0; x < w; x++) {
        const val = pixels[y * w + x];
        sum += val;
        if (val > 100 && val < 240) skinPixels++;
      }
      rowBrightness.push({ y, avg: sum / w, skinRatio: skinPixels / w });
    }

    // Find the brightest contiguous band in upper 60% (likely face)
    let bestStart = 0, bestEnd = 0, bestScore = 0;
    for (let start = 0; start < h * 0.6; start++) {
      for (let end = start + 10; end < Math.min(start + 60, h * 0.8); end++) {
        let score = 0;
        for (let y = start; y <= end; y++) {
          score += rowBrightness[y].skinRatio * rowBrightness[y].avg;
        }
        score /= (end - start + 1);
        if (score > bestScore) {
          bestScore = score;
          bestStart = start;
          bestEnd = end;
        }
      }
    }

    // Find column center of brightness in the face band
    let colWeightedSum = 0, colWeightTotal = 0;
    for (let y = bestStart; y <= bestEnd; y++) {
      for (let x = 0; x < w; x++) {
        const val = pixels[y * w + x];
        if (val > 100) {
          colWeightedSum += x * val;
          colWeightTotal += val;
        }
      }
    }
    const centerX = colWeightTotal > 0 ? colWeightedSum / colWeightTotal / w : 0.5;

    const faceCenterY = ((bestStart + bestEnd) / 2) / h;
    const faceTopY = bestStart / h;
    const faceHeight = (bestEnd - bestStart) / h;

    try { fs.unlinkSync(smallPath); } catch(e) {}

    return {
      centerX: Math.round(centerX * 1000) / 1000,
      centerY: Math.round(faceCenterY * 1000) / 1000,
      topY: Math.round(faceTopY * 1000) / 1000,
      height: Math.round(faceHeight * 1000) / 1000,
    };
  } catch (err) {
    console.error(`    Face detection failed: ${err.message}`);
    return { centerX: 0.5, centerY: 0.35, topY: 0.2, height: 0.15 };
  }
}

// ════════════════════════════════════════════════════════
// TRANSCRIPTION
// ════════════════════════════════════════════════════════

async function transcribeClip(audioPath, clipIndex, duration) {
  const audioBase64 = fs.readFileSync(audioPath).toString("base64");

  const prompt = `You are a precise speech-to-text transcription engine.

Transcribe this audio file with EXACT word-level timestamps.

The speaker is speaking in Uzbek (may include some Russian or English words). The audio is approximately ${Math.round(duration)} seconds long.

CRITICAL INSTRUCTIONS:
- Provide timestamps for EVERY word
- Timestamps must be in SECONDS (decimal, e.g., 2.35)
- Start time = when the word begins being spoken
- End time = when the word finishes being spoken
- Be as precise as possible — even 0.1s matters for video editing
- Group words into sentences (a sentence ends with a period, question mark, or exclamation mark)
- If you detect the speaker starting a sentence, stopping, and restarting the same idea, mark both attempts separately
- Add semantic_tags to each sentence: classify the content (e.g., "hook", "product_feature", "competitor_analysis", "call_to_action", "trend_analysis", "content_creation", etc.)

Return JSON in this EXACT format:
{
  "words": [
    { "word": "example", "start": 0.0, "end": 0.5 }
  ],
  "sentences": [
    {
      "text": "Full sentence text.",
      "start": 0.0,
      "end": 3.5,
      "semantic_tags": ["hook", "introduction"],
      "is_complete": true,
      "notes": ""
    }
  ]
}

If a sentence is incomplete (speaker stopped mid-sentence), set "is_complete": false and add a note explaining what happened.
If the speaker repeats or restarts, mark both versions — we'll pick the best one later.

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
      return JSON.parse(cleaned);
    } catch (err) {
      console.error(`    Attempt ${retry + 1} failed: ${err.message?.substring(0, 150)}`);
      if (retry < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error(`All transcription attempts failed for clip ${clipIndex}`);
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   STAGE 1: TRANSCRIPTION & VISUAL ANALYSIS          ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Find all A-roll clips
  const clips = fs.readdirSync(AROLL_DIR)
    .filter(f => /\.(mov|mp4)$/i.test(f))
    .sort()
    .map(f => path.join(AROLL_DIR, f));

  console.log(`  Found ${clips.length} A-roll clips:\n`);

  const allTranscriptions = [];
  const allFaces = [];

  for (let i = 0; i < clips.length; i++) {
    const clipPath = clips[i];
    const clipName = path.basename(clipPath);
    const info = getMediaInfo(clipPath);

    console.log(`══════════════════════════════════════════════════════`);
    console.log(`  CLIP ${i}: ${clipName}`);
    console.log(`  ${info.width}x${info.height} | ${info.duration.toFixed(2)}s | ${info.fps}fps`);
    console.log(`══════════════════════════════════════════════════════\n`);

    // 1. Extract audio
    const audioPath = path.join(OUTPUT_DIR, `clip_${i}_audio.mp3`);
    console.log(`  [1/3] Extracting audio...`);
    extractAudio(clipPath, audioPath);
    const audioSize = (fs.statSync(audioPath).size / 1024).toFixed(0);
    console.log(`    ✓ Audio extracted (${audioSize} KB)\n`);

    // 2. Transcribe
    console.log(`  [2/3] Transcribing with Gemini...`);
    const transcription = await transcribeClip(audioPath, i, info.duration);
    console.log(`    ✓ Words: ${transcription.words?.length || 0}`);
    console.log(`    ✓ Sentences: ${transcription.sentences?.length || 0}\n`);

    for (const s of (transcription.sentences || [])) {
      const complete = s.is_complete === false ? " [INCOMPLETE]" : "";
      const preview = s.text.length > 80 ? s.text.slice(0, 77) + "..." : s.text;
      console.log(`    [${s.start.toFixed(2)}-${s.end.toFixed(2)}s] "${preview}"${complete}`);
      if (s.semantic_tags?.length) console.log(`      tags: ${s.semantic_tags.join(", ")}`);
      if (s.notes) console.log(`      note: ${s.notes}`);
    }

    // Save transcription
    const transPath = path.join(OUTPUT_DIR, `clip_${i}_transcription.json`);
    fs.writeFileSync(transPath, JSON.stringify({
      clipIndex: i,
      clipPath: clipPath,
      clipName,
      duration: info.duration,
      resolution: `${info.width}x${info.height}`,
      ...transcription,
    }, null, 2));
    console.log(`\n    Saved: ${transPath}\n`);

    allTranscriptions.push({
      clipIndex: i,
      clipPath,
      clipName,
      duration: info.duration,
      width: info.width,
      height: info.height,
      transcription,
    });

    // 3. Face detection (sample 3 frames per clip)
    console.log(`  [3/3] Detecting face positions...`);
    const faceSamples = [];
    const sampleTimes = [
      info.duration * 0.2,
      info.duration * 0.5,
      info.duration * 0.8,
    ];

    for (const t of sampleTimes) {
      const framePath = path.join(OUTPUT_DIR, `clip_${i}_frame_${t.toFixed(1)}.jpg`);
      try {
        extractFrame(clipPath, t, framePath);
        const face = detectFaceRegion(framePath);
        faceSamples.push({ timestamp: t, ...face });
        console.log(`    t=${t.toFixed(1)}s: face center=(${(face.centerX * info.width).toFixed(0)}, ${(face.centerY * info.height).toFixed(0)}) topY=${(face.topY * info.height).toFixed(0)}`);
      } catch (err) {
        console.log(`    t=${t.toFixed(1)}s: frame extraction failed`);
        faceSamples.push({ timestamp: t, centerX: 0.5, centerY: 0.35, topY: 0.2, height: 0.15 });
      }
    }

    // Compute median face position
    const medianFace = {
      centerX: median(faceSamples.map(f => f.centerX)),
      centerY: median(faceSamples.map(f => f.centerY)),
      topY: median(faceSamples.map(f => f.topY)),
      height: median(faceSamples.map(f => f.height)),
    };

    console.log(`    Median face: center=(${(medianFace.centerX * info.width).toFixed(0)}, ${(medianFace.centerY * info.height).toFixed(0)}) topY=${(medianFace.topY * info.height).toFixed(0)}`);

    const facePath = path.join(OUTPUT_DIR, `clip_${i}_face.json`);
    fs.writeFileSync(facePath, JSON.stringify({
      clipIndex: i,
      clipName,
      resolution: { width: info.width, height: info.height },
      samples: faceSamples,
      median: medianFace,
      medianPixels: {
        centerX: Math.round(medianFace.centerX * info.width),
        centerY: Math.round(medianFace.centerY * info.height),
        topY: Math.round(medianFace.topY * info.height),
        faceHeight: Math.round(medianFace.height * info.height),
      },
    }, null, 2));
    console.log(`    Saved: ${facePath}\n`);

    allFaces.push({
      clipIndex: i,
      median: medianFace,
      medianPixels: {
        centerX: Math.round(medianFace.centerX * info.width),
        centerY: Math.round(medianFace.centerY * info.height),
        topY: Math.round(medianFace.topY * info.height),
        faceHeight: Math.round(medianFace.height * info.height),
      },
    });

    // Cleanup audio file
    try { fs.unlinkSync(audioPath); } catch(e) {}
  }

  // ════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  STAGE 1 SUMMARY");
  console.log("══════════════════════════════════════════════════════\n");

  let totalSentences = 0;
  let totalWords = 0;
  let incompleteSentences = 0;

  for (const clip of allTranscriptions) {
    const t = clip.transcription;
    const sentCount = t.sentences?.length || 0;
    const wordCount = t.words?.length || 0;
    const incomplete = (t.sentences || []).filter(s => s.is_complete === false).length;
    totalSentences += sentCount;
    totalWords += wordCount;
    incompleteSentences += incomplete;
    console.log(`  Clip ${clip.clipIndex} (${clip.clipName}): ${sentCount} sentences, ${wordCount} words, ${incomplete} incomplete`);
  }

  console.log(`\n  TOTALS: ${totalSentences} sentences, ${totalWords} words, ${incompleteSentences} incomplete`);
  console.log(`  Face data: ${allFaces.length} clips analyzed\n`);

  // Save combined summary
  const summaryPath = path.join(OUTPUT_DIR, "stage1-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({
    clipCount: clips.length,
    totalSentences,
    totalWords,
    incompleteSentences,
    clips: allTranscriptions.map(c => ({
      clipIndex: c.clipIndex,
      clipName: c.clipName,
      clipPath: c.clipPath,
      duration: c.duration,
      width: c.width,
      height: c.height,
      sentenceCount: c.transcription.sentences?.length || 0,
      wordCount: c.transcription.words?.length || 0,
    })),
    faces: allFaces,
  }, null, 2));

  console.log(`  Summary saved: ${summaryPath}`);
  console.log("\n  ✓ STAGE 1 COMPLETE\n");
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

main().catch(err => {
  console.error("STAGE 1 FAILED:", err);
  process.exit(1);
});
