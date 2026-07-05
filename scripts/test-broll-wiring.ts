/** Verify the route's B-roll planning phase: plan + modalityByBeat veto map + footage-prompt enrichment. */
import { readFileSync, existsSync } from "node:fs";
import { planBroll, type PlanBeat, type PlanWord } from "../src/lib/pipeline/broll-planner.ts";
import { planCadence } from "../src/lib/pipeline/cadence-planner.ts";
import { enrichFootagePrompts } from "../src/lib/pipeline/broll-prompt-engine.ts";

const root = process.cwd();
let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

const tr = JSON.parse(readFileSync(`${root}/public/exports/sp-temp/aroll-transcription.json`, "utf8"));
const beats: PlanBeat[] = (tr.sentences ?? []).map((s: any, i: number) => ({ index: i, text: s.text, start: s.start, end: s.end }));
const words: PlanWord[] = (tr.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end }));
const kwPath = `${root}/public/exports/sp-temp/speech-keywords.json`;
const keywordsOf: Record<number, string[]> = {};
if (existsSync(kwPath)) for (const s of JSON.parse(readFileSync(kwPath, "utf8")).sentences ?? []) keywordsOf[s.index] = s.keywords ?? [];

// EXACTLY as the route builds it
const plan = planBroll({ beats, words, keywordsOf, phaseOf: { 0: "hook" }, cadence: planCadence(tr?.editing_rhythm ?? { avg_segment_duration: 2.0 }), referenceStyle: "realistic_person" });

console.log("modalityByBeat:", JSON.stringify(plan.modalityByBeat));
ok("modalityByBeat covers EVERY beat (incl. would-be 'none')", Object.keys(plan.modalityByBeat).length === beats.length, Object.keys(plan.modalityByBeat).length);
ok("plannedModalityOf is a usable veto map (values are modality strings)", Object.values(plan.modalityByBeat).every((m) => typeof m === "string"));

// Step 3 enrichment with a deterministic stub LLM (route uses Gemini)
const stub = async () => JSON.stringify({ camera: "Eye-level medium shot, slow push-in", subject: "a young person", action: "smiles at a phone", setting: "a sunlit café", lighting: "warm golden light", style: "cinematic, candid" });
const footageCount = plan.slots.filter((s) => s.modality === "ai_footage").length;
const filled = await enrichFootagePrompts(plan.slots, stub, { style: "realistic_person", beatTextOf: (i) => beats[i]?.text });
ok(`enriched all footage slots (${filled}/${footageCount})`, filled === footageCount && footageCount > 0, `${filled}/${footageCount}`);
ok("every ai_footage slot now has a prompt + negative", plan.slots.filter((s) => s.modality === "ai_footage").every((s) => !!s.prompt && !!s.negative));
ok("non-footage slots stay promptless (graphics/stat unchanged)", plan.slots.filter((s) => s.modality !== "ai_footage").every((s) => !s.prompt));

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
