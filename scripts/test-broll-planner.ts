/** Verify the B-roll planner on the REAL Uzbek A-roll: deliberate modality, cadence slots, keyword anchoring. */
import { readFileSync, existsSync } from "node:fs";
import { planBroll, type PlanBeat, type PlanWord } from "../src/lib/pipeline/broll-planner.ts";
import { planCadence } from "../src/lib/pipeline/cadence-planner.ts";

const root = process.cwd();
const tr = JSON.parse(readFileSync(`${root}/public/exports/sp-temp/aroll-transcription.json`, "utf8"));
const beats: PlanBeat[] = (tr.sentences ?? []).map((s: any, i: number) => ({ index: i, text: s.text, start: s.start, end: s.end }));
const words: PlanWord[] = (tr.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end }));

const kwPath = `${root}/public/exports/sp-temp/speech-keywords.json`;
const keywordsOf: Record<number, string[]> = {};
if (existsSync(kwPath)) for (const s of JSON.parse(readFileSync(kwPath, "utf8")).sentences ?? []) keywordsOf[s.index] = s.keywords ?? [];

// reference is fast-paced; derive cadence from a representative rhythm
const cadence = planCadence({ avg_segment_duration: 2.0, pacing: "fast" });
const plan = planBroll({ beats, words, keywordsOf, phaseOf: { 0: "hook" }, cadence, referenceStyle: "realistic_person" });

console.log(`cadence: ${cadence.targetShotSec}s/shot (${cadence.source}) | beats: ${beats.length}\n`);
console.log("=== B-ROLL PLAN ===");
for (const s of plan.slots) {
  console.log(`  ${s.id.padEnd(11)} [${s.timeRange.start.toFixed(1)}-${s.timeRange.end.toFixed(1)}s] ${s.modality.padEnd(14)} ${s.layout.padEnd(6)} kw="${s.keyword ?? "—"}"`);
}
console.log("\nsummary:", JSON.stringify(plan.summary));

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  (got ${JSON.stringify(got)})`}`); if (!cond) fails++; };

console.log("\n=== checks ===");
const modOf = (i: number) => [...new Set(plan.slots.filter((s) => s.beatIndex === i).map((s) => s.modality))];
ok("s0 (hook) -> ai_footage", modOf(0).includes("ai_footage"), modOf(0));
ok("s3 (1500 / 90%) -> stat", modOf(3)[0] === "stat" && modOf(3).length === 1, modOf(3));
ok("s4 (tugmani bosib) -> motion_graphic", modOf(4)[0] === "motion_graphic", modOf(4));
const footageBeat = plan.slots.filter((s) => s.beatIndex === 2);
ok("s2 footage subdivided into a cadence montage (>1 slot)", footageBeat.length > 1, footageBeat.length);
ok("stat/cta beats are ONE slot (not montage)", plan.slots.filter((s) => s.beatIndex === 3).length === 1 && plan.slots.filter((s) => s.beatIndex === 4).length === 1);

// keyword anchoring: every keyword must actually be spoken inside its slot window
const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'%]/gu, "");
let anchoredOk = 0, anchoredTotal = 0;
for (const s of plan.slots) {
  if (!s.keyword) continue;
  anchoredTotal++;
  const spoken = words.some((w) => w.start >= s.timeRange.start - 0.06 && w.start < s.timeRange.end + 0.01 && n(w.word) === n(s.keyword!));
  if (spoken) anchoredOk++;
}
ok(`keyword anchoring: ${anchoredOk}/${anchoredTotal} keywords actually spoken in their slot window`, anchoredOk === anchoredTotal, `${anchoredOk}/${anchoredTotal}`);
ok("coverage > 0", plan.summary.coveragePct > 0, plan.summary.coveragePct);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
