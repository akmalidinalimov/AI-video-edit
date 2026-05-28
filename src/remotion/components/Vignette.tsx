import React from "react";
import { VDIM } from "../utils/vdim";

interface VignetteProps {
  intensity?: number; // 0.0 - 1.0, default 0.4
  spread?: number;    // 0-100%, default 50
}

export const Vignette: React.FC<VignetteProps> = ({
  intensity = 0.4,
  spread = 50,
}) => {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: VDIM.WIDTH,
        height: VDIM.HEIGHT,
        pointerEvents: "none",
        zIndex: 85,
        background: `radial-gradient(ellipse at center, transparent ${spread}%, rgba(0,0,0,${intensity}) 100%)`,
      }}
    />
  );
};
