/** Build + save broll-plan.json with real varied footage prompts (planner → engine → diversity). */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { planBroll, type PlanBeat, type PlanWord } from "../src/lib/pipeline/broll-planner.ts";
import { planCadence } from "../src/lib/pipeline/cadence-planner.ts";
import { enrichFootagePrompts } from "../src/lib/pipeline/broll-prompt-engine.ts";
import { framingForRegion } from "../src/lib/pipeline/broll-framing.ts";

const root = process.cwd();
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("no GEMINI_API_KEY"); process.exit(2); }

const tr = JSON.parse(readFileSync(`${root}/public/exports/sp-temp/aroll-transcription.json`, "utf8"));
const beats: PlanBeat[] = (tr.sentences ?? []).map((s: any, i: number) => ({ index: i, text: s.text, start: s.start, end: s.end }));
const words: PlanWord[] = (tr.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end }));
const kwPath = `${root}/public/exports/sp-temp/speech-keywords.json`;
const keywordsOf: Record<number, string[]> = {};
if (existsSync(kwPath)) for (const s of JSON.parse(readFileSync(kwPath, "utf8")).sentences ?? []) keywordsOf[s.index] = s.keywords ?? [];

const plan = planBroll({ beats, words, keywordsOf, phaseOf: { 0: "hook" }, cadence: planCadence(tr?.editing_rhythm ?? { avg_segment_duration: 2.0 }), referenceStyle: "realistic_person" });

const genAI = new GoogleGenerativeAI(KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json", temperature: 0.9 } });
async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { if (i === tries - 1) throw e; console.log(`  retry ${i + 1} (${String((e as Error).message).slice(0, 60)})`); await new Promise((r) => setTimeout(r, 3000 * (i + 1))); } }
  throw new Error("unreachable");
}
const callLLM = async (i: string) => (await withRetry(() => model.generateContent(i))).response.text();

// Region-fit framing: the reference's B-roll is the TOP 1:1 square → generate 1:1, waist-up, headroom.
const framing = framingForRegion({ width: 1080, height: 1080 }, true);
console.log(`framing: ${framing.reason}`);
const filled = await enrichFootagePrompts(plan.slots, callLLM, { style: "realistic_person", framing, beatTextOf: (i) => beats[i]?.text });
const planPath = `${root}/public/exports/sp-temp/broll-plan.json`;
writeFileSync(planPath, JSON.stringify(plan, null, 2));

console.log(`\nSAVED ${planPath}`);
console.log(`slots: ${plan.summary.total} ${JSON.stringify(plan.summary.byModality)} | footage prompts: ${filled}\n`);
for (const s of plan.slots) {
  const tag = s.modality === "ai_footage" ? "FOOTAGE" : s.modality.toUpperCase();
  console.log(`[${s.id}] ${tag} ${s.durationSec.toFixed(1)}s kw="${s.keyword}"`);
  if (s.prompt) console.log(`   ${s.prompt}\n   (neg: ${s.negative})\n`);
}
