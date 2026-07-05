/**
 * Counter — animated big-number stat with context (label + optional delta pill).
 * The "counter" graphic_type: a hero number that counts up from `from` → `value`
 * while it scales/de-blurs in, its label rises into place, and an optional delta
 * pill pops in tinted up/down. The infographic you reach for to land a single
 * impactful metric.
 *
 * Motion layers (motion-floor ≥3): number count-up · number scale+blur entrance ·
 * label fade+translateY · delta pill scale-pop. hw-accel only (transform/opacity/
 * filter:blur). honors reduceMotion (snaps to final state).
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2
 * Specialist: mg-counter-specialist
 */
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { MGBaseInput } from "../../contract";
import { resolveTokens } from "../../tokens";
import type { MotionComponent } from "../../types";

export const CounterInput = MGBaseInput.extend({
  value: z.number(),
  from: z.number().default(0),
  value_format: z.string().default("{n}"),
  label: z.string(),
  sublabel: z.string().optional(),
  delta: z
    .object({
      value: z.number(),
      direction: z.enum(["up", "down"]),
    })
    .optional(),
});
export type CounterInput = z.infer<typeof CounterInput>;

/** Parse #RGB / #RRGGBB → [r,g,b] (0..255). */
const toRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.replace(/(.)/g, "$1$1") : h;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
};
/** The palette swatch with the highest green-dominance (g − max(r,b)). */
const greenest = (palette: string[]): string | undefined =>
  [...palette].sort((a, b) => {
    const [ar, ag, ab] = toRgb(a);
    const [br, bg, bb] = toRgb(b);
    return bg - Math.max(br, bb) - (ag - Math.max(ar, ab));
  })[0];
/** The palette swatch with the highest red-dominance (r − max(g,b)). */
const reddest = (palette: string[]): string | undefined =>
  [...palette].sort((a, b) => {
    const [ar, ag, ab] = toRgb(a);
    const [br, bg, bb] = toRgb(b);
    return br - Math.max(bg, bb) - (ar - Math.max(ag, ab));
  })[0];

const CounterRender: React.FC<{ input: CounterInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = resolveTokens(input.style);
  const reduce = input.reduceMotion;

  const [nx, ny, nw, nh] = input.placement.bbox_norm;
  const box = { x: nx * width, y: ny * height, w: nw * width, h: nh * height };

  const enterF = Math.max(1, Math.round((input.timing.enter.duration_ms / 1000) * fps));

  // Layer 1: number count-up (eased from → value)
  const countT = reduce
    ? 1
    : spring({ frame, fps, config: t.spring, durationInFrames: enterF });
  const current = Math.round(input.from + (input.value - input.from) * countT);

  // Layer 2: number scale (0.92→1) + blur (12px→0) entrance
  const numScale = reduce ? 1 : interpolate(countT, [0, 1], [0.92, 1]);
  const numBlur = reduce ? 0 : interpolate(countT, [0, 1], [12, 0], { extrapolateRight: "clamp" });
  const numOpacity = reduce
    ? 1
    : interpolate(frame, [0, enterF * 0.4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Layer 3: label fade + translate up
  const labelDelay = Math.round(enterF * 0.25);
  const labelT = reduce
    ? 1
    : interpolate(frame, [labelDelay, labelDelay + enterF * 0.6], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
  const labelY = reduce ? 0 : interpolate(labelT, [0, 1], [28, 0]);

  // Layer 4 (optional): delta pill scale-pop
  const pillDelay = Math.round(enterF * 0.7);
  const pillT = reduce
    ? 1
    : spring({ frame: frame - pillDelay, fps, config: t.spring, durationInFrames: Math.round(enterF * 0.7) });
  const up = input.delta?.direction === "up";
  // green-ish (up) / red-ish (down). Scan the family palette for the most
  // green / most red swatch; fall back to accent (warm/red-ish in every family).
  const pillColor = up ? greenest(t.palette) ?? t.accent : reddest(t.palette) ?? t.accent;

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
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Layers 1+2: big number — count-up + scale + blur */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 18,
            fontFamily: t.fontMono,
            fontSize: 188,
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: -4,
            color: t.text,
            opacity: numOpacity,
            transform: `scale(${numScale})`,
            transformOrigin: "center bottom",
            filter: `blur(${numBlur}px)`,
            willChange: "transform, filter, opacity",
          }}
        >
          <span>{fmt(current)}</span>

          {/* Layer 4: delta pill */}
          {input.delta ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontFamily: t.fontFamily,
                fontSize: 38,
                fontWeight: 700,
                lineHeight: 1,
                color: pillColor,
                background: `${pillColor}22`,
                border: `2px solid ${pillColor}55`,
                borderRadius: 999,
                padding: "10px 20px",
                opacity: Math.min(1, pillT),
                transform: `scale(${interpolate(Math.min(1, pillT), [0, 1], [0.6, 1])})`,
                transformOrigin: "left center",
                willChange: "transform, opacity",
              }}
            >
              {up ? "▲" : "▼"} {fmt(input.delta.value)}
            </span>
          ) : null}
        </div>

        {/* Layer 3: label (+ optional sublabel) — fade + translate up */}
        <div
          style={{
            marginTop: 36,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            opacity: labelT,
            transform: `translateY(${labelY}px)`,
            willChange: "transform, opacity",
          }}
        >
          <div style={{ fontSize: 48, fontWeight: 700, letterSpacing: -0.5, color: t.text, textAlign: "center" }}>
            {input.label}
          </div>
          {input.sublabel ? (
            <div style={{ fontSize: 32, fontWeight: 500, color: t.textMuted, textAlign: "center" }}>
              {input.sublabel}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const counter: MotionComponent<CounterInput> = {
  id: "data-viz/counter",
  category: "counter",
  status: "production",
  inputSchema: CounterInput,
  Render: CounterRender,
  defaults: () =>
    CounterInput.parse({
      intent: "Show downloads climbing 24% this week",
      style: { family: "dark" },
      placement: { bbox_norm: [0.1, 0.34, 0.8, 0.32] },
      value: 1280,
      from: 0,
      value_format: "{n}",
      label: "Downloads this week",
      delta: { value: 24, direction: "up" },
    }),
  specialistId: "mg-counter-specialist",
  exemplars: [],
};
