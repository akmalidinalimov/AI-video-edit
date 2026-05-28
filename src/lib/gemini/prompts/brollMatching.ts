import type { ContentSegment } from "@/lib/matching/segmenter";
import type { BRollCatalogEntry } from "@/lib/types/project";

export function buildMatchingPrompt(
  segments: ContentSegment[],
  brollCatalog: BRollCatalogEntry[]
): string {
  const segDesc = segments
    .map(
      (s) =>
        `SEGMENT "${s.id}" (${s.globalStart.toFixed(1)}–${s.globalEnd.toFixed(1)}s, ${s.duration.toFixed(1)}s):
  Speech: "${s.text}"
  Tags: [${s.semanticTags.join(", ")}]
  Mood: ${s.mood}`
    )
    .join("\n\n");

  const brollDesc = brollCatalog
    .map(
      (b) =>
        `BROLL "${b.id}" (${b.classification}, ${b.duration ? b.duration.toFixed(1) + "s" : "image"}):
  Summary: ${b.content_summary}
  Tags: [${b.semantic_tags.join(", ")}]
  Quality: ${b.quality_score}/10
  Best use: ${b.best_use}`
    )
    .join("\n\n");

  return `You are matching B-roll footage to A-roll speech segments for a video edit.
The B-roll is a screen recording / demo video showing steps in an app.
Each speech segment should show a DIFFERENT portion of the B-roll that visually matches what is being discussed.

CONTENT SEGMENTS (what the speaker says):
${segDesc}

AVAILABLE B-ROLL ASSETS:
${brollDesc}

CRITICAL MATCHING RULES:
1. Match B-roll to segments based on SEMANTIC RELEVANCE — what the speaker is talking about should match what the B-roll shows
2. EVERY segment MUST have a different broll_start time — NO repetition. Each segment must show a DIFFERENT part of the video.
3. broll_start times MUST increase across segments (show the B-roll in order, like "steps" in a tutorial)
4. For a ${segments.length}-segment video using a single B-roll source:
   - Divide the B-roll video into ${segments.length} roughly equal chunks
   - Assign each chunk's start time to the corresponding segment
   - Example for a 30s B-roll: seg0→0s, seg1→5s, seg2→10s, seg3→15s, seg4→20s, seg5→25s
5. broll_start AND broll_end MUST be specified for every segment (never null)
6. Time ranges must NOT overlap between segments
7. Prefer higher quality_score B-roll when multiple options fit
8. If NO B-roll fits a segment, set selected_broll to "NONE" (avoid this — always try to match)
9. match_score: 0.0–1.0, where 1.0 = perfect semantic match, 0.5 = loosely related

Respond in JSON:
{
  "matches": [
    {
      "segment_id": "seg_0",
      "selected_broll": "broll_id or NONE",
      "match_reason": "Why this B-roll portion fits this speech segment",
      "match_score": 0.0-1.0,
      "broll_start": seconds (REQUIRED, different for each segment),
      "broll_end": seconds (REQUIRED),
      "alternative_brolls": ["broll_id2"],
      "missing_asset_description": null or "description of what asset would be ideal"
    }
  ]
}`;
}
