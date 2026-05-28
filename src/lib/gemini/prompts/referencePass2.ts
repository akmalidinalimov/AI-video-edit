export function getReferencePass2Prompt(pass1Results: string): string {
  return `You are a professional video editor performing pixel-precise analysis of visual elements.

The video canvas is 1080×1920 pixels (9:16 vertical). All coordinates must be in this space.
(0,0) is top-left. (1080,1920) is bottom-right.

For each segment identified in this structure: ${pass1Results}

Analyze and extract:
1. A-roll (primary footage) element:
   - position: [x, y] in pixels from top-left
   - size: [width, height] in pixels
   - shape: "rectangle" | "circle"
   - border: { color: hex, width: pixels } or null
   - If shape is circle, size means diameter
   - Any animation (position change during segment)

2. B-roll (background/secondary footage) element:
   - position: [x, y]
   - size: [width, height]
   - crop: any visible cropping (e.g., top bar removal)
   - scroll/pan effect: { speed: px_per_second, direction: "up"|"down"|"left"|"right", max_offset: pixels }

3. Text overlays (ALL text visible on screen):
   - text content (exact text shown)
   - position: [x, y]
   - style: { font_weight, font_size_px, color_hex, background_color_hex_or_null }
   - animation: { type: "none"|"slide_up"|"slide_down"|"fade_in"|"pop"|"typewriter", start_offset_seconds }

4. Other elements: title bars, CTA buttons, icons, decorative shapes, gradients

Respond ONLY in JSON format with this structure for each segment:
{
  "segments": [
    {
      "id": "seg_1",
      "aroll": { "position": [x,y], "size": [w,h], "shape": "...", "border": {...}, "animation": {...} },
      "broll": { "position": [x,y], "size": [w,h], "crop": {...}, "scroll": {...} },
      "text_overlays": [ { "text": "...", "position": [x,y], "style": {...}, "animation": {...} } ],
      "other_elements": [ { "type": "title_bar"|"cta"|"icon"|"shape", "position": [x,y], "size": [w,h], "style": {...} } ]
    }
  ]
}`;
}
