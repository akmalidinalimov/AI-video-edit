/**
 * reference-decode.mjs — RIGOROUS reference DECODER (the keystone "decode + save" step).
 *
 * Turns ANY reference reel into a reviewable, RENDERABLE spec + a saved frame library, so
 * Remotion (and the agent) can replicate the editing/animation style faithfully instead of
 * eyeballing. Closes the "what the reference shows vs what we render" gap on the INPUT side.
 *
 * Outputs to public/exports/refanalysis/<id>/:
 *   frames/cut_<t>.png      — a frame at every scene CUT (the shot boundaries)
 *   frames/t_<t>.png        — dense 1fps frame library (every second)
 *   sheets/sheet_<a>_<b>.png — contact sheets (6x6 tiles) for fast scanning
 *   recipe.json             — RENDERABLE spec: meta + shots[] (timing, camera/element motion,
 *                             TOOL routing) + layers[] + audio[] + fingerprint + resources[]
 *   <id>.style.md           — human-readable annotated timeline (review this)
 *
 * Usage: node scripts/reference-decode.mjs <video> --id <id> [--fps 1] [--scene 0.3]
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const ROOT = process.cwd();
const FF = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffprobe.exe");
const video = process.argv[2];
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
if (!video || video.startsWith("--")) { console.error("usage: node scripts/reference-decode.mjs <video> --id <id> [--fps 1] [--scene 0.3]"); process.exit(1); }
const ID = arg("--id", path.basename(video).replace(/\.[^.]+$/, ""));
const FPS = Number(arg("--fps", "1"));
const SCENE = Number(arg("--scene", "0.3"));
const OUT = path.join(ROOT, "public", "exports", "refanalysis", ID);
const FRAMES = path.join(OUT, "frames"), SHEETS = path.join(OUT, "sheets");

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) { const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim(); }
  return process.env.GEMINI_API_KEY;
}
const parseFps = (s) => { const [n, d] = String(s || "0/1").split("/").map(Number); return d ? +(n / d).toFixed(2) : null; };
const probe = (abs) => { try { return JSON.parse(execFileSync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", abs], { encoding: "utf-8" })); } catch { return null; } };

// detect scene-cut timestamps via ffmpeg's scene score.
// showinfo writes to stderr (which execFileSync drops on success), so we route the
// selected-frame timestamps to a metadata file and parse that instead.
function sceneCuts(abs) {
  const meta = path.join(OUT, "_cuts.txt");
  try {
    execFileSync(FF, ["-y", "-i", abs, "-vf", `select='gt(scene,${SCENE})',metadata=print:file=${meta.replace(/\\/g, "/")}`, "-an", "-f", "null", "-", "-loglevel", "error"], { stdio: "pipe" });
    const txt = fs.existsSync(meta) ? fs.readFileSync(meta, "utf-8") : "";
    try { fs.unlinkSync(meta); } catch {}
    return [...txt.matchAll(/pts_time:([0-9.]+)/g)].map(m => +(+m[1]).toFixed(2));
  } catch { return []; }
}
function frameAt(abs, t, outPng) { try { execFileSync(FF, ["-y", "-ss", String(t), "-i", abs, "-frames:v", "1", "-q:v", "3", outPng, "-loglevel", "error"], { stdio: "pipe" }); return true; } catch { return false; } }

const PROMPT = (dur) => `You are a senior short-form video editor + motion-graphics TD REVERSE-ENGINEERING an edited vertical reel (~${Math.round(dur)}s) so it can be RECREATED at 98%+ fidelity in Remotion on DIFFERENT footage. WATCH picture AND sound. Output STRICT JSON only (no markdown). Times in SECONDS.
{
 "meta":{"durationSec":n,"fps":n,"aspect":"9:16","language":"...","mood":"...","colorGrade":"...","brandColors":["#hex"],"topic":"..."},
 "shots":[  // the SHOT LIST — one entry per distinct shot/beat, in order
   {"startSec":n,"endSec":n,"summary":"<what happens>",
    "cameraMotion":"none|pan_left|pan_right|push_in|pull_out|zoom|orbit|parallax|handheld",
    "elementMotion":"<how on-screen elements animate: draw-on wires, nodes pop in, cards slide, images orbit, text typewriter, etc.>",
    "tool":"remotion|kling|image_gen|real_footage",  // best tool to REPRODUCE this shot: remotion=crisp UI/text/graphics/precise camera; kling=organic photoreal motion/camera; image_gen=a still; real_footage=user A-roll
    "notes":"<reproduction hints: easing, speed, colors, exact layout>"}
 ],
 "layers":[ {"type":"presenter|broll|caption|card|chrome|logo_bumper|cta|transition|image|ui","startSec":n,"endSec":n,"region":"fullscreen|pip_circle|pip_rect|top|bottom|center|corner_*","content":"...","isAIGenerated":true|false,"text":"<or null>","textStyle":{"fontClass":"...","color":"#hex","highlight":"#hex|null","pill":bool,"uppercase":bool,"position":"lower|upper|center"}|null,"animationIn":"cut|fade|pop|slide_up|slide_left|typewriter|zoom|wipe|none","animationOut":"cut|fade|pop|slide|zoom|none"} ],
 "audio":[ {"type":"music|voiceover|sfx","startSec":n,"endSec":n,"description":"..."} ],
 "fingerprint":{"captionStyle":"...","brollTreatment":"...","transitions":["..."],"pacingNotes":"<avg shot length, cut rhythm>","ctaStyle":"...","palette":["#hex"]},
 "resources":[ {"element":"...","description":"...","count":n,"source":"user_upload|ai_generate|remotion_build|audio_gen","notes":"..."} ]
}
Be exhaustive and SPECIFIC: every shot, every layer, every sound. For "tool", route UI/text/graphics/precise-camera to remotion, organic/photoreal camera moves to kling, stills to image_gen, real talking-head/product to real_footage.`;

async function main() {
  const key = loadKey(); if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  const abs = path.resolve(ROOT, video);
  if (!fs.existsSync(abs)) { console.error("not found:", abs); process.exit(1); }
  fs.mkdirSync(FRAMES, { recursive: true }); fs.mkdirSync(SHEETS, { recursive: true });

  const pr = probe(abs); const vs = pr?.streams?.find(s => s.codec_type === "video");
  const dur = pr ? +(+pr.format.duration).toFixed(2) : 0;
  const probed = { durationSec: dur, width: vs?.width, height: vs?.height, fps: parseFps(vs?.r_frame_rate) };
  console.log(`=== reference-decode: ${ID} (${probed.width}x${probed.height}, ${dur}s) ===`);

  // 1) scene cuts → save a frame at each cut
  console.log("[1/4] scene-cut detection + cut frames...");
  const cuts = sceneCuts(abs);
  for (const t of cuts) frameAt(abs, t, path.join(FRAMES, `cut_${t.toFixed(2)}.png`));
  console.log(`   ${cuts.length} cuts: ${cuts.slice(0, 12).join(", ")}${cuts.length > 12 ? " …" : ""}`);

  // 2) dense 1fps frame library
  console.log(`[2/4] dense frame library @${FPS}fps...`);
  execFileSync(FF, ["-y", "-i", abs, "-vf", `fps=${FPS}`, "-q:v", "3", path.join(FRAMES, "t_%04d.png"), "-loglevel", "error"], { stdio: "pipe" });
  // 3) contact sheets (6x6) for fast scanning
  const tileSecs = 36 / FPS;
  for (let a = 0; a < dur; a += tileSecs) {
    execFileSync(FF, ["-y", "-ss", String(a), "-i", abs, "-vf", `fps=${FPS},scale=240:-1,tile=6x6`, "-frames:v", "1", path.join(SHEETS, `sheet_${Math.round(a)}_${Math.round(Math.min(a + tileSecs, dur))}.png`), "-loglevel", "error"], { stdio: "pipe" });
  }
  const nFrames = fs.readdirSync(FRAMES).length;
  console.log(`   ${nFrames} frames, ${fs.readdirSync(SHEETS).length} contact sheets -> ${path.relative(ROOT, FRAMES)}`);

  // 4) Gemini deep analysis → recipe.json
  console.log("[3/4] Gemini deep analysis (uploading + watching)...");
  const fm = new GoogleAIFileManager(key);
  const up = await fm.uploadFile(abs, { mimeType: "video/mp4", displayName: ID });
  let file = await fm.getFile(up.file.name);
  process.stdout.write("   processing");
  while (file.state === "PROCESSING") { process.stdout.write("."); await new Promise(r => setTimeout(r, 2000)); file = await fm.getFile(up.file.name); }
  console.log(file.state === "ACTIVE" ? " ACTIVE" : " " + file.state);
  if (file.state !== "ACTIVE") process.exit(1);
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0.15, responseMimeType: "application/json" } });
  let recipe;
  for (let r = 0; r < 3 && !recipe; r++) {
    try { const res = await model.generateContent([{ fileData: { mimeType: "video/mp4", fileUri: file.uri } }, { text: PROMPT(dur) }]); recipe = JSON.parse(res.response.text()); }
    catch (e) { console.error("   retry", r + 1, String(e.message).slice(0, 80)); await new Promise(z => setTimeout(z, 3000)); }
  }
  if (!recipe) { console.error("analysis failed"); process.exit(1); }
  recipe.meta = { ...probed, ...(recipe.meta || {}) };
  recipe.id = ID; recipe.sourceVideo = path.relative(ROOT, abs).replace(/\\/g, "/");
  recipe.sceneCuts = cuts; recipe.framesDir = path.relative(ROOT, FRAMES).replace(/\\/g, "/");
  fs.writeFileSync(path.join(OUT, "recipe.json"), JSON.stringify(recipe, null, 2));

  // 5) human-readable style.md
  console.log("[4/4] writing style.md...");
  const shots = recipe.shots || [];
  const byTool = {}; for (const s of shots) byTool[s.tool] = (byTool[s.tool] || 0) + 1;
  const md = [
    `# ${ID} — reference style decode`, ``,
    `**${probed.width}x${probed.height} · ${dur}s · ${recipe.meta.fps}fps · ${recipe.meta.mood || ""}** — ${recipe.meta.topic || ""}`,
    `Color grade: ${recipe.meta.colorGrade || "?"} · palette: ${(recipe.fingerprint?.palette || recipe.meta.brandColors || []).join(" ")}`,
    `Frames: \`${recipe.framesDir}\` · ${cuts.length} scene cuts · sheets: \`${path.relative(ROOT, SHEETS).replace(/\\/g, "/")}\``, ``,
    `## Shot list (tool routing: ${JSON.stringify(byTool)})`,
    ...shots.map((s, i) => `${i + 1}. **[${s.startSec}-${s.endSec}s]** ${s.summary}\n   - camera: ${s.cameraMotion} · elements: ${s.elementMotion}\n   - **TOOL: ${s.tool}** — ${s.notes || ""}`),
    ``, `## Fingerprint`,
    `- captions: ${recipe.fingerprint?.captionStyle || "?"}`,
    `- b-roll: ${recipe.fingerprint?.brollTreatment || "?"}`,
    `- transitions: ${(recipe.fingerprint?.transitions || []).join(", ")}`,
    `- pacing: ${recipe.fingerprint?.pacingNotes || "?"}`,
    `- CTA: ${recipe.fingerprint?.ctaStyle || "?"}`,
    ``, `## Resources (bill of materials)`,
    ...(recipe.resources || []).map(r => `- **${r.element}** ×${r.count} — \`${r.source}\` — ${r.notes || r.description || ""}`),
  ].join("\n");
  fs.writeFileSync(path.join(OUT, `${ID}.style.md`), md);

  console.log(`\nDONE. ${shots.length} shots, ${(recipe.layers || []).length} layers, ${(recipe.audio || []).length} audio cues, ${(recipe.resources || []).length} resources.`);
  console.log(`  recipe:  ${path.relative(ROOT, path.join(OUT, "recipe.json"))}`);
  console.log(`  style:   ${path.relative(ROOT, path.join(OUT, ID + ".style.md"))}`);
  console.log(`  frames:  ${path.relative(ROOT, FRAMES)} (${nFrames})`);
}
main().catch(e => { console.error(e); process.exit(1); });
