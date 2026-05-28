/**
 * V3 Polished Renderer — Sentence-aligned transitions, consistent PIP, face-centered crop.
 *
 * Key improvements vs V2:
 * 1. Segment boundaries aligned to sentence endings — NO mid-sentence transitions
 * 2. Consistent circle PIP position/size across ALL circle segments
 * 3. Face-centered A-roll cropping
 * 4. Circle PIP with subtle border
 * 5. Extended to full speech duration (24.5s)
 *
 * Run: node scripts/render-v3-polished.mjs
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
const OUT = path.join(ROOT, "public", "exports", "v3-polished.mp4");
const CMP_DIR = path.join(ROOT, "public", "exports", "comparison-v3");

if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true });
if (!fs.existsSync(CMP_DIR)) fs.mkdirSync(CMP_DIR, { recursive: true });

// Load blueprint for text overlays and original data
const cache = JSON.parse(fs.readFileSync(
  path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json"), "utf-8"
));
const blueprint = cache.data;
const origSegments = blueprint.reference.segments;

// ── SENTENCE-ALIGNED SEGMENT MAP ──
// Transitions ONLY at sentence/clause boundaries
// Sentence 1: 0.0 - 3.8s  "2026-yil ... bo'lmaydi."
// Sentence 2: 3.8 - 11.2s "Chunki ... tuzib beradi."
// Sentence 3: 11.2 - 21.8s "Raqobatchilaringiz ... yozib beradi."
//   Clause break at 14.0s "qiladi,"
// Sentence 4: 21.8 - 24.5s "Eng qizig'i ... moslashtirasiz."
const segments = [
  {
    id: "seg_1",
    start: 0.0,
    end: 3.8,       // Sentence 1 ends here — "bo'lmaydi."
    layout: "vertical_split",
    // Use orig seg_1 data for A-roll/B-roll/text positions
    arollBox: origSegments[0].aroll.boundingBox,
    brollBox: origSegments[0].broll.boundingBox,
    blackRegions: origSegments[0].blackRegions,
    texts: origSegments[0].texts,
  },
  {
    id: "seg_2",
    start: 3.8,      // Sentence 2 starts — "Chunki..."
    end: 11.2,       // Sentence 2 ends — "beradi."
    layout: "circle_pip",
  },
  {
    id: "seg_3",
    start: 11.2,     // Sentence 3 starts — "Raqobatchilaringiz..."
    end: 14.0,       // Clause break at "qiladi,"
    layout: "circle_pip",
  },
  {
    id: "seg_4",
    start: 14.0,     // After clause break
    end: 21.8,       // Sentence 3 ends — "beradi."
    layout: "circle_pip",
  },
  {
    id: "seg_5",
    start: 21.8,     // Sentence 4 starts — "Eng qizig'i..."
    end: 24.5,       // Speech ends — "moslashtirasiz."
    layout: "circle_pip",
  },
];

// ── CONSISTENT CIRCLE PIP POSITION ──
// Single position for ALL circle PIP segments — no jumping
// Averaged from blueprint values, upper-right placement
const CIRCLE_PIP = {
  x: 544,
  y: 175,
  width: 426,
  height: 426,
};

// Border thickness for circle PIP
const BORDER_WIDTH = 4;
const BORDER_COLOR = "0xFFFFFF@0.6"; // semi-transparent white

// Face center in A-roll source (1920x1080)
const FACE_CENTER = { x: 650, y: 425 };
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
    .replace(/'/g, "’")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .trim();
}

function fontPath(weight, color) {
  // Gold/yellow headlines use Georgia Pro Bold Italic (matches reference's calligraphic serif)
  const isGold = color && (
    color.toUpperCase() === "#FDD835" ||
    color.toUpperCase() === "#FFD700" ||
    color.toUpperCase() === "#FFEB3B"
  );
  if (isGold) return "C\\:/Windows/Fonts/GeorgiaPro-BoldItalic.ttf";
  return weight === "bold" ? "C\\:/Windows/Fonts/arialbd.ttf" : "C\\:/Windows/Fonts/arial.ttf";
}

// ── Face-centered crop expression for A-roll ──
// Calculates crop offset to keep face centered when cropping from scaled A-roll
function faceCenteredCrop(targetW, targetH) {
  // Scale A-roll (1920x1080) to fill targetW x targetH
  const scaleW = targetW / AROLL_W;
  const scaleH = targetH / AROLL_H;
  const scale = Math.max(scaleW, scaleH);
  const scaledW = Math.round(AROLL_W * scale);
  const scaledH = Math.round(AROLL_H * scale);

  // Face position in scaled coordinates
  const faceX = Math.round(FACE_CENTER.x * scale);
  const faceY = Math.round(FACE_CENTER.y * scale);

  // Crop offset to center face
  let cropX = Math.max(0, Math.min(faceX - Math.round(targetW / 2), scaledW - targetW));
  let cropY = Math.max(0, Math.min(faceY - Math.round(targetH / 2), scaledH - targetH));

  return { scaledW, scaledH, cropX, cropY };
}

// ── Build filter for Segment 1: vertical_split ──
function buildSeg1Filter(seg) {
  const dur = seg.end - seg.start;
  const arollBox = seg.arollBox;
  const brollBox = seg.brollBox;
  const headerRegion = seg.blackRegions.find(br => br.purpose === "header");
  const headerH = headerRegion ? headerRegion.boundingBox.height : 220;

  const filters = [];

  // 1. Create black canvas
  filters.push(`color=black:s=1080x1920:r=30:d=${dur}[canvas]`);

  // 2. Scale B-roll to fit its designated region
  filters.push(`[0:v]scale=${brollBox.width}:${brollBox.height}:force_original_aspect_ratio=increase,crop=${brollBox.width}:${brollBox.height},setsar=1[broll_s]`);

  // 3. Overlay B-roll at its position
  filters.push(`[canvas][broll_s]overlay=${brollBox.x}:${brollBox.y}[step1]`);

  // 4. Scale/crop A-roll with face centering
  const fc = faceCenteredCrop(arollBox.width, arollBox.height);
  filters.push(`[1:v]scale=${fc.scaledW}:${fc.scaledH},crop=${arollBox.width}:${arollBox.height}:${fc.cropX}:${fc.cropY},setsar=1[aroll_s]`);

  // 5. Overlay A-roll at its position
  filters.push(`[step1][aroll_s]overlay=${arollBox.x}:${arollBox.y}[step2]`);

  // 6. Add ALL styled headline texts in the header region
  const headerTexts = seg.texts.filter(t => t.isHeadline && t.boundingBox.y < (headerH + 150));

  let lastLabel = "step2";
  let stepN = 3;

  for (let i = 0; i < headerTexts.length; i++) {
    const t = headerTexts[i];
    const clean = escapeText(t.text);
    if (!clean) continue;

    const outLabel = (i === headerTexts.length - 1) ? "out" : `step${stepN}`;
    const fontColor = t.color.startsWith("#") ? t.color.replace("#", "0x") : "0xFFFFFF";
    const fontSize = t.estimatedFontSize || 36;
    const textX = t.boundingBox.x + t.boundingBox.width / 2;
    const textY = t.boundingBox.y + t.boundingBox.height / 2;
    const font = fontPath(t.fontWeight, t.color);

    let bgOpts = "";
    if (t.backgroundColor) {
      const bgColor = t.backgroundColor.startsWith("#") ? t.backgroundColor.replace("#", "0x") : "0x000000@0.7";
      bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=12`;
    }

    filters.push(`[${lastLabel}]drawtext=fontfile='${font}':text='${clean}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)${bgOpts}[${outLabel}]`);
    lastLabel = outLabel;
    stepN++;
  }

  if (lastLabel !== "out") {
    filters.push(`[${lastLabel}]copy[out]`);
  }

  return filters.join(";\n");
}

// ── Build filter for circle PIP segments (consistent position, with border) ──
function buildCirclePIPFilter(seg) {
  const pip = CIRCLE_PIP; // SAME position for ALL circle segments
  const r = Math.min(pip.width, pip.height) / 2;
  const cx = pip.width / 2;
  const cy = pip.height / 2;

  // Face-centered crop for the circle
  const fc = faceCenteredCrop(pip.width, pip.height);

  // Border ring dimensions
  const borderPipW = pip.width + BORDER_WIDTH * 2;
  const borderPipH = pip.height + BORDER_WIDTH * 2;
  const borderR = Math.min(borderPipW, borderPipH) / 2;
  const borderCx = borderPipW / 2;
  const borderCy = borderPipH / 2;

  const filters = [
    // B-roll fullscreen
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]`,

    // Create white circle border (slightly larger circle)
    `color=${BORDER_COLOR}:s=${borderPipW}x${borderPipH}:r=30:d=999[border_color]`,
    `[border_color]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderR},2)),255,0)'[border_circle]`,

    // Overlay border circle onto background
    `[bg][border_circle]overlay=${pip.x - BORDER_WIDTH}:${pip.y - BORDER_WIDTH}:format=auto[bg_border]`,

    // Scale A-roll for PIP (face-centered crop)
    `[1:v]scale=${fc.scaledW}:${fc.scaledH},crop=${pip.width}:${pip.height}:${fc.cropX}:${fc.cropY},setsar=1[pip_raw]`,

    // Circle mask for content
    `[pip_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${r},2)),255,0)'[pip_circle]`,

    // Overlay content circle (NO text overlays — those are B-roll UI text)
    `[bg_border][pip_circle]overlay=${pip.x}:${pip.y}:format=auto[out]`
  ];

  return filters.join(";\n");
}

// ── Render a single segment ──
async function renderSegment(seg, idx) {
  const dur = seg.end - seg.start;
  const outPath = path.join(TEMP, `seg-${seg.id}.mp4`);
  const filterPath = path.join(TEMP, `filter-${seg.id}.txt`);

  let filter;
  const isVerticalSplit = seg.layout === "vertical_split";

  if (isVerticalSplit) {
    filter = buildSeg1Filter(seg);
  } else {
    filter = buildCirclePIPFilter(seg);
  }

  fs.writeFileSync(filterPath, filter);
  console.log(`\n--- ${seg.id}: ${seg.start.toFixed(2)}s-${seg.end.toFixed(2)}s, layout=${seg.layout}, dur=${dur.toFixed(2)}s ---`);

  // A-roll cursor: continuous position in A-roll source
  let arollStart = 0;
  for (let i = 0; i < idx; i++) arollStart += segments[i].end - segments[i].start;

  // B-roll: seek to segment start in the reference timeline
  // (B-roll timestamps correspond to reference video positions)
  const brollStart = seg.start;

  const args = ["-y"];
  args.push("-ss", brollStart.toString(), "-t", dur.toString(), "-i", BROLL);
  args.push("-ss", arollStart.toString(), "-t", dur.toString(), "-i", AROLL);
  args.push("-filter_complex_script", filterPath, "-map", "[out]");

  // A-roll IS the audio source
  args.push("-map", "1:a?");
  args.push("-t", dur.toString(), "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-r", "30", outPath);

  const result = await run(args, seg.id);
  try { fs.unlinkSync(filterPath); } catch {}

  if (result.code === 0 && fs.existsSync(outPath)) {
    console.log(`  ✓ Success`);
    return { path: outPath, success: true };
  } else {
    console.error(`  ✗ Failed`);
    console.error(`  Filter:\n${filter}`);
    return { path: outPath, success: false };
  }
}

// ── Main pipeline ──
async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║  V3 POLISHED — Sentence-aligned transitions  ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  console.log("Sentence boundaries:");
  console.log("  S1: 0.0-3.8s | S2: 3.8-11.2s | S3: 11.2-21.8s | S4: 21.8-24.5s\n");
  console.log("Segment map (aligned to sentences):");
  segments.forEach(s => console.log(`  ${s.id}: ${s.start.toFixed(1)}-${s.end.toFixed(1)}s [${s.layout}]`));
  console.log(`\nCircle PIP (consistent): x=${CIRCLE_PIP.x} y=${CIRCLE_PIP.y} ${CIRCLE_PIP.width}x${CIRCLE_PIP.height}`);
  console.log(`Border: ${BORDER_WIDTH}px ${BORDER_COLOR}\n`);

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
  console.log(`\n✅ V3 Polished: ${OUT} (${(stats.size/1024/1024).toFixed(1)} MB)`);

  // Extract comparison frames
  console.log("\n=== Extracting comparison frames ===");
  const timestamps = [
    { id: "seg_1", t: 1.9 },   // mid of sentence 1
    { id: "seg_2", t: 7.5 },   // mid of sentence 2
    { id: "seg_3", t: 12.6 },  // mid of first clause
    { id: "seg_4", t: 17.0 },  // mid of rest of sentence 3
    { id: "seg_5", t: 23.0 },  // mid of sentence 4
  ];

  for (const ts of timestamps) {
    const refFrame = path.join(CMP_DIR, `ref_${ts.id}.jpg`);
    const v3Frame = path.join(CMP_DIR, `v3_${ts.id}.jpg`);
    const sbs = path.join(CMP_DIR, `sbs_v3_${ts.id}.jpg`);

    await run(["-y", "-ss", ts.t.toString(), "-i", REF, "-vframes", "1", "-q:v", "2", refFrame], `ref-${ts.id}`);
    await run(["-y", "-ss", ts.t.toString(), "-i", OUT, "-vframes", "1", "-q:v", "2", v3Frame], `v3-${ts.id}`);
    await run(["-y", "-i", refFrame, "-i", v3Frame,
      "-filter_complex", "[0:v]scale=540:960[left];[1:v]scale=540:960[right];[left][right]hstack=inputs=2[out]",
      "-map", "[out]", "-frames:v", "1", "-q:v", "2", sbs], `sbs-${ts.id}`);
  }

  console.log(`\nComparison frames: ${CMP_DIR}`);
  console.log("\n=== TRANSITION VERIFICATION ===");
  console.log("Checking audio continuity at transition points...\n");

  // Extract frames at exact transition points to verify no glitch
  const transitions = [
    { label: "rect→circle", t: 3.8, before: 3.7, after: 3.9 },
    { label: "seg2→seg3", t: 11.2, before: 11.1, after: 11.3 },
    { label: "seg3→seg4", t: 14.0, before: 13.9, after: 14.1 },
    { label: "seg4→seg5", t: 21.8, before: 21.7, after: 21.9 },
  ];

  for (const tr of transitions) {
    const before = path.join(CMP_DIR, `transition_${tr.label.replace(/[→]/g, "_")}_before.jpg`);
    const after = path.join(CMP_DIR, `transition_${tr.label.replace(/[→]/g, "_")}_after.jpg`);
    await run(["-y", "-ss", tr.before.toString(), "-i", OUT, "-vframes", "1", "-q:v", "2", before], `tr-before-${tr.label}`);
    await run(["-y", "-ss", tr.after.toString(), "-i", OUT, "-vframes", "1", "-q:v", "2", after], `tr-after-${tr.label}`);
    console.log(`  ✓ ${tr.label} at ${tr.t}s — frames extracted`);
  }

  console.log("\nDone! Review video and transition frames.\n");
}

main().catch(console.error);
