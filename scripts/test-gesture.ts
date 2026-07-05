/** Standalone test: does Gemini detect the A-roll gestures per sentence? */
import fs from "node:fs";
import path from "node:path";

// load GEMINI_API_KEY from .env.local
const env = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

void (async () => {
  const { detectArollGestures } = await import("../src/lib/pipeline/aroll-gesture");
  const plan = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/exports/sp-temp/dynamic-plan.json"), "utf8"));
  const sentences = (plan.sentences ?? []).map((s: { index?: number; text: string; start: number; end: number }, i: number) => ({
    index: s.index ?? i, text: s.text, start: s.start, end: s.end,
  }));
  console.log(`Analyzing ${sentences.length} sentences of the clean A-roll for gestures...`);
  const aroll = path.join(process.cwd(), "public/uploads/aroll-clean.mp4");
  const g = await detectArollGestures(aroll, sentences);
  if (!g) { console.error("FAILED — no gestures returned"); process.exit(1); }
  for (const x of g) {
    const s = sentences.find((y: { index: number }) => y.index === x.index);
    console.log(`  [${x.index}] ${x.direction.toUpperCase().padEnd(7)} ${s ? `"${s.text.slice(0, 45)}"` : ""} — ${x.reason}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
