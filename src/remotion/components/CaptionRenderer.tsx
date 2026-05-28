import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import type { CaptionTrack, CaptionWord as CaptionWordData, CaptionStyle } from "@/lib/types/timeline";

interface CaptionRendererProps {
  captions: CaptionTrack;
}

export const CaptionRenderer: React.FC<CaptionRendererProps> = ({ captions }) => {
  const frame = useCurrentFrame();

  // Find the active line at current frame
  const activeLine = captions.lines.find(
    (line) => frame >= line.start_frame && frame <= line.end_frame
  );

  if (!activeLine) return null;

  const style = activeLine.style ?? captions.style;
  const [posX, posY] = activeLine.position ?? captions.position;

  // Fade in the line
  const lineOpacity = interpolate(
    frame - activeLine.start_frame,
    [0, 5],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <div
      style={{
        position: "absolute",
        left: posX,
        top: posY,
        transform: "translateX(-50%)",
        maxWidth: style.maxWidth,
        textAlign: style.textAlign,
        opacity: lineOpacity,
      }}
    >
      <div
        style={{
          display: "inline-block",
          backgroundColor: style.backgroundColor ?? "rgba(0,0,0,0.6)",
          padding: style.padding ?? 12,
          borderRadius: style.borderRadius ?? 8,
        }}
      >
        {activeLine.words.map((word, i) => (
          <CaptionWordEl
            key={i}
            word={word}
            style={style}
            currentFrame={frame}
          />
        ))}
      </div>
    </div>
  );
};

interface CaptionWordProps {
  word: CaptionWordData;
  style: CaptionStyle;
  currentFrame: number;
}

const CaptionWordEl: React.FC<CaptionWordProps> = ({ word, style, currentFrame }) => {
  const isActive = currentFrame >= word.start_frame && currentFrame <= word.end_frame;
  const isPast = currentFrame > word.end_frame;

  // Scale pulse when word becomes active
  const scale = isActive
    ? interpolate(
        currentFrame - word.start_frame,
        [0, 3, 6],
        [1.0, 1.08, 1.0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      )
    : 1.0;

  return (
    <span
      style={{
        display: "inline-block",
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        color: isActive ? "#FFFFFF" : isPast ? style.color : style.color,
        backgroundColor: isActive ? style.highlightColor : "transparent",
        borderRadius: 4,
        padding: "2px 4px",
        margin: "0 2px",
        transform: `scale(${scale})`,
        transformOrigin: "center bottom",
        textTransform: style.textTransform ?? "none",
        transition: "background-color 0.05s",
      }}
    >
      {word.word}
    </span>
  );
};
