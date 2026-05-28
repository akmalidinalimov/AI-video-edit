import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";

interface TextOverlayProps {
  text: string;
  position: [number, number];
  style: Record<string, unknown>;
  animation?: Record<string, unknown>;
  startFrame: number;
  endFrame: number;
}

export const TextOverlay: React.FC<TextOverlayProps> = ({
  text,
  position,
  style: textStyle,
  animation,
  startFrame,
  endFrame,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Only render during active range (relative to segment)
  if (frame < startFrame || frame > endFrame) return null;

  const localFrame = frame - startFrame;
  const [x, y] = position;

  // Entry animation
  let opacity = 1;
  let translateY = 0;
  let scale = 1;

  const animType = (animation?.type as string) ?? "fade_in";
  const animDuration = (animation?.duration_frames as number) ?? 10;

  if (localFrame < animDuration) {
    switch (animType) {
      case "pop":
        scale = spring({
          frame: localFrame,
          fps,
          config: { damping: 10, stiffness: 200 },
          durationInFrames: animDuration,
        });
        opacity = Math.min(1, localFrame / 3);
        break;

      case "slide_up":
        translateY = interpolate(localFrame, [0, animDuration], [40, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        opacity = interpolate(localFrame, [0, animDuration * 0.6], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        break;

      case "fade_in":
      default:
        opacity = interpolate(localFrame, [0, animDuration], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
    }
  }

  // Exit fade
  const remaining = endFrame - startFrame - localFrame;
  if (remaining < 8) {
    opacity *= interpolate(remaining, [0, 8], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: `translate(-50%, -50%) translateY(${translateY}px) scale(${scale})`,
        opacity,
        ...(textStyle as React.CSSProperties),
      }}
    >
      {text}
    </div>
  );
};
