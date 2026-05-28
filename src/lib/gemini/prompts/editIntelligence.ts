import type { ContentSegment } from "@/lib/matching/segmenter";
import type { MatchResult } from "@/lib/types/project";

export function buildEditIntelligencePrompt(
  segments: ContentSegment[],
  matches: MatchResult[],
  refTransitions: string[],
  colorTemperature: string
): string {
  const segDesc = segments.map((s, i) => {
    const match = matches.find((m) => m.segment_id === s.id);
    const prevSeg = i > 0 ? segments[i - 1] : null;
    const topicChange = prevSeg && prevSeg.mood !== s.mood;

    return `SEGMENT ${i + 1} "${s.id}" (${s.globalStart.toFixed(1)}–${s.globalEnd.toFixed(1)}s):
  Speech: "${s.text.slice(0, 120)}"
  Tags: [${s.semanticTags.join(", ")}]
  Mood: ${s.mood}
  Has B-roll: ${match?.selected_broll !== "NONE" ? "YES" : "NO — MISSING"}
  ${match?.selected_broll === "NONE" ? `Missing because: ${match?.match_reason}` : ""}
  ${topicChange ? "⚠ TOPIC CHANGE from previous segment" : "Continues previous topic"}`;
  }).join("\n\n");

  return `You are an AI video editor making decisions for a 9:16 vertical short-form video (Instagram Reels / TikTok / YouTube Shorts).

The reference video used these transitions: [${refTransitions.join(", ")}]
Color temperature: ${colorTemperature}

CONTENT SEGMENTS:
${segDesc}

Make THREE decisions:

1. TRANSITIONS: For each segment, decide the transition_in type based on content flow:
   - "none": Same topic continues, hard cut
   - "fade": Topic ending or conclusion
   - "slide_up" / "slide_down": New topic introduction
   - "zoom_in": Emphasis or reveal moment
   - "dissolve": Mood shift
   Prefer transitions the reference video uses. Keep it consistent — don't overuse fancy transitions.

2. ENGAGEMENT HOOK: Design a 1.5-2 second hook for the FIRST FRAME of the video.
   The hook determines whether viewers keep watching. Design based on what the content is about.
   Types:
   - "text": A bold text question or statement (e.g., "Want to know why...?", "3 mistakes you're making")
   - "question": A direct question to the viewer
   - "visual": A text tease of the most interesting part of the content

3. MISSING ASSET PROMPTS: For segments with NO B-roll match, generate a prompt for AI image generation.
   Include: subject, composition, style, mood, colors. Keep it specific and visual.
   Style should match the color temperature: ${colorTemperature}.

Respond in JSON:
{
  "transitions": [
    {
      "segment_id": "seg_0",
      "transition_in": "none"|"fade"|"slide_up"|"slide_down"|"zoom_in"|"dissolve",
      "transition_duration_frames": 6-12,
      "reasoning": "brief reason"
    }
  ],
  "hook": {
    "type": "text"|"question"|"visual",
    "text": "The hook text shown to viewer",
    "animation": "pop"|"slide_up"|"typewriter"|"fade_in"
  },
  "missing_asset_prompts": [
    {
      "segment_id": "seg_X",
      "imagen_prompt": "Detailed image generation prompt",
      "style_guidance": "photorealistic / illustration / abstract / screenshot mockup",
      "suggested_type": "photo"|"illustration"|"abstract"|"screenshot_mockup"
    }
  ]
}`;
}
