export const REFERENCE_PASS4_PROMPT = `Based on all the analysis of this reference video, create a comprehensive STYLE FINGERPRINT.

This fingerprint will be used to apply the same editing style to completely different content.
Focus on HOW things are presented, not WHAT is presented.

Extract:
1. Color grade: brightness, saturation, contrast adjustments visible in the video
2. PIP style: shape, typical size, border style, shadow, typical positions
3. Text style: font characteristics, color palette, typical sizes, animation preferences
4. Editing rhythm: how long segments last, transition preferences, pacing
5. B-roll treatment: scroll/pan speed, crop style, overlay opacity
6. Overall mood: professional, casual, energetic, educational, etc.

Respond in JSON:
{
  "color_grade": { "brightness": number, "saturation": number, "contrast": number, "temperature": "warm"|"neutral"|"cool" },
  "pip_style": { "shape": "circle"|"rectangle", "typical_size": pixels, "border": {...}, "shadow": "css_shadow_string", "preferred_positions": [[x,y], ...] },
  "text_style": { "primary_font_weight": "bold"|"normal", "title_size_range": [min, max], "body_size_range": [min, max], "color_palette": ["#hex", ...], "animation_preference": "slide"|"fade"|"pop"|"none" },
  "editing_rhythm": { "avg_segment_duration": seconds, "cut_frequency": "fast"|"moderate"|"slow", "transition_preference": "hard_cut"|"crossfade"|"mixed" },
  "broll_treatment": { "scroll_speed_range": [min, max], "crop_style": "full"|"zoomed"|"panned", "overlay_opacity": number },
  "mood": "professional"|"casual"|"energetic"|"educational"|"cinematic"
}`;
