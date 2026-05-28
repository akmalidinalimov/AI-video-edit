import React from "react";
import { useCurrentFrame, interpolate, Img } from "remotion";
import { VDIM } from "../utils/vdim";

interface ParallaxLayerProps {
  src: string;
  durationFrames: number;
  /** Parallax intensity — higher = more movement. Default 1.0 */
  intensity?: number;
  /** Direction of parallax drift */
  direction?: "left" | "right" | "up" | "down";
}

/**
 * Creates a subtle parallax depth effect on static images
 * by rendering the image at 110% scale and panning slightly.
 * Foreground virtual layer moves 1.5x, background 0.5x of base.
 */
export const ParallaxLayer: React.FC<ParallaxLayerProps> = ({
  src,
  durationFrames,
  intensity = 1.0,
  direction = "right",
}) => {
  const frame = useCurrentFrame();

  const maxPan = 20 * intensity;

  // Base pan over the segment duration
  const basePan = interpolate(
    frame,
    [0, durationFrames],
    [0, maxPan],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Foreground layer — moves more
  const fgPan = basePan * 1.5;
  // Background layer — moves less
  const bgPan = basePan * 0.5;

  const getTranslate = (pan: number): string => {
    switch (direction) {
      case "left": return `translateX(${-pan}px)`;
      case "right": return `translateX(${pan}px)`;
      case "up": return `translateY(${-pan}px)`;
      case "down": return `translateY(${pan}px)`;
    }
  };

  return (
    <div
      style={{
        width: VDIM.WIDTH,
        height: VDIM.HEIGHT,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Background layer — slower movement, slight blur */}
      <Img
        src={src}
        style={{
          position: "absolute",
          width: VDIM.WIDTH * 1.15,
          height: VDIM.HEIGHT * 1.15,
          objectFit: "cover",
          top: "50%",
          left: "50%",
          transform: `translate(-50%, -50%) ${getTranslate(bgPan)} scale(1.05)`,
          filter: "blur(1px)",
        }}
      />

      {/* Foreground layer — faster movement, sharp */}
      <Img
        src={src}
        style={{
          position: "absolute",
          width: VDIM.WIDTH * 1.1,
          height: VDIM.HEIGHT * 1.1,
          objectFit: "cover",
          top: "50%",
          left: "50%",
          transform: `translate(-50%, -50%) ${getTranslate(fgPan)}`,
        }}
      />
    </div>
  );
};
