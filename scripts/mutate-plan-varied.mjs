/** Swap the saved plan's FOOTAGE ranges to the 7 new varied clips (keep MG ranges). */
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const plan = JSON.parse(fs.readFileSync(path.join(root, "public/exports/sp-temp/dynamic-plan.json"), "utf8"));

const gen = path.join(root, "public/uploads/generated");
const myClips = ["broll-s0-hook", "broll-s1a-kitchen", "broll-s1b-coworking", "broll-s2a-park", "broll-s2b-desk", "broll-s2c-street", "broll-s5-studio"]
  .map((n) => path.join(gen, n + ".mp4"));
for (const c of myClips) if (!fs.existsSync(c)) { console.error("MISSING clip:", c); process.exit(1); }

// MG ranges keep their motion-graphic clip; everything else is footage → re-point.
const MG_RANGES = new Set(["range_1", "range_10", "range_12", "range_18", "range_20"]);

const base = plan.sources.brollClips.length;
myClips.forEach((p, i) => plan.sources.brollClips.push({ path: p, duration: 5, inputIndex: base + i }));

let g = 0;
for (const r of plan.layoutRanges) {
  if (MG_RANGES.has(r.id)) continue;
  const clipIdx = base + (g % myClips.length);
  const pass = Math.floor(g / myClips.length);              // 0,1,2 — vary the window on repeats
  r.brollSourceIndex = clipIdx;
  r.brollOffset = Math.min(0.4 + pass * 1.8, 3.5);
  r.brollKeyframes = undefined;
  r.brollCropRegion = undefined;
  r.brollSpeed = 1.0;
  g++;
}
const out = path.join(root, "public/exports/sp-temp/dynamic-plan-varied.json");
fs.writeFileSync(out, JSON.stringify(plan, null, 2));
console.log(`re-pointed ${g} footage ranges → ${myClips.length} varied clips (${MG_RANGES.size} MG ranges kept). saved ${out}`);
