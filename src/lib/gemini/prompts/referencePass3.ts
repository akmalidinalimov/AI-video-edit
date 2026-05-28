export const REFERENCE_PASS3_PROMPT = `You are analyzing the audio-visual synchronization of a reference video.

Transcribe ALL spoken words with precise timestamps.
For each visual change (B-roll swap, text appearance, layout change), note the exact timestamp.
Map which visual is playing during which spoken words/sentences.

Respond in JSON:
{
  "transcription": {
    "full_text": "complete transcription",
    "language": "uz" | "ru" | "en" | "mixed",
    "words": [
      { "word": "string", "start": seconds, "end": seconds }
    ],
    "sentences": [
      { "text": "full sentence", "start": seconds, "end": seconds }
    ]
  },
  "visual_events": [
    { "timestamp": seconds, "event": "broll_swap"|"text_appear"|"text_disappear"|"layout_change"|"pip_move", "description": "what changed" }
  ],
  "sync_map": [
    { "speech_start": seconds, "speech_end": seconds, "speech_text": "...", "visual_segment": "seg_1", "visual_description": "what's shown during this speech" }
  ]
}`;
