/**
 * creative-director.mjs — the auto-router (Phase 2 "Creative Director").
 *
 * Reads the narration beats + the narrative phases + speech keywords and decides,
 * PER BEAT, which B-roll modality to use — no hardcoded sentence indices. Then it
 * pins the matching motion-graphic clip onto a range of that beat and writes
 * dynamic-plan-cd.json for rerender-from-plan.
 *
 *   numbers / %        → STAT      (Counter for the count, Donut for the %)
 *   phase = cta        → KINETIC   (CTA text)
 *   phase = hook       → KINETIC   (hook text)
 *   phase = solution   → KENBURNS  (cinematic still for the concept/aspiration)
 *   everything else    → FOOTAGE   (keep the AI video / event footage)
 *
 * Content note: this v1 routes automatically and reuses the pre-rendered, hand-
 * tuned MG clips for content. A v2 would generate the MG content per beat (numbers
 * are already auto-extracted here; kinetic TEXT is the spot to add an LLM).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sp = path.join(root, "public/exports/sp-temp");
const gen = path.join(root, "public/uploads/generated");

const plan = JSON.parse(readFileSync(path.join(sp, "dynamic-plan.json"), "utf8"));
const narrative = existsSync(path.join(sp, "narrative-context.json"))
  ? JSON.parse(readFileSync(path.join(sp, "narrative-context.json"), "utf8"))
  : { narrativePhases: [] };

const phaseOf = {};
for (const p of narrative.narrativePhases ?? []) for (const i of p.sentenceIndices) phaseOf[i] = p.phase;

// Pre-rendered MG clips this router can place (v2 renders these per-beat).
const CLIP = {
  kineticHook: "kinetic-hook.mp4",
  kineticCta: "kinetic-cta.mp4",
  counter: "stat-counter.mp4",
  donut: "stat-donut.mp4",
  kenburns: "ken-burns.mp4",
};

function extractStat(text) {
  const pct = text.match(/(\d{1,3})\s*%/);
  const bigs = [...text.matchAll(/\b(\d{3,})\b/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => !(n >= 1900 && n <= 2100)); // a year (e.g. 2026) is not a count
  return { percent: pct ? parseInt(pct[1], 10) : null, count: bigs.length ? Math.max(...bigs) : null };
}

/** Decide the modality for one beat (sentence). CTA wins over a stray hook; a
 *  year is not a stat; only the FIRST sentence gets the kinetic hook. */
let hookPlaced = false;
function routeBeat(s) {
  const phase = phaseOf[s.index];
  const isCta = phase === "cta" || /\btugma|bosib|bosing\b/i.test(s.text);
  const stat = extractStat(s.text);
  if (stat.count || stat.percent) return { modality: "stat", ...stat };
  if (isCta) return { modality: "kinetic", role: "cta" };
  if ((phase === "hook" || s.index === 0) && !hookPlaced) { hookPlaced = true; return { modality: "kinetic", role: "hook" }; }
  if (phase === "solution") return { modality: "kenburns" };
  return { modality: "footage" };
}

// --- add MG clips to the pool on demand, pin to ranges ---
const base = plan.sources.brollClips.length;
const clipIdx = {}; // filename → source index (added lazily)
function sourceIndexFor(file) {
  if (clipIdx[file] !== undefined) return clipIdx[file];
  const p = path.join(gen, file);
  if (!existsSync(p)) throw new Error(`missing MG clip: ${p}`);
  const idx = base + Object.keys(clipIdx).length;
  plan.sources.brollClips.push({ path: p, duration: 3, inputIndex: idx });
  clipIdx[file] = idx;
  return idx;
}
const rangesOf = (i) => plan.layoutRanges.filter((r) => r.sentences.some((x) => x.index === i));
function pin(range, file, label) {
  if (!range) return;
  range.brollSourceIndex = sourceIndexFor(file);
  range.brollOffset = 0;
  range.brollKeyframes = undefined;
  console.log(`  ${range.id} (s${range.sentences[0].index}) → ${label}`);
}

const sentences = plan.sentences ?? [];
const summary = [];
for (const s of sentences) {
  const r = routeBeat(s);
  summary.push(`s${s.index}:${r.modality}${r.role ? "/" + r.role : ""}`);
  const rg = rangesOf(s.index);
  if (!rg.length) continue;
  if (r.modality === "stat") {
    if (r.count) pin(rg[0], CLIP.counter, `STAT counter (${r.count}+)`);
    if (r.percent) pin(rg[rg.length - 1], CLIP.donut, `STAT donut (${r.percent}%)`);
  } else if (r.modality === "kinetic") {
    pin(rg[0], r.role === "cta" ? CLIP.kineticCta : CLIP.kineticHook, `KINETIC ${r.role}`);
  } else if (r.modality === "kenburns") {
    pin(rg[0], CLIP.kenburns, "KEN BURNS still");
  } // footage → leave as-is
}

console.log("\nRouting:", summary.join("  "));
const out = path.join(sp, "dynamic-plan-cd.json");
writeFileSync(out, JSON.stringify(plan, null, 2));
console.log(`Wrote ${out} — ${plan.sources.brollClips.length} clips (added ${Object.keys(clipIdx).length} MG)`);
