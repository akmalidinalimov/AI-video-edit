/** Run the Step-4 video-critic on a real clip: extract frames → Gemini vision → verdict. */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { critiqueVideo, type VisionLLM } from "../src/lib/pipeline/broll-critic.ts";

const root = process.cwd();
const clip = process.argv[2];
const concept = process.argv[3] ?? "a person in a realistic setting";
if (!clip || !existsSync(clip)) { console.error("usage: run-video-critic <clip.mp4> [concept]"); process.exit(2); }
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
const KEY = process.env.GEMINI_API_KEY!;
const genAI = new GoogleGenerativeAI(KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json", temperature: 0.2 } });
const FF = `${root}/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe`;

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { if (i === tries - 1) throw e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); } }
  throw new Error("x");
}

// vision call: send 3 frames spanning the clip
const frameVision: VisionLLM = async (clipPath, question) => {
  const parts: any[] = [{ text: question }];
  for (const t of [0.4, 2.0, 4.2]) {
    const tmp = `${root}/public/exports/sp-temp/_vc_${t}.png`;
    execFileSync(FF, ["-y", "-loglevel", "error", "-ss", String(t), "-i", clipPath, "-frames:v", "1", tmp]);
    parts.push({ inlineData: { mimeType: "image/png", data: readFileSync(tmp).toString("base64") } });
  }
  return (await withRetry(() => model.generateContent(parts))).response.text();
};

const verdict = await critiqueVideo(clip, { concept, style: "realistic_person", durationSec: 5 }, frameVision);
console.log(`\nVIDEO-CRITIC verdict for ${clip}:`);
console.log(`  approved: ${verdict.approved}`);
console.log(`  severity: ${verdict.severity}`);
console.log(`  issues:   ${verdict.issues.length ? verdict.issues.join(" | ") : "(none)"}`);
