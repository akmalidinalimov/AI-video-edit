/**
 * Content Awareness Comparison Test
 *
 * Compares OLD (time-proportional) vs NEW (keyword+OCR+semantic) B-roll matching:
 *
 * 1. Loads cached B-roll material analysis (with frameContent that has visibleText)
 * 2. Loads A-roll transcription (sentences)
 * 3. Runs OLD approach: time-proportional B-roll matching (no content awareness)
 * 4. Runs NEW approach: re-groups scenes WITH OCR text, simulates keyword extraction,
 *    runs enhanced semantic+OCR affinity matching
 * 5. Extracts frames from B-roll video at OLD and NEW matched offsets
 * 6. For each sentence: shows which B-roll scene was selected by each approach
 * 7. Sends comparison pairs to Gemini for quality scoring
 * 8. Prints a side-by-side comparison table
 *
 * Usage: node scripts/test-content-awareness.mjs
 */

import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── Paths ──
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const CACHE_DIR = path.join(ROOT, "public", "analysis", ".cache");
const BROLL_PATH = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const AROLL_TRANS_PATH = path.join(ROOT, "public", "exports", "sp-temp", "aroll-transcription.json");
const OUTPUT_DIR = path.join(ROOT, "public", "exports", "sp-temp", "comparison");

// ── Load Google Generative AI ──
let genAI;
try {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    // Try reading from .env.local
    const envPath = path.join(ROOT, ".env.local");
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      const match = envContent.match(/(?:GEMINI_API_KEY|GOOGLE_AI_API_KEY)=(.+)/);
      if (match) {
        genAI = new GoogleGenerativeAI(match[1].trim());
      }
    }
    if (!genAI) {
      console.error("ERROR: No GEMINI_API_KEY or GOOGLE_AI_API_KEY found");
      process.exit(1);
    }
  } else {
    genAI = new GoogleGenerativeAI(apiKey);
  }
} catch (err) {
  console.error("ERROR: Failed to load @google/generative-ai:", err.message);
  process.exit(1);
}

// ════════════════════════════════════════════════════════════
// STEP 1: Load cached data
// ════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(70));
console.log("  CONTENT AWARENESS COMPARISON TEST");
console.log("  OLD (time-proportional) vs NEW (keyword+OCR+semantic)");
console.log("═".repeat(70) + "\n");

// Find B-roll material cache
const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith("-broll_material.json"));
if (cacheFiles.length === 0) {
  console.error("ERROR: No B-roll material cache found. Run the pipeline first.");
  process.exit(1);
}
const brollCache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, cacheFiles[0]), "utf-8"));
const brollData = brollCache.data;
console.log(`✓ Loaded B-roll material cache: ${cacheFiles[0]}`);
console.log(`  Duration: ${brollData.duration}s, Frames: ${brollData.frameContent.length}`);
console.log(`  Content type: ${brollData.contentType}, Motion: ${brollData.motionType}`);
console.log(`  Original scenes (no OCR): ${brollData.internalScenes.length}`);

// Load A-roll transcription
if (!fs.existsSync(AROLL_TRANS_PATH)) {
  console.error("ERROR: No A-roll transcription found at:", AROLL_TRANS_PATH);
  process.exit(1);
}
const arollTrans = JSON.parse(fs.readFileSync(AROLL_TRANS_PATH, "utf-8"));
// Support both { sentences: [...] } and { data: { sentences: [...] } }
const sentences = arollTrans.sentences || arollTrans.data?.sentences || [];
console.log(`✓ Loaded A-roll transcription: ${sentences.length} sentences`);
for (const s of sentences) {
  console.log(`  [S${s.index ?? sentences.indexOf(s)}] "${s.text}"`);
}

// ════════════════════════════════════════════════════════════
// STEP 2: Re-group frames into scenes WITH OCR (new approach)
// ════════════════════════════════════════════════════════════

console.log("\n── Re-grouping frames with OCR text ──");

