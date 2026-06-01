/**
 * transcript-verify.mjs — verify the EDITED video keeps each sentence COMPLETE.
 *
 * Two layers:
 *   (1) DETERMINISTIC (the 100% gate, no ASR): each segment's [sourceStart,
 *       sourceEnd] must contain EXACTLY its intended sentence's words — no first/
 *       last word clipped, no neighbour word bleeding in. Uses the source word
 *       timings we already have; a word counts as "in" the cut if its MIDPOINT is
 *       inside [sourceStart,sourceEnd] (robust to the small acoustic silence-trim
 *       at the edges, which removes silence, not the word).
 *   (2) CONFIDENCE (Gemini, optional): cut the rendered segment's audio,
 *       Gemini-transcribe it, align to the expected tokens, return a word-match
 *       accuracy %. Catches render/audio bugs the deterministic layer can't see.
 *
 * Reuses sentence resolution from trim-validator.mjs (single source of truth).
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  loadTranscription, resolveIntendedSentence, normalizeTokens, SENT_EPS,
} from "./trim-validator.mjs";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const MID_EPS = 0.02; // midpoint inclusion slack (seconds)
const SPEECH_DB = -34; // a cut-off boundary region above this = real speech (clip), below = silence

const mid = (w) => (w.start + w.end) / 2;

/**
 * Does a clip-audio window contain SUSTAINED speech (>= `sustain` consecutive
 * 25ms windows above SPEECH_DB)? Used to decide whether the portion of a boundary
 * word cut off by the trim was real SPEECH (a true clip) or SILENCE (the acoustic
 * refiner correctly trimming a mistimed onset/offset, possibly leaving a 1-window
 * residual right at the cut). Returns false on any failure (treated as silence).
 */
function hasSustainedSpeech(clipPath, from, to, sustain = 2) {
  if (!clipPath || !fs.existsSync(clipPath) || to - from < 0.01) return false;
  let pcm;
  try {
    pcm = execFileSync(FFMPEG, [
      "-ss", Math.max(0, from).toFixed(4), "-to", to.toFixed(4), "-i", clipPath,
      "-ac", "1", "-ar", "16000", "-f", "s16le", "-loglevel", "error", "pipe:1",
    ], { maxBuffer: 8 * 1024 * 1024 });
  } catch { return false; }
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const wn = 400; // 25ms @16k
  let run = 0;
  for (let k = 0; k + wn <= samples.length; k += wn) {
    let sum = 0;
    for (let j = 0; j < wn; j++) { const v = samples[k + j] / 32768; sum += v * v; }
    const db = 10 * Math.log10(Math.max(1e-10, sum / wn));
    if (db > SPEECH_DB) { if (++run >= sustain) return true; }
    else run = 0;
  }
  return false;
}

/** Index range [a,b] (inclusive) of the intended sentence's words in the clip word list. */
function sentenceWordIndexRange(words, startSentence, endSentence) {
  const lo = startSentence.start - SENT_EPS, hi = endSentence.end + SENT_EPS;
  let a = -1, b = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start >= lo && words[i].end <= hi) { if (a < 0) a = i; b = i; }
  }
  return a < 0 ? null : { a, b };
}

/**
 * DETERMINISTIC word-completeness check for one segment.
 *   -> { passed, reason, expected, actual, clippedStart, clippedEnd,
 *        extraLeading, extraTrailing }
 */
export function verifyDeterministic(segment, opts = {}) {
  const audioRecheck = opts.audioRecheck !== false; // default on (needs ffmpeg + clip path)
  const tr = loadTranscription(segment.sourceClipIndex);
  if (!tr) return { passed: true, reason: "no transcription (skipped)", expected: [], actual: [] };
  const resolved = resolveIntendedSentence(segment, tr);
  if (!resolved) return { passed: true, reason: "sentence unresolved (skipped)", expected: [], actual: [] };

  const words = tr.words;
  const range = sentenceWordIndexRange(words, resolved.startSentence, resolved.endSentence);
  if (!range) return { passed: true, reason: "no words in sentence span (skipped)", expected: [], actual: [] };

  const { a, b } = range;
  const expected = words.slice(a, b + 1).map(w => w.word);

  // Words whose MIDPOINT falls inside the cut.
  const s = segment.sourceStart - MID_EPS, e = segment.sourceEnd + MID_EPS;
  let lo = -1, hi = -1;
  for (let i = 0; i < words.length; i++) {
    const m = mid(words[i]);
    if (m >= s && m <= e) { if (lo < 0) lo = i; hi = i; }
  }
  const actual = lo < 0 ? [] : words.slice(lo, hi + 1).map(w => w.word);

  let clippedStart = lo < 0 || lo > a;     // first intended word missing
  let clippedEnd = hi < 0 || hi < b;       // last intended word missing
  const extraLeading = lo >= 0 && lo < a;  // neighbour word before the sentence leaked in
  const extraTrailing = hi >= 0 && hi > b; // neighbour word after the sentence leaked in

  // ENERGY recheck: Gemini word timestamps drift ~±250ms, so a "clipped" boundary
  // word may just be a mistimed onset/offset where the cut removed SILENCE (the
  // acoustic refiner's job), not the word. Only keep the flag if the cut-off
  // portion is actually SPEECH.
  if (audioRecheck && clippedStart && !extraLeading) {
    // cut-off = [word labeled start, segment start); skip the 1-window residual
    // right at the cut by trusting only SUSTAINED speech.
    if (!hasSustainedSpeech(segment.sourceClipPath, words[a].start, segment.sourceStart)) clippedStart = false;
  }
  if (audioRecheck && clippedEnd && !extraTrailing) {
    if (!hasSustainedSpeech(segment.sourceClipPath, segment.sourceEnd, words[b].end)) clippedEnd = false;
  }

  const problems = [];
  if (clippedStart) problems.push(`clipped START (missing "${words[a].word}")`);
  if (clippedEnd) problems.push(`clipped END (missing "${words[b].word}")`);
  if (extraLeading) problems.push(`extra leading word "${words[lo].word}"`);
  if (extraTrailing) problems.push(`extra trailing word "${words[hi].word}"`);

  return {
    passed: problems.length === 0,
    reason: problems.join("; ") || "complete",
    expected, actual, clippedStart, clippedEnd, extraLeading, extraTrailing,
  };
}

