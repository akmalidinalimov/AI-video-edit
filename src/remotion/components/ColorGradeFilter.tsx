import React from "react";
import type { ColorGrade } from "@/lib/types/styleProfile";
import { VDIM } from "../utils/vdim";

interface ColorGradeFilterProps {
  colorGrade: ColorGrade;
  children: React.ReactNode;
}

export const ColorGradeFilter: React.FC<ColorGradeFilterProps> = ({
  colorGrade,
  children,
}) => {
  const { temperature, saturation, contrast, brightness } = colorGrade;

  const filters: string[] = [];

  // Temperature → hue-rotate + sepia
  switch (temperature) {
    case "warm":
      filters.push("sepia(0.15)", "hue-rotate(-5deg)");
      break;
    case "cool":
      filters.push("sepia(0.05)", "hue-rotate(10deg)");
      break;
    case "neutral":
    default:
      break;
  }

  // Saturation (numeric — 1.0 = normal)
  if (typeof saturation === "number" && saturation !== 1) {
    filters.push(`saturate(${saturation})`);
  }

  // Contrast (numeric — 1.0 = normal)
  if (typeof contrast === "number" && contrast !== 1) {
    filters.push(`contrast(${contrast})`);
  }

  // Brightness (numeric — 1.0 = normal)
  if (typeof brightness === "number" && brightness !== 1) {
    filters.push(`brightness(${brightness})`);
  }

  return (
    <div
      style={{
        width: VDIM.WIDTH,
        height: VDIM.HEIGHT,
        position: "relative",
        filter: filters.length > 0 ? filters.join(" ") : undefined,
      }}
    >
      {children}
    </div>
  );
};
