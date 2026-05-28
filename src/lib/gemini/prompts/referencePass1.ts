export const REFERENCE_PASS1_PROMPT = `You are a professional video editor analyzing a reference video for style cloning.

Analyze this video and extract its STRUCTURE:
1. Total duration (seconds, to 2 decimal places)
2. Number of distinct visual segments (a segment changes when the layout changes)
3. For each segment:
   - start_time and end_time (seconds)
   - layout type: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side"
   - transition type entering this segment: "none" | "cut" | "crossfade" | "slide_left" | "slide_right" | "zoom_in" | "zoom_out" | "wipe"
4. Overall editing rhythm: average segment duration, cut frequency

Respond ONLY in this exact JSON format:
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
      "transition_in": string,
      "description": "brief description of what's shown"
    }
  ],
  "editing_rhythm": {
    "avg_segment_duration": number,
    "total_segments": number,
    "cut_style": "hard_cut" | "smooth_transition" | "mixed",
    "pacing": "fast" | "moderate" | "slow"
  }
}`;
