/**
 * _shared.mjs — helper every GENERATED-beat strategy uses to call the director model.
 * Injects the shared HOUSE_RULES so each strategy only adds its own focused guidance.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { HOUSE_RULES } from "../contract.mjs";

export const BEAT_SCHEMA = `Output STRICT JSON only (no markdown):
{ "productMode": "variety|identity|none",
  "reframeNote": "<if you reframed any screen/app/text concept to real-world, say how; else ''>",
  "beats": [ { "order": 0, "kind": "generated", "concept": "<short label>",
    "model": "kling3_0|seedance_2_0", "durationSec": 2.5-3.5,
    "cameraMotion": "<one camera move>", "continuityNote": "<shared with prev beat; '' for first>",
    "prompt": "<one flowing renderable paragraph per the house rules>" } ] }`;

export async function callDirector(systemExtra, user, { apiKey, model = "gemini-2.5-pro" } = {}) {
  const gen = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model,
    systemInstruction: HOUSE_RULES + "\n\n" + systemExtra,
    generationConfig: { temperature: 0.35, responseMimeType: "application/json" },
  });
  let parsed = null, err;
  for (let i = 0; i < 3 && !parsed; i++) {
    try { parsed = JSON.parse((await gen.generateContent(user)).response.text()); } catch (e) { err = e; }
  }
  if (!parsed) throw new Error("director call failed: " + (err?.message || ""));
  return parsed;
}

export const beatHint = (neededDur) => (neededDur <= 3.6 ? 1 : Math.min(3, Math.max(2, Math.round(neededDur / 3))));
