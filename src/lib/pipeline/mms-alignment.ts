/**
 * ⚠️ DEPRECATED — do NOT use in the live/commercial path. torchaudio MMS_FA is CC-BY-NC-4.0
 * (NON-COMMERCIAL). The live route now uses the pluggable COMMERCIAL-SAFE aligner in
 * `aligner.ts` (stable-ts/Whisper by default). This file is kept only for the standalone
 * dev/test path; MMS is reachable via `aligner.ts` only with ALIGNER_PROVIDER=mms.
 *
 * mms-alignment.ts — (legacy) wire MMS forced alignment into the pipeline.
 *
 * Gemini gives the correct WORDS but its per-word TIMES drift 0.5–2.2s (measured). MMS
 * forced alignment (scripts/python/align_mms.py, torchaudio MMS_FA — Uzbek-capable) re-pins
 * each known word to the actual audio. This helper aligns ONE clip's transcription to its
 * own audio; the route calls it per A-roll clip BEFORE the offset-merge, so the whole
 * timeline (plan, MG placement, captions) runs on accurate times.
 *
 * Non-blocking: if the venv/model/script is missing or align fails, returns the input
 * unchanged (Gemini times) so a render never breaks on alignment.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface ClipTranscription {
  words: Array<{ word: string; start: number; end: number }>;
  sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }>;
}

const PY = path.join(process.cwd(), "scripts", "python", ".venv", "Scripts", "python.exe");
const SCRIPT = path.join(process.cwd(), "scripts", "python", "align_mms.py");

/** True if the MMS toolchain (venv python + script) is present. */
export function mmsAvailable(): boolean {
  return fs.existsSync(PY) && fs.existsSync(SCRIPT);
}

/**
 * Re-time `tr`'s words/sentences to `audioPath` via MMS forced alignment.
 * `idx` disambiguates temp files for multi-clip runs. Returns Gemini times on any failure.
 */
export function alignTranscriptionMMS(tr: ClipTranscription, audioPath: string, tempDir: string, idx = 0): ClipTranscription {
  if (!mmsAvailable()) { console.warn("[mms] toolchain not found — keeping Gemini times"); return tr; }
  if (!tr.words?.length) return tr;
  const trPath = path.join(tempDir, `mms-clip-${idx}.json`);
  const outPath = path.join(tempDir, `mms-clip-${idx}-words.json`);
  try {
    fs.writeFileSync(trPath, JSON.stringify({ words: tr.words, sentences: tr.sentences }));
    // align_mms.py updates trPath IN PLACE with MMS times + re-derives sentence times.
    execFileSync(PY, [SCRIPT, audioPath, trPath, outPath], { stdio: "pipe", timeout: 300_000 });
    const aligned = JSON.parse(fs.readFileSync(trPath, "utf8")) as ClipTranscription;
    const n = aligned.words?.length ?? 0;
    console.log(`[mms] clip ${idx}: aligned ${n} words to audio (detector=mms)`);
    return { words: aligned.words ?? tr.words, sentences: aligned.sentences ?? tr.sentences };
  } catch (e) {
    console.error(`[mms] clip ${idx} alignment failed (non-blocking):`, (e as Error).message?.slice(0, 160));
    return tr;
  }
}