function groupIntoScenesWithOCR(frameContent) {
  if (frameContent.length === 0) return [];

  const scenes = [];
  let currentScene = {
    start: frameContent[0].timestamp,
    end: frameContent[0].timestamp,
    description: frameContent[0].topicMatch,
    contentTags: [...frameContent[0].contentTags],
    visibleText: [...(frameContent[0].visibleText ?? [])],
    uiElements: [...(frameContent[0].uiElements ?? [])],
  };

  for (let i = 1; i < frameContent.length; i++) {
    const frame = frameContent[i];
    const prevFrame = frameContent[i - 1];

    const commonTags = frame.contentTags.filter(t => prevFrame.contentTags.includes(t));
    const similarity = prevFrame.contentTags.length > 0
      ? commonTags.length / Math.max(prevFrame.contentTags.length, 1)
      : 0;

    if (similarity >= 0.5) {
      currentScene.end = frame.timestamp;
      for (const tag of frame.contentTags) {
        if (!currentScene.contentTags.includes(tag)) {
          currentScene.contentTags.push(tag);
        }
      }
      for (const text of (frame.visibleText ?? [])) {
        if (!currentScene.visibleText.includes(text)) {
          currentScene.visibleText.push(text);
        }
      }
      for (const ui of (frame.uiElements ?? [])) {
        if (!currentScene.uiElements.includes(ui)) {
          currentScene.uiElements.push(ui);
        }
      }
    } else {
      if (currentScene.end - currentScene.start >= 0.5) {
        scenes.push(currentScene);
      }
      currentScene = {
        start: frame.timestamp,
        end: frame.timestamp,
        description: frame.topicMatch,
        contentTags: [...frame.contentTags],
        visibleText: [...(frame.visibleText ?? [])],
        uiElements: [...(frame.uiElements ?? [])],
      };
    }
  }

  if (currentScene.end - currentScene.start >= 0.5 || scenes.length === 0) {
    scenes.push(currentScene);
  }

  return scenes;
}

const newScenes = groupIntoScenesWithOCR(brollData.frameContent);
const oldScenes = brollData.internalScenes; // Original (no OCR)

// Ensure frame 0's OCR data is included in the first scene
// (The scene grouper may skip it if the first "scene" starts at timestamp 1)
if (brollData.frameContent.length > 0 && brollData.frameContent[0].timestamp === 0) {
  const frame0 = brollData.frameContent[0];
  if (newScenes.length > 0 && newScenes[0].start > 0) {
    // Frame 0 was orphaned — merge its OCR into the first scene
    newScenes[0].start = 0;
    for (const text of (frame0.visibleText ?? [])) {
      if (!newScenes[0].visibleText.includes(text)) {
        newScenes[0].visibleText.push(text);
      }
    }
    for (const tag of frame0.contentTags) {
      if (!newScenes[0].contentTags.includes(tag)) {
        newScenes[0].contentTags.push(tag);
      }
    }
    console.log("  ✓ Merged frame 0 OCR into first scene (was orphaned)");
  }
}

console.log(`  OLD scenes (cached, no OCR): ${oldScenes.length}`);
for (const s of oldScenes) {
  console.log(`    [${s.start}-${s.end}s] ${s.contentTags.slice(0, 4).join(", ")} | "${s.description}"`);
}

console.log(`  NEW scenes (with OCR): ${newScenes.length}`);
for (const s of newScenes) {
  const ocrSample = s.visibleText?.slice(0, 5).join(", ") || "none";
  console.log(`    [${s.start}-${s.end}s] ${s.contentTags.slice(0, 4).join(", ")} | OCR: [${ocrSample}]`);
}

// ════════════════════════════════════════════════════════════
// STEP 3: Semantic affinity function (replicates plan-builder.ts)
// ════════════════════════════════════════════════════════════

