/**
 * Transcribe A-roll audio using Gemini to get accurate word-level timestamps.
 * This replaces the reference video's transcription (which has different timing).
 *
 * Usage: node scripts/transcribe-aroll.mjs
 */
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

const ROOT = process.cwd();

// Load .env.local
if (!process.env.GEMINI_API_KEY) {
  const envPath = path.join(ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  }
}

const AUDIO_PATH = path.join(ROOT, "public", "exports", "sp-temp", "aroll-audio.mp3");
const OUTPUT_PATH = path.join(ROOT, "public", "exports", "sp-temp", "aroll-transcription.json");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

async function main() {
  console.log("Transcribing A-roll audio with Gemini...\n");

  const audioBase64 = fs.readFileSync(AUDIO_PATH).toString("base64");

  const prompt = `You are a precise speech-to-text transcription engine.

Transcribe this audio file with EXACT word-level timestamps.

The speaker is speaking in Uzbek. The audio is approximately 23 seconds long.

CRITICAL INSTRUCTIONS:
- Provide timestamps for EVERY word
- Timestamps must be in SECONDS (decimal, e.g., 2.35)
- Start time = when the word begins being spoken
- End time = when the word finishes being spoken
- Be as precise as possible — even 0.1s matters for video editing
- Group words into sentences (a sentence ends with a period, question mark, or exclamation mark)

Return JSON in this EXACT format:
{
  "words": [
    { "word": "example", "start": 0.0, "end": 0.5 },
    ...
  ],
  "sentences": [
    { "text": "Full sentence text.", "start": 0.0, "end": 3.5 },
    ...
  ]
}

Return ONLY the JSON, no markdown fences, no explanation.`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: "audio/mpeg", data: audioBase64 } },
  ];

  for (let retry = 0; retry < 3; retry++) {
    try {
      const result = await model.generateContent(parts);
      const text = result.response.text();
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const data = JSON.parse(cleaned);

      console.log(`Words: ${data.words.length}`);
      console.log(`Sentences: ${data.sentences.length}\n`);

      for (const s of data.sentences) {
        const preview = s.text.length > 70 ? s.text.slice(0, 67) + "..." : s.text;
        console.log(`  [${s.start.toFixed(2)}-${s.end.toFixed(2)}s] "${preview}"`);
      }

      console.log("\nWord-level detail (first 15 words):");
      for (const w of data.words.slice(0, 15)) {
        console.log(`  ${w.start.toFixed(2)}-${w.end.toFixed(2)}s: "${w.word}"`);
      }

      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
      console.log(`\nSaved: ${OUTPUT_PATH}`);
      return data;
    } catch (err) {
      console.error(`  Attempt ${retry + 1} failed:`, err.message?.substring(0, 200));
      if (retry < 2) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  console.error("All transcription attempts failed");
  process.exit(1);
}

main().catch(console.error);
