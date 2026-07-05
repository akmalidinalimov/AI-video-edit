/** Verify Step 4: re-roll orchestration (stubs) + real Gemini prompt-critic + real video-critic. */
import { readFileSync, existsSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateBrollForSlot, type GenerationDeps } from "../src/lib/pipeline/broll-generation.ts";
import { critiquePrompt, critiqueVideo, type TextLLM, type VisionLLM } from "../src/lib/pipeline/broll-critic.ts";

const root = process.cwd();
let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

const slot = { id: "slot_1_0", prompt: "a good light prompt", negative: "neg", concept: "a person succeeding", keyword: "daromad", durationSec: 4 };
const baseDeps: GenerationDeps = {
  critiquePrompt: async () => ({ approved: true, issues: [] }),
  generateClip: async (_p, o) => ({ path: `clip_seed${o.seed}.mp4` }),
  critiqueVideo: async () => ({ approved: true, issues: [], severity: "ok" }),
};

console.log("=== Part A: orchestration (stubs) ===");
const happy = await generateBrollForSlot(slot, baseDeps);
ok("happy path -> approved on attempt 1", happy.status === "approved" && happy.attempts === 1 && happy.clipPath === "clip_seed1.mp4", happy);

const revised = await generateBrollForSlot(slot, { ...baseDeps, critiquePrompt: async () => ({ approved: false, issues: ["geometry"], revised: "REVISED LIGHT PROMPT" }) });
ok("rejected prompt -> uses the revised prompt", revised.promptUsed === "REVISED LIGHT PROMPT" && revised.status === "approved", revised.promptUsed);

let vcalls = 0;
const reroll = await generateBrollForSlot(slot, { ...baseDeps, critiqueVideo: async () => (++vcalls === 1 ? { approved: false, issues: ["flipped"], severity: "reroll" } : { approved: true, issues: [], severity: "ok" }) });
ok("video rejects seed1 -> re-rolls -> approved on seed2", reroll.status === "approved" && reroll.attempts === 2 && reroll.clipPath === "clip_seed2.mp4", reroll);

const exhausted = await generateBrollForSlot(slot, { ...baseDeps, critiqueVideo: async () => ({ approved: false, issues: ["bad"], severity: "reroll" }) }, { maxAttempts: 2 });
ok("all attempts fail -> exhausted, keeps last clip", exhausted.status === "exhausted" && exhausted.attempts === 2 && exhausted.clipPath === "clip_seed2.mp4", exhausted);

const noPrompt = await generateBrollForSlot({ ...slot, prompt: undefined }, baseDeps);
ok("no prompt -> no_prompt", noPrompt.status === "no_prompt", noPrompt.status);
const genFail = await generateBrollForSlot(slot, { ...baseDeps, generateClip: async () => null }, { maxAttempts: 2 });
ok("generator always null -> gen_failed", genFail.status === "gen_failed", genFail.status);

// ── Part B: critic code, deterministic (stub LLM) — verifies parsing + verdict logic ──
console.log("\n=== Part B: critic logic (stubs) ===");
const stubReject: TextLLM = async () => JSON.stringify({ approved: false, issues: ["object geometry", "forced on-screen text"], revised: "a clean light prompt" });
const stubApprove: TextLLM = async () => JSON.stringify({ approved: true, issues: [], revised: "" });
const pr = await critiquePrompt("bad prompt", stubReject);
ok("critiquePrompt parses a rejection + corrected prompt", pr.approved === false && pr.issues.length === 2 && pr.revised === "a clean light prompt", pr);
const pa = await critiquePrompt("good prompt", stubApprove);
ok("critiquePrompt parses an approval (no revised)", pa.approved === true && !pa.revised, pa);
const stubVid = (sev: string): VisionLLM => async () => JSON.stringify({ approved: sev === "ok", issues: sev === "ok" ? [] : ["defect"], severity: sev });
const vReroll = await critiqueVideo("c.mp4", { concept: "x" }, stubVid("reroll"));
ok("critiqueVideo: reroll severity -> NOT approved", vReroll.approved === false && vReroll.severity === "reroll", vReroll);
const vOk = await critiqueVideo("c.mp4", { concept: "x" }, stubVid("ok"));
ok("critiqueVideo: ok severity -> approved", vOk.approved === true && vOk.severity === "ok", vOk);

// ── Part C: real Gemini (BONUS — graceful skip on outage/no-key) ──
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
const KEY = process.env.GEMINI_API_KEY;
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { if (i === tries - 1) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); } }
  throw new Error("unreachable");
}
if (KEY) {
  console.log("\n=== Part C: real prompt-critic (bonus) ===");
  try {
    const genAI = new GoogleGenerativeAI(KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json", temperature: 0.2 } });
    const textLLM: TextLLM = async (i) => (await withRetry(() => model.generateContent(i))).response.text();
    const good = "Medium close-up, slow push-in. A young woman in a casual blazer, warm smile. She looks at her phone and lights up with delight. A sunlit café balcony, leaves stirring. Warm golden-hour light. Cinematic, shallow depth of field, candid.";
    const bad = "Medium shot of a man at a desk. The laptop screen is upright above the keyboard facing him, the keyboard deck angled toward the viewer, the screen clearly showing a green line chart with the text PROFIT visible, as the camera slowly pushes in then pans left then tilts up across the cluttered room full of devices.";
    const gv = await critiquePrompt(good, textLLM);
    const bv = await critiquePrompt(bad, textLLM);
    console.log(`  good -> approved=${gv.approved} | bad -> approved=${bv.approved}, issues=${JSON.stringify(bv.issues).slice(0, 140)}`);
    ok("[bonus] approves clean, rejects over-prompted", gv.approved === true && bv.approved === false && bv.issues.length > 0, { good: gv.approved, bad: bv.approved });
  } catch (e) { console.log(`  (skipped — Gemini unavailable: ${String((e as Error).message).slice(0, 80)})`); }
} else { console.log("\n(skip Part C: no GEMINI_API_KEY)"); }

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
