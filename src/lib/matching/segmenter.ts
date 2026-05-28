import type { StyleProfile } from "@/lib/types/styleProfile";
import type { ARollClipAnalysis, ARollSequence, UsableSegment } from "@/lib/types/project";

export interface ContentSegment {
  id: string;
  clipId: string;
  clipFileName: string;
  start: number;
  end: number;
  duration: number;
  text: string;
  semanticTags: string[];
  mood: string;
  globalStart: number;
  globalEnd: number;
}

export function segmentContent(
  clips: ARollClipAnalysis[],
  sequence: ARollSequence | null,
  style: StyleProfile
): ContentSegment[] {
  const ordered = sequence
    ? [...clips].sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    : clips;

  const targetDuration = style.editing_rhythm.avg_segment_duration;
  const segments: ContentSegment[] = [];
  let globalOffset = 0;
  let segIndex = 0;

  for (const clip of ordered) {
    const usable = clip.usableSegments ?? [{
      start: 0,
      end: clip.analysis.duration,
      duration: clip.analysis.duration,
      text: clip.analysis.transcription.full_text,
    }];

    for (const block of usable) {
      const blockSegments = splitBlock(
        block,
        clip,
        targetDuration,
        globalOffset,
        segIndex
      );

      for (const seg of blockSegments) {
        segments.push(seg);
        segIndex++;
      }

      globalOffset += block.duration;
    }
  }

  return segments;
}

function splitBlock(
  block: UsableSegment,
  clip: ARollClipAnalysis,
  targetDuration: number,
  globalOffset: number,
  startIndex: number
): ContentSegment[] {
  const sentences = clip.analysis.transcription.sentences.filter(
    (s) => s.start >= block.start - 0.1 && s.end <= block.end + 0.1
  );

  if (block.duration <= targetDuration * 1.5 || sentences.length <= 1) {
    return [{
      id: `seg_${startIndex}`,
      clipId: clip.fileId,
      clipFileName: clip.fileName,
      start: block.start,
      end: block.end,
      duration: block.duration,
      text: block.text || sentences.map((s) => s.text).join(" "),
      semanticTags: collectTags(sentences),
      mood: findMood(clip, block.start, block.end),
      globalStart: globalOffset,
      globalEnd: globalOffset + block.duration,
    }];
  }

  // Split at natural edit points or sentence boundaries near target duration
  const editPoints = clip.analysis.edit_points
    .filter((ep) => ep.timestamp > block.start && ep.timestamp < block.end)
    .sort((a, b) => b.confidence - a.confidence);

  const splitPoints: number[] = [];
  let cursor = block.start;

  while (cursor < block.end - targetDuration * 0.5) {
    const ideal = cursor + targetDuration;

    // Find best split near the ideal point
    const candidates = [
      ...editPoints
        .filter((ep) => ep.timestamp > cursor + targetDuration * 0.4 && ep.timestamp < cursor + targetDuration * 1.6)
        .map((ep) => ({ time: ep.timestamp, score: ep.confidence })),
      ...sentences
        .filter((s) => s.end > cursor + targetDuration * 0.4 && s.end < cursor + targetDuration * 1.6)
        .map((s) => ({ time: s.end, score: 0.5 })),
    ];

    if (candidates.length === 0) {
      cursor = ideal;
      if (cursor < block.end - 1) splitPoints.push(cursor);
      continue;
    }

    // Prefer candidates closest to ideal with highest confidence
    candidates.sort((a, b) => {
      const distA = Math.abs(a.time - ideal);
      const distB = Math.abs(b.time - ideal);
      const scoreA = a.score - distA / targetDuration * 0.3;
      const scoreB = b.score - distB / targetDuration * 0.3;
      return scoreB - scoreA;
    });

    const best = candidates[0].time;
    splitPoints.push(best);
    cursor = best;
  }

  // Build segments from split points
  const boundaries = [block.start, ...splitPoints, block.end];
  const results: ContentSegment[] = [];
  let localOffset = 0;

  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    const segDuration = segEnd - segStart;

    if (segDuration < 0.5) continue;

    const segSentences = sentences.filter(
      (s) => s.start >= segStart - 0.1 && s.end <= segEnd + 0.1
    );

    results.push({
      id: `seg_${startIndex + results.length}`,
      clipId: clip.fileId,
      clipFileName: clip.fileName,
      start: segStart,
      end: segEnd,
      duration: segDuration,
      text: segSentences.map((s) => s.text).join(" "),
      semanticTags: collectTags(segSentences),
      mood: findMood(clip, segStart, segEnd),
      globalStart: globalOffset + localOffset,
      globalEnd: globalOffset + localOffset + segDuration,
    });

    localOffset += segDuration;
  }

  return results;
}

function collectTags(sentences: { semantic_tags?: string[] }[]): string[] {
  const tags = new Set<string>();
  for (const s of sentences) {
    if (s.semantic_tags) {
      for (const t of s.semantic_tags) tags.add(t);
    }
  }
  return [...tags];
}

function findMood(clip: ARollClipAnalysis, start: number, end: number): string {
  const mid = (start + end) / 2;
  const arc = clip.analysis.emotional_arc.find(
    (a) => a.start <= mid && a.end >= mid
  );
  return arc?.mood ?? "neutral";
}
