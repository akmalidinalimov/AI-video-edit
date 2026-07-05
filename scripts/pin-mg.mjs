/**
 * pin-mg.mjs — pin motion-graphics clips onto specific narration beats in a saved
 * plan, then write dynamic-plan-mg.json for rerender-from-plan. This is the manual
 * stand-in for the Creative-Director placement layer: motion graphics at the
 * hook / stat / CTA beats, AI footage everywhere else (the multi-modal mix).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sp = path.join(root, "public/exports/sp-temp");
const plan = JSON.parse(readFileSync(path.join(sp, "dynamic-plan.json"), "utf8"));
const gen = path.join(root, "public/uploads/generated");

const mg = [
  { key: "hook", file: "kinetic-hook.mp4" },
  { key: "counter", file: "stat-counter.mp4" },
  { key: "donut", file: "stat-donut.mp4" },
  { key: "cta", file: "kinetic-cta.mp4" },
];

const base = plan.sources.brollClips.length;
const idx = {};
mg.forEach((m, i) => {
  const p = path.join(gen, m.file);
  if (!existsSync(p)) throw new Error(`missing MG clip: ${p}`);
  plan.sources.brollClips.push({ path: p, duration: 3, inputIndex: base + i });
  idx[m.key] = base + i;
});

const ranges = (s) => plan.layoutRanges.filter((r) => r.sentences.some((x) => x.index === s));
const pin = (range, srcIdx, label) => {
  if (!range) return;
  range.brollSourceIndex = srcIdx;
  range.brollOffset = 0;
  range.brollKeyframes = undefined; // MG clip drives its own motion
  console.log(`  ${range.id} (s${range.sentences[0].index}) → ${label} [src ${srcIdx}]`);
};

const s0 = ranges(0); pin(s0[0], idx.hook, "kinetic-hook");
const s3 = ranges(3); pin(s3[0], idx.counter, "stat-counter"); pin(s3[s3.length - 1], idx.donut, "stat-donut");
const s4 = ranges(4); pin(s4[0], idx.cta, "kinetic-cta");

const out = path.join(sp, "dynamic-plan-mg.json");
writeFileSync(out, JSON.stringify(plan, null, 2));
console.log(`\nWrote ${out} — ${plan.sources.brollClips.length} clips (added ${mg.length} MG)`);
