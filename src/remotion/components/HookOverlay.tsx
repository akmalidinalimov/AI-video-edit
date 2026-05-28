import React from "react";
import { useCurrentFrame, spring, interpolate, useVideoConfig } from "remotion";
import type { EngagementHook } from "@/lib/types/timeline";

interface HookOverlayProps {
  hook: EngagementHook;
}

export const HookOverlay: React.FC<HookOverlayProps> = ({ hook }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Only show during hook duration
  if (frame > hook.duration_frames) return null;

  const [x, y] = hook.position;
  const animDuration = hook.animation.duration_frames;
  const animStyle = getAnimationStyle(hook.animation.type, frame, animDuration, fps);

  // Fade out at the end
  const fadeOut = interpolate(
    frame,
    [hook.duration_frames - 10, hook.duration_frames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: `translate(-50%, -50%) ${animStyle.transform}`,
        opacity: animStyle.opacity * fadeOut,
        ...hook.style as React.CSSProperties,
      }}
    >
      {hook.text}
    </div>
  );
};

function getAnimationStyle(
  type: string,
  frame: number,
  durationFrames: number,
  fps: number
): { transform: string; opacity: number } {
  switch (type) {
    case "pop": {
      const scale = spring({
        frame,
        fps,
        config: { damping: 10, stiffness: 200 },
        durationInFrames: durationFrames,
      });
      return {
        transform: `scale(${scale})`,
        opacity: Math.min(1, frame / 3),
      };
    }

    case "slide_up": {
      const translateY = interpolate(
        frame,
        [0, durationFrames],
        [80, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
      const opacity = interpolate(
        frame,
        [0, durationFrames * 0.5],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
      return {
        transform: `translateY(${translateY}px)`,
        opacity,
      };
    }

    case "typewriter": {
      // This needs to be handled at the text level
      const opacity = interpolate(frame, [0, 5], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      return { transform: "", opacity };
    }

    case "fade_in":
    default: {
      const opacity = interpolate(
        frame,
        [0, durationFrames],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
      return { transform: "", opacity };
    }
  }
}
