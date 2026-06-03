/**
 * reel2-transcribe.mjs — verbatim transcript + sentence timings of a clip via Gemini.
 * Used to recover reel-2's real dialogue + sequence and to QA the rendered output.
 *   node scripts/reel2-transcribe.mjs <video> [--label name]
 */
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const ROOT = process.cwd();
const video = process.argv[2];
const li = process.argv.indexOf("--label");
const label = li >= 0 ? process.argv[li + 1] : path.basename(video);
if (!video) { console.error("usage: node scripts/reel2-transcribe.mjs <video> [--label name]"); process.exit(1); }

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim();
  }
  return process.env.GEMINI_API_KEY;
}

const PROMPT = `Transcribe the SPOKEN AUDIO of this video VERBATIM. Return STRICT JSON:
{ "language": "...", "fullText": "<everything said, verbatim>",
  "sentences": [ { "startSec": n, "endSec": n, "text": "..." } ],
  "audioIssues": "<note any abrupt cut-off words, mid-word audio cuts, or jarring jumps you HEAR; '' if none>" }
Be precise about sentence start/end seconds. If a word is cut off at an audio boundary, note it in audioIssues.`;

async function main() {
  const key = loadKey();
  if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  const abs = path.resolve(ROOT, video);
  const fm = new GoogleAIFileManager(key);
  process.stdout.write(`[${label}] uploading...`);
  const up = await fm.uploadFile(abs, { mimeType: video.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4", displayName: label });
  let file = await fm.getFile(up.file.name);
  while (file.state === "PROCESSING") { await new Promise(r => setTimeout(r, 2000)); file = await fm.getFile(up.file.name); }
  if (file.state !== "ACTIVE") { console.error(" upload failed", file.state); process.exit(1); }
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0, responseMimeType: "application/json" } });
  process.stdout.write(" transcribing...\n");
  const res = await model.generateContent([{ fileData: { mimeType: file.mimeType, fileUri: file.uri } }, { text: PROMPT }]);
  const j = JSON.parse(res.response.text());
  console.log(`\n=== ${label} (${j.language}) ===`);
  console.log(`FULL: ${j.fullText}`);
  console.log(`\nSENTENCES:`);
  for (const s of j.sentences || []) console.log(`  [${s.startSec}-${s.endSec}] ${s.text}`);
  console.log(`\nAUDIO ISSUES: ${j.audioIssues || "(none noted)"}`);
}
main().catch(e => { console.error(e); process.exit(1); });
