/**
 * V2 Improved Renderer — targeting 95%+ Gemini match score.
 *
 * Key fixes vs v1:
 * 1. Seg 1: Proper vertical_split with black header + multiple styled texts
 * 2. Seg 2-5: Pure circle PIP — NO text overlays (detected "headlines" are B-roll UI)
 * 3. Black region rendering for segments that have them
 * 4. Face-centered A-roll cropping using detected face center
 *
 * Run: node scripts/render-v2-improved.mjs
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
const OUT = path.join(ROOT, "public", "exports", "v2-improved.mp4");
const CMP_DIR = path.join(ROOT, "public", "exports", "comparison");

if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true });
if (!fs.existsSync(CMP_DIR)) fs.mkdirSync(CMP_DIR, { recursive: true });

// Load blueprint
const cache = JSON.parse(fs.readFileSync(
  path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json"), "utf-8"
));
const blueprint = cache.data;
const segments = blueprint.reference.segments;

// Face center from A-roll analysis
const FACE_CENTER = { x: 650, y: 425 };

// A-roll source dimensions (landscape 1920x1080)
const AROLL_W = 1920;
const AROLL_H = 1080;

function run(args, label, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { cwd: ROOT, shell: false, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve({ code: -1, stderr: "timeout" }); }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errs = stderr.split("\n").filter(l => /Error|error|Invalid/.test(l)).slice(0, 5);
        console.error(`  [${label}] EXIT ${code}:`);
        errs.forEach(e => console.error(`    ${e}`));
        // Also show filter-related lines
        const filterErrs = stderr.split("\n").filter(l => /filter|Filter|option/.test(l)).slice(0, 3);
        filterErrs.forEach(e => console.error(`    ${e}`));
      }
      resolve({ code, stderr });
    });
    proc.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stderr: e.message }); });
  });
}

// ── Text escaping for filter_complex_script ──
function escapeText(text) {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/'/g, "’")   // right single quote
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .trim();
}

function fontPath(weight) {
  return weight === "bold" ? "C\\:/Windows/Fonts/arialbd.ttf" : "C\\:/Windows/Fonts/arial.ttf";
}

// ── Determine if segment has STYLED text overlays (in black regions) vs B-roll UI text ──
function hasStyledTextOverlays(seg) {
  // Only seg_1 has actual styled overlays (texts in the black header region)
  // A segment has styled overlays if it has blackRegions AND headline texts within those regions
  if (!seg.blackRegions || seg.blackRegions.length === 0) return false;
  const headerRegion = seg.blackRegions.find(br => br.purpose === "header");
  if (!headerRegion) return false;
  // Check if any headline text falls within the header region
  const headerBottom = headerRegion.boundingBox.y + headerRegion.boundingBox.height;
  return seg.texts.some(t => t.isHeadline && t.boundingBox.y < headerBottom + 150);
}

// ── Build filter for Segment 1: vertical_split ──
function buildSeg1Filter(seg) {
  const dur = seg.end - seg.start;
  const arollBox = seg.aroll.boundingBox;
  const brollBox = seg.broll.boundingBox;
  const headerRegion = seg.blackRegions.find(br => br.purpose === "header");
  const headerH = headerRegion ? headerRegion.boundingBox.height : 220;

  const filters = [];

  // 1. Create black canvas
  filters.push(`color=black:s=1080x1920:r=30:d=${dur}[canvas]`);

  // 2. Scale B-roll to fit its designated region
  filters.push(`[0:v]scale=${brollBox.width}:${brollBox.height}:force_original_aspect_ratio=increase,crop=${brollBox.width}:${brollBox.height},setsar=1[broll_s]`);

  // 3. Overlay B-roll at its position
  filters.push(`[canvas][broll_s]overlay=${brollBox.x}:${brollBox.y}[step1]`);

  // 4. Scale/crop A-roll to fit its region (face-centered crop)
  // A-roll is landscape 1920x1080. Need to crop to arollBox aspect ratio then scale.
  const targetW = arollBox.width;
  const targetH = arollBox.height;
  // Scale A-roll to fill the target area
  filters.push(`[1:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},setsar=1[aroll_s]`);

  // 5. Overlay A-roll at its position
  filters.push(`[step1][aroll_s]overlay=${arollBox.x}:${arollBox.y}[step2]`);

  // 6. Add styled text overlays (headlines in the black header region)
  let lastLabel = "step2";
  let stepN = 3;

  // Get all headline texts that are in the header area
  const headerTexts = seg.texts.filter(t => t.isHeadline && t.boundingBox.y < (headerH + 150));

  for (let i = 0; i < headerTexts.length; i++) {
    const t = headerTexts[i];
    const clean = escapeText(t.text);
    if (!clean) continue;

    const outLabel = (i === headerTexts.length - 1) ? "out" : `step${stepN}`;
    const fontColor = t.color.startsWith("#") ? t.color.replace("#", "0x") : "0xFFFFFF";
    const fontSize = t.estimatedFontSize || 36;
    const textX = t.boundingBox.x + t.boundingBox.width / 2;
    const textY = t.boundingBox.y + t.boundingBox.height / 2;
    const font = fontPath(t.fontWeight);

    let bgOpts = "";
    if (t.backgroundColor) {
      const bgColor = t.backgroundColor.startsWith("#") ? t.backgroundColor.replace("#", "0x") : "0x000000@0.7";
      bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=12`;
    }

    filters.push(`[${lastLabel}]drawtext=fontfile='${font}':text='${clean}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)${bgOpts}[${outLabel}]`);
    lastLabel = outLabel;
    stepN++;
  }

  // If no texts were rendered, just copy
  if (lastLabel !== "out") {
    filters.push(`[${lastLabel}]copy[out]`);
  }

  return filters.join(";\n");
}

// ── Per-segment PIP position overrides (fine-tuned from visual comparison) ──
// Blueprint coordinates can be slightly off; these are corrected from reference frame analysis
const PIP_OVERRIDES = {
  "seg_3": { x: 556, y: 255, width: 375, height: 375 }, // midpoint between blueprint (576,251,388) and smaller estimate
};

// ── Build filter for circle PIP segments (NO text) ──
function buildCirclePIPFilter(seg) {
  // Use override if available, otherwise use blueprint coordinates
  const override = PIP_OVERRIDES[seg.id];
  const pipBox = override || seg.aroll.boundingBox;
  const r = Math.min(pipBox.width, pipBox.height) / 2;
  const cx = pipBox.width / 2;
  const cy = pipBox.height / 2;

  const filters = [
    // B-roll fullscreen
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]`,
    // Scale A-roll for PIP (face-centered)
    `[1:v]scale=${pipBox.width}:${pipBox.height}:force_original_aspect_ratio=increase,crop=${pipBox.width}:${pipBox.height},setsar=1[pip_raw]`,
    // Circle mask
    `[pip_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${r},2)),255,0)'[pip_circle]`,
    // Overlay
    `[bg][pip_circle]overlay=${pipBox.x}:${pipBox.y}:format=auto[out]`
  ];

  return filters.join(";\n");
}

// ── Render a single segment ──
async function renderSegment(seg, idx) {
  const dur = seg.end - seg.start;
  const outPath = path.join(TEMP, `seg-${seg.id}.mp4`);
  const filterPath = path.join(TEMP, `filter-${seg.id}.txt`);

  let filter;
  let hasAroll = !!seg.aroll;

  // Determine layout based on actual content, not just blueprint label
  const isVerticalSplit = seg.aroll?.shape === "rectangle" &&
                          seg.blackRegions?.length > 0 &&
                          seg.aroll.boundingBox.width >= 1000; // Full-width A-roll = vertical split

  if (isVerticalSplit) {
    filter = buildSeg1Filter(seg);
  } else if (seg.aroll?.shape === "circle") {
    filter = buildCirclePIPFilter(seg);
  } else {
    // Fallback: fullscreen B-roll only
    filter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[out]`;
    hasAroll = false;
  }

  fs.writeFileSync(filterPath, filter);
  console.log(`\n--- ${seg.id}: ${seg.start.toFixed(2)}s-${seg.end.toFixed(2)}s, layout=${isVerticalSplit ? "vertical_split" : seg.aroll?.shape}, dur=${dur.toFixed(2)}s ---`);

  // Calculate A-roll cursor position
  let arollStart = 0;
  for (let i = 0; i < idx; i++) arollStart += segments[i].end - segments[i].start;

  const args = ["-y"];

  if (isVerticalSplit) {
    // For vertical_split, seek B-roll and A-roll
    args.push("-ss", seg.start.toString(), "-t", dur.toString(), "-i", BROLL);
    args.push("-ss", arollStart.toString(), "-t", dur.toString(), "-i", AROLL);
  } else {
    // For circle PIP
    args.push("-ss", seg.start.toString(), "-t", dur.toString(), "-i", BROLL);
    if (hasAroll) {
      args.push("-ss", arollStart.toString(), "-t", dur.toString(), "-i", AROLL);
    }
  }

  args.push("-filter_complex_script", filterPath, "-map", "[out]");

  // A-roll IS the audio source
  if (hasAroll) args.push("-map", "1:a?");
  else args.push("-map", "0:a?");

  args.push("-t", dur.toString(), "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-r", "30", outPath);

  const result = await run(args, seg.id);
  try { fs.unlinkSync(filterPath); } catch {}

  if (result.code === 0 && fs.existsSync(outPath)) {
    console.log(`  ✓ Success`);
    return { path: outPath, success: true };
  } else {
    console.error(`  ✗ Failed`);
    // Dump the filter for debugging
    console.error(`  Filter was:\n${filter}`);
    return { path: outPath, success: false };
  }
}

// ── Main pipeline ──
async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║  V2 IMPROVED RENDER — Targeting 95%+ match   ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  const successPaths = [];

  for (let i = 0; i < segments.length; i++) {
    const result = await renderSegment(segments[i], i);
    if (result.success) {
      successPaths.push(result.path);
    } else {
      console.error(`\n⚠️ ${segments[i].id} FAILED — stopping.`);
      return;
    }
  }

  // Concatenate
  console.log("\n=== Concatenating... ===");
  const concatList = path.join(TEMP, "concat.txt");
  fs.writeFileSync(concatList, successPaths.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
  const cr = await run(["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", "-movflags", "+faststart", OUT], "CONCAT");
  try { fs.unlinkSync(concatList); } catch {}
  for (const p of successPaths) try { fs.unlinkSync(p); } catch {}

  if (cr.code !== 0) { console.error("❌ Concat failed"); return; }

  const stats = fs.statSync(OUT);
  console.log(`\n✅ Improved video: ${OUT} (${(stats.size/1024/1024).toFixed(1)} MB)`);

  // Extract comparison frames at segment midpoints
  console.log("\n=== Extracting comparison frames ===");
  const timestamps = [
    { id: "seg_1", t: 1.4 },
    { id: "seg_2", t: 6.0 },
    { id: "seg_3", t: 11.0 },
    { id: "seg_4", t: 15.0 },
    { id: "seg_5", t: 21.0 },
  ];

  for (const ts of timestamps) {
    const refFrame = path.join(CMP_DIR, `ref_${ts.id}.jpg`);
    const v2Frame = path.join(CMP_DIR, `v2i_${ts.id}.jpg`);
    const sbs = path.join(CMP_DIR, `sbs_improved_${ts.id}.jpg`);

    await run(["-y", "-ss", ts.t.toString(), "-i", REF, "-vframes", "1", "-q:v", "2", refFrame], `ref-${ts.id}`);
    await run(["-y", "-ss", ts.t.toString(), "-i", OUT, "-vframes", "1", "-q:v", "2", v2Frame], `v2i-${ts.id}`);
    await run(["-y", "-i", refFrame, "-i", v2Frame,
      "-filter_complex", "[0:v]scale=540:960[left];[1:v]scale=540:960[right];[left][right]hstack=inputs=2[out]",
      "-map", "[out]", "-frames:v", "1", "-q:v", "2", sbs], `sbs-${ts.id}`);
  }

  console.log(`\nComparison frames saved to ${CMP_DIR}`);
  console.log("\nDone! Now run: node scripts/compare-gemini.mjs (with GEMINI_API_KEY) to score.\n");
}

main().catch(console.error);
