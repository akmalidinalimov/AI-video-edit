/**
 * reel-analyze.mjs — REUSABLE "Reference Resource Analyzer".
 *
 * Watches a reference reel with Gemini and emits BOTH:
 *   1) a STYLE PROFILE (temporal layer recipe + style fingerprint + sound design), and
 *   2) a RESOURCE MANIFEST — the bill of materials to recreate the reel at >=98%, with
 *      every element tagged user_upload | ai_generate | remotion_build | audio_gen so the
 *      user knows exactly what to upload vs what we generate.
 *
 *   node scripts/reel-analyze.mjs <video> [--out public/exports/reel2]
 * Outputs <out>/style-profile.json and <out>/resource-manifest.json
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const ROOT = process.cwd();
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const video = process.argv[2];
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg("--out", "public/exports/reel2"));
if (!video) { console.error("usage: node scripts/reel-analyze.mjs <video> [--out dir]"); process.exit(1); }

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim();
  }
  return process.env.GEMINI_API_KEY;
}
const parseFps = (s) => { const [n, d] = String(s || "0/1").split("/").map(Number); return d ? +(n / d).toFixed(2) : null; };
const probe = (abs) => { try { return JSON.parse(execFileSync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", abs], { encoding: "utf-8" })); } catch { return null; } };

const PROMPT = `You are a senior short-form video editor + technical director REVERSE-ENGINEERING an edited vertical reel so it can be RECREATED at 98%+ fidelity on DIFFERENT footage. WATCH the whole video (picture AND sound) and output STRICT JSON only (no markdown).

Analyze EVERYTHING that appears or is heard. Use MM:SS-derived SECONDS for all times. Shape:
{
  "meta": { "durationSec": n, "fps": n, "aspect": "9:16|...", "language": "...",
            "presenterModel": "persistent_pip|interleaved_fullscreen|fullscreen_dominant|none",
            "mood": "...", "colorGrade": "<short description>", "brandColors": ["#hex", ...],
            "topic": "<what the reel is about>" },
  "layers": [   // EVERY visual element over time, in order
    { "type": "presenter|broll|caption|card|chrome|logo_bumper|cta|transition|image",
      "startSec": n, "endSec": n,
      "region": "fullscreen|pip_circle|pip_rect|top|bottom|center|corner_*",
      "content": "<what is shown; for broll/image describe the footage/subject>",
      "isAIGenerated": true|false,   // does this look like AI-generated footage/imagery?
      "text": "<on-screen text, or null>",
      "textStyle": { "fontClass": "sans-bold|display|...", "color": "#hex", "highlight": "#hex|null",
                     "pill": true|false, "uppercase": true|false, "position": "lower|upper|center" } | null,
      "animationIn": "cut|fade|pop|slide_up|slide_left|typewriter|zoom|wipe|none",
      "animationOut": "cut|fade|pop|slide|zoom|none",
      "textOrigin": "editor_overlay|source_burned_in|null" }
  ],
  "audio": [   // the SOUND DESIGN
    { "type": "music|voiceover|sfx", "startSec": n, "endSec": n, "description": "<e.g. upbeat tech music bed / whoosh on cut / pop on caption / ding>" }
  ],
  "fingerprint": {
    "captionStyle": "<font, color, karaoke/highlight, pill, position, animation>",
    "brollTreatment": "<AI-generated vs stock vs screen-rec; motion; how it's framed/overlaid>",
    "transitions": ["..."], "pacingNotes": "<cut rhythm, avg shot length>",
    "ctaStyle": "<the call-to-action design + text>" },
  "resources": [   // THE BILL OF MATERIALS to recreate at >=98% on new footage
    { "element": "<e.g. presenter A-roll / AI character B-roll #1 / tool screen-recording / logo / background music / whoosh SFX / keyword captions>",
      "description": "<what it is + how it's used>",
      "count": n,
      "source": "user_upload|ai_generate|remotion_build|audio_gen",
      "notes": "<why this source; e.g. 'real footage, user must film' / 'AI-generated character, we can generate' / 'caption animation, built in Remotion' / 'music bed, generate via audio API'>" }
  ]
}

Rules for "resources[].source":
- A-roll talking-head, real product/people footage, real screenshots/logos => "user_upload" (they must provide it).
- AI-looking footage/characters/imagery the creator clearly generated => "ai_generate" (we can generate it).
- Captions, lower-thirds, text cards, transitions, logo-bumper animation, any motion graphics => "remotion_build" (we build it, no upload).
- Music bed and every sound effect => "audio_gen" (generate via audio API) unless it's clearly the presenter's own voice (that comes with the A-roll).
Be exhaustive and specific (separate entries per distinct B-roll subject, each SFX type, each caption style).`;

async function main() {
  const key = loadKey();
  if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const abs = path.resolve(ROOT, video);
  const pr = probe(abs);
  const vstream = pr?.streams?.find(s => s.codec_type === "video");
  const probed = pr ? { durationSec: +(+pr.format.duration).toFixed(2), width: vstream?.width, height: vstream?.height, fps: parseFps(vstream?.r_frame_rate) } : {};

  console.log(`Uploading ${path.basename(abs)} ...`);
  const fm = new GoogleAIFileManager(key);
  const up = await fm.uploadFile(abs, { mimeType: "video/mp4", displayName: path.basename(abs) });
  let file = await fm.getFile(up.file.name);
  process.stdout.write("processing");
  while (file.state === "PROCESSING") { process.stdout.write("."); await new Promise(r => setTimeout(r, 2000)); file = await fm.getFile(up.file.name); }
  console.log(file.state === "ACTIVE" ? " ACTIVE" : " " + file.state);
  if (file.state !== "ACTIVE") process.exit(1);

  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0.15, responseMimeType: "application/json" } });
  console.log("Deep analysis (watching the full reel)...\n");
  const t = Date.now();
  const res = await model.generateContent([{ fileData: { mimeType: "video/mp4", fileUri: file.uri } }, { text: PROMPT }]);
  let parsed;
  try { parsed = JSON.parse(res.response.text()); } catch (e) { console.error("JSON parse failed:\n", res.response.text().slice(0, 2000)); process.exit(1); }

  parsed.meta = { ...probed, ...(parsed.meta || {}) };
  parsed.sourceVideo = path.relative(ROOT, abs).replace(/\\/g, "/");

  const styleProfile = { meta: parsed.meta, layers: parsed.layers || [], audio: parsed.audio || [], fingerprint: parsed.fingerprint || {}, sourceVideo: parsed.sourceVideo };
  const manifest = { sourceVideo: parsed.sourceVideo, meta: parsed.meta, resources: parsed.resources || [] };
  fs.writeFileSync(path.join(OUT, "style-profile.json"), JSON.stringify(styleProfile, null, 2));
  fs.writeFileSync(path.join(OUT, "resource-manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`OK in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  console.log(`  meta: ${JSON.stringify(parsed.meta)}`);
  const byType = {}; for (const l of styleProfile.layers) byType[l.type] = (byType[l.type] || 0) + 1;
  console.log(`  layers: ${styleProfile.layers.length} ${JSON.stringify(byType)}`);
  console.log(`  audio cues: ${styleProfile.audio.length}`);
  const bySrc = {}; for (const r of manifest.resources) bySrc[r.source] = (bySrc[r.source] || 0) + 1;
  console.log(`  resources: ${manifest.resources.length} by source ${JSON.stringify(bySrc)}`);
  console.log(`  -> ${path.join(OUT, "style-profile.json")}`);
  console.log(`  -> ${path.join(OUT, "resource-manifest.json")}`);
}
main().catch(e => { console.error(e); process.exit(1); });
