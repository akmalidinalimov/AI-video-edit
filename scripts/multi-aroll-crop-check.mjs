/**
 * multi-aroll-crop-check.mjs — verify the talking head is FULLY INSIDE the circle
 * with a TOP GAP and head+shoulders visible (the user's "don't clip the head" rule).
 *
 * For every circle segment it samples K frames from the RENDERED circle region,
 * runs YuNet (measure_circle_head.py), and gates on:
 *   - head top has a gap below the circle rim   (minHeadTopFrac >= GAP_MIN)
 *   - chin/shoulders not clipped at the bottom   (maxFaceBottomFrac <= BOTTOM_MAX)
 * across EVERY sampled frame (the speaker moves).
 *
 * Exports measureCrop(videoPath) and suggestTarget(report, current) so the closed
 * loop can auto-tune reference-circle-target.json. CLI prints a pass/fail report.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = process.cwd();
const PY = path.join(ROOT, "scripts", "python", ".venv-vision", "Scripts", "python.exe");
const MEASURE = path.join(ROOT, "scripts", "python", "measure_circle_head.py");
const STAGE2 = path.join(ROOT, "public", "exports", "multi-aroll", "stage2");
const STAGE4 = path.join(ROOT, "public", "exports", "multi-aroll", "stage4");
const REF_GT = path.join(ROOT, "public", "exports", "sp-temp", "reference-ground-truth.json");
const TARGET_PATH = path.join(ROOT, "public", "exports", "multi-aroll", "stage1", "reference-circle-target.json");

// Rendered circle region (cx=781, cy=404, r=214).
const CIRCLE = { x: 567, y: 190, w: 428, h: 428 };
const K = 5;                  // frames sampled per segment
export const GAP_MIN = 0.06;  // head top must sit >= 6% of the diameter below the rim
export const BOTTOM_MAX = 0.93; // face-box bottom must stay within 93% (chin+shoulder inside)

function circleSegmentIndices(timeline) {
  let refLayout = [];
  try {
    const raw = JSON.parse(fs.readFileSync(REF_GT, "utf-8"));
    if (Array.isArray(raw)) refLayout = raw.map(s => (s.shape === "rectangle" ? "rectangle" : "circle"));
  } catch {}
  return timeline.segments.map((_, i) => i).filter(i => (refLayout[i] || "circle") !== "rectangle");
}

export function measureCrop(videoPath) {
  const timeline = JSON.parse(fs.readFileSync(path.join(STAGE2, "clean-timeline.json"), "utf-8"));
  const circleIdx = circleSegmentIndices(timeline);
  const perSegment = [];

  for (const i of circleIdx) {
    const seg = timeline.segments[i];
    const t0 = seg.timelineStart + 0.2, t1 = seg.timelineEnd - 0.2;
    if (t1 <= t0) continue;
    const times = Array.from({ length: K }, (_, k) => (t0 + (t1 - t0) * k / (K - 1)).toFixed(3));
    const outJson = path.join(STAGE4, `_crop_seg${i}.json`);
    try {
      execFileSync(PY, [MEASURE, videoPath, `${CIRCLE.x},${CIRCLE.y},${CIRCLE.w},${CIRCLE.h}`, times.join(","), outJson],
        { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      perSegment.push({ segment: i, error: "measure failed" });
      continue;
    }
    const r = JSON.parse(fs.readFileSync(outJson, "utf-8"));
    const s = r.summary;
    const headOk = s.minHeadTopFrac >= GAP_MIN;
    const bottomOk = s.maxFaceBottomFrac <= BOTTOM_MAX;
    perSegment.push({
      segment: i, ...s,
      headOk, bottomOk, passed: headOk && bottomOk && s.detectedRatio >= 0.6,
    });
    try { fs.unlinkSync(outJson); } catch {}
  }

  const overall = {
    minHeadTopFrac: Math.min(...perSegment.map(p => p.minHeadTopFrac ?? 1)),
    maxFaceBottomFrac: Math.max(...perSegment.map(p => p.maxFaceBottomFrac ?? 0)),
    medFaceFrac: median(perSegment.map(p => p.medFaceFrac).filter(v => v != null)),
  };
  const passed = perSegment.length > 0 && perSegment.every(p => p.passed);
  return { passed, perSegment, overall };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Suggest a new crop target from a failing report (damped, one axis preferred).
 *   headClipped -> push face DOWN (faceCenterYIn += ) and/or shrink (faceFraction -=)
 *   chinClipped -> pull face UP   (faceCenterYIn -= )
 * Clamped to sane bounds. Returns { faceFraction, faceCenterYIn, changed }.
 */
