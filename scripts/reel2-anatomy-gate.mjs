/**
 * reel2-anatomy-gate.mjs — Gemini-vision anatomy/cleanliness gate for a character image.
 *
 * Reel-2 v2's bunny "Zig" came out with FOUR ears (a NanoBanana anatomy artifact). This gate
 * counts ears/eyes/limbs and flags artifacts so we can regenerate until the character is clean.
 * Mirrors the broll-cleanliness.mjs pattern (sample -> Gemini -> structured verdict).
 *
 * Usage:
 *   node scripts/reel2-anatomy-gate.mjs <image> <animal> [--expect-ears N]
 *   e.g. node scripts/reel2-anatomy-gate.mjs public/uploads/gen/reel2/zig-bunny.png rabbit
 * Prints JSON: { animal, ears, eyes, arms, legs, extraLimbs, artifacts, ok, note }
 * Exit 0 if ok (ears === expected, no extra limbs/artifacts), else exit 3.
 */
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

const ROOT = process.cwd();
const img = process.argv[2];
const animal = (process.argv[3] || "animal").toLowerCase();
const ei = process.argv.indexOf("--expect-ears");
const EXPECT_EARS = ei >= 0 ? Number(process.argv[ei + 1]) : 2;
if (!img) { console.error("usage: node scripts/reel2-anatomy-gate.mjs <image> <animal> [--expect-ears N]"); process.exit(1); }

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const p = path.join(ROOT, ".env.local");
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim();
  }
  return process.env.GEMINI_API_KEY;
}

const PROMPT = `You are an anatomy QA inspector for a cartoon ${animal} character image (a 3D Pixar/Zootopia-style render).
Count the VISIBLE anatomical parts CAREFULLY and report artifacts. A correct ${animal} has EXACTLY ${EXPECT_EARS} ears, 2 eyes, 2 arms, 2 legs — no duplicates, no extra/floating/ghost limbs or ears, no merged/melted/deformed parts, no extra fingers.
Look specifically for the common generation bug of DUPLICATE or EXTRA EARS (e.g. a second faint pair behind the main ears).
Return ONLY strict JSON:
{ "ears": <int, total distinct ears you can count>,
  "eyes": <int>, "arms": <int>, "legs": <int>,
  "extraLimbs": <int, count of any extra/floating/duplicate limbs or ears beyond normal>,
  "artifacts": "<short note of any deformity/duplication/melt, or '' if clean>",
  "ok": <true only if ears===${EXPECT_EARS} AND eyes===2 AND no extra limbs AND no artifacts>,
  "note": "<one-line summary>" }`;

async function main() {
  const key = loadKey(); if (!key) { console.error("No GEMINI_API_KEY"); process.exit(1); }
  const abs = path.resolve(ROOT, img);
  const b64 = fs.readFileSync(abs).toString("base64");
  const mime = abs.toLowerCase().endsWith(".jpg") || abs.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0, responseMimeType: "application/json" } });
  let j = null, lastErr = null;
  for (let r = 0; r < 4 && !j; r++) {
    try {
      const res = await model.generateContent([{ text: PROMPT }, { inlineData: { mimeType: mime, data: b64 } }]);
      j = JSON.parse(res.response.text());
    } catch (e) { lastErr = e; await new Promise(z => setTimeout(z, 3000 * (r + 1))); }
  }
  if (!j) { console.error("gate failed:", lastErr?.message); process.exit(1); }
  // enforce expectation locally too (don't fully trust the model's ok field)
  const ok = j.ears === EXPECT_EARS && (j.eyes === 2 || j.eyes == null) && (j.extraLimbs || 0) === 0 && (!j.artifacts || j.artifacts.trim() === "");
  const out = { animal, expectEars: EXPECT_EARS, ...j, ok };
  console.log(JSON.stringify(out, null, 2));
  process.exit(ok ? 0 : 3);
}
main().catch(e => { console.error(e); process.exit(1); });
