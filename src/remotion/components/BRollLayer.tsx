import React from "react";
import { useCurrentFrame, useVideoConfig, Img, OffthreadVideo, interpolate } from "remotion";
import type { TimelineSegment, BRollMotion } from "@/lib/types/timeline";
import { VDIM } from "../utils/vdim";

interface BRollLayerProps {
  broll: TimelineSegment["broll"];
  startFrame: number;
  durationFrames: number;
}

export const BRollLayer: React.FC<BRollLayerProps> = ({
  broll,
  startFrame,
  durationFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame;

  if (!broll.src) {
    return (
      <div
        style={{
          width: VDIM.WIDTH,
          height: VDIM.HEIGHT,
          backgroundColor: "#111",
        }}
      />
    );
  }

  const motion = broll.motion;
  const transform = motion
    ? computeMotionTransform(motion, localFrame + startFrame)
    : { x: 0, y: 0, scale: broll.scale ?? 1 };

  const isImage = broll.src.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i);

  const mediaStyle: React.CSSProperties = {
    position: "absolute",
    width: VDIM.WIDTH,
    height: VDIM.HEIGHT,
    objectFit: "cover",
    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
    transformOrigin: "center center",
  };

  // Apply crop if specified
  if (broll.crop) {
    const { x, y, width, height } = broll.crop;
    mediaStyle.clipPath = `inset(${y}px ${VDIM.WIDTH - x - width}px ${VDIM.HEIGHT - y - height}px ${x}px)`;
  }

  return (
    <div
      style={{
        width: VDIM.WIDTH,
        height: VDIM.HEIGHT,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {isImage ? (
        <Img src={broll.src} style={mediaStyle} />
      ) : (
        <OffthreadVideo
          src={broll.src}
          style={mediaStyle}
          muted
          startFrom={Math.round((broll.startFrom ?? 0) * fps)}
        />
      )}
    </div>
  );
};

function computeMotionTransform(
  motion: BRollMotion,
  absoluteFrame: number
): { x: number; y: number; scale: number } {
  const { keyframes, easing } = motion;

  if (keyframes.length === 0) return { x: 0, y: 0, scale: 1 };
  if (keyframes.length === 1) return keyframes[0];

  // Find the two keyframes we're between
  const firstKf = keyframes[0];
  const lastKf = keyframes[keyframes.length - 1];

  if (absoluteFrame <= firstKf.frame) return firstKf;
  if (absoluteFrame >= lastKf.frame) return lastKf;

  for (let i = 0; i < keyframes.length - 1; i++) {
    const kfA = keyframes[i];
    const kfB = keyframes[i + 1];

    if (absoluteFrame >= kfA.frame && absoluteFrame <= kfB.frame) {
      const range = kfB.frame - kfA.frame;
      const rawProgress = range > 0 ? (absoluteFrame - kfA.frame) / range : 0;
      const t = applyEasing(rawProgress, easing);

      return {
        x: kfA.x + (kfB.x - kfA.x) * t,
        y: kfA.y + (kfB.y - kfA.y) * t,
        scale: kfA.scale + (kfB.scale - kfA.scale) * t,
      };
    }
  }

  return lastKf;
}

function applyEasing(t: number, easing: string): number {
  switch (easing) {
    case "ease-in-out":
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case "ease-out":
      return 1 - Math.pow(1 - t, 2);
    case "linear":
    default:
      return t;
  }
}
