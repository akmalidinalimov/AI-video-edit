/**
 * broll-cleanliness.mjs — the TEXT-ARTIFACT / cleanliness gate.
 *
 * Generation models render text as GIBBERISH, which looks unprofessional behind the
 * PIP. This gate samples frames from a generated clip and asks Gemini whether any
 * readable/gibberish on-screen text, UI, captions, watermark, or logo is present, and
 * how clean/professional the footage is. The orchestrator REJECTS (→ regen) any beat
 * that fails. This is the direct fix for the "blurry/gibberish text" complaint.
 *
 *   import { checkCleanliness } from "./broll-cleanliness.mjs";
 *   const r = await checkCleanliness(clipPath, { apiKey, ffmpegPath });
 *   // r = { clean: 0..100, hasText: bool, pass: bool, note }
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";

const PROMPT = `These frames are sampled across a single short B-ROLL clip meant to be CLEAN, professional, real-world cinematic footage with NO on-screen text or UI.
Judge ONLY whether the footage is clean and professional:
- Is there ANY readable OR gibberish/garbled on-screen TEXT, app/phone UI, captions, labels, buttons, watermark, or logo visible?
- Is the footage photorealistic and professional (good lighting/focus, believable), or does it have obvious AI artifacts (warped faces/hands, morphing, distortion)?
Return ONLY JSON: {"hasText": true|false, "clean": 0-100, "note": "<short reason>"}
"clean" = 100 means pristine real-world footage with zero text/UI and no artifacts; lower it for any text/UI (major penalty) or visible AI artifacts.`;

/**
 * @param {string} videoPath absolute or repo-relative path to the clip
 * @param {{apiKey:string, ffmpegPath:string, ffprobePath?:string, frames?:number, model?:string, threshold?:number, root?:string}} opts
 */
export async function checkCleanliness(videoPath, opts) {
  const { apiKey, ffmpegPath, ffprobePath, frames = 3, model = "gemini-2.5-flash", threshold = 70, root = process.cwd() } = opts;
  const abs = path.resolve(root, videoPath);
  // duration (probe if we can; else assume 8s and sample fixed offsets)
  let dur = 8;
  try {
    if (ffprobePath) {
      const raw = execFileSync(ffprobePath, ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", abs], { encoding: "utf-8" });
      dur = parseFloat(raw) || dur;
    }
  } catch {}

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bclean-"));
  const parts = [];
  for (let k = 0; k < frames; k++) {
    const t = dur * ((k + 1) / (frames + 1));
    const fp = path.join(tmp, `f${k}.jpg`);
    try {
      execFileSync(ffmpegPath, ["-y", "-ss", t.toFixed(2), "-i", abs, "-frames:v", "1", "-q:v", "3", fp], { stdio: "pipe" });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: fs.readFileSync(fp).toString("base64") } });
    } catch {}
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (!parts.length) return { clean: 0, hasText: true, pass: false, note: "no frames extracted" };

  const gen = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model, generationConfig: { temperature: 0.1, responseMimeType: "application/json" } });
  let parsed = null;
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    try {
      const res = await gen.generateContent([...parts, { text: PROMPT }]);
      parsed = JSON.parse(res.response.text());
    } catch {}
  }
  if (!parsed) return { clean: 0, hasText: true, pass: false, note: "gemini error" };
  const clean = Math.max(0, Math.min(100, parsed.clean ?? 0));
  const hasText = !!parsed.hasText;
  // A clip with ANY on-screen text fails outright; otherwise gate on the clean score.
  const pass = !hasText && clean >= threshold;
  return { clean, hasText, pass, note: parsed.note || "" };
}
