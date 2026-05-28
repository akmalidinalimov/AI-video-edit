import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { VDIM } from "../utils/vdim";

interface ProgressBarProps {
  color?: string;
  height?: number;
  position?: "top" | "bottom";
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  color = "#FFFFFF",
  height = 3,
  position = "bottom",
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const progress = Math.min(1, frame / durationInFrames);
  const width = VDIM.WIDTH * progress;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        [position === "top" ? "top" : "bottom"]: 0,
        width: VDIM.WIDTH,
        height,
        backgroundColor: "rgba(255,255,255,0.15)",
        zIndex: 100,
      }}
    >
      <div
        style={{
          width,
          height: "100%",
          backgroundColor: color,
          borderRadius: position === "bottom" ? "0 2px 0 0" : "0 0 2px 0",
        }}
      />
    </div>
  );
};
