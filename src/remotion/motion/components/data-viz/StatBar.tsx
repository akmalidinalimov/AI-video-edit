/**
 * StatBar — horizontal stat / progress bars (the "metric rows" infographic).
 * Mirrors the BarChart MGCS pattern: typed contract → token variants →
 * hw-accelerated render → descriptor.
 *
 * Motion layers (motion-floor ≥3): container fade-in · per-row enter
 * (opacity + translateY, staggered) · per-row fill grow (scaleX, staggered) ·
 * per-row value count-up. hw-accel only for movement (transform/opacity); the
 * fill bar grows via transform: scaleX with transformOrigin left (never width).
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2
 * Specialist: mg-progress-specialist
 */
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { Hex, MGBaseInput } from "../../contract";
import { resolveTokens } from "../../tokens";
import type { MotionComponent } from "../../types";

export const StatBarInput = MGBaseInput.extend({
  items: z
    .array(
      z.object({
        label: z.string(),
        percent: z.number().min(0).max(100),
        color: Hex.optional(),
      }),
    )
    .min(1)
    .max(5),
  value_format: z.string().default("{n}%"),
  show_track: z.boolean().default(true),
  title: z.string().optional(),
});
export type StatBarInput = z.infer<typeof StatBarInput>;

const StatBarRender: React.FC<{ input: StatBarInput }> = ({ input }) => {
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

  const titleH = input.title ? 88 : 0;
  const n = input.items.length;
  const rowGap = 22;
  const rowsH = Math.max(40, box.h - titleH);
  const rowH = Math.max(36, (rowsH - rowGap * (n - 1)) / n);
  const trackH = Math.max(14, Math.min(rowH * 0.42, 40));
  const labelH = Math.max(22, rowH - trackH - 10);

  const fmt = (v: number) => input.value_format.replace("{n}", String(v));

  return (
    <AbsoluteFill style={{ fontFamily: t.fontFamily }}>
      <div
        style={{
          position: "absolute",
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          opacity: containerOpacity,
          willChange: "opacity",
        }}
      >
        {input.title ? (
          <div
            style={{
              height: titleH,
              display: "flex",
              alignItems: "center",
              fontSize: 44,
              fontWeight: 700,
              letterSpacing: -0.5,
              color: t.text,
            }}
          >
            {input.title}
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: rowGap, height: rowsH, width: "100%" }}>
          {input.items.map((item, i) => {
            const delay = reduce ? 0 : i * Math.round(enterF * 0.22);

            // row enter: opacity + translateY (hw-accel)
            const enter = reduce
              ? 1
              : spring({ frame: frame - delay, fps, config: t.spring, durationInFrames: enterF });
            const rowOpacity = reduce ? 1 : interpolate(enter, [0, 1], [0, 1]);
            const rowTranslateY = reduce ? 0 : interpolate(enter, [0, 1], [24, 0]);

            // fill grow: scaleX 0 → fraction (hw-accel), transformOrigin left
            const grow = reduce
              ? 1
              : spring({ frame: frame - delay, fps, config: t.spring, durationInFrames: enterF });
            const fraction = item.percent / 100;
            const shown = Math.round(item.percent * grow);

            const barColor = item.color ?? t.palette[i % t.palette.length];

            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  height: rowH,
                  opacity: rowOpacity,
                  transform: `translateY(${rowTranslateY}px)`,
                  willChange: "transform, opacity",
                }}
              >
                <div
                  style={{
                    height: labelH,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingBottom: 8,
                  }}
                >
                  <span style={{ fontSize: 28, fontWeight: 600, color: t.text }}>{item.label}</span>
                  <span style={{ fontSize: 28, fontWeight: 700, color: t.textMuted, fontFamily: t.fontMono }}>
                    {fmt(shown)}
                  </span>
                </div>

                <div style={{ position: "relative", width: "100%", height: trackH }}>
                  {input.show_track ? (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: t.textMuted,
                        opacity: 0.18,
                        borderRadius: trackH / 2,
                      }}
                    />
                  ) : null}
                  {/* fill outer = final width; inner scaleX animates the reveal */}
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      height: trackH,
                      width: `${fraction * 100}%`,
                      transform: `scaleX(${grow})`,
                      transformOrigin: "left center",
                      willChange: "transform",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        background: barColor,
                        borderRadius: trackH / 2,
                        boxShadow: `0 0 24px ${barColor}55`,
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const statBar: MotionComponent<StatBarInput> = {
  id: "data-viz/stat-bar",
  category: "progress_bar",
  status: "production",
  inputSchema: StatBarInput,
  Render: StatBarRender,
  defaults: () =>
    StatBarInput.parse({
      intent: "Show how the system scores across speed, quality and cost",
      style: { family: "warm" },
      placement: { bbox_norm: [0.1, 0.34, 0.8, 0.32] },
      title: "Benchmark",
      value_format: "{n}%",
      show_track: true,
      items: [
        { label: "Speed", percent: 92 },
        { label: "Quality", percent: 78 },
        { label: "Cost", percent: 45 },
      ],
    }),
  specialistId: "mg-progress-specialist",
  exemplars: [],
};
