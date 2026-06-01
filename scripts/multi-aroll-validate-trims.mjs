/**
 * Re-emit clean-timeline.json with trims snapped to TRUE WORD boundaries
 * (WhisperX word onsets/offsets) instead of ffmpeg silencedetect. A breath is
 * sound but not a word, so word-snapping excludes the speaker's in-breath that
 * silencedetect used to catch.
 *
 * Run:  node scripts/multi-aroll-validate-trims.mjs
 *
 * Source of truth for the ROUGH boundaries is clean-timeline.pre-validate.json
 * (the original Gemini sentence timestamps). That backup is preserved, never
 * overwritten — re-running is idempotent.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { validateTrims } from "./lib/trim-validator.mjs";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const STAGE2 = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
const TL = path.join(STAGE2, "clean-timeline.json");
const PRE = path.join(STAGE2, "clean-timeline.pre-validate.json");

// Decode a window of clip audio to a per-25ms-window RMS-dB envelope.
const WIN = 0.025, SR = 16000, THRESH_DB = -34, SUSTAIN = 3;
function rmsEnvelope(clipPath, from, span) {
  let pcm;
  try {
    pcm = execFileSync(FFMPEG, [
      "-ss", Math.max(0, from).toFixed(4), "-t", span.toFixed(4), "-i", clipPath,
      "-ac", "1", "-ar", String(SR), "-f", "s16le", "-loglevel", "error", "pipe:1",
    ], { maxBuffer: 8 * 1024 * 1024 });
  } catch { return null; }
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const wn = Math.floor(WIN * SR);
  const nWin = Math.floor(samples.length / wn);
  const env = [];
  for (let k = 0; k < nWin; k++) {
    let sum = 0;
    for (let j = 0; j < wn; j++) { const v = samples[k * wn + j] / 32768; sum += v * v; }
    env.push(10 * Math.log10(Math.max(1e-10, sum / wn)));
  }
  return env;
}

// Word boundaries now come from MMS FORCED ALIGNMENT (align_mms.py) and are
// precise (~20-50ms). The acoustic refiners are now just gentle SILENCE polish at
// the cut — small search windows (they can't reach a far word, so they can't
// re-introduce a clip). The wide windows were a hack for Gemini's ~1s drift, no
// longer needed. The output re-transcription guard (boundary-guard.mjs) is the
// final safety net.

// ACOUSTIC-ONSET: find the FIRST sustained-speech window in
// [wordStart-BACK, wordStart+FWD]; cut just before it (tiny pre-roll).
const ONSET = { BACK: 0.12, FWD: 0.25, PREROLL: 0.03 };
function acousticOnset(clipIndex, clipPath, wordStart) {
  if (!clipPath || !fs.existsSync(clipPath)) return null;
  const from = Math.max(0, wordStart - ONSET.BACK);
  const env = rmsEnvelope(clipPath, from, ONSET.BACK + ONSET.FWD);
  if (!env) return null;
  let run = 0;
  for (let k = 0; k < env.length; k++) {
    if (env[k] > THRESH_DB) {
      if (++run >= SUSTAIN) return Math.max(0, from + (k - (SUSTAIN - 1)) * WIN - ONSET.PREROLL);
    } else run = 0;
  }
  return null;
}

// ACOUSTIC-OFFSET: trim a tiny bit of trailing silence after the (now precise)
// last word. Small BACK window — MMS already places the word end accurately, so we
// only polish residual silence and CANNOT reach an earlier word.
const OFFSET = { BACK: 0.35, FWD: 0.15, TAIL: 0.05 };
function acousticOffset(clipIndex, clipPath, lastWordEnd) {
  if (!clipPath || !fs.existsSync(clipPath)) return null;
  const from = Math.max(0, lastWordEnd - OFFSET.BACK);
  const env = rmsEnvelope(clipPath, from, OFFSET.BACK + OFFSET.FWD);
  if (!env) return null;
  let lastSpeechWin = -1, run = 0;
  for (let k = 0; k < env.length; k++) {
    if (env[k] > THRESH_DB) { if (++run >= SUSTAIN) lastSpeechWin = k; }
    else run = 0;
  }
  if (lastSpeechWin < 0) return null; // no speech found — keep the word-based end
  // End just after the LAST real speech window (+ tiny tail). This trims the
  // trailing silence that Gemini mislabeled as part of the last word.
  return from + (lastSpeechWin + 1) * WIN + OFFSET.TAIL;
}

function main() {
  // Use the original rough boundaries if we have them; else snap the current TL.
  const srcPath = fs.existsSync(PRE) ? PRE : TL;
  const timeline = JSON.parse(fs.readFileSync(srcPath, "utf-8"));

  // First time only: snapshot the original boundaries.
  if (!fs.existsSync(PRE)) fs.copyFileSync(TL, PRE);

  // With MMS forced-aligned word times, boundaries are precise — use them directly
  // (PREROLL/TAIL give a small clean pad). The acoustic refiners were a hack for
  // Gemini's ~1s drift and now only risk nicking a soft word edge, so they're off.
  // (They remain available for non-aligned fallback via { acousticOnset, acousticOffset }.)
  const useRefiners = process.argv.includes("--acoustic");
  // Boundary-guard extends (if a prior pass found a clipped boundary word).
  let extendBySeg = {};
  const exPath = path.join(STAGE2, "trim-extends.json");
  if (fs.existsSync(exPath)) {
    try { extendBySeg = JSON.parse(fs.readFileSync(exPath, "utf-8")); } catch {}
  }
  const opts = { extendBySeg };
  if (useRefiners) { opts.acousticOnset = acousticOnset; opts.acousticOffset = acousticOffset; }
  const fixed = validateTrims(timeline, opts);
  fs.writeFileSync(TL, JSON.stringify(fixed, null, 2));

  console.log(`Sentence-anchored trim validation complete${useRefiners ? " (+acoustic)" : " (MMS-precise)"}.`);
  console.log(`  Source: ${path.basename(srcPath)}`);
  console.log(`  totalDuration ${timeline.totalDuration} -> ${fixed.totalDuration}\n`);
  for (const s of fixed.segments) {
    console.log(`  seg ${s.segmentIndex} (${s.sourceClipName}): ` +
      `src ${s.sourceStart.toFixed(3)}-${s.sourceEnd.toFixed(3)} (${s.sourceDuration.toFixed(3)}s)`);
    console.log(`        ${s._trimNote}`);
  }
}

main();
