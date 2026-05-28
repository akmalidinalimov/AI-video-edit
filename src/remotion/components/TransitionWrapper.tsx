import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { VDIM } from "../utils/vdim";

interface TransitionWrapperProps {
  transitionIn?: { type: string; duration_frames: number };
  transitionOut?: { type: string; duration_frames: number };
  durationFrames: number;
  children: React.ReactNode;
}

export const TransitionWrapper: React.FC<TransitionWrapperProps> = ({
  transitionIn,
  transitionOut,
  durationFrames,
  children,
}) => {
  const frame = useCurrentFrame();

  let opacity = 1;
  let translateX = 0;
  let translateY = 0;
  let scale = 1;

  // Apply enter transition
  if (transitionIn && frame < transitionIn.duration_frames) {
    const progress = frame / transitionIn.duration_frames;
    const eased = easeOutCubic(progress);

    switch (transitionIn.type) {
      case "fade":
        opacity = eased;
        break;
      case "slide_left":
        translateX = interpolate(frame, [0, transitionIn.duration_frames], [-VDIM.WIDTH, 0], {
          extrapolateLeft: "clamp", extrapolateRight: "clamp",
        });
        break;
      case "slide_right":
        translateX = interpolate(frame, [0, transitionIn.duration_frames], [VDIM.WIDTH, 0], {
          extrapolateLeft: "clamp", extrapolateRight: "clamp",
        });
        break;
      case "slide_up":
        translateY = interpolate(frame, [0, transitionIn.duration_frames], [VDIM.HEIGHT, 0], {
          extrapolateLeft: "clamp", extrapolateRight: "clamp",
        });
        break;
      case "zoom":
        scale = interpolate(frame, [0, transitionIn.duration_frames], [0.5, 1], {
          extrapolateLeft: "clamp", extrapolateRight: "clamp",
        });
        opacity = eased;
        break;
      case "dissolve":
        opacity = eased;
        break;
      default:
        opacity = eased;
    }
  }

  // Apply exit transition
  if (transitionOut && frame > durationFrames - transitionOut.duration_frames) {
    const remaining = durationFrames - frame;
    const progress = remaining / transitionOut.duration_frames;
    const eased = easeOutCubic(Math.max(0, progress));

    switch (transitionOut.type) {
      case "fade":
        opacity *= eased;
        break;
      case "slide_left":
        translateX = interpolate(remaining, [transitionOut.duration_frames, 0], [0, -VDIM.WIDTH], {
          extrapolateLeft: "clamp", extrapolateRight: "clamp",
        });
        break;
      case "zoom":
        scale = interpolate(remaining, [transitionOut.duration_frames, 0], [1, 1.3], {
          extrapolateLeft: "clamp", extrapolateRight: "clamp",
        });
        opacity *= eased;
        break;
      default:
        opacity *= eased;
    }
  }

  return (
    <div
      style={{
        width: VDIM.WIDTH,
        height: VDIM.HEIGHT,
        position: "absolute",
        top: 0,
        left: 0,
        opacity,
        transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      {children}
    </div>
  );
};

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
