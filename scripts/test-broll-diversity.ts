/** Verify the diversity pass: distinct angles + a REAL Gemini run proving laptop-repetition is fixed. */
import { readFileSync, existsSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { assignAngles } from "../src/lib/pipeline/broll-diversity.ts";
import { enrichFootagePrompts } from "../src/lib/pipeline/broll-prompt-engine.ts";
import { planBroll, type PlanBeat, type PlanWord } from "../src/lib/pipeline/broll-planner.ts";
import { planCadence } from "../src/lib/pipeline/cadence-planner.ts";

const root = process.cwd();
let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

// ── Part A: deterministic angle assignment ──
console.log("=== Part A: angle assignment ===");
const angles = assignAngles(7);
const settings = angles.map((a) => a.setting);
ok("7 slots -> 7 DISTINCT settings (no repeats)", new Set(settings).size === 7, settings);
let consecOk = true;
for (let i = 1; i < angles.length; i++) if (angles[i].setting === angles[i - 1].setting || angles[i].action === angles[i - 1].action) consecOk = false;
ok("consecutive slots differ on setting AND action", consecOk);
ok("deterministic (same seed -> same angles)", JSON.stringify(assignAngles(7)) === JSON.stringify(angles));

// ── Part B: real Gemini — is the laptop repetition actually gone? ──
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.log("\n(skip Part B: no GEMINI_API_KEY)"); process.exit(fails ? 1 : 0); }

console.log("\n=== Part B: REAL Gemini, WITH diversity pass ===");
const tr = JSON.parse(readFileSync(`${root}/public/exports/sp-temp/aroll-transcription.json`, "utf8"));
const beats: PlanBeat[] = (tr.sentences ?? []).map((s: any, i: number) => ({ index: i, text: s.text, start: s.start, end: s.end }));
const words: PlanWord[] = (tr.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end }));
const plan = planBroll({ beats, words, phaseOf: { 0: "hook" }, cadence: planCadence({ avg_segment_duration: 2.0 }), referenceStyle: "realistic_person" });

const genAI = new GoogleGenerativeAI(KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json", temperature: 0.9 } });
const callLLM = async (i: string) => (await model.generateContent(i)).response.text();
await enrichFootagePrompts(plan.slots, callLLM, { style: "realistic_person", beatTextOf: (i) => beats[i]?.text });

const footage = plan.slots.filter((s) => s.modality === "ai_footage" && s.prompt);
const PLACES = ["café", "cafe", "kitchen", "co-working", "coworking", "park", "desk", "street", "studio", "living room", "rooftop", "library", "window", "terrace"];
const placeOf = (p: string) => PLACES.find((k) => p.toLowerCase().includes(k)) ?? "?";
let laptops = 0;
for (const s of footage) {
  if (/\blaptop\b/i.test(s.prompt!)) laptops++;
  console.log(`  [${s.id}] place=${placeOf(s.prompt!).padEnd(11)} ${s.prompt!.slice(0, 120)}...`);
}
const distinctPlaces = new Set(footage.map((s) => placeOf(s.prompt!))).size;
console.log(`\n  distinct settings: ${distinctPlaces}/${footage.length} | laptop mentions: ${laptops}/${footage.length}`);
ok(`varied settings (>=4 distinct across ${footage.length} footage slots)`, distinctPlaces >= 4, distinctPlaces);
ok(`laptop cliché controlled (<=2 of ${footage.length}, was ~2/3 before)`, laptops <= 2, laptops);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