function computeSemanticAffinity(sentenceTags, segmentTags, ocrText, speechKeywords) {
  let score = 0;

  // Signal 1: Tag overlap (max 25 pts)
  if (sentenceTags?.length && segmentTags?.length) {
    const sentSet = new Set(sentenceTags.map(t => t.toLowerCase()));
    const segSet = new Set(segmentTags.map(t => t.toLowerCase()));
    let tagMatches = 0;
    for (const tag of sentSet) {
      if (segSet.has(tag)) {
        tagMatches++;
      } else {
        for (const segTag of segSet) {
          if (segTag.includes(tag) || tag.includes(segTag)) {
            tagMatches += 0.5;
            break;
          }
        }
      }
    }
    const maxPossible = Math.max(sentSet.size, segSet.size);
    score += maxPossible > 0 ? Math.min(25, (tagMatches / maxPossible) * 25) : 0;
  }

  // Signal 2: OCR keyword match (max 25 pts)
  if (ocrText?.length && speechKeywords?.length) {
    const ocrLower = ocrText.map(t => t.toLowerCase()).join(" ");
    let kwMatches = 0;
    for (const kw of speechKeywords) {
      const kwLower = kw.toLowerCase();
      if (kwLower.length < 2) continue;
      if (ocrLower.includes(kwLower)) {
        kwMatches += 2;
      } else {
        const words = kwLower.split(/\s+/);
        for (const word of words) {
          if (word.length >= 3 && ocrLower.includes(word)) {
            kwMatches += 1;
            break;
          }
        }
      }
    }
    score += Math.min(25, kwMatches * 5);
  }

  return Math.min(50, score);
}

// ════════════════════════════════════════════════════════════
// STEP 4: OLD approach — time-proportional matching
// ════════════════════════════════════════════════════════════

console.log("\n── OLD Approach: Time-Proportional Matching ──");

const totalDuration = sentences.length > 0
  ? sentences[sentences.length - 1].end
  : 24.33;

const oldMatches = [];
for (let i = 0; i < sentences.length; i++) {
  const s = sentences[i];
  const midpoint = (s.start + s.end) / 2;
  const proportionalTime = (midpoint / totalDuration) * brollData.duration;

  // Find closest scene
  let bestScene = oldScenes[0];
  let bestDist = Infinity;
  for (const scene of oldScenes) {
    const sceneMid = (scene.start + scene.end) / 2;
    const dist = Math.abs(sceneMid - proportionalTime);
    if (dist < bestDist) {
      bestDist = dist;
      bestScene = scene;
    }
  }

  oldMatches.push({
    sentenceIndex: i,
    sentenceText: s.text,
    matchedScene: bestScene,
    offset: bestScene.start,
    method: "proportional",
    score: 0, // no score for proportional
  });

  console.log(`  S${i}: offset=${bestScene.start.toFixed(1)}s | "${s.text.substring(0, 50)}..."`);
  console.log(`        → "${bestScene.description}"`);
}

// ════════════════════════════════════════════════════════════
// STEP 5: NEW approach — keyword+OCR+semantic matching
// ════════════════════════════════════════════════════════════

console.log("\n── Extracting keywords via Gemini ──");

const kwModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

async function extractKeywordsViaGemini(sentences) {
  const sentenceList = sentences
    .map((s, i) => `  [S${i}] "${s.text}"`)
    .join("\n");

  const prompt = `Extract specific keywords from each sentence that could match against visual content in a screen recording of a mobile app (Chat Place).

For each sentence, extract:
1. keywords: ALL meaningful nouns, proper nouns, and compound terms
2. featureNames: Specific product features or tool names mentioned
3. actionVerbs: What actions are described

IMPORTANT: Extract keywords in BOTH Uzbek and English. The app UI may show text in either language.

SENTENCES:
${sentenceList}

Return JSON only:
{
  "sentences": [
    {
      "index": 0,
      "keywords": ["SMM", "mutaxassis", "specialist", "2026"],
      "featureNames": ["SMM specialist"],
      "actionVerbs": []
    }
  ]
}`;

  try {
    const result = await kwModel.generateContent([{ text: prompt }]);
    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("  Gemini keyword extraction failed:", err.message);
    return null;
  }
}

const geminiKeywords = await extractKeywordsViaGemini(sentences);
const keywordsPerSentence = [];

