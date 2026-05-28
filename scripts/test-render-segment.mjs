/**
 * Direct test of V2 segment rendering — isolate FFmpeg errors.
 * Run: node scripts/test-render-segment.mjs
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const ROOT = process.cwd();
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const BROLL = path.join(ROOT, "public", "uploads", "IMG_6163.MP4");
const AROLL = path.join(ROOT, "public", "uploads", "IMG_6108.MOV");
const TEMP = path.join(ROOT, "public", "exports", "temp");
const OUT = path.join(ROOT, "public", "exports", "test-v2-segments.mp4");

if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true });

// Load blueprint
const cache = JSON.parse(fs.readFileSync(
  path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json"), "utf-8"
));
const blueprint = cache.data;
const segments = blueprint.reference.segments;

function runFFmpeg(args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n[${label}] Running FFmpeg...`);
    const proc = spawn(FFMPEG, args, { cwd: ROOT, shell: false, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        // Extract just the error lines
        const errLines = stderr.split("\n")
          .filter(l => l.includes("Error") || l.includes("error") || l.includes("Invalid") || l.includes("No such") || l.includes("not found") || l.includes("Discarding"))
          .slice(0, 10);
        console.error(`[${label}] EXIT CODE: ${code}`);
        console.error(`[${label}] Error lines:\n${errLines.join("\n")}`);
        // Also show last 15 lines for context
        const lastLines = stderr.split("\n").slice(-15).join("\n");
        console.error(`[${label}] Last 15 lines:\n${lastLines}`);
      } else {
        console.log(`[${label}] ✓ Success`);
      }
      resolve({ code, stderr });
    });
    proc.on("error", reject);
  });
}

// Build a simple PIP circle filter for testing (no text overlays)
function buildSimpleCirclePIP(seg, fps) {
  const pipBox = seg.aroll.boundingBox;
  const r = Math.min(pipBox.width, pipBox.height) / 2;
  const cx = pipBox.width / 2;
  const cy = pipBox.height / 2;
  const dur = seg.end - seg.start;

  return [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]`,
    `[1:v]scale=${pipBox.width}:${pipBox.height}:force_original_aspect_ratio=increase,crop=${pipBox.width}:${pipBox.height},setsar=1[pip_raw]`,
    `[pip_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${r},2)),255,0)'[pip_circle]`,
    `[bg][pip_circle]overlay=${pipBox.x}:${pipBox.y}:format=auto[out]`
  ].join(";\n");
}

function buildSimpleRectPIP(seg, fps) {
  const pipBox = seg.aroll.boundingBox;
  return [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]`,
    `[1:v]scale=${pipBox.width}:${pipBox.height}:force_original_aspect_ratio=increase,crop=${pipBox.width}:${pipBox.height},setsar=1[pip]`,
    `[bg][pip]overlay=${pipBox.x}:${pipBox.y}[out]`
  ].join(";\n");
}

async function renderSegment(seg, idx) {
  const duration = seg.end - seg.start;
  const outputPath = path.join(TEMP, `seg-${seg.id}.mp4`);
  const filterPath = path.join(TEMP, `filter-${seg.id}.txt`);

  let filter;
  let hasAroll = !!seg.aroll;

  if (seg.aroll?.shape === "circle") {
    filter = buildSimpleCirclePIP(seg, 30);
  } else if (seg.aroll?.shape === "rectangle") {
    filter = buildSimpleRectPIP(seg, 30);
  } else {
    filter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[out]`;
    hasAroll = false;
  }

  fs.writeFileSync(filterPath, filter);
  console.log(`\n--- ${seg.id}: ${seg.start}s-${seg.end}s, layout=${seg.layout}, shape=${seg.aroll?.shape}, dur=${duration.toFixed(2)}s ---`);
  console.log(`Filter:\n${filter}`);

  const args = ["-y"];
  args.push("-ss", seg.start.toString(), "-t", duration.toString(), "-i", BROLL);
  if (hasAroll) {
    // Calculate aroll start: sum of all previous segment durations
    let arollStart = 0;
    for (let i = 0; i < idx; i++) {
      arollStart += segments[i].end - segments[i].start;
    }
    args.push("-ss", arollStart.toString(), "-t", duration.toString(), "-i", AROLL);
  }
  args.push("-filter_complex_script", filterPath);
  args.push("-map", "[out]");
  if (hasAroll) args.push("-map", "1:a?");
  else args.push("-map", "0:a?");
  args.push("-t", duration.toString());
  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-r", "30");
  args.push(outputPath);

  const result = await runFFmpeg(args, seg.id);

  try { fs.unlinkSync(filterPath); } catch {}

  return { path: outputPath, success: result.code === 0 };
}

async function main() {
  console.log("=== V2 Segment Render Test ===");
  console.log(`Segments: ${segments.length}`);
  console.log(`B-roll: ${BROLL} (exists: ${fs.existsSync(BROLL)})`);
  console.log(`A-roll: ${AROLL} (exists: ${fs.existsSync(AROLL)})`);

  const successPaths = [];

  for (let i = 0; i < segments.length; i++) {
    const result = await renderSegment(segments[i], i);
    if (result.success) {
      successPaths.push(result.path);
    } else {
      console.error(`\n⚠️ Segment ${segments[i].id} FAILED — stopping here.`);
      break;
    }
  }

  if (successPaths.length === segments.length) {
    console.log(`\n\n=== All ${segments.length} segments rendered. Concatenating... ===`);

    const concatList = path.join(TEMP, "concat.txt");
    fs.writeFileSync(concatList, successPaths.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"));

    const concatResult = await runFFmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", concatList,
      "-c", "copy", "-movflags", "+faststart", OUT
    ], "CONCAT");

    try { fs.unlinkSync(concatList); } catch {}
    for (const p of successPaths) { try { fs.unlinkSync(p); } catch {} }

    if (concatResult.code === 0) {
      const stats = fs.statSync(OUT);
      console.log(`\n✅ Final video: ${OUT} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  } else {
    console.log(`\n❌ Only ${successPaths.length}/${segments.length} segments succeeded.`);
  }
}

main().catch(console.error);
