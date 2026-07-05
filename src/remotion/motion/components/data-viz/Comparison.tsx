/**
 * Comparison — head-to-head "A vs B" versus card. The "comparison" graphic_type:
 * two equal panels (left / right) race in from opposite edges, a central "VS"
 * badge scale-pops between them, each side's value count-ups (numbers) or fades
 * in (strings), and the declared winner panel gets an emphasis pulse + glow.
 * The infographic you reach for to dramatize a before/after or this-vs-that.
 *
 * Motion layers (motion-floor ≥3): left panel slide-in (translateX −→0) ·
 * right panel slide-in (translateX +→0) · VS badge scale-pop · winner emphasis
 * pulse (scale + boxShadow). hw-accel only (transform/opacity). honors
 * reduceMotion (snaps to final state).
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2
 * Specialist: mg-comparison-specialist
 */
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { Hex, MGBaseInput } from "../../contract";
import { resolveTokens } from "../../tokens";
import type { MotionComponent } from "../../types";

const Side = z.object({
  label: z.string(),
  value: z.union([z.number(), z.string()]),
  color: Hex.optional(),
});

export const ComparisonInput = MGBaseInput.extend({
  left: Side,
  right: Side,
  metric_label: z.string().optional(),
  winner: z.enum(["left", "right", "none"]).default("none"),
});
export type ComparisonInput = z.infer<typeof ComparisonInput>;

const ComparisonRender: React.FC<{ input: ComparisonInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = resolveTokens(input.style);
  const reduce = input.reduceMotion;

  const [nx, ny, nw, nh] = input.placement.bbox_norm;
  const box = { x: nx * width, y: ny * height, w: nw * width, h: nh * height };

  const enterF = Math.max(1, Math.round((input.timing.enter.duration_ms / 1000) * fps));

  // Geometry: two equal columns with a VS gutter centered between them.
  const vsSize = Math.max(96, Math.min(160, box.w * 0.18));
  const colGap = 28;
  const colW = Math.max(40, (box.w - vsSize - colGap * 2) / 2);

  // Layer 1: left panel slides in from the left (translateX negative → 0).
  const leftT = reduce ? 1 : spring({ frame, fps, config: t.spring, durationInFrames: enterF });
  const leftX = reduce ? 0 : interpolate(leftT, [0, 1], [-(colW + vsSize), 0]);

  // Layer 2: right panel slides in from the right (translateX positive → 0).
  const rightT = reduce
    ? 1
    : spring({ frame, fps, config: t.spring, durationInFrames: enterF });
  const rightX = reduce ? 0 : interpolate(rightT, [0, 1], [colW + vsSize, 0]);

  // Layer 3: central VS badge scale-pops in (after the panels start moving).
  const vsDelay = Math.round(enterF * 0.35);
  const vsT = reduce
    ? 1
    : spring({ frame: frame - vsDelay, fps, config: t.spring, durationInFrames: Math.round(enterF * 0.7) });
  const vsScale = reduce ? 1 : interpolate(Math.min(1, vsT), [0, 1], [0.2, 1]);

  // Layer 4: winner emphasis pulse (scale + glow) after both panels land.
  const settled = leftT > 0.98 && rightT > 0.98;
  const winnerPulse =
    reduce || !settled ? 0 : Math.max(0, Math.sin((frame - enterF) / 7));

  // Value resolution: number → count-up, string → fade-in.
  const valueT = reduce ? 1 : spring({ frame, fps, config: t.spring, durationInFrames: enterF });
  const renderValue = (raw: number | string): { text: string; opacity: number } => {
    if (typeof raw === "number") {
      const shown = Math.round(raw * valueT);
      return { text: String(shown), opacity: 1 };
    }
    const op = reduce
      ? 1
      : interpolate(frame, [enterF * 0.4, enterF * 0.9], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
    return { text: raw, opacity: op };
  };

  const panel = (
    side: ComparisonInput["left"],
    which: "left" | "right",
    tx: number,
  ): React.ReactNode => {
    const isWinner = input.winner === which;
    const paletteColor = t.palette[(which === "left" ? 0 : 1) % t.palette.length];
    const accent = side.color ?? (isWinner ? t.accent : paletteColor);
    const val = renderValue(side.value);
    const pulseScale = isWinner ? 1 + 0.035 * winnerPulse : 1;
    const glow = isWinner ? 24 + 28 * winnerPulse : 0;

    return (
      <div
        style={{
          flex: `0 0 ${colW}px`,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          padding: "28px 24px",
          boxSizing: "border-box",
          background: t.surface,
          border: `2px solid ${isWinner ? accent : `${t.textMuted}33`}`,
          borderRadius: t.radius,
          transform: `translateX(${tx}px) scale(${pulseScale})`,
          transformOrigin: "center center",
          boxShadow: isWinner ? `0 0 ${glow}px ${accent}66` : "none",
          willChange: "transform",
        }}
      >
        <div
          style={{
            fontFamily: t.fontMono,
            fontSize: Math.min(96, colW * 0.42),
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: -2,
            color: accent,
            textAlign: "center",
            opacity: val.opacity,
            willChange: "opacity",
          }}
        >
          {val.text}
        </div>
        <div
          style={{
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: -0.4,
            color: t.text,
            textAlign: "center",
          }}
        >
          {side.label}
        </div>
      </div>
    );
  };

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
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: input.metric_label ? 24 : 0,
        }}
      >
        {input.metric_label ? (
          <div
            style={{
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: t.textMuted,
              textAlign: "center",
              opacity: reduce
                ? 1
                : interpolate(frame, [0, enterF * 0.5], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
              willChange: "opacity",
            }}
          >
            {input.metric_label}
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: colGap, width: "100%", flex: 1, minHeight: 0 }}>
          {panel(input.left, "left", leftX)}

          {/* Layer 3: central VS badge */}
          <div
            style={{
              flex: `0 0 ${vsSize}px`,
              width: vsSize,
              height: vsSize,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 999,
              background: t.accent,
              color: t.bg,
              fontFamily: t.fontMono,
              fontSize: vsSize * 0.34,
              fontWeight: 800,
              letterSpacing: -1,
              boxShadow: `0 0 36px ${t.accent}55`,
              transform: `scale(${vsScale})`,
              transformOrigin: "center center",
              willChange: "transform",
            }}
          >
            VS
          </div>

          {panel(input.right, "right", rightX)}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const comparison: MotionComponent<ComparisonInput> = {
  id: "data-viz/comparison",
  category: "comparison",
  status: "production",
  inputSchema: ComparisonInput,
  Render: ComparisonRender,
  defaults: () =>
    ComparisonInput.parse({
      intent: "Show load time dropping from 3.2s to 0.4s after the rewrite",
      style: { family: "dark" },
      placement: { bbox_norm: [0.1, 0.34, 0.8, 0.32] },
      left: { label: "Before", value: "3.2s" },
      right: { label: "After", value: "0.4s" },
      metric_label: "Load time",
      winner: "right",
    }),
  specialistId: "mg-comparison-specialist",
  exemplars: [],
};
