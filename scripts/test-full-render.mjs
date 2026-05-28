/**
 * Full V2 render test with text overlays.
 * Tests what the actual segmentRenderer produces.
 * Run: node scripts/test-full-render.mjs
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const BROLL = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const AROLL = path.join(ROOT, "public", "uploads", "IMG_6108.MOV");
const REF = path.join(ROOT, "public", "uploads", "IMG_6018.MOV");
const TEMP = path.join(ROOT, "public", "exports", "temp");
const OUT = path.join(ROOT, "public", "exports", "v2-final.mp4");
const COMPARE_DIR = path.join(ROOT, "public", "exports", "comparison");

if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true });
if (!fs.existsSync(COMPARE_DIR)) fs.mkdirSync(COMPARE_DIR, { recursive: true });

// Load blueprint
const cache = JSON.parse(fs.readFileSync(
  path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json"), "utf-8"
));
const blueprint = cache.data;
const segments = blueprint.reference.segments;

function run(args, label, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { cwd: ROOT, shell: false, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("timeout")); }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errLines = stderr.split("\n").filter(l => /Error|error|Invalid/.test(l)).slice(0, 5);
        console.error(`[${label}] EXIT ${code}: ${errLines.join(" | ")}`);
      } else {
        console.log(`[${label}] ✓`);
      }
      resolve({ code, stderr });
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// Text escaping for filter_complex_script context
function escapeText(text) {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/'/g, "’")  // right single quote
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .trim();
}

function buildDrawText(t, inLabel, outLabel) {
  const clean = escapeText(t.text);
  if (!clean) return null;

  const fontColor = t.color.startsWith("#") ? t.color.replace("#", "0x") : "0xFFFFFF";
  const fontSize = t.estimatedFontSize || 36;
  const textX = t.boundingBox.x + t.boundingBox.width / 2;
  const textY = t.boundingBox.y + t.boundingBox.height / 2;
  const fontFile = t.fontWeight === "bold" ? "C\\:/Windows/Fonts/arialbd.ttf" : "C\\:/Windows/Fonts/arial.ttf";

  let bgOpts = "";
  if (t.backgroundColor) {
    const bgColor = t.backgroundColor.startsWith("#") ? t.backgroundColor.replace("#", "0x") : "0x000000@0.7";
    bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=10`;
  }

  return `[${inLabel}]drawtext=fontfile='${fontFile}':text='${clean}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)${bgOpts}[${outLabel}]`;
}

function buildCirclePIP(seg, fps) {
  const pipBox = seg.aroll.boundingBox;
  const r = Math.min(pipBox.width, pipBox.height) / 2;
  const cx = pipBox.width / 2;
  const cy = pipBox.height / 2;

  const filters = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]`,
    `[1:v]scale=${pipBox.width}:${pipBox.height}:force_original_aspect_ratio=increase,crop=${pipBox.width}:${pipBox.height},setsar=1[pip_raw]`,
    `[pip_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${r},2)),255,0)'[pip_circle]`,
    `[bg][pip_circle]overlay=${pipBox.x}:${pipBox.y}:format=auto[step1]`
  ];

  const headline = seg.texts.find(t => t.isHeadline);
  const textF = headline ? buildDrawText(headline, "step1", "out") : null;
  if (textF) filters.push(textF);
  else filters.push(`[step1]copy[out]`);

  return filters.join(";\n");
}

function buildRectPIP(seg) {
  const pipBox = seg.aroll.boundingBox;
  const filters = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]`,
    `[1:v]scale=${pipBox.width}:${pipBox.height}:force_original_aspect_ratio=increase,crop=${pipBox.width}:${pipBox.height},setsar=1[pip]`,
    `[bg][pip]overlay=${pipBox.x}:${pipBox.y}[step1]`
  ];

  const headline = seg.texts.find(t => t.isHeadline);
  const textF = headline ? buildDrawText(headline, "step1", "out") : null;
  if (textF) filters.push(textF);
  else filters.push(`[step1]copy[out]`);

  return filters.join(";\n");
}

async function renderSeg(seg, idx) {
  const dur = seg.end - seg.start;
  const outPath = path.join(TEMP, `seg-${seg.id}.mp4`);
  const filterPath = path.join(TEMP, `filter-${seg.id}.txt`);

  let filter;
  let hasAroll = !!seg.aroll;

  if (seg.aroll?.shape === "circle") {
    filter = buildCirclePIP(seg, 30);
  } else if (seg.aroll?.shape === "rectangle") {
    filter = buildRectPIP(seg);
  } else {
    filter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[out]`;
    hasAroll = false;
  }

  fs.writeFileSync(filterPath, filter);
  console.log(`\n--- ${seg.id}: ${seg.start.toFixed(2)}s-${seg.end.toFixed(2)}s, shape=${seg.aroll?.shape}, dur=${dur.toFixed(2)}s ---`);

  let arollStart = 0;
  for (let i = 0; i < idx; i++) arollStart += segments[i].end - segments[i].start;

  const args = ["-y", "-ss", seg.start.toString(), "-t", dur.toString(), "-i", BROLL];
  if (hasAroll) args.push("-ss", arollStart.toString(), "-t", dur.toString(), "-i", AROLL);
  args.push("-filter_complex_script", filterPath, "-map", "[out]");
  if (hasAroll) args.push("-map", "1:a?");
  else args.push("-map", "0:a?");
  args.push("-t", dur.toString(), "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-r", "30", outPath);

  const result = await run(args, seg.id);
  try { fs.unlinkSync(filterPath); } catch {}

  return { path: outPath, success: result.code === 0 };
}

async function extractComparisonFrames(videoPath, label, timestamps) {
  for (const t of timestamps) {
    const outFile = path.join(COMPARE_DIR, `${label}_${t.toFixed(1)}s.jpg`);
    await run([
      "-y", "-ss", t.toString(), "-i", videoPath,
      "-vframes", "1", "-q:v", "2", outFile
    ], `frame-${label}-${t}s`);
  }
}

async function main() {
  console.log("=== V2 Full Render (with text) ===\n");

  const successPaths = [];
  for (let i = 0; i < segments.length; i++) {
    const r = await renderSeg(segments[i], i);
    if (r.success) successPaths.push(r.path);
    else { console.error(`⚠️ ${segments[i].id} FAILED`); break; }
  }

  if (successPaths.length < segments.length) {
    console.log(`\n❌ Only ${successPaths.length}/${segments.length} segments. Stopping.`);
    return;
  }

  console.log("\n=== Concatenating... ===");
  const concatList = path.join(TEMP, "concat.txt");
  fs.writeFileSync(concatList, successPaths.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
  const cr = await run(["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", "-movflags", "+faststart", OUT], "CONCAT");
  try { fs.unlinkSync(concatList); } catch {}
  for (const p of successPaths) try { fs.unlinkSync(p); } catch {}

  if (cr.code !== 0) { console.error("❌ Concat failed"); return; }

  const stats = fs.statSync(OUT);
  console.log(`\n✅ Final: ${OUT} (${(stats.size/1024/1024).toFixed(1)} MB)`);

  // Extract comparison frames at key moments
  console.log("\n=== Extracting comparison frames ===");
  const timestamps = [1, 5, 10, 15, 20, 23];
  await extractComparisonFrames(REF, "ref", timestamps);
  await extractComparisonFrames(OUT, "v2", timestamps);

  console.log(`\n✅ Comparison frames saved to ${COMPARE_DIR}`);
  console.log("Timestamps:", timestamps.map(t => `${t}s`).join(", "));
}

main().catch(console.error);
