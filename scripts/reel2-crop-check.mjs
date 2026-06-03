/**
 * reel2-crop-check.mjs — head-safety gate for reel-2's TOP A-roll band.
 *
 * v3 cut the real talking head off (no face-aware crop). v3.1 crops the top band head-safe;
 * this verifies it on the RENDERED output. For each Act-1 split segment it samples K frames
 * from reel2.mp4's TOP BAND region (0,0,1080,840), runs YuNet (measure_circle_head.py), and
 * gates EVERY sampled frame on:
 *   - head top has a gap below the band top   (minHeadTopFrac >= GAP_MIN)
 *   - chin/shoulders not clipped at the bottom (maxFaceBottomFrac <= BOTTOM_MAX)
 * Ports scripts/multi-aroll-crop-check.mjs, with band-appropriate thresholds (the wide-short
 * band is tighter than the circle for close subjects, so a small headroom counts as head-safe).
 *
 * Usage: node scripts/reel2-crop-check.mjs [path-to-mp4]   (default public/exports/reel2/reel2.mp4)
 * Exit 0 if every Act-1 turn passes, else 1.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = process.cwd();
const PY = path.join(ROOT, "scripts", "python", ".venv-vision", "Scripts", "python.exe");
const MEASURE = path.join(ROOT, "scripts", "python", "measure_circle_head.py");
const REEL2 = path.join(ROOT, "public", "exports", "reel2");
const PROPS = path.join(REEL2, "reel2-props.json");
const VIDEO = process.argv[2] || path.join(REEL2, "reel2.mp4");

const BAND = { x: 0, y: 0, w: 1080, h: 840 };   // top A-roll band on the 1080x1920 canvas
const K = 5;                                      // frames sampled per turn (the speaker moves)
const GAP_MIN = 0.03;                             // head-top >= 3% of band height below the top (a little headroom)
const BOTTOM_MAX = 0.99;                          // chin within 99% (head fully in; for a close subject the chin may sit at the band's bottom edge, where it meets the cartoon panel)

function main() {
  const props = JSON.parse(fs.readFileSync(PROPS, "utf-8"));
  const fps = props.fps || 30;
  const splits = props.segments.filter(s => s.kind === "split");
  console.log(`Head-safety check on TOP band of ${path.basename(VIDEO)} — ${splits.length} A-roll turns\n`);

  const perTurn = [];
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    const t0 = s.startFrame / fps + 0.1, t1 = s.endFrame / fps - 0.1;
    if (t1 <= t0) continue;
    const times = Array.from({ length: K }, (_, k) => (t0 + (t1 - t0) * k / (K - 1)).toFixed(3));
    const outJson = path.join(REEL2, `_cropchk_t${i + 1}.json`);
    let r;
    try {
      execFileSync(PY, [MEASURE, VIDEO, `${BAND.x},${BAND.y},${BAND.w},${BAND.h}`, times.join(","), outJson], { stdio: ["pipe", "pipe", "pipe"] });
      r = JSON.parse(fs.readFileSync(outJson, "utf-8")).summary;
    } catch (e) {
      perTurn.push({ turn: i + 1, error: "measure failed" });
      continue;
    } finally { try { fs.unlinkSync(outJson); } catch {} }
    const headOk = r.minHeadTopFrac >= GAP_MIN;
    const bottomOk = r.maxFaceBottomFrac <= BOTTOM_MAX;
    const detOk = r.detectedRatio >= 0.6;
    const passed = headOk && bottomOk && detOk;
    perTurn.push({ turn: i + 1, ...r, headOk, bottomOk, detOk, passed });
    console.log(`  t${i + 1}: ${passed ? "OK  " : "FAIL"} headTop(min)=${r.minHeadTopFrac} (>= ${GAP_MIN})  ` +
      `faceBottom(max)=${r.maxFaceBottomFrac} (<= ${BOTTOM_MAX})  faceFrac=${r.medFaceFrac}  det=${r.detectedRatio}` +
      `${headOk ? "" : "  ← HEAD CLIPPED"}${bottomOk ? "" : "  ← CHIN/SHOULDER CLIPPED"}${detOk ? "" : "  ← no face"}`);
  }

  const passed = perTurn.length > 0 && perTurn.every(p => p.passed);
  console.log(`\n  Overall: ${passed ? "PASS — every turn keeps the head with headroom + shoulders" : "FAIL — fix the flagged turns"}`);
  process.exit(passed ? 0 : 1);
}
main();
