/**
 * STAGE 2: Duplicate Detection & Clean Timeline
 *
 * 1. Re-transcribe clips with bad timestamps (clip 2)
 * 2. Send ALL transcriptions to Gemini for intelligent duplicate/restart detection
 * 3. Determine narrative order
 * 4. Build clean timeline with only usable segments
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const STAGE1_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage1");
const STAGE2_DIR = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
const AROLL_DIR = path.join(ROOT, "public", "uploads", "arolls");

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
// STEP 1: Fix bad timestamps via re-transcription
// ════════════════════════════════════════════════════════

async function retranscribeClip(clipIndex) {
  console.log(`\n  Re-transcribing clip ${clipIndex} (bad timestamps detected)...`);

  const transPath = path.join(STAGE1_DIR, `clip_${clipIndex}_transcription.json`);
  const existing = JSON.parse(fs.readFileSync(transPath, "utf-8"));

  const audioPath = path.join(STAGE1_DIR, `clip_${clipIndex}_audio_retry.mp3`);
  execFileSync(FFMPEG, [
    "-y", "-i", existing.clipPath,
    "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-q:a", "2",
    audioPath,
  ], { stdio: "pipe" });

  const audioBase64 = fs.readFileSync(audioPath).toString("base64");

  const prompt = `You are a precise speech-to-text transcription engine.

Transcribe this audio file with EXACT word-level timestamps.

The speaker is speaking in Uzbek (may include some Russian or English words). The audio is approximately ${Math.round(existing.duration)} seconds long.

CRITICAL TIMESTAMP RULES:
- The audio is ${existing.duration.toFixed(1)} seconds long
- Timestamps MUST span the full duration of the audio
- The last word's end timestamp should be close to the audio duration
- Timestamps must be in SECONDS (decimal, e.g., 2.35, 15.78)
- A typical word takes 0.3-0.8 seconds to say
- Gaps between words should reflect actual pauses in speech
- DO NOT compress all timestamps into a tiny range — spread them across the full audio duration

CONTENT INSTRUCTIONS:
- Group words into sentences
- If the speaker starts, stops, and restarts, mark both attempts as separate sentences
- Set "is_complete": false for incomplete sentences
- Add semantic_tags to each sentence

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
      "semantic_tags": ["tag1"],
      "is_complete": true,
      "notes": ""
    }
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
      const parsed = JSON.parse(cleaned);

      // Validate timestamps span the audio
      const lastWord = parsed.words?.[parsed.words.length - 1];
      const lastSentence = parsed.sentences?.[parsed.sentences.length - 1];
      const maxTimestamp = Math.max(lastWord?.end || 0, lastSentence?.end || 0);

      if (maxTimestamp < existing.duration * 0.3) {
        console.log(`    Attempt ${retry + 1}: timestamps still compressed (max=${maxTimestamp.toFixed(1)}s vs duration=${existing.duration.toFixed(1)}s)`);
        if (retry < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
      }

      // Update the transcription file
      existing.words = parsed.words;
      existing.sentences = parsed.sentences;
      existing._retranscribed = true;
      fs.writeFileSync(transPath, JSON.stringify(existing, null, 2));

      console.log(`    ✓ Re-transcribed: ${parsed.sentences?.length} sentences, max timestamp ${maxTimestamp.toFixed(1)}s`);
      try { fs.unlinkSync(audioPath); } catch(e) {}
      return existing;
    } catch (err) {
      console.error(`    Attempt ${retry + 1} failed: ${err.message?.substring(0, 150)}`);
      if (retry < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }

  try { fs.unlinkSync(audioPath); } catch(e) {}
  console.log(`    ⚠ Re-transcription failed, using original timestamps`);
  return existing;
}

// ════════════════════════════════════════════════════════
// STEP 2: Load all transcriptions + detect bad timestamps
// ════════════════════════════════════════════════════════

async function loadAndFixTranscriptions() {
  const clips = [];
  // Generic over clip count: read every contiguous clip_N_transcription.json.
  for (let i = 0; fs.existsSync(path.join(STAGE1_DIR, `clip_${i}_transcription.json`)); i++) {
    const transPath = path.join(STAGE1_DIR, `clip_${i}_transcription.json`);
    const trans = JSON.parse(fs.readFileSync(transPath, "utf-8"));

    // Check if timestamps are obviously broken
    const lastSent = trans.sentences?.[trans.sentences.length - 1];
    const maxEnd = lastSent?.end || 0;
    if (maxEnd < trans.duration * 0.3) {
      console.log(`  ⚠ Clip ${i}: timestamps span only ${maxEnd.toFixed(1)}s of ${trans.duration.toFixed(1)}s — re-transcribing`);
      const fixed = await retranscribeClip(i);
      clips.push(fixed);
    } else {
      clips.push(trans);
    }
  }
  return clips;
}

// ════════════════════════════════════════════════════════
// STEP 3: Intelligent duplicate detection via Gemini
// ════════════════════════════════════════════════════════

async function detectDuplicatesAndOrder(clips) {
  // Build a comprehensive view of ALL sentences across all clips
  const allSentences = [];
  for (const clip of clips) {
    for (let si = 0; si < (clip.sentences || []).length; si++) {
      const s = clip.sentences[si];
      allSentences.push({
        id: `C${clip.clipIndex}_S${si}`,
        clipIndex: clip.clipIndex,
        clipName: clip.clipName,
        sentenceIndex: si,
        text: s.text,
        start: s.start,
        end: s.end,
        duration: s.end - s.start,
        isComplete: s.is_complete !== false,
        tags: s.semantic_tags || [],
        notes: s.notes || "",
      });
    }
  }

  const sentenceList = allSentences.map(s =>
    `[${s.id}] clip=${s.clipIndex} t=${s.start.toFixed(2)}-${s.end.toFixed(2)}s complete=${s.isComplete} tags=[${s.tags.join(",")}]\n  "${s.text}"\n  notes: ${s.notes || "none"}`
  ).join("\n\n");

  const prompt = `You are an intelligent video editor analyzing raw footage transcriptions to build a clean edit.

The speaker recorded ${clips.length} separate video clips for a product promotional video. Each clip may contain:
- Test counts ("1, 2, 3", "K uch")
- Readiness checks ("ketdi mana", "Da")
- Self-corrections ("mana shu yerda to'xtayapsiz")
- Incomplete sentences (speaker stopped mid-sentence)
- Complete retakes of the same sentence
- Meta-conversation ("nima edi?", "shundami edi?")

YOUR TASKS:
1. Identify ALL sentences that should be REMOVED (test audio, self-talk, meta-conversation, incomplete takes that have a better retake)
2. For duplicate/retake pairs: keep the COMPLETE version, remove the incomplete one
3. Determine the NARRATIVE ORDER of the remaining good sentences to create a coherent promotional video
4. The narrative should follow: Hook → Problem → Solution → How it works → Call to action

ALL SENTENCES:
${sentenceList}

Return JSON:
{
  "removals": [
    {
      "id": "C0_S0",
      "reason": "Test audio — speaker counting before recording"
    }
  ],
  "retakePairs": [
    {
      "incomplete": "C0_S2",
      "complete": "C0_S4",
      "explanation": "Same sentence about product photos — C0_S4 is the finished version"
    }
  ],
  "cleanSequence": [
    {
      "id": "C3_S1",
      "role": "hook",
      "narrativePosition": 1,
      "reason": "Opens with 'If you want to increase sales on Instagram' — natural hook"
    }
  ],
  "narrativeReasoning": "One paragraph explaining the narrative flow"
}

The cleanSequence should ONLY contain IDs that are NOT in the removals list. Order them for maximum narrative impact.
Return ONLY JSON, no markdown.`;

  for (let retry = 0; retry < 3; retry++) {
    try {
      const result = await model.generateContent([{ text: prompt }]);
      const text = result.response.text();
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return { analysis: JSON.parse(cleaned), allSentences };
    } catch (err) {
      console.error(`  Attempt ${retry + 1} failed: ${err.message?.substring(0, 150)}`);
      if (retry < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error("Duplicate detection failed after 3 attempts");
}

// ════════════════════════════════════════════════════════
// STEP 4: Build clean timeline
// ════════════════════════════════════════════════════════

function buildCleanTimeline(analysis, allSentences, clips) {
  const removedIds = new Set(analysis.removals.map(r => r.id));
  const sentMap = new Map(allSentences.map(s => [s.id, s]));
  const clipMap = new Map(clips.map(c => [c.clipIndex, c]));

  const segments = [];
  let timelineOffset = 0;

  for (const entry of analysis.cleanSequence) {
    const sent = sentMap.get(entry.id);
    if (!sent) {
      console.log(`  ⚠ Skipping unknown ID: ${entry.id}`);
      continue;
    }
    if (removedIds.has(entry.id)) {
      console.log(`  ⚠ Skipping removed ID in sequence: ${entry.id}`);
      continue;
    }

    const clip = clipMap.get(sent.clipIndex);
    const segment = {
      segmentIndex: segments.length,
      id: entry.id,
      role: entry.role,
      narrativePosition: entry.narrativePosition,

      // Source coordinates
      sourceClipIndex: sent.clipIndex,
      sourceClipName: sent.clipName,
      sourceClipPath: clip.clipPath,
      sourceStart: sent.start,
      sourceEnd: sent.end,
      sourceDuration: sent.end - sent.start,

      // Timeline coordinates (cumulative)
      timelineStart: timelineOffset,
      timelineEnd: timelineOffset + (sent.end - sent.start),

      // Content
      text: sent.text,
      semanticTags: sent.tags,
    };

    segments.push(segment);
    timelineOffset = segment.timelineEnd;
  }

  return {
    totalDuration: timelineOffset,
    segmentCount: segments.length,
    segments,
    narrativeReasoning: analysis.narrativeReasoning,
  };
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   STAGE 2: DUPLICATE DETECTION & CLEAN TIMELINE     ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Step 1: Load and fix transcriptions
  console.log("  Step 1: Loading & fixing transcriptions...\n");
  const clips = await loadAndFixTranscriptions();

  // Step 2: Show all sentences
  console.log("\n  Step 2: All sentences across clips:\n");
  let totalRaw = 0;
  for (const clip of clips) {
    console.log(`  ── Clip ${clip.clipIndex} (${clip.clipName}, ${clip.duration.toFixed(1)}s) ──`);
    for (let si = 0; si < (clip.sentences || []).length; si++) {
      const s = clip.sentences[si];
      const complete = s.is_complete === false ? " [INCOMPLETE]" : "";
      const preview = s.text.length > 80 ? s.text.slice(0, 77) + "..." : s.text;
      console.log(`    C${clip.clipIndex}_S${si} [${s.start.toFixed(2)}-${s.end.toFixed(2)}s]: "${preview}"${complete}`);
      totalRaw++;
    }
    console.log();
  }
  console.log(`  Total raw sentences: ${totalRaw}\n`);

  // Step 3: Detect duplicates & determine order
  console.log("  Step 3: Analyzing duplicates & narrative order with Gemini...\n");
  const { analysis, allSentences } = await detectDuplicatesAndOrder(clips);

  // Print removals
  console.log(`  Removals (${analysis.removals.length}):`);
  for (const r of analysis.removals) {
    const sent = allSentences.find(s => s.id === r.id);
    const preview = sent ? (sent.text.length > 50 ? sent.text.slice(0, 47) + "..." : sent.text) : "???";
    console.log(`    ✂ ${r.id}: "${preview}" — ${r.reason}`);
  }

  console.log(`\n  Retake pairs (${analysis.retakePairs?.length || 0}):`);
  for (const p of (analysis.retakePairs || [])) {
    console.log(`    ${p.incomplete} → ${p.complete}: ${p.explanation}`);
  }

  console.log(`\n  Clean sequence (${analysis.cleanSequence.length}):`);
  for (const entry of analysis.cleanSequence) {
    const sent = allSentences.find(s => s.id === entry.id);
    const preview = sent ? (sent.text.length > 60 ? sent.text.slice(0, 57) + "..." : sent.text) : "???";
    console.log(`    ${entry.narrativePosition}. [${entry.id}] (${entry.role}): "${preview}"`);
  }

  console.log(`\n  Narrative reasoning: ${analysis.narrativeReasoning}\n`);

  // Step 4: Build clean timeline
  console.log("  Step 4: Building clean timeline...\n");
  const timeline = buildCleanTimeline(analysis, allSentences, clips);

  console.log(`  Clean timeline: ${timeline.segmentCount} segments, ${timeline.totalDuration.toFixed(2)}s total\n`);
  for (const seg of timeline.segments) {
    console.log(`    Seg ${seg.segmentIndex}: [${seg.timelineStart.toFixed(2)}-${seg.timelineEnd.toFixed(2)}s] (${seg.role})`);
    console.log(`      Source: ${seg.sourceClipName} [${seg.sourceStart.toFixed(2)}-${seg.sourceEnd.toFixed(2)}s]`);
    const preview = seg.text.length > 70 ? seg.text.slice(0, 67) + "..." : seg.text;
    console.log(`      Text: "${preview}"`);
  }

  // Save outputs
  const timelinePath = path.join(STAGE2_DIR, "clean-timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
  console.log(`\n  Saved: ${timelinePath}`);

  const reportPath = path.join(STAGE2_DIR, "duplicate-report.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    totalRawSentences: totalRaw,
    removals: analysis.removals,
    retakePairs: analysis.retakePairs,
    cleanSequence: analysis.cleanSequence,
    narrativeReasoning: analysis.narrativeReasoning,
    cleanSentenceCount: analysis.cleanSequence.length,
    removedCount: analysis.removals.length,
  }, null, 2));
  console.log(`  Saved: ${reportPath}`);

  // Verification
  console.log("\n  ── VERIFICATION ──");
  const uniqueClips = new Set(timeline.segments.map(s => s.sourceClipIndex));
  console.log(`  ✓ ${timeline.segmentCount} clean segments from ${uniqueClips.size} clips`);
  console.log(`  ✓ Total duration: ${timeline.totalDuration.toFixed(2)}s`);
  console.log(`  ✓ Removed ${analysis.removals.length} sentences (${totalRaw} → ${analysis.cleanSequence.length})`);

  // Check for gaps in timeline
  for (let i = 1; i < timeline.segments.length; i++) {
    const gap = timeline.segments[i].timelineStart - timeline.segments[i - 1].timelineEnd;
    if (Math.abs(gap) > 0.01) {
      console.log(`  ⚠ Gap of ${gap.toFixed(3)}s between segment ${i - 1} and ${i}`);
    }
  }

  console.log("\n  ✓ STAGE 2 COMPLETE\n");
}

main().catch(err => {
  console.error("STAGE 2 FAILED:", err);
  process.exit(1);
});
