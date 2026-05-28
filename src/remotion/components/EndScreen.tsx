import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import type { EndScreenConfig } from "@/lib/types/render";
import { VDIM } from "../utils/vdim";

interface EndScreenProps {
  config: EndScreenConfig;
  /** Style derived from reference profile */
  textColor?: string;
  accentColor?: string;
}

export const EndScreen: React.FC<EndScreenProps> = ({
  config,
  textColor = "#FFFFFF",
  accentColor = "#FFD700",
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const endScreenStart = durationInFrames - config.durationFrames;

  // Only render during end screen period
  if (frame < endScreenStart) return null;

  const localFrame = frame - endScreenStart;

  // Background fade in
  const bgOpacity = interpolate(
    localFrame,
    [0, 15],
    [0, 0.85],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Text spring animation
  const textScale = spring({
    frame: localFrame,
    fps,
    config: { damping: 12, stiffness: 150 },
    durationInFrames: 20,
  });

  // Subtext fade in (delayed)
  const subtextOpacity = interpolate(
    localFrame,
    [15, 30],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: VDIM.WIDTH,
        height: VDIM.HEIGHT,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: `rgba(0,0,0,${bgOpacity})`,
        zIndex: 95,
      }}
    >
      {/* Main CTA text */}
      <div
        style={{
          fontSize: 64,
          fontWeight: "bold",
          color: textColor,
          textAlign: "center",
          transform: `scale(${textScale})`,
          maxWidth: VDIM.WIDTH * 0.8,
          lineHeight: 1.2,
        }}
      >
        {config.text}
      </div>

      {/* Subtext */}
      {config.subtext && (
        <div
          style={{
            fontSize: 32,
            color: accentColor,
            textAlign: "center",
            marginTop: 24,
            opacity: subtextOpacity,
          }}
        >
          {config.subtext}
        </div>
      )}

      {/* Decorative line */}
      <div
        style={{
          width: interpolate(localFrame, [10, 25], [0, 200], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          height: 3,
          backgroundColor: accentColor,
          borderRadius: 2,
          marginTop: 30,
          opacity: subtextOpacity,
        }}
      />
    </div>
  );
};
