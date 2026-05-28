/**
 * Step 1.2 — Consolidated Reference Video Analysis Prompt
 *
 * Merges Pass 1 (structure) + Pass 3 (transcription/sync) into a single
 * Gemini call for efficiency. Pass 4 (style fingerprint) stays separate.
 */

export const REFERENCE_CONSOLIDATED_PROMPT = `You are an expert video editor analyzing a reference video to clone its editing style.

Analyze this video and extract BOTH its structure AND audio-visual synchronization in a single pass.

## PART 1: STRUCTURE ANALYSIS
1. Total duration (seconds, to 2 decimal places)
2. Identify each distinct visual segment. A segment boundary occurs when:
   - The LAYOUT changes (e.g., from vertical_split to pip_overlay)
   - The B-roll content changes significantly (new screen, new clip)
   - A major visual transition occurs
3. For each segment, determine:
   - Exact start_time and end_time (seconds, 2 decimal places)
   - Layout type used in that segment
   - Transition used to enter the segment

## PART 2: TRANSCRIPTION & SYNC
1. Transcribe ALL spoken words with precise timestamps
2. Group words into sentences with start/end times
3. For each visual change (B-roll swap, text appearance, layout change), note the exact timestamp
4. Map which visual segment is active during which spoken sentences

## LAYOUT TYPES (pick ONE per segment):
- "vertical_split": Screen divided vertically — typically black header area with text on top, talking head/A-roll in middle, B-roll on bottom. The A-roll and B-roll do NOT overlap.
- "pip_overlay": B-roll fills most/all of the screen, with A-roll as a smaller overlay (circle or rectangle PIP). A-roll is ON TOP of B-roll.
- "full_screen": Single source fills the entire screen (no split, no PIP)
- "side_by_side": Two sources placed horizontally next to each other

## CRITICAL RULES:
- Be precise with timestamps to 2 decimal places
- Each segment MUST have a unique sequential id: "seg_1", "seg_2", etc.
- Segments must be contiguous (no gaps between end of one and start of next)
- Words must be monotonically increasing in time (each word starts after the previous)
- Sentences should roughly align with natural speech pauses

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
      "transition_in": "none" | "cut" | "crossfade" | "slide_left" | "slide_right" | "zoom_in" | "zoom_out" | "wipe",
      "description": "brief description of what is shown in this segment"
    }
  ],
  "editing_rhythm": {
    "avg_segment_duration": number,
    "total_segments": number,
    "cut_style": "hard_cut" | "smooth_transition" | "mixed",
    "pacing": "fast" | "moderate" | "slow"
  },
  "transcription": {
    "full_text": "complete transcription of all spoken words",
    "language": "uz" | "ru" | "en" | "mixed",
    "words": [
      { "word": "string", "start": number, "end": number }
    ],
    "sentences": [
      { "text": "full sentence text", "start": number, "end": number, "semantic_tags": ["tag1", "tag2"] }
    ]
  },
  "visual_events": [
    { "timestamp": number, "event": "broll_swap" | "text_appear" | "text_disappear" | "layout_change" | "pip_move", "description": "what changed" }
  ],
  "sync_map": [
    { "speech_start": number, "speech_end": number, "speech_text": "...", "visual_segment": "seg_1" }
  ]
}`;
