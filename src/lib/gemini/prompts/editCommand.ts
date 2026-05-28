import type { TimelineDefinition } from "@/lib/types/timeline";

export function buildEditCommandPrompt(
  userMessage: string,
  timeline: TimelineDefinition
): string {
  const segmentSummary = timeline.segments.map((s, i) => {
    const durSec = ((s.end_frame - s.start_frame) / timeline.fps).toFixed(1);
    return `  Segment ${i + 1} (${s.id}): ${durSec}s, layout=${s.layout}, broll=${s.broll.src || "none"}, pip=${s.aroll ? "yes" : "no"}, motion=${s.broll.motion?.type ?? "none"}`;
  }).join("\n");

  const captionInfo = `${timeline.captions.lines.length} caption lines, style: fontSize=${timeline.captions.style.fontSize}, color=${timeline.captions.style.color}, highlight=${timeline.captions.style.highlightColor}`;

  const hookInfo = timeline.hook
    ? `Hook: "${timeline.hook.text}" (${timeline.hook.type}, ${timeline.hook.animation.type})`
    : "No hook";

  return `You are a video editing assistant for a 1080×1920 vertical short-form video editor.

Current timeline has ${timeline.segments.length} segments, ${timeline.duration.toFixed(1)}s total, ${timeline.fps}fps.

Segments:
${segmentSummary}

Captions: ${captionInfo}
${hookInfo}
Color grade: temperature=${timeline.color_grade.temperature}, saturation=${timeline.color_grade.saturation}, contrast=${timeline.color_grade.contrast}

The user wants to modify the edit. Parse their request into structured edit commands.

User message: "${userMessage}"

Respond with a JSON object:
{
  "commands": [
    {
      "type": "swap_broll" | "resize_pip" | "move_pip" | "change_layout" | "update_caption_style" | "change_transition" | "toggle_hook" | "adjust_timing" | "change_color_grade" | "update_text" | "toggle_layer" | "adjust_speed",
      "segmentId": "segment_id or null for global",
      "params": { ... command-specific parameters ... },
      "description": "Human-readable description of what this command does"
    }
  ],
  "reply": "Natural language response to the user explaining what changes will be made"
}

Command params by type:
- swap_broll: { "newBrollId": string } or { "action": "remove" }
- resize_pip: { "size": number } (in pixels, default 280)
- move_pip: { "position": [x, y] } (in 1080×1920 coordinates)
- change_layout: { "layout": "full_screen" | "pip_overlay" | "vertical_split" | "side_by_side" }
- update_caption_style: { "fontSize"?: number, "color"?: string, "highlightColor"?: string, "position"?: [x, y] }
- change_transition: { "type": "fade" | "slide_left" | "slide_right" | "slide_up" | "zoom" | "dissolve" | "none", "durationFrames"?: number }
- toggle_hook: { "enabled": boolean, "text"?: string, "animation"?: "pop" | "slide_up" | "typewriter" | "fade_in" }
- adjust_timing: { "action": "extend" | "shorten", "frames": number }
- change_color_grade: { "temperature"?: "warm" | "neutral" | "cool", "saturation"?: number, "contrast"?: number, "brightness"?: number }
- update_text: { "text": string }
- toggle_layer: { "layer": "broll" | "pip" | "captions" | "hook" | "grain" | "vignette" | "progress_bar", "visible": boolean }
- adjust_speed: { "speed": number } (1.0 = normal, 0.85 = slow, 1.3 = fast)

If the request is ambiguous or doesn't map to an edit command, return empty commands array and explain in reply.
If the request mentions "all segments" or is global, set segmentId to null.
Return ONLY the JSON object, no markdown or extra text.`;
}
