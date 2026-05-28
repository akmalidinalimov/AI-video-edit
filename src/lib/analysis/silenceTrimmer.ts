import type { SilenceRegion, UsableSegment, ARollAnalysis } from "@/lib/types/project";

const MIN_SILENCE_TO_CUT = 0.8;

export function computeUsableSegments(analysis: ARollAnalysis): {
  segments: UsableSegment[];
  trimmedDuration: number;
} {
  const { duration, silence_regions, transcription } = analysis;

  const cuttable = silence_regions.filter((r) => r.duration > MIN_SILENCE_TO_CUT);

  if (cuttable.length === 0) {
    return {
      segments: [
        {
          start: 0,
          end: duration,
          duration,
          text: transcription.full_text,
        },
      ],
      trimmedDuration: duration,
    };
  }

  // Sort silence regions by start time
  const sorted = [...cuttable].sort((a, b) => a.start - b.start);

  const segments: UsableSegment[] = [];
  let cursor = 0;

  for (const silence of sorted) {
    if (silence.start > cursor) {
      const segStart = cursor;
      const segEnd = silence.start;
      segments.push({
        start: segStart,
        end: segEnd,
        duration: segEnd - segStart,
        text: getTextForRange(transcription.sentences, segStart, segEnd),
      });
    }
    // Jump past the silence to where speech resumes
    cursor = silence.end;
  }

  // Capture remaining content after last silence
  if (cursor < duration) {
    segments.push({
      start: cursor,
      end: duration,
      duration: duration - cursor,
      text: getTextForRange(transcription.sentences, cursor, duration),
    });
  }

  const trimmedDuration = segments.reduce((sum, s) => sum + s.duration, 0);

  return { segments, trimmedDuration };
}

function getTextForRange(
  sentences: { text: string; start: number; end: number }[],
  rangeStart: number,
  rangeEnd: number
): string {
  return sentences
    .filter((s) => s.start >= rangeStart - 0.1 && s.end <= rangeEnd + 0.1)
    .map((s) => s.text)
    .join(" ");
}

export function computeTotalTrimmedDuration(
  clips: { usableSegments?: UsableSegment[]; trimmedDuration?: number; analysis: ARollAnalysis }[]
): { originalTotal: number; trimmedTotal: number; savedSeconds: number } {
  const originalTotal = clips.reduce((sum, c) => sum + c.analysis.duration, 0);
  const trimmedTotal = clips.reduce((sum, c) => sum + (c.trimmedDuration ?? c.analysis.duration), 0);
  return {
    originalTotal,
    trimmedTotal,
    savedSeconds: originalTotal - trimmedTotal,
  };
}
