import { GoogleAIFileManager } from "@google/generative-ai/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = "AIzaSyCOFv8CC0gKgkpghkAqYG4aDUINEsAUvkw";
const fm = new GoogleAIFileManager(API_KEY);
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
});

async function main() {
  console.log("Uploading reference video (IMG_6018.MOV)...");
  const result = await fm.uploadFile("C:/Users/akmal/Desktop/IMG_6018.MOV", {
    mimeType: "video/quicktime",
    displayName: "reference-video",
  });
  console.log("Upload done:", result.file.name, "state:", result.file.state);

  let file = result.file;
  while (file.state === "PROCESSING") {
    console.log("Processing...");
    await new Promise((r) => setTimeout(r, 3000));
    file = await fm.getFile(file.name);
  }
  console.log("File ready. State:", file.state);
  console.log("URI:", file.uri);

  const prompt = `You are a professional video editor analyzing a reference video for style cloning.

Analyze this video and extract its STRUCTURE:
1. Total duration (seconds, to 2 decimal places)
2. Number of distinct visual segments (a segment changes when the layout changes)
3. For each segment: start_time and end_time, layout type, transition type.
4. Overall editing rhythm.

Respond ONLY in JSON:
{
  "duration": number,
  "fps": number,
  "resolution": "WIDTHxHEIGHT",
  "segments": [
    {
      "id": "seg_1",
      "start": number,
      "end": number,
      "layout": "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side",
      "transition_in": "none" | "cut" | "crossfade" | "slide_left" | "slide_right" | "zoom_in" | "zoom_out" | "wipe",
      "description": "brief description of what is shown"
    }
  ],
  "editing_rhythm": {
    "avg_segment_duration": number,
    "total_segments": number,
    "cut_style": "hard_cut" | "smooth_transition" | "mixed",
    "pacing": "fast" | "moderate" | "slow"
  }
}`;

  console.log("\nRunning Pass 1 (Structure Scan)...");
  const response = await model.generateContent([
    { text: prompt },
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ]);

  const text = response.response.text();
  console.log("\n=== PASS 1 RESULT ===");
  console.log(text);

  const parsed = JSON.parse(text);
  console.log("\nParsed successfully. Segments:", parsed.segments?.length);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
