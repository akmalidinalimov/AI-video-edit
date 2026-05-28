import { GoogleAIFileManager } from "@google/generative-ai/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { writeFileSync } from "fs";

const API_KEY = "AIzaSyCOFv8CC0gKgkpghkAqYG4aDUINEsAUvkw";
const fm = new GoogleAIFileManager(API_KEY);
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
});

async function uploadAndWait(filePath, mimeType, displayName) {
  console.log(`  Uploading ${displayName}...`);
  const result = await fm.uploadFile(filePath, { mimeType, displayName });
  let file = result.file;
  while (file.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 2000));
    file = await fm.getFile(file.name);
  }
  if (file.state === "FAILED") throw new Error(`File processing failed: ${displayName}`);
  console.log(`  Ready: ${file.uri}`);
  return file;
}

async function analyzeReference(file) {
  console.log("\n=== REFERENCE ANALYSIS (4 passes) ===");

  // Pass 1
  console.log("\nPass 1 — Structure Scan...");
  const p1 = await model.generateContent([
    { text: `You are a professional video editor analyzing a reference video for style cloning.

Analyze this video and extract its STRUCTURE:
1. Total duration (seconds, to 2 decimal places)
2. Number of distinct visual segments (a segment changes when the layout changes)
3. For each segment: start_time and end_time (seconds), layout type: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side", transition type entering this segment: "none" | "cut" | "crossfade" | "slide_left" | "slide_right" | "zoom_in" | "zoom_out" | "wipe"
4. Overall editing rhythm: average segment duration, cut frequency

Respond ONLY in JSON format:
{
  "duration": number,
  "fps": number,
  "resolution": "WIDTHxHEIGHT",
  "segments": [{ "id": "seg_1", "start": number, "end": number, "layout": string, "transition_in": string, "description": string }],
  "editing_rhythm": { "avg_segment_duration": number, "total_segments": number, "cut_style": "hard_cut"|"smooth_transition"|"mixed", "pacing": "fast"|"moderate"|"slow" }
}` },
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ]);
  const pass1 = JSON.parse(p1.response.text());
  console.log(`  Found ${pass1.segments.length} segments, duration: ${pass1.duration}s`);

  // Pass 2
  console.log("\nPass 2 — Visual Element Mapping...");
  const p2 = await model.generateContent([
    { text: `You are a professional video editor performing pixel-precise analysis of visual elements.

The video canvas is 1080×1920 pixels (9:16 vertical). All coordinates must be in this space.
(0,0) is top-left. (1080,1920) is bottom-right.

For each segment identified in this structure: ${JSON.stringify(pass1)}

Analyze and extract:
1. A-roll element: position [x,y], size [w,h], shape "rectangle"|"circle", border, animation
2. B-roll element: position, size, crop, scroll/pan effect
3. Text overlays: text content, position, style, animation
4. Other elements: title bars, CTA buttons, icons

Respond ONLY in JSON:
{
  "segments": [{
    "id": "seg_1",
    "aroll": { "position": [x,y], "size": [w,h], "shape": "circle"|"rectangle", "border": {"color":"#hex","width":px}|null, "animation": null },
    "broll": { "position": [x,y], "size": [w,h], "crop": null, "scroll": {"speed":px_per_sec,"direction":"up"|"down","max_offset":px}|null },
    "text_overlays": [{ "text": "...", "position": [x,y], "style": {"fontSize":px,"fontWeight":"bold"|"normal","color":"#hex","backgroundColor":"#hex"|null}, "animation": null }],
    "other_elements": []
  }]
}` },
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ]);
  const pass2 = JSON.parse(p2.response.text());
  console.log(`  Mapped ${pass2.segments.length} segments with visual elements`);

  // Pass 3
  console.log("\nPass 3 — Audio-Visual Sync...");
  const p3 = await model.generateContent([
    { text: `You are analyzing the audio-visual synchronization of a reference video.

Transcribe ALL spoken words with precise timestamps.
For each visual change, note the exact timestamp.
Map which visual is playing during which spoken words.

Respond in JSON:
{
  "transcription": {
    "full_text": "complete transcription",
    "language": "uz"|"ru"|"en"|"mixed",
    "words": [{ "word": "string", "start": seconds, "end": seconds }],
    "sentences": [{ "text": "full sentence", "start": seconds, "end": seconds }]
  },
  "visual_events": [{ "timestamp": seconds, "event": "broll_swap"|"text_appear"|"layout_change", "description": "what changed" }],
  "sync_map": [{ "speech_start": seconds, "speech_end": seconds, "speech_text": "...", "visual_segment": "seg_1", "visual_description": "what is shown" }]
}` },
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ]);
  const pass3 = JSON.parse(p3.response.text());
  console.log(`  Language: ${pass3.transcription.language}, Words: ${pass3.transcription.words.length}, Sentences: ${pass3.transcription.sentences.length}`);

  // Pass 4
  console.log("\nPass 4 — Style Fingerprint...");
  const p4 = await model.generateContent([
    { text: `Based on all the analysis of this reference video, create a comprehensive STYLE FINGERPRINT.
Focus on HOW things are presented, not WHAT is presented.

Respond in JSON:
{
  "color_grade": { "brightness": number, "saturation": number, "contrast": number, "temperature": "warm"|"neutral"|"cool" },
  "pip_style": { "shape": "circle"|"rectangle", "typical_size": pixels, "border": {"color":"#hex","width":px}, "shadow": "css_shadow_string", "preferred_positions": [[x,y]] },
  "text_style": { "primary_font_weight": "bold"|"normal", "title_size_range": [min,max], "body_size_range": [min,max], "color_palette": ["#hex"], "animation_preference": "slide"|"fade"|"pop"|"none" },
  "editing_rhythm": { "avg_segment_duration": seconds, "cut_frequency": "fast"|"moderate"|"slow", "transition_preference": "hard_cut"|"crossfade"|"mixed" },
  "broll_treatment": { "scroll_speed_range": [min,max], "crop_style": "full"|"zoomed"|"panned", "overlay_opacity": number },
  "mood": "professional"|"casual"|"energetic"|"educational"|"cinematic"
}` },
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ]);
  const pass4 = JSON.parse(p4.response.text());
  console.log(`  Mood: ${pass4.mood}, PIP: ${pass4.pip_style.shape} ${pass4.pip_style.typical_size}px`);

  return { pass1, pass2, pass3, pass4 };
}

