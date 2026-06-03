/**
 * profiler-spike.mjs — DE-RISK the Reference Style Profiler.
 * Upload one reel to Gemini (Files API), let the model WATCH it, and ask for a
 * structured temporal edit-recipe (layers + captions + CTA over time). If this
 * returns usable JSON, the whole profiler approach is viable.
 *
 *   node scripts/profiler-spike.mjs [path-to-mp4]
 */
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const ROOT = process.cwd();
const video = process.argv[2] || "public/uploads/references/IMG_6299.MP4";

// Load GEMINI_API_KEY from .env.local (same pattern as the rest of the pipeline).
function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim();
  }
  return process.env.GEMINI_API_KEY;
}

const PROMPT = `You are a senior short-form video editor reverse-engineering an edited vertical reel (9:16).
WATCH the whole video (visuals + audio) and output a STRUCTURED EDIT RECIPE as JSON only (no prose, no markdown fences).

Use this exact shape:
{
  "meta": { "durationSec": number, "language": "uz|ru|en|mixed",
            "hasPresenter": boolean,
            "presenterModel": "persistent_pip|interleaved_fullscreen|fullscreen_dominant|none",
            "mood": string },
  "layers": [
    { "type": "presenter|broll|caption|card|chrome|logo_bumper|cta|transition",
      "startSec": number, "endSec": number,
      "region": "fullscreen|circle_top|circle_bottom|pip_rect|top_strip|bottom_strip|corner_tl|corner_tr|overlay_center",
      "content": string,                       // what is shown (for broll: describe the footage/screenshot)
      "text": string|null,                     // for caption/card/cta/chrome: the on-screen text
      "textStyle": { "color": string, "highlightColor": string|null, "pill": boolean,
                     "fontWeight": "normal|bold|black", "uppercase": boolean }|null,
      "animationIn": "cut|fade|pop|slide_up|slide_left|typewriter|zoom|none",
      "textOrigin": "editor_overlay|source_burned_in|null"   // is text a caption the editor added, or burned into the b-roll?
    }
  ],
  "ctaText": string|null
}

Rules:
- Cover the ENTIRE timeline; captions should be broken into their on-screen phrases with start/end.
- Distinguish editor-added captions (textOrigin=editor_overlay) from text that is part of a screenshot/b-roll (source_burned_in).
- Be precise about WHEN the presenter is on vs when b-roll fills the frame vs overlays on top.
- Identify the CTA (e.g. "subscribe", "comment X").`;

async function main() {
  const key = loadKey();
  if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  const abs = path.resolve(ROOT, video);
  console.log(`Uploading ${path.basename(abs)} ...`);
  const fm = new GoogleAIFileManager(key);
  const up = await fm.uploadFile(abs, { mimeType: "video/mp4", displayName: path.basename(abs) });
  let file = await fm.getFile(up.file.name);
  process.stdout.write("processing");
  while (file.state === "PROCESSING") { process.stdout.write("."); await new Promise(r => setTimeout(r, 2000)); file = await fm.getFile(up.file.name); }
  console.log(file.state === "ACTIVE" ? " ACTIVE" : ` ${file.state}`);
  if (file.state !== "ACTIVE") process.exit(1);

  const model = new GoogleGenerativeAI(key).getGenerativeModel({
    model: "gemini-2.5-pro",
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  });
  console.log("Asking gemini-2.5-pro for the edit recipe (watching the full reel)...\n");
  const t = Date.now();
  const res = await model.generateContent([
    { fileData: { mimeType: "video/mp4", fileUri: file.uri } },
    { text: PROMPT },
  ]);
  const text = res.response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { console.error("JSON parse failed; raw:\n", text.slice(0, 2000)); process.exit(1); }

  const out = path.join(ROOT, "public/exports/refanalysis", path.basename(abs, path.extname(abs)) + ".recipe.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(parsed, null, 2));

  console.log(`OK in ${((Date.now()-t)/1000).toFixed(0)}s -> ${out}`);
  console.log(`  meta:`, JSON.stringify(parsed.meta));
  console.log(`  layers: ${parsed.layers?.length} events; cta: ${JSON.stringify(parsed.ctaText)}`);
  const byType = {};
  for (const l of parsed.layers || []) byType[l.type] = (byType[l.type]||0)+1;
  console.log(`  by type:`, JSON.stringify(byType));
  console.log(`  first 6 events:`);
  for (const l of (parsed.layers||[]).slice(0,6)) console.log(`    ${l.startSec}-${l.endSec}s ${l.type} [${l.region}] ${l.text?('"'+l.text+'"'):l.content?.slice(0,40)||''}`);
}
main().catch(e => { console.error(e); process.exit(1); });
