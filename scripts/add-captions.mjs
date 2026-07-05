/**
 * add-captions.mjs — burn word-timed captions onto a rendered video, matched to the
 * reference's style (middle band, white, ~2–3 word chunks). Uses the SAME word-level
 * A-roll transcript that drives B-roll/graphics placement, so captions land frame-exact.
 *
 *   node scripts/add-captions.mjs <input.mp4> [yPos]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const FF = path.join(root, "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe");
const input = process.argv[2];
const yPos = parseInt(process.argv[3] || "858", 10); // vertical center of the caption (PlayResY 1920)
if (!input) { console.error("usage: node scripts/add-captions.mjs <input.mp4> [yPos]"); process.exit(1); }

const tr = JSON.parse(readFileSync(path.join(root, "public/exports/sp-temp/aroll-transcription.json"), "utf8"));
const words = (tr.words ?? []).filter((w) => typeof w.start === "number");

// Group into ~3-word chunks, breaking on sentence punctuation.
const chunks = [];
let cur = [];
for (const w of words) {
  cur.push(w);
  if (cur.length >= 3 || /[.!?,]$/.test(w.word)) {
    chunks.push({ text: cur.map((x) => x.word).join(" ").replace(/[{}]/g, ""), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  }
}
if (cur.length) chunks.push({ text: cur.map((x) => x.word).join(" "), start: cur[0].start, end: cur[cur.length - 1].end });

const t = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
};

// ASS: bold white, thick black outline + shadow (legible over any footage), centered at yPos.
let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap, Arial, 58, &H00FFFFFF, &H00FFFFFF, &H00101010, &H64000000, -1, 0, 0, 0, 100, 100, 0, 0, 1, 5, 3, 5, 60, 60, 0, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
for (const c of chunks) {
  ass += `Dialogue: 0,${t(c.start)},${t(c.end)},Cap,,0,0,0,,{\\an5\\pos(540,${yPos})}${c.text}\n`;
}
const assRel = "public/exports/sp-temp/captions.ass";
writeFileSync(path.join(root, assRel), ass);

const out = input.replace(/\.mp4$/, "-cap.mp4");
console.log(`Captions: ${chunks.length} chunks, y=${yPos}. Burning...`);
const r = spawnSync(FF, ["-y", "-loglevel", "error", "-i", input, "-vf", `ass=${assRel}`, "-c:a", "copy", out], { cwd: root, stdio: "inherit" });
if (r.status === 0) console.log(`OUT: ${out}`); else process.exit(r.status ?? 1);