/** Run the deterministic check over a whole timeline. */
export function verifyTimelineDeterministic(timeline) {
  const perSegment = timeline.segments.map((seg, i) => ({
    segmentIndex: i, id: seg.id, ...verifyDeterministic(seg),
  }));
  return { passed: perSegment.every(p => p.passed), perSegment };
}

// ──────────────────────────────────────────────────────────────────────────
// CONFIDENCE LAYER (Gemini) — optional, async
// ──────────────────────────────────────────────────────────────────────────

function loadGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const envPath = path.join(ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim();
    }
  }
  return process.env.GEMINI_API_KEY || null;
}

/** Levenshtein similarity ratio in [0,1] (tolerates Uzbek spelling variants). */
function simRatio(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[m] / Math.max(m, n);
}

/** Fuzzy LCS length: tokens match if their similarity >= 0.82. */
function fuzzyLcs(a, b) {
  const dp = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = simRatio(a[i - 1], b[j - 1]) >= 0.82 ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Gemini confidence check for one segment: cut its rendered audio, transcribe,
 * align to expected tokens, return accuracy in [0,1]. Reuses transcribe-aroll's
 * prompt/model pattern. Returns { accuracy, expected, heard } (accuracy null on error).
 */
export async function verifyGemini(renderedMp4, segment, expectedTokens) {
  const key = loadGeminiKey();
  if (!key) return { accuracy: null, reason: "no GEMINI_API_KEY", expected: expectedTokens, heard: [] };

  // Cut segment audio to mp3, PADDED by 0.15s each side so a boundary word isn't
  // clipped by the cut itself (extra adjacent words don't hurt — we measure how
  // many EXPECTED words are heard).
  const PAD = 0.15;
  const tmp = path.join(ROOT, "public", "exports", "multi-aroll", "stage4", `_seg${segment.segmentIndex ?? "x"}_audio.mp3`);
  try {
    execFileSync(FFMPEG, [
      "-y", "-ss", Math.max(0, segment.timelineStart - PAD).toFixed(4), "-to", (segment.timelineEnd + PAD).toFixed(4),
      "-i", renderedMp4, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "96k",
      "-loglevel", "error", tmp,
    ]);
  } catch (e) { return { accuracy: null, reason: "ffmpeg cut failed", expected: expectedTokens, heard: [] }; }

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-flash" });
  const audioBase64 = fs.readFileSync(tmp).toString("base64");
  const prompt = `Transcribe this short Uzbek speech clip VERBATIM. Return ONLY the raw words spoken, as plain text, no punctuation needed, no explanation, no JSON.`;

  let heard = [];
  for (let retry = 0; retry < 3; retry++) {
    try {
      const res = await model.generateContent([
        { text: prompt },
        { inlineData: { mimeType: "audio/mpeg", data: audioBase64 } },
      ]);
      heard = normalizeTokens(res.response.text());
      break;
    } catch (e) {
      if (retry === 2) { try { fs.unlinkSync(tmp); } catch {} return { accuracy: null, reason: "gemini failed", expected: expectedTokens, heard: [] }; }
      await new Promise(r => setTimeout(r, 2500));
    }
  }
  try { fs.unlinkSync(tmp); } catch {}

  const matched = fuzzyLcs(expectedTokens, heard);
  const accuracy = expectedTokens.length ? matched / expectedTokens.length : 1;
  return { accuracy, expected: expectedTokens, heard };
}

/** Gemini confidence over the whole timeline. opts.minAccuracy default 0.95. */
export async function verifyTimelineGemini(renderedMp4, timeline, opts = {}) {
  const minAccuracy = opts.minAccuracy ?? 0.95;
  const perSegment = [];
  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = { ...timeline.segments[i], segmentIndex: i };
    const det = verifyDeterministic(seg);
    const expectedTokens = det.expected.map(w => normalizeTokens(w).join("")).filter(Boolean);
    const r = await verifyGemini(renderedMp4, seg, expectedTokens);
    perSegment.push({ segmentIndex: i, id: seg.id, ...r, passed: r.accuracy == null ? null : r.accuracy >= minAccuracy });
  }
  const scored = perSegment.filter(p => p.accuracy != null);
  return {
    passed: scored.length > 0 && scored.every(p => p.accuracy >= minAccuracy),
    minAccuracy: scored.length ? Math.min(...scored.map(p => p.accuracy)) : null,
    perSegment,
  };
}
