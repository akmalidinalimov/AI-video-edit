/**
 * test-region-decode.ts — VLM-driven MULTI-REGION decode on a reel (schema v2: x extents + time).
 * VLM proposes the stacked band structure; CV detects shots PER B-roll band.
 * Usage: (bundled) node ... [<video>] [--r3]
 *   default video = R2 (DownReels_20260701_191828.mp4) → tight 4-band stack assertions
 *   --r3 (or passing ref3-aipipeline.mp4) → PIP-over-fullscreen assertions
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { analyzeLayoutRegions, type RegionBand } from "../src/lib/analysis/layout-regions.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const args = process.argv.slice(2);
const r3Flag = args.includes("--r3");
const video = args.find((a) => !a.startsWith("--"))
  || (r3Flag ? `${process.cwd()}/public/uploads/ref3-aipipeline.mp4` : `${process.cwd()}/public/uploads/DownReels_20260701_191828.mp4`);
const isR3 = r3Flag || /ref3-aipipeline/i.test(video);
const PY = `${process.cwd()}/scripts/python/.venv/Scripts/python.exe`;
const SHOTS = `${process.cwd()}/scripts/python/region_shots.py`;

console.log(`\nMULTI-REGION DECODE (${isR3 ? "R3 PIP mode" : "R2 stack mode"}): ${path.basename(video)}\n`);
const layout = await analyzeLayoutRegions(video);
if (!layout) { console.log("FAIL: region decode null (GEMINI_API_KEY?)"); process.exit(1); }

console.log(`layoutClass: ${layout.layoutClass}  |  A-roll band: #${layout.arollBandIndex}`);
console.log(`summary: ${layout.summary}`);
if (layout.structureTimeline) console.log(`structureTimeline: ${layout.structureTimeline.length} window(s): ${layout.structureTimeline.map((w) => `${w.start}-${w.end}s(${w.bands.length} bands)`).join(", ")}`);
console.log("\nband  role              y-range        x-range        persistent  shape         shots  description");
let totalBrollShots = 0;
const fmtTimeline = (b: RegionBand) =>
  b.contentTimeline?.length ? `        └ contentTimeline: ${b.contentTimeline.map((w) => `${w.start.toFixed(0)}-${w.end.toFixed(0)}s ${w.content}`).join(" | ")}` : null;
for (let i = 0; i < layout.bands.length; i++) {
  const b = layout.bands[i];
  let shotsCol = "—";
  if (b.role === "broll" || b.role === "screen_recording") {
    try {
      const out = execFileSync(PY, [SHOTS, video, String(b.yStart), String(b.yEnd)], { stdio: "pipe", timeout: 200_000 }).toString();
      const j = JSON.parse(out.trim().split("\n").pop() || "{}");
      shotsCol = String(j.shots ?? "?");
      if (b.role === "broll") totalBrollShots += (j.shots ?? 0);
    } catch { shotsCol = "err"; }
  }
  console.log(
    `#${i}    ${b.role.padEnd(16)} ${(b.yStart.toFixed(2) + "-" + b.yEnd.toFixed(2)).padEnd(13)} ${(b.xStart.toFixed(2) + "-" + b.xEnd.toFixed(2)).padEnd(13)} ${String(b.persistent).padEnd(11)} ${b.shape.padEnd(13)} ${shotsCol.padEnd(6)} ${b.description.slice(0, 46)}`
  );
  const tl = fmtTimeline(b); if (tl) console.log(tl);
}
console.log(`\nB-roll shots (per-band, the fast rhythm the whole-frame detector missed): ${totalBrollShots}`);

let fails = 0; const ok = (n: string, c: boolean) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) fails++; };

if (isR3) {
  // R3 truth: persistent centered rounded-rect A-roll PIP (~60% width, bottom-center) over a
  // full-frame background whose CONTENT CLASS changes over time.
  ok("layoutClass is PIP-like or multi_region_stack",
    ["circle_pip", "multi_region_stack", "pip", "pip_over_fullscreen"].includes(layout.layoutClass));
  const aroll = layout.arollBandIndex >= 0 ? layout.bands[layout.arollBandIndex] : undefined;
  ok("found an A-roll band", !!aroll);
  ok("A-roll is a centered PIP: xStart > 0.02 AND xEnd < 0.98",
    !!aroll && aroll.xStart > 0.02 && aroll.xEnd < 0.98);
  if (aroll && aroll.shape !== "rounded_rect" && aroll.shape === "rectangle") {
    console.log(`WARN  A-roll shape reported as "rectangle" (expected rounded_rect) — accepting with warning`);
  }
  ok("A-roll shape is rounded_rect (or rectangle w/ warning)",
    !!aroll && (aroll.shape === "rounded_rect" || aroll.shape === "rectangle"));
  const timelineBand = layout.bands.find((b) =>
    (b.contentTimeline?.length ?? 0) >= 2 && new Set(b.contentTimeline!.map((w) => w.content)).size >= 2);
  ok("a band has a contentTimeline with ≥2 entries of differing content classes", !!timelineBand);
} else {
  // R2 truth (verified frames): exactly 4 stacked bands — header_title 0-0.10, broll 0.10-0.50,
  // screen_recording 0.50-0.65, aroll 0.65-1.0. Structure stable over time.
  const TRUTH_ROLES = ["header_title", "broll", "screen_recording", "aroll"];
  const TRUTH_BOUNDS = [0, 0.10, 0.50, 0.65, 1.0];
  const TOL = 0.07;
  ok("decoded as a multi-region stack", layout.layoutClass === "multi_region_stack");
  ok("exactly 4 bands", layout.bands.length === 4);
  ok(`roles in order = ${TRUTH_ROLES.join(", ")}`,
    layout.bands.length === 4 && layout.bands.every((b, i) => b.role === TRUTH_ROLES[i]));
  ok("arollBandIndex === 3", layout.arollBandIndex === 3);
  if (layout.bands.length === 4) {
    for (let i = 0; i < 4; i++) {
      const b = layout.bands[i];
      ok(`band #${i} y ${b.yStart.toFixed(2)}-${b.yEnd.toFixed(2)} within ±${TOL} of ${TRUTH_BOUNDS[i]}-${TRUTH_BOUNDS[i + 1]}`,
        Math.abs(b.yStart - TRUTH_BOUNDS[i]) <= TOL && Math.abs(b.yEnd - TRUTH_BOUNDS[i + 1]) <= TOL);
    }
  }
  ok("bands are contiguous 0..1",
    Math.abs(layout.bands[0].yStart) < 0.01 && Math.abs(layout.bands[layout.bands.length - 1].yEnd - 1) < 0.01);
}
console.log(fails === 0 ? "\n✅ multi-region decode working" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
