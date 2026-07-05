/**
 * BarChart — flagship data-viz motion component (the infographics gap ReelStack
 * doesn't cover). Demonstrates the full MGCS pattern: typed contract → token
 * variants → hw-accelerated render → descriptor.
 *
 * Motion layers (motion-floor ≥3): container fade-in · per-bar grow (scaleY) ·
 * value count-up · highlighted-bar emphasis. hw-accel only (transform/opacity).
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2
 * Specialist: mg-bar-chart-specialist
 */
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { Hex, MGBaseInput } from "../../contract";
import { resolveTokens } from "../../tokens";
import type { MotionComponent } from "../../types";

export const BarChartInput = MGBaseInput.extend({
  data: z
    .array(z.object({ label: z.string(), value: z.number(), color: Hex.optional() }))
    .min(1)
    .max(8),
  orientation: z.enum(["vertical", "horizontal"]).default("vertical"),
  reveal: z.enum(["grow", "stagger"]).default("stagger"),
  value_format: z.string().default("{n}"),
  baseline: z.number().optional(),
  highlight_index: z.number().int().optional(),
  title: z.string().optional(),
});
export type BarChartInput = z.infer<typeof BarChartInput>;

const BarChartRender: React.FC<{ input: BarChartInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = resolveTokens(input.style);
  const reduce = input.reduceMotion;

  const [nx, ny, nw, nh] = input.placement.bbox_norm;
  const box = { x: nx * width, y: ny * height, w: nw * width, h: nh * height };

  const enterF = Math.max(1, Math.round((input.timing.enter.duration_ms / 1000) * fps));
  const containerOpacity = reduce ? 1 : interpolate(frame, [0, enterF * 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const titleH = input.title ? 88 : 0;
  const labelH = 64;
  const chartH = Math.max(40, box.h - titleH - labelH);
  const n = input.data.length;
  const gap = 24;
  const barW = Math.max(8, (box.w - gap * (n - 1)) / n);

  const values = input.data.map((d) => d.value);
  const max = Math.max(1, ...values, input.baseline ?? 0);

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

        <div style={{ display: "flex", alignItems: "flex-end", gap, height: chartH, width: "100%" }}>
          {input.data.map((d, i) => {
            const delay = input.reveal === "stagger" && !reduce ? i * Math.round(enterF * 0.18) : 0;
            const grow = reduce
              ? 1
              : spring({ frame: frame - delay, fps, config: t.spring, durationInFrames: enterF });
            const full = (d.value / max) * chartH;
            const isHi = input.highlight_index === i;
            const barColor = d.color ?? (isHi ? t.accent : t.palette[i % t.palette.length]);
            const shown = Math.round(d.value * grow);

            // highlighted bar: subtle hw-accel pulse after it lands
            const pulse =
              isHi && !reduce
                ? 1 + 0.03 * Math.max(0, Math.sin((frame - delay - enterF) / 6)) * (grow > 0.98 ? 1 : 0)
                : 1;

            return (
              <div key={i} style={{ flex: `0 0 ${barW}px`, display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ position: "relative", width: "100%", height: chartH, display: "flex", alignItems: "flex-end" }}>
                  <div style={{ position: "absolute", bottom: full + 12, width: "100%", textAlign: "center", fontSize: 30, fontWeight: 700, color: t.text, fontFamily: t.fontMono, opacity: grow }}>
                    {fmt(shown)}
                  </div>
                  <div
                    style={{
                      width: "100%",
                      height: full,
                      background: barColor,
                      borderRadius: `${Math.min(t.radius, barW / 2)}px ${Math.min(t.radius, barW / 2)}px 4px 4px`,
                      transform: `scaleY(${grow}) scale(${pulse})`,
                      transformOrigin: "bottom center",
                      boxShadow: isHi ? `0 0 40px ${barColor}66` : "none",
                      willChange: "transform",
                    }}
                  />
                </div>
                <div style={{ height: labelH, display: "flex", alignItems: "center", textAlign: "center", fontSize: 26, fontWeight: 600, color: t.textMuted, paddingTop: 10 }}>
                  {d.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const barChart: MotionComponent<BarChartInput> = {
  id: "data-viz/bar-chart",
  category: "bar_chart",
  status: "production",
  inputSchema: BarChartInput,
  Render: BarChartRender,
  defaults: () =>
    BarChartInput.parse({
      intent: "Show monthly active users tripling across the quarter",
      style: { family: "dark" },
      placement: { bbox_norm: [0.1, 0.3, 0.8, 0.42] },
      reveal: "stagger",
      value_format: "{n}K",
      highlight_index: 3,
      title: "Monthly active users",
      data: [
        { label: "Jan", value: 42 },
        { label: "Feb", value: 68 },
        { label: "Mar", value: 95 },
        { label: "Apr", value: 134 },
      ],
    }),
  specialistId: "mg-bar-chart-specialist",
  exemplars: [],
};
