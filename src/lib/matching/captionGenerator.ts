import type { CaptionTrack, CaptionLine, CaptionWord, CaptionStyle } from "@/lib/types/timeline";
import type { StyleProfile } from "@/lib/types/styleProfile";
import type { ContentSegment } from "./segmenter";
import type { ARollClipAnalysis } from "@/lib/types/project";

const FPS = 30;
const MAX_WORDS_PER_LINE = 6;
const WIDTH = 1080;
const HEIGHT = 1920;

export function generateCaptions(
  segments: ContentSegment[],
  clips: ARollClipAnalysis[],
  style: StyleProfile
): CaptionTrack {
  const captionStyle = deriveCaptionStyle(style);
  const position: [number, number] = [WIDTH / 2, HEIGHT * 0.78];

  const lines: CaptionLine[] = [];

  for (const seg of segments) {
    const clip = clips.find((c) => c.fileId === seg.clipId);
    if (!clip) continue;

    const words = clip.analysis.transcription.words.filter(
      (w) => w.start >= seg.start - 0.05 && w.end <= seg.end + 0.05
    );

    if (words.length === 0) continue;

    // Group words into lines of MAX_WORDS_PER_LINE
    for (let i = 0; i < words.length; i += MAX_WORDS_PER_LINE) {
      const chunk = words.slice(i, i + MAX_WORDS_PER_LINE);
      const lineText = chunk.map((w) => w.word).join(" ");
      const lineStart = chunk[0].start + seg.globalStart - seg.start;
      const lineEnd = chunk[chunk.length - 1].end + seg.globalStart - seg.start;

      const captionWords: CaptionWord[] = chunk.map((w) => ({
        word: w.word,
        start_frame: Math.round((w.start + seg.globalStart - seg.start) * FPS),
        end_frame: Math.round((w.end + seg.globalStart - seg.start) * FPS),
      }));

      lines.push({
        text: lineText,
        start_frame: Math.round(lineStart * FPS),
        end_frame: Math.round(lineEnd * FPS),
        words: captionWords,
        position,
        style: captionStyle,
      });
    }
  }

  return { lines, style: captionStyle, position };
}

function deriveCaptionStyle(style: StyleProfile): CaptionStyle {
  // Try to match caption style from reference text overlays
  const refOverlay = style.segments
    .flatMap((s) => s.text_overlays)
    .find((t) => t?.style);

  if (refOverlay?.style) {
    return {
      fontSize: refOverlay.style.fontSize ?? refOverlay.style.size ?? 42,
      fontWeight: refOverlay.style.fontWeight ?? "bold",
      color: refOverlay.style.color ?? "#FFFFFF",
      highlightColor: "#FFD700",
      backgroundColor: refOverlay.style.background ?? refOverlay.style.backgroundColor ?? "rgba(0,0,0,0.6)",
      padding: refOverlay.style.padding ?? 12,
      borderRadius: refOverlay.style.borderRadius ?? 8,
      textAlign: "center",
      textTransform: "none",
      maxWidth: 900,
    };
  }

  // Default short-form caption style
  return {
    fontSize: 42,
    fontWeight: "bold",
    color: "#FFFFFF",
    highlightColor: "#FFD700",
    backgroundColor: "rgba(0,0,0,0.6)",
    padding: 12,
    borderRadius: 8,
    textAlign: "center",
    textTransform: "none",
    maxWidth: 900,
  };
}
