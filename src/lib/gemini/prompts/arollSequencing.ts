export function buildSequencingPrompt(
  clips: { id: string; fileName: string; summary: string; transcription: string; duration: number }[]
): string {
  const clipDescriptions = clips
    .map(
      (c, i) =>
        `--- CLIP ${i + 1} (id: "${c.id}", file: "${c.fileName}", duration: ${c.duration.toFixed(1)}s) ---
SUMMARY: ${c.summary}
FULL TRANSCRIPTION:
${c.transcription}
---`
    )
    .join("\n\n");

  return `You are sequencing ${clips.length} A-roll talking head video clips into the correct narrative order.

These clips were recorded as parts of one continuous message but uploaded separately. Your job is to figure out the CORRECT ORDER so the meaning flows naturally when played back-to-back.

CLIPS:
${clipDescriptions}

SEQUENCING RULES:
1. READ THE TRANSCRIPTIONS CAREFULLY — what is being said is the primary signal
2. Look for discourse markers: "first", "next", "now", "so", "finally", "as I mentioned", "let me show you", "to recap", etc.
3. Look for topic progression: introduction → explanation → details → conclusion
4. Look for references between clips: "as we saw earlier", "building on that", "the next step"
5. Look for greeting/intro language (likely first) and closing/summary language (likely last)
6. Consider emotional arc: opening energy → main content → conclusion
7. If visual context helps (e.g., the speaker references something visible), use it as a secondary signal

Respond in JSON:
{
  "sequence": [
    {
      "clip_id": "the clip id",
      "position": 1,
      "reasoning": "Why this clip goes here — what in the transcription signals this position"
    }
  ],
  "narrative_summary": "Brief description of the overall narrative arc across all clips",
  "confidence": 0.0-1.0
}`;
}
