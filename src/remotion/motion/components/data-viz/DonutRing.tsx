/**
 * DonutRing — donut / percentage ring data-viz motion component. A single stat
 * told as a sweeping arc: the progress ring fills 0→percent while the center
 * number counts up and the label fades in. Demonstrates the full MGCS pattern:
 * typed contract → token variants → hw-accelerated render → descriptor.
 *
 * Motion layers (motion-floor ≥3): container fade-in · ring scale-in (transform)
 * · arc sweep (strokeDashoffset, paint-only) · center count-up · label fade.
 * Movement is transform/opacity only; the arc progress is paint-only stroke.
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2
 * Specialist: mg-donut-specialist
 */
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { Hex, MGBaseInput } from "../../contract";
import { resolveTokens } from "../../tokens";
import type { MotionComponent } from "../../types";

export const DonutRingInput = MGBaseInput.extend({
  percent: z.number().min(0).max(100),
  label: z.string(),
  center_format: z.string().default("{n}%"),
  thickness: z.number().positive().default(28),
  track: z.boolean().default(true),
});
export type DonutRingInput = z.infer<typeof DonutRingInput>;

const DonutRingRender: React.FC<{ input: DonutRingInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = resolveTokens(input.style);
  const reduce = input.reduceMotion;

  const [nx, ny, nw, nh] = input.placement.bbox_norm;
  const box = { x: nx * width, y: ny * height, w: nw * width, h: nh * height };

  const enterF = Math.max(1, Math.round((input.timing.enter.duration_ms / 1000) * fps));
  const containerOpacity = reduce
    ? 1
    : interpolate(frame, [0, enterF * 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // ring scale-in (entrance, transform only)
  const scaleIn = reduce ? 1 : spring({ frame, fps, config: t.spring, durationInFrames: enterF });

  // arc sweep + center count-up share a single 0→1 progress drive (paint + count)
  const sweep = reduce
    ? 1
    : spring({ frame: frame - Math.round(enterF * 0.15), fps, config: t.spring, durationInFrames: Math.round(enterF * 1.4) });

  // label fade trails the ring landing
  const labelOpacity = reduce
    ? 1
    : interpolate(frame, [enterF * 0.5, enterF * 1.1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const accent = t.accent ?? t.palette[0];
  const pct = Math.max(0, Math.min(100, input.percent));
  const progressFraction = (pct / 100) * sweep;

  // square SVG sized to the smaller box dimension, centered in the bbox
  const size = Math.max(40, Math.min(box.w, box.h));
  const stroke = Math.min(input.thickness, size / 2 - 1);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progressFraction);

  const shown = Math.round(pct * sweep);
  const centerText = input.center_format.replace("{n}", String(shown));
  const centerFontSize = Math.max(28, Math.min(size * 0.3, 220));
  const labelFontSize = Math.max(20, Math.min(size * 0.085, 56));

  return (
    <AbsoluteFill style={{ fontFamily: t.fontFamily }}>
      <div
        style={{
          position: "absolute",
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: containerOpacity,
          willChange: "opacity",
        }}
      >
        <div
          style={{
            position: "relative",
            width: size,
            height: size,
            transform: `scale(${scaleIn})`,
            transformOrigin: "center center",
            willChange: "transform",
          }}
        >
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
            {/* rotate -90° so the arc starts at the top */}
            <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
              {input.track ? (
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={t.surface}
                  strokeOpacity={0.5}
                  strokeWidth={stroke}
                />
              ) : null}
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={accent}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                style={{ filter: `drop-shadow(0 0 24px ${accent}55)` }}
              />
            </g>
          </svg>

          {/* center number (count-up) + label, layered over the ring */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              padding: stroke,
            }}
          >
            <div
              style={{
                fontFamily: t.fontMono,
                fontSize: centerFontSize,
                fontWeight: 700,
                lineHeight: 1,
                letterSpacing: -1,
                color: t.text,
              }}
            >
              {centerText}
            </div>
            <div
              style={{
                marginTop: labelFontSize * 0.4,
                fontSize: labelFontSize,
                fontWeight: 600,
                color: t.textMuted,
                opacity: labelOpacity,
                willChange: "opacity",
              }}
            >
              {input.label}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const donutRing: MotionComponent<DonutRingInput> = {
  id: "data-viz/donut-ring",
  category: "donut",
  status: "production",
  inputSchema: DonutRingInput,
  Render: DonutRingRender,
  defaults: () =>
    DonutRingInput.parse({
      intent: "Show goal completion at 73%",
      style: { family: "glass" },
      placement: { bbox_norm: [0.2, 0.32, 0.6, 0.36] },
      percent: 73,
      label: "Goal complete",
      center_format: "{n}%",
    }),
  specialistId: "mg-donut-specialist",
  exemplars: [],
};
