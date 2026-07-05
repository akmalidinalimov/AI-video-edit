/**
 * render-captions.mjs — render the animated 2-row caption track over a base video.
 * Renders TWO versions to compare: keyword-italic (A) and uniform (B). Words come from
 * the A-roll word-level transcript; keywords from speech-keywords.json.
 *
 *   node scripts/render-captions.mjs <base.mp4> [yFraction] [leadSec]
 *   e.g. node scripts/render-captions.mjs exports/styleclone-X.mp4 0.43 0.15
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const FF = path.join(root, "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe");
const base = process.argv[2];
if (!base) { console.error("usage: node scripts/render-captions.mjs <base.mp4> [yFraction] [leadSec]"); process.exit(1); }
const yFraction = parseFloat(process.argv[3] || "0.43");
const leadSec = parseFloat(process.argv[4] || "0.15");
const baseAbs = path.join(root, "public", base);

let info = "";
try { execFileSync(FF, ["-i", baseAbs], { stdio: "pipe" }); } catch (e) { info = String(e.stderr ?? ""); }
const m = info.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
const durSec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 27;
const durationInFrames = Math.round(durSec * 30);

const tr = JSON.parse(readFileSync(path.join(root, "public/exports/sp-temp/aroll-transcription.json"), "utf8"));
const words = (tr.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end }));

const kwPath = path.join(root, "public/exports/sp-temp/speech-keywords.json");
const keywords = existsSync(kwPath)
  ? [...new Set((JSON.parse(readFileSync(kwPath, "utf8")).sentences ?? []).flatMap((s) => s.keywords ?? []))]
  : [];
console.log(`base ${durSec.toFixed(2)}s -> ${durationInFrames} frames | ${words.length} words | ${keywords.length} keywords | y=${yFraction} lead=${leadSec}`);

const versions = [
  { tag: "uniform", emphasize: false },
];
for (const v of versions) {
  const props = { baseVideo: base, words, durationInFrames, yFraction, leadSec, emphasize: v.emphasize, keywords, maxRowWidthPx: 900 };
  const pf = path.join(root, `public/exports/sp-temp/cap-props-${v.tag}.json`);
  writeFileSync(pf, JSON.stringify(props));
  const out = `public/exports/captioned-${v.tag}.mp4`;
  console.log(`\n=== ${v.tag} (emphasize=${v.emphasize}) -> ${out} ===`);
  const r = spawnSync("npx", ["remotion", "render", "src/remotion/entry.tsx", "CaptionedVideo", out, `--props=${pf}`], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error(`${v.tag} failed (${r.status})`); process.exit(r.status ?? 1); }
}
console.log("\nDONE: captioned-italic.mp4 + captioned-uniform.mp4");
