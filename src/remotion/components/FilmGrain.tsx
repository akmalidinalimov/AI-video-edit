import React from "react";
import { useCurrentFrame } from "remotion";
import { VDIM } from "../utils/vdim";

interface FilmGrainProps {
  intensity?: number; // 0.0 - 0.15, default 0.05
}

export const FilmGrain: React.FC<FilmGrainProps> = ({ intensity = 0.05 }) => {
  const frame = useCurrentFrame();

  // Cycle seed every frame for animated grain
  const seed = frame % 1000;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: VDIM.WIDTH,
        height: VDIM.HEIGHT,
        pointerEvents: "none",
        zIndex: 90,
        mixBlendMode: "overlay",
        opacity: intensity,
      }}
    >
      <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <filter id={`grain-${seed}`}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.65"
            numOctaves="3"
            seed={seed}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect
          width="100%"
          height="100%"
          filter={`url(#grain-${seed})`}
        />
      </svg>
    </div>
  );
};
