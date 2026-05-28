/**
 * Compare reference vs V2 video frames using:
 * 1. FFmpeg side-by-side composites
 * 2. Gemini Vision detailed analysis per segment
 *
 * Run: node scripts/compare-gemini.mjs
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";

const ROOT = process.cwd();

// Load .env.local if GEMINI_API_KEY not already set
if (!process.env.GEMINI_API_KEY) {
  const envPath = path.join(ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  }
}
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const REF = path.join(ROOT, "public", "uploads", "IMG_6018.MOV");
const V2 = path.join(ROOT, "public", "exports", "singlepass.mp4");
const OUT_DIR = path.join(ROOT, "public", "exports", "comparison");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Load Gemini with fallback models
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const models = [
  genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),
  genAI.getGenerativeModel({ model: "gemini-2.5-pro" }),
  genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" }),
];

function run(args, label, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { cwd: ROOT, shell: false, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve({ code: -1, stderr: "timeout" }); }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errs = stderr.split("\n").filter(l => /Error|error/.test(l)).slice(0, 3);
        console.error(`  [${label}] EXIT ${code}: ${errs.join(" | ")}`);
      }
      resolve({ code, stderr });
    });
  });
}

// Segment timestamps (midpoints)
const segments = [
  { id: "seg_1", time: 1.9, label: "0-3.8s: Rectangle PIP + headline (sentence 1)" },
  { id: "seg_2", time: 7.5, label: "3.8-11.2s: Circle PIP (sentence 2)" },
  { id: "seg_3", time: 12.6, label: "11.2-14.0s: Circle PIP (clause break)" },
  { id: "seg_4", time: 17.0, label: "14.0-21.8s: Circle PIP (sentence 3 cont)" },
  { id: "seg_5", time: 23.0, label: "21.8-24.5s: Circle PIP (sentence 4)" },
];

async function extractFrame(videoPath, timestamp, outPath) {
  await run(["-y", "-ss", timestamp.toString(), "-i", videoPath, "-vframes", "1", "-q:v", "2", outPath], path.basename(outPath));
}

async function createSideBySide(refFrame, v2Frame, outPath) {
  // Stack ref (left) and v2 (right) side by side, both scaled to 540px wide
  await run([
    "-y", "-i", refFrame, "-i", v2Frame,
    "-filter_complex",
    "[0:v]scale=540:960[left];[1:v]scale=540:960[right];[left][right]hstack=inputs=2[out]",
    "-map", "[out]", "-frames:v", "1", "-q:v", "2", outPath
  ], "sidebyside");
}

async function analyzeWithGemini(refFramePath, v2FramePath, segLabel) {
  const refBase64 = fs.readFileSync(refFramePath).toString("base64");
  const v2Base64 = fs.readFileSync(v2FramePath).toString("base64");

  const prompt = `You are comparing a REFERENCE video frame (Image 1) against a CLONED/RECREATED video frame (Image 2).
The goal is to evaluate how accurately the clone reproduces the reference's visual LAYOUT STRUCTURE.

Segment: ${segLabel}

CRITICAL INSTRUCTIONS:
- The B-roll is a COMPLETELY DIFFERENT screen recording app. ALL content inside the B-roll area — text, headers, footers, icons, buttons, filter chips, modal dialogs, popups, navigation bars, and ANY UI elements — are EXPECTED to differ. Do NOT penalize for ANY B-roll content differences. A modal dialog visible in one but not the other is a B-roll content difference, NOT a structural difference.
- The A-roll is the same person but from a different camera angle/take.
- Only penalize for STRUCTURAL differences: PIP shape/position/size, canvas aspect ratio, whether the B-roll fills the correct spatial region, and any ADDED styled text overlays that appear ON TOP of the content (not text that is part of the B-roll UI).
- For segment 1 only: there are ADDED styled text overlays ("2026 yil SMM" in gold and "mutaxassis kerak emas!" in white on pink) that should match. For all other segments, there should be NO added text overlays — any text visible is part of the B-roll UI and should NOT be scored.
- For Canvas & Composition: ONLY score the structural arrangement of canvas regions (PIP area, B-roll area, header area). Do NOT let B-roll content (like modal dialogs or popups) affect this score.

Score each dimension 0-10:

1. **PIP Shape & Type** — Does the clone use the same PIP shape (circle vs rectangle)? Is it the correct type (picture-in-picture vs vertical split)?
2. **PIP Position & Size** — Is the PIP overlay in the correct position (x,y coordinates) and correct size (width,height) relative to the canvas?
3. **A-roll Framing** — Is the person's face properly visible and centered within the PIP? Is the crop/zoom level similar?
4. **B-roll Region** — Does the B-roll content fill the correct spatial region of the canvas? (Ignore the actual content — only check spatial coverage)
5. **Added Overlays** — For seg_1: Do the styled headline texts match in position, color, and style? For other segments: Score 10/10 if no unwanted overlays are added (B-roll UI text does NOT count as overlays).
6. **Canvas & Composition** — Is the overall canvas 1080x1920 portrait? Does the spatial arrangement of all elements match the reference's structure?

Return JSON:
{
  "pip_shape": { "score": 0-10, "notes": "..." },
  "pip_position": { "score": 0-10, "notes": "..." },
  "aroll_framing": { "score": 0-10, "notes": "..." },
  "broll_region": { "score": 0-10, "notes": "..." },
  "added_overlays": { "score": 0-10, "notes": "..." },
  "canvas_composition": { "score": 0-10, "notes": "..." },
  "total_score": 0-60,
  "percentage": 0-100,
  "summary": "2-3 sentence assessment focusing on STRUCTURAL layout accuracy only"
}`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: "image/jpeg", data: refBase64 } },
    { inlineData: { mimeType: "image/jpeg", data: v2Base64 } },
  ];

  for (let mi = 0; mi < models.length; mi++) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const result = await models[mi].generateContent(parts);
        const text = result.response.text();
        const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        return JSON.parse(cleaned);
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("503") || msg.includes("429") || msg.includes("overloaded")) {
          const delay = 3000 * (retry + 1);
          if (retry < 2) {
            console.log(`    Retry ${retry+1}/3 in ${delay/1000}s (model ${mi})...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          // Fall to next model
          console.log(`    Model ${mi} exhausted, trying next...`);
          break;
        }
        console.error(`  Gemini analysis failed for ${segLabel}:`, msg.substring(0, 200));
        return null;
      }
    }
  }
  console.error(`  All models failed for ${segLabel}`);
  return null;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Reference vs V2 — Visual Comparison + Gemini   ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Step 1: Extract frames + create side-by-side composites
  console.log("Step 1: Extracting frames...\n");

  for (const seg of segments) {
    const refFrame = path.join(OUT_DIR, `ref_${seg.id}.jpg`);
    const v2Frame = path.join(OUT_DIR, `v2_${seg.id}.jpg`);
    const sbs = path.join(OUT_DIR, `sidebyside_${seg.id}.jpg`);

    await extractFrame(REF, seg.time, refFrame);
    await extractFrame(V2, seg.time, v2Frame);
    await createSideBySide(refFrame, v2Frame, sbs);
    console.log(`  ✓ ${seg.id} (${seg.time}s) — frames + side-by-side`);
  }

  // Step 2: Send to Gemini for analysis
  console.log("\nStep 2: Gemini Vision analysis...\n");

  const results = [];
  for (const seg of segments) {
    const refFrame = path.join(OUT_DIR, `ref_${seg.id}.jpg`);
    const v2Frame = path.join(OUT_DIR, `v2_${seg.id}.jpg`);

    console.log(`  Analyzing ${seg.id}: ${seg.label}...`);
    const analysis = await analyzeWithGemini(refFrame, v2Frame, seg.label);

    if (analysis) {
      results.push({ ...seg, analysis });
      console.log(`    Score: ${analysis.total_score}/60 (${analysis.percentage}%)`);
      console.log(`    PIP Shape: ${analysis.pip_shape.score}/10 | PIP Pos: ${analysis.pip_position.score}/10 | A-roll: ${analysis.aroll_framing.score}/10`);
      console.log(`    B-roll Region: ${analysis.broll_region.score}/10 | Overlays: ${analysis.added_overlays.score}/10 | Canvas: ${analysis.canvas_composition.score}/10`);
      console.log(`    Summary: ${analysis.summary}\n`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 1000));
  }

  // Step 3: Aggregate scores
  if (results.length > 0) {
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║            AGGREGATE COMPARISON REPORT           ║");
    console.log("╚══════════════════════════════════════════════════╝\n");

    const dims = ["pip_shape", "pip_position", "aroll_framing", "broll_region", "added_overlays", "canvas_composition"];
    const dimLabels = ["PIP Shape & Type", "PIP Position & Size", "A-roll Framing", "B-roll Region", "Added Overlays", "Canvas & Composition"];

    for (let i = 0; i < dims.length; i++) {
      const scores = results.map(r => r.analysis[dims[i]].score);
      const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
      const bar = "█".repeat(Math.round(parseFloat(avg))) + "░".repeat(10 - Math.round(parseFloat(avg)));
      console.log(`  ${dimLabels[i].padEnd(22)} ${bar} ${avg}/10  [${scores.join(", ")}]`);
    }

    const totalAvg = (results.reduce((s, r) => s + r.analysis.percentage, 0) / results.length).toFixed(1);
    console.log(`\n  ════════════════════════════════════════`);
    console.log(`  OVERALL MATCH: ${totalAvg}%`);
    console.log(`  ════════════════════════════════════════\n`);

    // Per-segment breakdown
    console.log("  Per-segment scores:");
    for (const r of results) {
      console.log(`    ${r.id} (${r.label}): ${r.analysis.percentage}% — ${r.analysis.summary}`);
    }

    // Save full report
    const report = {
      timestamp: new Date().toISOString(),
      referenceVideo: "IMG_6018.MOV",
      editedVideo: "v2-final.mp4",
      overallMatch: parseFloat(totalAvg),
      segments: results.map(r => ({
        id: r.id,
        time: r.time,
        label: r.label,
        analysis: r.analysis,
      })),
      dimensionAverages: Object.fromEntries(dims.map((d, i) => [
        dimLabels[i],
        parseFloat((results.reduce((s, r) => s + r.analysis[d].score, 0) / results.length).toFixed(1))
      ])),
    };

    const reportPath = path.join(OUT_DIR, "gemini-comparison-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n  Report saved: ${reportPath}`);
  }

  console.log("\n  Side-by-side images saved to:", OUT_DIR);
  console.log("  Done!\n");
}

main().catch(console.error);
