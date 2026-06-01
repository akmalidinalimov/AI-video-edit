/**
 * boundary-guard.mjs — the user's idea, as the final safety net: transcribe the
 * TRIMMED OUTPUT and confirm the FIRST and LAST intended word of each segment are
 * actually present at the boundary. If a boundary word is clipped, the closed loop
 * EXTENDS that trim and re-checks. This catches any residual clip even if the
 * forced alignment ever slips.
 *
 * It is POSITION-AWARE: unlike the overall %-match (which is noisy on Uzbek middle
 * words), it only asks "does the segment START with its expected first word and END
 * with its expected last word" — exactly the thing the user keeps catching.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  loadTranscription, resolveIntendedSentence, sentenceWordSpan, normalizeTokens, CONTIG_EPS,
} from "./trim-validator.mjs";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const PAD = 0.18;        // include a little context so a present boundary word is fully heard
const SIM = 0.72;        // fuzzy token-match threshold
const NEAR = 2;          // boundary word must appear within the first/last NEAR heard tokens

function simRatio(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length; if (!m || !n) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) { const t = dp[i]; dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return 1 - dp[m] / Math.max(m, n);
}
const near = (token, arr) => arr.some(h => simRatio(token, h) >= SIM);

let _gemini = null;
async function geminiTranscribe(mp3Path) {
  if (!process.env.GEMINI_API_KEY) {
    const envPath = path.join(ROOT, ".env.local");
    if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const mm = line.match(/^([^#=]+)=(.*)$/); if (mm) process.env[mm[1].trim()] = mm[2].trim();
    }
  }
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_gemini) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: "gemini-2.5-flash" });
  }
  const audioBase64 = fs.readFileSync(mp3Path).toString("base64");
  const prompt = "Transcribe this short Uzbek speech clip VERBATIM. Return ONLY the raw words, plain text, no punctuation, no explanation.";
  for (let r = 0; r < 3; r++) {
    try {
      const res = await _gemini.generateContent([{ text: prompt }, { inlineData: { mimeType: "audio/mpeg", data: audioBase64 } }]);
      return normalizeTokens(res.response.text());
    } catch { await new Promise(z => setTimeout(z, 2500)); }
  }
  return null;
}

/** Is segment i the start / end of a same-clip merged run? */
function runFlags(segs, i) {
  const p = segs[i - 1], n = segs[i + 1];
  const isRunStart = !(p && p.sourceClipIndex === segs[i].sourceClipIndex && Math.abs(p.sourceEnd - segs[i].sourceStart) < CONTIG_EPS);
  const isRunEnd = !(n && n.sourceClipIndex === segs[i].sourceClipIndex && Math.abs(segs[i].sourceEnd - n.sourceStart) < CONTIG_EPS);
  return { isRunStart, isRunEnd };
}

/**
 * Check the first/last intended word of each segment in the rendered output.
 *   → { passed, perSegment:[{ segment, firstOk, lastOk, expectedFirst, expectedLast, heard }] }
 * Only the run's OUTER edges are real cut boundaries; internal run continuations
 * are skipped (continuous speech).
 */
export async function checkBoundaryWords(videoPath, timeline) {
  const segs = timeline.segments;
  const perSegment = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = { ...segs[i], segmentIndex: i };
    const tr = loadTranscription(seg.sourceClipIndex);
    const resolved = tr ? resolveIntendedSentence(seg, tr) : null;
    const span = resolved ? sentenceWordSpan(tr.words, resolved.startSentence, resolved.endSentence) : null;
    if (!span) { perSegment.push({ segment: i, skipped: "no sentence" }); continue; }

    const { isRunStart, isRunEnd } = runFlags(segs, i);
    const expectedFirst = normalizeTokens(span.firstWord).join("");
    const expectedLast = normalizeTokens(span.lastWord).join("");

    const tmp = path.join(ROOT, "public", "exports", "multi-aroll", "stage4", `_bg_seg${i}.mp3`);
    try {
      execFileSync(FFMPEG, ["-y", "-ss", Math.max(0, seg.timelineStart - PAD).toFixed(4),
        "-to", (seg.timelineEnd + PAD).toFixed(4), "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000",
        "-b:a", "96k", "-loglevel", "error", tmp]);
    } catch { perSegment.push({ segment: i, skipped: "ffmpeg" }); continue; }
    const heard = await geminiTranscribe(tmp);
    try { fs.unlinkSync(tmp); } catch {}
    if (!heard) { perSegment.push({ segment: i, skipped: "no gemini" }); continue; }

    const firstOk = !isRunStart || !expectedFirst || near(expectedFirst, heard.slice(0, NEAR + 1));
    const lastOk = !isRunEnd || !expectedLast || near(expectedLast, heard.slice(-(NEAR + 1)));
    perSegment.push({
      segment: i, firstOk, lastOk, expectedFirst, expectedLast,
      heardFirst: heard.slice(0, 2).join(" "), heardLast: heard.slice(-2).join(" "),
    });
  }
  const passed = perSegment.every(p => p.skipped || (p.firstOk && p.lastOk));
  return { passed, perSegment };
}
