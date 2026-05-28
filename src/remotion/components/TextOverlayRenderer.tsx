import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import type { TimelineSegment } from "@/lib/types/timeline";

interface TextOverlayRendererProps {
  segments: TimelineSegment[];
}

/**
 * Renders per-segment text overlays (title cards, labels, etc.)
 * These are separate from captions — they match the reference video's
 * decorative text elements (e.g. "2026 yil SMM" in the opening).
 */
export const TextOverlayRenderer: React.FC<TextOverlayRendererProps> = ({
  segments,
}) => {
  const frame = useCurrentFrame();

  // Find current segment
  const currentSegment = segments.find(
    (s) => frame >= s.start_frame && frame < s.end_frame
  );

  if (!currentSegment?.text_overlays?.length) return null;

  return (
    <>
      {currentSegment.text_overlays.map((overlay, i) => {
        // Only show if within the overlay's frame range
        if (frame < overlay.start_frame || frame > overlay.end_frame) return null;

        const relFrame = frame - overlay.start_frame;
        const duration = overlay.end_frame - overlay.start_frame;

        // Fade in over 8 frames
        const opacity = interpolate(relFrame, [0, 8], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        // Slight slide up animation
        const translateY = interpolate(relFrame, [0, 10], [15, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        // Fade out in last 8 frames
        const fadeOut = interpolate(
          relFrame,
          [duration - 8, duration],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        const style = overlay.style as Record<string, unknown>;
        const [x, y] = overlay.position;

        return (
          <div
            key={`${currentSegment.id}-overlay-${i}`}
            style={{
              position: "absolute",
              left: x,
              top: y,
              opacity: opacity * fadeOut,
              transform: `translateY(${translateY}px)`,
              fontSize: (style.fontSize as number) ?? (style.size as number) ?? 48,
              fontWeight: (style.fontWeight as string) ?? "bold",
              color: (style.color as string) ?? "#FFFFFF",
              backgroundColor: (style.backgroundColor as string) ?? (style.background as string) ?? "transparent",
              padding: style.backgroundColor || style.background ? "6px 16px" : undefined,
              borderRadius: style.backgroundColor || style.background ? 8 : undefined,
              fontFamily: (style.font as string) ?? "'Inter', 'Segoe UI', sans-serif",
              letterSpacing: "0.02em",
              textShadow: !(style.backgroundColor || style.background)
                ? "2px 2px 8px rgba(0,0,0,0.7)"
                : undefined,
              zIndex: 20,
              whiteSpace: "nowrap",
            }}
          >
            {overlay.text}
          </div>
        );
      })}
    </>
  );
};
