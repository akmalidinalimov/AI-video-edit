/**
 * validate-scribe.mjs — A/B the timing engines on OUR real Uzbek clip.
 * Sends the A-roll audio to ElevenLabs Scribe, then compares Scribe's word
 * timestamps against the MMS forced-alignment times we already have, word-by-word.
 *
 * Needs ELEVENLABS_API_KEY in .env.local. Run:
 *   node scripts/validate-scribe.mjs            # default model scribe_v1, audio auto
 *   node scripts/validate-scribe.mjs scribe_v1 uzb
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const model = process.argv[2] || "scribe_v1";
const lang = process.argv[3] || ""; // "" = auto-detect; or "uzb"

// .env.local
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error("MISSING ELEVENLABS_API_KEY in .env.local"); process.exit(2); }

const audioPath = path.join(root, "public/exports/sp-temp/aroll-audio.mp3");
if (!existsSync(audioPath)) { console.error("missing audio: " + audioPath + " (extract it first)"); process.exit(2); }

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

async function main() {
  console.log(`Scribe: model=${model} lang=${lang || "auto"} ...`);
  const buf = readFileSync(audioPath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "aroll.mp3");
  fd.append("model_id", model);
  fd.append("timestamps_granularity", "word");
  if (lang) fd.append("language_code", lang);

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": KEY }, body: fd });
  if (!res.ok) { console.error(`Scribe HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`); process.exit(1); }
  const data = await res.json();
  const sWords = (data.words ?? []).filter((w) => (w.type ?? "word") === "word" && norm(w.text ?? w.word ?? ""));
  console.log(`Scribe language=${data.language_code ?? "?"}  words=${sWords.length}`);
  writeFileSync(path.join(root, "public/exports/sp-temp/aroll-words-scribe.json"), JSON.stringify({ model, language: data.language_code, words: sWords.map((w) => ({ word: w.text ?? w.word, start: w.start, end: w.end })) }, null, 2));

  // MMS reference (already aligned in place)
  const mms = JSON.parse(readFileSync(path.join(root, "public/exports/sp-temp/aroll-transcription.json"), "utf8")).words ?? [];

  // Sequential word-by-word match (both should be the same utterance in order)
  const deltas = [];
  let si = 0;
  for (const mw of mms) {
    const mn = norm(mw.word); if (!mn) continue;
    // find the next Scribe word that matches (within a small look-ahead)
    let j = -1;
    for (let k = si; k < Math.min(si + 4, sWords.length); k++) { if (norm(sWords[k].text ?? sWords[k].word) === mn) { j = k; break; } }
    if (j >= 0) { deltas.push({ word: mw.word, mms: mw.start, scribe: sWords[j].start, d: sWords[j].start - mw.start }); si = j + 1; }
  }
  const abs = deltas.map((x) => Math.abs(x.d)).sort((a, b) => a - b);
  const mean = abs.reduce((a, b) => a + b, 0) / (abs.length || 1);
  const median = abs[Math.floor(abs.length / 2)] ?? 0;
  console.log(`\nmatched ${deltas.length}/${mms.length} words | |Δ| mean=${(mean * 1000).toFixed(0)}ms median=${(median * 1000).toFixed(0)}ms max=${(Math.max(...abs, 0) * 1000).toFixed(0)}ms`);
  console.log("\nKey words (start times):");
  for (const kw of ["1500", "90", "tugmani", "bosib", "maqsad", "daromad"]) {
    const r = deltas.find((x) => norm(x.word).includes(kw));
    if (r) console.log(`  ${r.word.padEnd(14)} mms=${r.mms.toFixed(2)}s  scribe=${r.scribe.toFixed(2)}s  Δ=${(r.d * 1000).toFixed(0)}ms`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