export function suggestTarget(report, current, iter = 0) {
  let { faceFraction, faceCenterYIn } = current;
  const damp = Math.max(0.4, 1 - iter * 0.25);
  const o = report.overall;
  let changed = false;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const headClipped = o.minHeadTopFrac < GAP_MIN;
  const chinClipped = o.maxFaceBottomFrac > BOTTOM_MAX;

  if (headClipped && chinClipped) {
    // Can't fit head + chin: zoom OUT (smaller face) to gain margin both ends.
    faceFraction = clamp(faceFraction - 0.04 * damp, 0.42, 0.56); changed = true;
  } else if (headClipped) {
    const deficit = GAP_MIN - o.minHeadTopFrac;
    faceCenterYIn = clamp(faceCenterYIn + (deficit + 0.02) * damp, 0.30, 0.46); changed = true;
  } else if (chinClipped) {
    const excess = o.maxFaceBottomFrac - BOTTOM_MAX;
    faceCenterYIn = clamp(faceCenterYIn - (excess + 0.02) * damp, 0.30, 0.46); changed = true;
  }
  return { faceFraction: round3(faceFraction), faceCenterYIn: round3(faceCenterYIn), changed };
}

function round3(v) { return Math.round(v * 1000) / 1000; }

/** Persist a new target into reference-circle-target.json. */
export function writeTarget(faceFraction, faceCenterYIn) {
  const t = JSON.parse(fs.readFileSync(TARGET_PATH, "utf-8"));
  t.target.faceFraction = faceFraction;
  t.target.faceCenterYIn = faceCenterYIn;
  t.target._autotuned = true;
  fs.writeFileSync(TARGET_PATH, JSON.stringify(t, null, 2));
}

function main() {
  const methodArg = process.argv.find(a => /^\d$/.test(a)) || "2";
  const videoPath = path.join(STAGE4, `method-${methodArg}-rendered.mp4`);
  console.log(`Crop head-safety check on method ${methodArg}: ${videoPath}\n`);
  const r = measureCrop(videoPath);
  for (const p of r.perSegment) {
    if (p.error) { console.log(`  seg${p.segment}: ${p.error}`); continue; }
    console.log(`  seg${p.segment}: ${p.passed ? "OK" : "FAIL"} — headTop(min)=${p.minHeadTopFrac} (>= ${GAP_MIN}) ` +
      `faceBottom(max)=${p.maxFaceBottomFrac} (<= ${BOTTOM_MAX}) faceFrac=${p.medFaceFrac} det=${p.detectedRatio}`);
  }
  console.log(`\n  Overall: ${r.passed ? "PASS" : "FAIL"} — headTop(min)=${r.overall.minHeadTopFrac} faceBottom(max)=${r.overall.maxFaceBottomFrac}`);
  if (!r.passed) {
    const cur = JSON.parse(fs.readFileSync(TARGET_PATH, "utf-8")).target;
    const s = suggestTarget(r, cur);
    console.log(`  Suggestion: faceFraction ${cur.faceFraction}->${s.faceFraction}, faceCenterYIn ${cur.faceCenterYIn}->${s.faceCenterYIn}`);
  }
  process.exit(r.passed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
