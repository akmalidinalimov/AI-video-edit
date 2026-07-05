/**
 * aligner.ts — pluggable, COMMERCIAL-SAFE word-level forced alignment.
 *
 * WHY THIS EXISTS: the previous hard dependency (torchaudio MMS_FA) is CC-BY-NC-4.0 —
 * NON-COMMERCIAL — a legal ship-gate for a commercial product. This abstraction makes the
 * commercial-safe backend the DEFAULT and demotes MMS to an explicit dev-only opt-in.
 *
 * Gemini gives the correct WORDS; a forced aligner re-pins their TIMES to the audio.
 * Providers (license = the ship-gate criterion):
 *   - stable_ts (DEFAULT) — stable-ts + OpenAI Whisper, both **MIT** (code AND weights).
 *       Uzbek-capable (Whisper is multilingual; forced alignment of KNOWN words needs no
 *       per-language model). Offline, no API key. → scripts/python/align_stable.py
 *   - scribe — ElevenLabs Scribe API (commercial license; you own the output). Needs
 *       ELEVENLABS_API_KEY. Word timestamps in one call. (Wired when a key is present.)
 *   - gemini — PASSTHROUGH: keep Gemini's own word times. Commercial-safe, less precise
 *       (drift ~300-1000ms). The always-available fallback so a render never breaks.
 *   - mms — legacy torchaudio MMS_FA. **CC-BY-NC-4.0 → NON-COMMERCIAL.** NEVER auto-selected;
 *       requires ALIGNER_PROVIDER=mms and prints a loud "do not ship" warning.
 *
 * Selection: env ALIGNER_PROVIDER (explicit) else AUTO = scribe(if key) → stable_ts(if
 * installed) → gemini. Non-blocking: any failure falls back to Gemini times.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface ClipTranscription {
  words: Array<{ word: string; start: number; end: number }>;
  sentences: Array<{ text: string; start: number; end: number; semantic_tags?: string[] }>;
}

export type AlignProvider = "stable_ts" | "scribe" | "gemini" | "mms";

/** Providers considered forced-aligned AND commercial-safe (the regression gate accepts these). */
export const COMMERCIAL_SAFE_ALIGNERS: readonly string[] = ["stable_ts", "scribe", "mfa"];

const PY = path.join(process.cwd(), "scripts", "python", ".venv", "Scripts", "python.exe");
const STABLE_SCRIPT = path.join(process.cwd(), "scripts", "python", "align_stable.py");
const MMS_SCRIPT = path.join(process.cwd(), "scripts", "python", "align_mms.py");

function stableAvailable(): boolean {
  return fs.existsSync(PY) && fs.existsSync(STABLE_SCRIPT);
}

/** Resolve which provider to use. NEVER returns "mms" unless it is explicitly requested. */
export function resolveAlignProvider(): AlignProvider {
  const explicit = (process.env.ALIGNER_PROVIDER || "").toLowerCase().trim();
  if (explicit === "mms") {
    console.warn(
      "[aligner] ⚠️  ALIGNER_PROVIDER=mms — torchaudio MMS_FA weights are CC-BY-NC-4.0 " +
      "(NON-COMMERCIAL). This path is for local/dev research only. DO NOT SHIP commercially."
    );
    return "mms";
  }
  if (explicit === "stable_ts" || explicit === "scribe" || explicit === "gemini") return explicit as AlignProvider;
  // AUTO (commercial-safe order): scribe if a key is configured, else local stable-ts, else passthrough.
  if (process.env.ELEVENLABS_API_KEY) return "scribe";
  if (stableAvailable()) return "stable_ts";
  return "gemini";
}

/** Run a Python aligner script (stable_ts / mms) that updates the transcription JSON in place. */
function runPythonAligner(script: string, tr: ClipTranscription, audioPath: string, tempDir: string, idx: number, tag: string): ClipTranscription | null {
  if (!fs.existsSync(PY) || !fs.existsSync(script)) return null;
  const trPath = path.join(tempDir, `align-${idx}.json`);
  const outPath = path.join(tempDir, `align-${idx}-words.json`);
  try {
    fs.writeFileSync(trPath, JSON.stringify({ words: tr.words, sentences: tr.sentences, language: (tr as { language?: string }).language ?? "uz" }));
    execFileSync(PY, [script, audioPath, trPath, outPath], { stdio: "pipe", timeout: 600_000 });
    const aligned = JSON.parse(fs.readFileSync(trPath, "utf8")) as ClipTranscription;
    console.log(`[aligner] clip ${idx}: aligned ${aligned.words?.length ?? 0} words (detector=${tag})`);
    return { words: aligned.words ?? tr.words, sentences: aligned.sentences ?? tr.sentences };
  } catch (e) {
    console.error(`[aligner] clip ${idx} ${tag} alignment failed (non-blocking):`, (e as Error).message?.slice(0, 160));
    return null;
  }
}

/**
 * Align `tr`'s words/sentences to `audioPath` with the resolved COMMERCIAL-SAFE provider.
 * `idx` disambiguates temp files. Returns Gemini times on any failure (never throws).
 */
export function alignTranscription(tr: ClipTranscription, audioPath: string, tempDir: string, idx = 0): ClipTranscription & { detector: string } {
  if (!tr.words?.length) return { ...tr, detector: "gemini" };
  const provider = resolveAlignProvider();

  if (provider === "stable_ts") {
    const r = runPythonAligner(STABLE_SCRIPT, tr, audioPath, tempDir, idx, "stable_ts");
    if (r) return { ...r, detector: "stable_ts" };
    console.warn("[aligner] stable_ts unavailable/failed — falling back to Gemini times (commercial-safe, less precise)");
    return { ...tr, detector: "gemini" };
  }
  if (provider === "scribe") {
    // ElevenLabs Scribe requires a live API call; wired when ELEVENLABS_API_KEY is set.
    // Until the Scribe backend is implemented+tested, fall back to the local commercial-safe path.
    if (stableAvailable()) {
      const r = runPythonAligner(STABLE_SCRIPT, tr, audioPath, tempDir, idx, "stable_ts");
      if (r) { console.log("[aligner] scribe requested; using local stable_ts (commercial-safe) until Scribe backend is enabled"); return { ...r, detector: "stable_ts" }; }
    }
    return { ...tr, detector: "gemini" };
  }
  if (provider === "mms") {
    const r = runPythonAligner(MMS_SCRIPT, tr, audioPath, tempDir, idx, "mms");
    if (r) return { ...r, detector: "mms" }; // non-commercial — dev only
    return { ...tr, detector: "gemini" };
  }
  // gemini passthrough
  return { ...tr, detector: "gemini" };
}
