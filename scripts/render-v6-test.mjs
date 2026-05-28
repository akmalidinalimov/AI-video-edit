/**
 * V6 Render Test — Triggers the API pipeline and extracts verification frames.
 *
 * This calls the real /api/clone-style endpoint which uses the actual
 * plan-renderer.ts code (with V6 direct replication changes).
 * Then extracts frames at key timestamps to visually verify:
 * - Rectangle: full source frame visible (no zoom/crop)
 * - Circle: face approximately centered
 * - Transition: correct timing
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const FFMPEG = "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe";
const API_URL = "http://localhost:3000/api/clone-style";

// Check FFmpeg exists
if (!fs.existsSync(FFMPEG)) {
  console.error("FFmpeg not found at:", FFMPEG);
  process.exit(1);
}

// ── Step 1: Call the API ──
console.log("=== STEP 1: Calling /api/clone-style ===");
console.log("  (Make sure Next.js dev server is running: npm run dev)\n");

const body = JSON.stringify({
  referenceVideo: "uploads/IMG_6018.MOV",
  arollVideo: "uploads/IMG_6108.MOV",
  brollVideo: "uploads/IMG_6163.MP4",
});

let downloadUrl;
try {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!resp.ok) {
    console.error("API returned:", resp.status, resp.statusText);
    const text = await resp.text();
    console.error(text.slice(0, 500));
    process.exit(1);
  }

  // Parse SSE stream
  const text = await resp.text();
  const lines = text.split("\n").filter(l => l.startsWith("data: "));

  for (const line of lines) {
    const data = JSON.parse(line.replace("data: ", ""));
    if (data.phase === "complete") {
      downloadUrl = data.downloadUrl;
      console.log("  Render complete! Download URL:", downloadUrl);
    } else if (data.phase === "error") {
      console.error("  Error:", data.error);
      process.exit(1);
    } else {
      console.log(`  ${data.phase}: ${data.progress}%`);
    }
  }
} catch (err) {
  console.error("Failed to call API:", err.message);
  console.error("\nIs the dev server running? Start with: npm run dev");
  process.exit(1);
}

if (!downloadUrl) {
  console.error("No download URL received from API");
  process.exit(1);
}

// ── Step 2: Find the rendered video file ──
const videoPath = path.join("public", downloadUrl.replace(/^\//, ""));
console.log("\n=== STEP 2: Video at", videoPath, "===");

if (!fs.existsSync(videoPath)) {
  console.error("Video file not found:", videoPath);
  process.exit(1);
}

// ── Step 3: Extract verification frames ──
console.log("\n=== STEP 3: Extracting verification frames ===");

const framesDir = "public/exports/sp-temp/v6-frames";
fs.mkdirSync(framesDir, { recursive: true });

// Key timestamps to extract:
// - t=1.0s: Rectangle layout (should show full uncropped source frame)
// - t=3.5s: Just before transition (still rectangle)
// - t=4.0s: Just after transition (should be circle)
// - t=8.0s: Circle layout mid-video
// - t=15.0s: Circle layout later
const timestamps = [
  { t: "1.0", label: "rect_mid" },
  { t: "3.5", label: "rect_before_transition" },
  { t: "4.0", label: "circle_after_transition" },
  { t: "8.0", label: "circle_mid" },
  { t: "15.0", label: "circle_late" },
];

for (const { t, label } of timestamps) {
  const outFile = path.join(framesDir, `frame_${label}_${t}s.png`);
  try {
    execFileSync(FFMPEG, [
      "-y", "-ss", t, "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", outFile
    ], { stdio: "pipe" });
    console.log(`  Extracted: ${label} (t=${t}s) -> ${outFile}`);
  } catch (err) {
    console.error(`  Failed to extract frame at t=${t}s:`, err.message?.slice(0, 200));
  }
}

// ── Step 4: Also save the filter for inspection ──
const filterPath = path.join("public/exports/sp-temp", "last-render-filter.txt");
if (fs.existsSync(filterPath)) {
  const filter = fs.readFileSync(filterPath, "utf8");
  console.log("\n=== STEP 4: FFmpeg filter used ===");
  console.log(filter);
} else {
  console.log("\n  (No filter file found — check API route debug logging)");
}

console.log("\n=== DONE ===");
console.log(`Video: ${videoPath}`);
console.log(`Frames: ${framesDir}/`);
console.log("\nVisually inspect the extracted frames to verify:");
console.log("  1. rect_mid: Full source frame visible (no zoom/crop)");
console.log("  2. circle_after_transition: Face approximately centered in circle");
console.log("  3. Transition at correct time (between rect_before and circle_after)");