async function analyzeAroll(file) {
  console.log("\n=== A-ROLL ANALYSIS ===");
  const result = await model.generateContent([
    { text: `Analyze this A-roll video for video editing purposes.

1. CONTENT TYPE: "talking_head"|"voiceover"|"screen_recording"|"product_commercial"|"silent_footage"|"mixed"
2. TRANSCRIPTION: Transcribe with word-level timestamps. Detect language (Uzbek, Russian, English).
3. SPEAKER ANALYSIS: Face position, gesture moments
4. EDIT POINTS: sentence boundaries, topic changes, pauses > 0.5s

Respond in JSON:
{
  "content_type": string,
  "duration": seconds,
  "language": "uz"|"ru"|"en"|"mixed",
  "transcription": { "full_text": "...", "words": [{"word":"...","start":sec,"end":sec}], "sentences": [{"text":"...","start":sec,"end":sec,"topic":"..."}] },
  "speaker": { "face_position": {"x_center":px,"y_center":px,"face_size":px}, "gesture_moments": [{"timestamp":sec,"type":"hand_gesture"|"head_nod"|"expression_change"}] },
  "edit_points": [{"timestamp":sec,"type":"sentence_boundary"|"topic_change"|"pause"|"emphasis","confidence":0.0}],
  "emotional_arc": [{"start":sec,"end":sec,"mood":"intro"|"explanation"|"excitement"|"conclusion"}]
}` },
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ]);
  const analysis = JSON.parse(result.response.text());
  console.log(`  Type: ${analysis.content_type}, Language: ${analysis.language}, Duration: ${analysis.duration}s`);
  console.log(`  Sentences: ${analysis.transcription.sentences.length}, Edit points: ${analysis.edit_points.length}`);
  return analysis;
}

async function analyzeBroll(file) {
  console.log("\n=== B-ROLL ANALYSIS ===");
  const result = await model.generateContent([
    { text: `Analyze this B-roll asset (video) for use in a short-form video edit. Output video is 1080×1920 (9:16 vertical).

Analyze: content, classification, quality score, visible text, dominant colors, duration, usable segments, camera motion, crop recommendation, semantic tags, best use.

Respond in JSON:
{
  "type": "video",
  "content_summary": "detailed description",
  "classification": "product_shot"|"screenshot"|"app_demo"|"lifestyle"|"text_graphic"|"illustration"|"stock_footage"|"behind_scenes"|"other",
  "quality_score": 0-100,
  "visible_text": ["text found"],
  "dominant_colors": ["#hex1","#hex2","#hex3"],
  "duration": seconds,
  "usable_segments": [{"start":sec,"end":sec,"description":"..."}],
  "camera_motion": "static"|"pan"|"zoom"|"handheld"|null,
  "crop_recommendation": { "strategy": "scale_to_fill"|"scale_to_fit"|"crop_center"|"crop_custom", "crop": {"x":px,"y":px,"width":px,"height":px}, "notes": "..." },
  "semantic_tags": ["tag1","tag2"],
  "best_use": "background_scroll"|"full_screen"|"split_screen"|"overlay"
}` },
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ]);
  const catalog = JSON.parse(result.response.text());
  console.log(`  Classification: ${catalog.classification}, Quality: ${catalog.quality_score}/100`);
  console.log(`  Best use: ${catalog.best_use}, Tags: ${catalog.semantic_tags.join(", ")}`);
  return catalog;
}

async function main() {
  console.log("StyleClone v2.0 — Full Pipeline Test\n");

  // Upload all 3 files in parallel
  console.log("Uploading all 3 files...");
  const [refFile, arollFile, brollFile] = await Promise.all([
    uploadAndWait("C:/Users/akmal/Desktop/IMG_6018.MOV", "video/quicktime", "reference"),
    uploadAndWait("C:/Users/akmal/Desktop/IMG_6108.MOV", "video/quicktime", "aroll"),
    uploadAndWait("C:/Users/akmal/Desktop/IMG_6163.MP4", "video/mp4", "broll"),
  ]);

  // Run analyses
  const refResult = await analyzeReference(refFile);
  const arollResult = await analyzeAroll(arollFile);
  const brollResult = await analyzeBroll(brollFile);

  // Save results
  const allResults = {
    reference: refResult,
    aroll: arollResult,
    broll: brollResult,
    timestamp: new Date().toISOString(),
  };
  writeFileSync("test-results.json", JSON.stringify(allResults, null, 2));
  console.log("\n=== ALL RESULTS SAVED to test-results.json ===");
  console.log("Pipeline test complete!");
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
