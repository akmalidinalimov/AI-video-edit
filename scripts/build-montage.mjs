/**
 * build-montage.mjs — build the continuous full-canvas B-roll montage from a
 * plan's layoutRanges using PER-SEGMENT INPUT-SEEK + concat (the memory-light,
 * robust way to render a cut-list). Each range becomes one trimmed input; concat
 * stitches them into one 1080×1920 track covering the whole timeline.
 *
 * This replaces the black-base + time-shifted-overlay + start-pad approach,
 * which OOMs once the plan is subdivided into many shots.
 *
 * Usage: node scripts/build-montage.mjs [plan.json] [out.mp4]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const FFMPEG = path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const planPath = process.argv[2] || path.join(root, "public/exports/sp-temp/dynamic-plan.json");
const outPath = process.argv[3] || path.join(root, "public/exports", `montage-${Date.now()}.mp4`);

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const W = plan.canvas.width, H = plan.canvas.height, FPS = plan.fps;
const clips = plan.sources.brollClips ?? [{ path: plan.sources.broll }];

export function buildMontageArgs(plan, outPath) {
  const ranges = plan.layoutRanges;
  const inputs = [];
  const parts = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const src = clips[r.brollSourceIndex ?? 0]?.path ?? clips[0].path;
    const off = Math.max(0, r.brollOffset ?? 0);
    const speed = r.brollSpeed && r.brollSpeed > 0 ? r.brollSpeed : 1;
    const rangeDur = r.timeRange.end - r.timeRange.start;
    const srcDur = rangeDur * speed + 0.3; // consume a touch extra
    // input-level seek: fast + only decodes the needed window (low memory)
    inputs.push("-ss", off.toFixed(3), "-t", srcDur.toFixed(3), "-i", src);
    let f = `[${i}:v]`;
    if (speed !== 1) f += `setpts=${(1 / speed).toFixed(4)}*PTS,`;
    f +=
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},` +
      `tpad=stop_mode=clone:stop_duration=2,trim=duration=${rangeDur.toFixed(4)},` +
      `setpts=PTS-STARTPTS,format=yuv420p[s${i}]`;
    parts.push(f);
  }
  const concat =
    ranges.map((_, i) => `[s${i}]`).join("") + `concat=n=${ranges.length}:v=1:a=0[bg]`;
  const filter = parts.join(";") + ";" + concat;
  return [
    "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex", filter,
    "-map", "[bg]",
    "-t", plan.totalDuration.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", String(FPS),
    outPath,
  ];
}

// Run standalone
const args = buildMontageArgs(plan, outPath);
console.log(`Building montage: ${plan.layoutRanges.length} segments → ${outPath}`);
const proc = spawn(FFMPEG, args, { cwd: root });
let err = "";
proc.stderr.on("data", (d) => (err += d.toString()));
proc.on("close", (code) => {
  if (code === 0 && fs.existsSync(outPath)) {
    console.log(`✅ montage OK: ${outPath}`);
  } else {
    console.error(`❌ montage failed (code ${code})\n${err.split("\n").filter((l) => /error|Invalid|memory/i.test(l)).slice(0, 6).join("\n")}`);
    process.exit(1);
  }
});