if (geminiKeywords?.sentences) {
  for (const s of geminiKeywords.sentences) {
    const allKw = [...(s.keywords || []), ...(s.featureNames || [])];
    keywordsPerSentence.push(allKw);
    console.log(`  S${s.index}: [${allKw.join(", ")}]`);
  }
} else {
  // Fallback to manual keywords
  console.log("  ⚠ Gemini failed, using manual keywords");
  keywordsPerSentence.push(
    ["SMM", "mutaxassis", "specialist", "2026", "social media"],
    ["Chat Place", "virallik", "virality", "AI agent", "content", "kontent", "VIRALE", "chatplace"],
    ["raqobatchi", "competitor", "analiz", "analysis", "trend", "Trendlar", "reels", "szenariy", "scenario"],
    ["Chat Place", "virallik", "virality", "komentariya", "comment", "havola", "link", "chatplace"],
  );
}

console.log("\n── NEW Approach: Keyword + OCR + Semantic Matching ──");

const newMatches = [];
for (let i = 0; i < sentences.length; i++) {
  const s = sentences[i];
  const keywords = keywordsPerSentence[i] || [];

  // Score each NEW scene
  let bestScene = newScenes[0];
  let bestScore = -1;
  let bestIdx = 0;

  for (let j = 0; j < newScenes.length; j++) {
    const scene = newScenes[j];
    const score = computeSemanticAffinity(
      s.semantic_tags || [],
      scene.contentTags,
      scene.visibleText,
      keywords
    );

    if (score > bestScore) {
      bestScore = score;
      bestScene = scene;
      bestIdx = j;
    }
  }

  // Fallback to proportional if no semantic match
  if (bestScore <= 0) {
    const midpoint = (s.start + s.end) / 2;
    const proportionalTime = (midpoint / totalDuration) * brollData.duration;
    let closestDist = Infinity;
    for (let j = 0; j < newScenes.length; j++) {
      const scene = newScenes[j];
      const sceneMid = (scene.start + scene.end) / 2;
      const dist = Math.abs(sceneMid - proportionalTime);
      if (dist < closestDist) {
        closestDist = dist;
        bestScene = scene;
        bestIdx = j;
      }
    }
  }

  const method = bestScore > 20 ? "keyword+ocr" : bestScore > 0 ? "semantic" : "proportional";
  newMatches.push({
    sentenceIndex: i,
    sentenceText: s.text,
    matchedScene: bestScene,
    offset: bestScene.start,
    method,
    score: bestScore,
    ocrHits: bestScene.visibleText?.filter(t =>
      keywords.some(kw => t.toLowerCase().includes(kw.toLowerCase()) ||
                         kw.toLowerCase().includes(t.toLowerCase()))
    ) || [],
  });

  const ocrHits = newMatches[i].ocrHits;
  console.log(`  S${i}: offset=${bestScene.start.toFixed(1)}s (${method}, score=${bestScore.toFixed(0)}) | "${s.text.substring(0, 50)}..."`);
  console.log(`        → "${bestScene.description}"`);
  if (ocrHits.length > 0) {
    console.log(`        🎯 OCR matches: [${ocrHits.join(", ")}]`);
  }
}

// ════════════════════════════════════════════════════════════
// STEP 6: Extract comparison frames from B-roll
// ════════════════════════════════════════════════════════════

