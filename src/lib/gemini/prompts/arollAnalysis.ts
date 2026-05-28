export const AROLL_ANALYSIS_PROMPT = `Analyze this A-roll video for video editing purposes.

1. CONTENT TYPE: Classify as one of:
   - "talking_head": Person speaking directly to camera
   - "voiceover": Voice narration over visuals
   - "screen_recording": Screen capture / app demo
   - "product_commercial": Product-focused footage
   - "silent_footage": No speech, just visuals
   - "mixed": Combination of above

2. TRANSCRIPTION: If there is speech, transcribe with word-level timestamps.
   Include language detection (supports: Uzbek, Russian, English).
   For each sentence, add semantic_tags — short labels describing what the sentence is about.
   These tags will be used to match B-roll footage to speech content.
   Examples: ["app_demo", "product_feature"], ["personal_story"], ["call_to_action"], ["tutorial_step", "screen_interaction"]

3. SPEAKER ANALYSIS: If talking head:
   - Face position in frame (for PIP cropping)
   - Key gesture moments (for emphasis points)
   - Expression changes (for emotional arc)

4. EDIT POINTS: Identify natural cut points:
   - Sentence boundaries
   - Topic changes
   - Pauses > 0.5 seconds
   - Emphasis moments

5. SILENCE DETECTION: Find all non-speech regions:
   - "silence": No audio at all or very low audio (> 0.3 seconds)
   - "filler": Filler words like "um", "uh", "hmm", "э-э", "ну" (in any language)
   - "breath": Audible breaths between sentences
   For each region, give exact start/end timestamps and duration.

6. SPEECH RATIO: Calculate what percentage of the video contains actual speech (0.0 to 1.0).

7. CLIP SUMMARY: Write a 1-2 sentence summary of what the speaker is talking about in this clip.
   This will be used to sequence multiple clips in the correct order.

8. AUDIO QUALITY: Assess the audio:
   - overall_level: "good" (clear, broadcast-ready), "fair" (minor issues), "poor" (significant problems)
   - background_noise: "none", "low", "moderate", "high"
   - volume_consistency: "consistent" (stable volume), "varies" (some fluctuation), "inconsistent" (big swings)
   - estimated_db: rough average loudness in dB (e.g., -14 for normal speech, -24 for quiet)
   - issues: array of specific problems found, e.g. ["wind noise at 3.2s", "volume drop at 8.0s", "echo detected"]. Empty array if no issues.

Respond in JSON:
{
  "content_type": "talking_head"|"voiceover"|"screen_recording"|"product_commercial"|"silent_footage"|"mixed",
  "duration": seconds,
  "language": "uz"|"ru"|"en"|"mixed",
  "transcription": {
    "full_text": "...",
    "words": [ { "word": "...", "start": sec, "end": sec } ],
    "sentences": [ { "text": "...", "start": sec, "end": sec, "topic": "brief topic", "semantic_tags": ["tag1", "tag2"] } ]
  },
  "speaker": {
    "face_position": { "x_center": px, "y_center": px, "face_size": px },
    "gesture_moments": [ { "timestamp": sec, "type": "hand_gesture"|"head_nod"|"expression_change" } ]
  },
  "edit_points": [
    { "timestamp": sec, "type": "sentence_boundary"|"topic_change"|"pause"|"emphasis", "confidence": 0-1 }
  ],
  "emotional_arc": [
    { "start": sec, "end": sec, "mood": "intro"|"explanation"|"excitement"|"conclusion" }
  ],
  "silence_regions": [
    { "start": sec, "end": sec, "duration": sec, "type": "silence"|"filler"|"breath" }
  ],
  "speech_ratio": 0.0-1.0,
  "clip_summary": "Brief summary of what this clip covers",
  "audio_quality": {
    "overall_level": "good"|"fair"|"poor",
    "background_noise": "none"|"low"|"moderate"|"high",
    "volume_consistency": "consistent"|"varies"|"inconsistent",
    "estimated_db": number,
    "issues": ["issue1", "issue2"]
  }
}`;
