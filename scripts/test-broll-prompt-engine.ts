/** Verify the prompt engine: deterministic assembly (stub LLM) + a REAL Gemini run on our slots. */
import { readFileSync, existsSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildComponentInstruction, assembleFromComponents, generateBrollPrompt, type ComponentLLM } from "../src/lib/pipeline/broll-prompt-engine.ts";
import { planBroll, type PlanBeat, type PlanWord } from "../src/lib/pipeline/broll-planner.ts";
import { planCadence } from "../src/lib/pipeline/cadence-planner.ts";

const root = process.cwd();
let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  (got ${JSON.stringify(got)})`}`); if (!cond) fails++; };

// ── Part A: deterministic core (no network) ──
console.log("=== Part A: deterministic ===");
const instr = buildComponentInstruction({ concept: "ordinary person succeeding", keyword: "daromad", beatText: "AI orqali daromad", style: "realistic_person", durationSec: 4 });
ok("instruction names Kling", /Kling/.test(instr));
ok("instruction carries the discipline (no geometry rule)", /geometry/i.test(instr));
ok("instruction emphasises the keyword", instr.includes("daromad"));
ok("instruction injects the style", /realistic_person/.test(instr));

const stub: ComponentLLM = async () => JSON.stringify({
  camera: "Eye-level medium shot, slow push-in", subject: "a young woman in a casual blazer",
  action: "she smiles at her phone", setting: "a sunlit café balcony, city blurred behind",
  lighting: "warm golden-hour light", style: "cinematic, shallow depth of field, candid",
});
const r = await generateBrollPrompt({ concept: "x", keyword: "daromad" }, stub);
ok("assembles in director order (camera first)", r.prompt.startsWith("Eye-level medium shot"));
ok("prompt is light (<=70 words)", r.light, r.wordCount);
ok("picks default negative for a single subject", r.negative.includes("distorted face") && !r.negative.startsWith("morphing"));
const grp = assembleFromComponents({ ...JSON.parse(await stub("")), subject: "a diverse group of people" });
ok("group subject -> group negative", grp.negative.startsWith("morphing"));

// ── Part B: real Gemini on our actual planned slots ──
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.log("\n(skip Part B: no GEMINI_API_KEY)"); process.exit(fails ? 1 : 0); }

console.log("\n=== Part B: REAL Gemini generation on our slots ===");
const tr = JSON.parse(readFileSync(`${root}/public/exports/sp-temp/aroll-transcription.json`, "utf8"));
const beats: PlanBeat[] = (tr.sentences ?? []).map((s: any, i: number) => ({ index: i, text: s.text, start: s.start, end: s.end }));
const words: PlanWord[] = (tr.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end }));
const plan = planBroll({ beats, words, phaseOf: { 0: "hook" }, cadence: planCadence({ avg_segment_duration: 2.0 }), referenceStyle: "realistic_person" });
const footage = plan.slots.filter((s) => s.modality === "ai_footage").slice(0, 3);

const genAI = new GoogleGenerativeAI(KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json", temperature: 0.9 } });
const callLLM: ComponentLLM = async (i) => (await model.generateContent(i)).response.text();

const GEOM = /(facing the viewer|toward the viewer|above the keyboard|screen shows|text saying|reads ")/i;
for (const slot of footage) {
  const beat = beats[slot.beatIndex];
  const out = await generateBrollPrompt({ concept: slot.concept, keyword: slot.keyword, beatText: beat.text, style: "realistic_person", durationSec: slot.durationSec }, callLLM);
  console.log(`\n  [${slot.id}] kw="${slot.keyword}" (${out.wordCount} words, light=${out.light})`);
  console.log(`    ${out.prompt}`);
  ok(`  ${slot.id}: non-empty + light`, out.prompt.length > 40 && out.light, out.wordCount);
  ok(`  ${slot.id}: no geometry / forced-text leakage`, !GEOM.test(out.prompt));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