console.log("\n── Extracting comparison frames ──");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function extractFrame(videoPath, timestamp, outputPath) {
  try {
    execFileSync(FFMPEG, [
      "-ss", String(Math.max(0, timestamp)),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      "-y",
      outputPath,
    ], { stdio: "pipe", timeout: 15000 });
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to extract frame at ${timestamp}s: ${err.message}`);
    return false;
  }
}

// Extract frames for each match pair
const framePairs = [];
for (let i = 0; i < sentences.length; i++) {
  const oldOffset = oldMatches[i].offset;
  const newOffset = newMatches[i].offset;

  const oldFramePath = path.join(OUTPUT_DIR, `s${i}_old_${oldOffset.toFixed(0)}s.jpg`);
  const newFramePath = path.join(OUTPUT_DIR, `s${i}_new_${newOffset.toFixed(0)}s.jpg`);

  const oldOk = extractFrame(BROLL_PATH, oldOffset + 0.5, oldFramePath);
  const newOk = extractFrame(BROLL_PATH, newOffset + 0.5, newFramePath);

  framePairs.push({
    sentenceIndex: i,
    oldFrame: oldOk ? oldFramePath : null,
    newFrame: newOk ? newFramePath : null,
    oldOffset,
    newOffset,
    sameScene: Math.abs(oldOffset - newOffset) < 1.0,
  });

  const status = Math.abs(oldOffset - newOffset) < 1.0
    ? "SAME"
    : `DIFFERENT (old=${oldOffset.toFixed(1)}s, new=${newOffset.toFixed(1)}s)`;
  console.log(`  S${i}: ${status}`);
}

// ════════════════════════════════════════════════════════════
// STEP 7: Gemini visual comparison
// ════════════════════════════════════════════════════════════

console.log("\n── Gemini Visual Comparison ──");

async function compareWithGemini(sentenceText, oldFramePath, newFramePath, oldDesc, newDesc, oldMethod, newMethod) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const parts = [
    {
      text: `You are a video editing quality checker. A speaker says this sentence:
"${sentenceText}"

Two different approaches selected B-roll to visually accompany this speech.

APPROACH A (time-proportional): Selected B-roll scene at time offset → "${oldDesc}"
APPROACH B (keyword+OCR matching): Selected B-roll scene at time offset → "${newDesc}"

Score each approach 0-100 on how well the B-roll supports the speech:
- 90-100: Perfect — B-roll directly shows what's being discussed
- 70-89: Good — B-roll is relevant and supports the speech
- 50-69: Weak — tangentially related
- 0-49: Bad — doesn't match at all

Return JSON only:
{
  "approachA_score": <number>,
  "approachA_reason": "<brief reason>",
  "approachB_score": <number>,
  "approachB_reason": "<brief reason>",
  "winner": "A" or "B" or "tie",
  "improvement": "<what changed and why it's better/worse>"
}`,
    },
  ];

  // Add images if available
  if (oldFramePath && fs.existsSync(oldFramePath)) {
    const oldImage = fs.readFileSync(oldFramePath);
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: oldImage.toString("base64"),
      },
    });
    parts.push({ text: "↑ This is the B-roll frame for APPROACH A (time-proportional)" });
  }

  if (newFramePath && fs.existsSync(newFramePath)) {
    const newImage = fs.readFileSync(newFramePath);
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: newImage.toString("base64"),
      },
    });
    parts.push({ text: "↑ This is the B-roll frame for APPROACH B (keyword+OCR matching)" });
  }

  try {
    const result = await model.generateContent(parts);
    const text = result.response.text();
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error(`  Gemini comparison failed: ${err.message}`);
    return null;
  }
}

// Run comparisons
const comparisonResults = [];
for (let i = 0; i < sentences.length; i++) {
  const pair = framePairs[i];
  const oldMatch = oldMatches[i];
  const newMatch = newMatches[i];

  if (pair.sameScene) {
    console.log(`  S${i}: SAME scene — skipping comparison`);
    comparisonResults.push({
      sentenceIndex: i,
      sameScene: true,
      oldScore: 50,
      newScore: 50,
      winner: "tie",
    });
    continue;
  }

  console.log(`  S${i}: Comparing OLD vs NEW with Gemini...`);

  const result = await compareWithGemini(
    sentences[i].text,
    pair.oldFrame,
    pair.newFrame,
    oldMatch.matchedScene.description,
    newMatch.matchedScene.description,
    oldMatch.method,
    newMatch.method,
  );

  if (result) {
    comparisonResults.push({
      sentenceIndex: i,
      sameScene: false,
      oldScore: result.approachA_score,
      newScore: result.approachB_score,
      winner: result.winner,
      oldReason: result.approachA_reason,
      newReason: result.approachB_reason,
      improvement: result.improvement,
    });

    const icon = result.winner === "B" ? "✅" : result.winner === "A" ? "❌" : "🔄";
    console.log(`    ${icon} OLD: ${result.approachA_score}/100 | NEW: ${result.approachB_score}/100 | Winner: ${result.winner}`);
    console.log(`    OLD reason: ${result.approachA_reason}`);
    console.log(`    NEW reason: ${result.approachB_reason}`);
  } else {
    comparisonResults.push({
      sentenceIndex: i,
      sameScene: false,
      oldScore: 0,
      newScore: 0,
      winner: "error",
    });
  }

  // Small delay between Gemini calls
  await new Promise(r => setTimeout(r, 500));
}

// ════════════════════════════════════════════════════════════
// STEP 8: Print comparison table
// ════════════════════════════════════════════════════════════

console.log("\n\n" + "═".repeat(70));
console.log("  COMPARISON RESULTS");
console.log("═".repeat(70));

console.log("\n┌─────┬────────────────────────────────────────────┬──────┬──────┬────────┐");
console.log("│  S# │ Sentence (first 40 chars)                   │  OLD │  NEW │ Winner │");
console.log("├─────┼────────────────────────────────────────────┼──────┼──────┼────────┤");

let totalOld = 0;
let totalNew = 0;
let newWins = 0;
let oldWins = 0;
let ties = 0;

for (const r of comparisonResults) {
  const text = sentences[r.sentenceIndex].text.substring(0, 40).padEnd(40);
  const oldScore = String(r.oldScore).padStart(4);
  const newScore = String(r.newScore).padStart(4);
  const winner = r.sameScene ? " tie " : r.winner === "B" ? " NEW ✅" : r.winner === "A" ? " OLD " : " tie ";

  console.log(`│ S${r.sentenceIndex}  │ ${text}   │ ${oldScore} │ ${newScore} │${winner} │`);

  totalOld += r.oldScore;
  totalNew += r.newScore;
  if (r.winner === "B") newWins++;
  else if (r.winner === "A") oldWins++;
  else ties++;
}

console.log("├─────┼────────────────────────────────────────────┼──────┼──────┼────────┤");

const avgOld = (totalOld / comparisonResults.length).toFixed(1);
const avgNew = (totalNew / comparisonResults.length).toFixed(1);
console.log(`│ AVG │                                            │ ${String(avgOld).padStart(4)} │ ${String(avgNew).padStart(4)} │        │`);
console.log("└─────┴────────────────────────────────────────────┴──────┴──────┴────────┘");

console.log(`\n  Summary:`);
console.log(`    NEW approach wins: ${newWins}/${comparisonResults.length}`);
console.log(`    OLD approach wins: ${oldWins}/${comparisonResults.length}`);
console.log(`    Ties:             ${ties}/${comparisonResults.length}`);
console.log(`    Average OLD score: ${avgOld}/100`);
console.log(`    Average NEW score: ${avgNew}/100`);
console.log(`    Improvement:       ${(parseFloat(avgNew) - parseFloat(avgOld)).toFixed(1)} points`);

// Detailed improvements
console.log("\n── Detailed Improvements ──");
for (const r of comparisonResults) {
  if (r.sameScene) continue;
  if (r.improvement) {
    console.log(`  S${r.sentenceIndex}: ${r.improvement}`);
  }
}

// Save results
const resultPath = path.join(OUTPUT_DIR, "comparison-results.json");
fs.writeFileSync(resultPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  sentences: sentences.map((s, i) => ({
    index: i,
    text: s.text,
    oldMatch: {
      offset: oldMatches[i].offset,
      method: oldMatches[i].method,
      description: oldMatches[i].matchedScene.description,
    },
    newMatch: {
      offset: newMatches[i].offset,
      method: newMatches[i].method,
      score: newMatches[i].score,
      description: newMatches[i].matchedScene.description,
      ocrHits: newMatches[i].ocrHits,
    },
    comparison: comparisonResults[i],
  })),
  summary: {
    avgOld: parseFloat(avgOld),
    avgNew: parseFloat(avgNew),
    improvement: parseFloat(avgNew) - parseFloat(avgOld),
    newWins,
    oldWins,
    ties,
  },
}, null, 2));

console.log(`\n✓ Results saved to: ${resultPath}`);
console.log(`✓ Comparison frames saved to: ${OUTPUT_DIR}/`);

const passed = parseFloat(avgNew) >= parseFloat(avgOld);
console.log(`\n${passed ? "✅ PASS" : "❌ FAIL"}: NEW approach ${passed ? "is equal or better" : "is worse"} than OLD approach`);
console.log("═".repeat(70) + "\n");

process.exit(passed ? 0 : 1);
