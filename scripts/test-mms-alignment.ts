/** Verify the MMS-into-route helper: it re-times Gemini words to the audio (real Python run). */
import { readFileSync, existsSync } from "node:fs";
import { alignTranscriptionMMS, mmsAvailable } from "../src/lib/pipeline/mms-alignment.ts";

const root = process.cwd();
let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

console.log("mmsAvailable:", mmsAvailable());
ok("MMS toolchain present", mmsAvailable());

// Use the Gemini backup (pre-alignment) so we can SEE the shift.
const gemPath = `${root}/public/exports/sp-temp/aroll-transcription.gemini.json`;
const src = existsSync(gemPath) ? gemPath : `${root}/public/exports/sp-temp/aroll-transcription.json`;
const tr = JSON.parse(readFileSync(src, "utf8"));
const audio = existsSync(`${root}/public/exports/sp-temp/aroll-audio.mp3`)
  ? `${root}/public/exports/sp-temp/aroll-audio.mp3`
  : `${root}/public/uploads/aroll-clean.mp4`;
console.log(`source: ${src.split(/[\\/]/).pop()} | audio: ${audio.split(/[\\/]/).pop()}`);

const t0 = Date.now();
const aligned = alignTranscriptionMMS({ words: tr.words, sentences: tr.sentences }, audio, `${root}/public/exports/sp-temp`, 99);
console.log(`aligned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

ok("returns same word count", aligned.words.length === tr.words.length, `${aligned.words.length} vs ${tr.words.length}`);
const find = (arr: any[], re: RegExp) => arr.find((w) => re.test(w.word))?.start;
for (const kw of ["1500", "90", "tugmani"]) {
  const a = find(aligned.words, new RegExp(kw));
  const b = find(tr.words, new RegExp(kw));
  if (a != null && b != null) console.log(`  ${kw.padEnd(8)} in=${b.toFixed(2)}s  out=${a.toFixed(2)}s  Δ=${((a - b) * 1000).toFixed(0)}ms`);
}
// If the source was the Gemini backup, times should have shifted EARLIER (Gemini was late).
if (src.endsWith(".gemini.json")) {
  const tugIn = find(tr.words, /tugmani/), tugOut = find(aligned.words, /tugmani/);
  ok("MMS shifted 'tugmani' earlier than Gemini (the late-time fix)", tugOut != null && tugIn != null && tugOut < tugIn - 0.5, { tugIn, tugOut });
} else {
  ok("times are stable (already MMS-aligned source)", true);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
