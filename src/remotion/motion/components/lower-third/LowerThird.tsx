/**
 * LowerThird — name / title chyron (the broadcast-style identifier overlay).
 * Follows the full MGCS pattern: typed contract → token variants →
 * hw-accelerated render → descriptor.
 *
 * Motion layers (motion-floor ≥3): card surface fade + rise · accent bar wipe
 * (scaleX, origin left) · title slide-up + fade · subtitle delayed fade. All
 * movement is hw-accel only (transform / opacity) — never top/left/width/height.
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2
 * Specialist: mg-lower-third-specialist
 */
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { MGBaseInput } from "../../contract";
import { resolveTokens } from "../../tokens";
import type { MotionComponent } from "../../types";

export const LowerThirdInput = MGBaseInput.extend({
  title: z.string(),
  subtitle: z.string().optional(),
  accent_bar: z.boolean().default(true),
  align: z.enum(["left", "center"]).default("left"),
});
export type LowerThirdInput = z.infer<typeof LowerThirdInput>;

const LowerThirdRender: React.FC<{ input: LowerThirdInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = resolveTokens(input.style);
  const reduce = input.reduceMotion;

  const [nx, ny, nw, nh] = input.placement.bbox_norm;
  const box = { x: nx * width, y: ny * height, w: nw * width, h: nh * height };

  const enterF = Math.max(1, Math.round((input.timing.enter.duration_ms / 1000) * fps));
  const isCenter = input.align === "center";

  // Layer 1 — card surface: fade + rise (translateY)
  const cardSpring = reduce ? 1 : spring({ frame, fps, config: t.spring, durationInFrames: enterF });
  const cardOpacity = reduce
    ? 1
    : interpolate(frame, [0, enterF * 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cardRise = reduce ? 0 : interpolate(cardSpring, [0, 1], [28, 0]);

  // Layer 2 — accent bar: wipe in via transform scaleX (origin left)
  const barDelay = reduce ? 0 : Math.round(enterF * 0.12);
  const barScaleX = reduce
    ? 1
    : spring({ frame: frame - barDelay, fps, config: t.spring, durationInFrames: enterF });

  // Layer 3 — title: slide up (translateY) + fade
  const titleDelay = reduce ? 0 : Math.round(enterF * 0.18);
  const titleSpring = reduce
    ? 1
    : spring({ frame: frame - titleDelay, fps, config: t.spring, durationInFrames: enterF });
  const titleRise = reduce ? 0 : interpolate(titleSpring, [0, 1], [22, 0]);
  const titleOpacity = reduce
    ? 1
    : interpolate(frame, [titleDelay, titleDelay + enterF * 0.5], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });

  // Layer 4 — subtitle: delayed fade in
  const subDelay = reduce ? 0 : Math.round(enterF * 0.36);
  const subOpacity = reduce
    ? 1
    : interpolate(frame, [subDelay, subDelay + enterF * 0.6], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
  const subRise = reduce ? 0 : interpolate(subOpacity, [0, 1], [10, 0]);

  const barW = 8;

  return (
    <AbsoluteFill style={{ fontFamily: t.fontFamily }}>
      <div
        style={{
          position: "absolute",
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          opacity: cardOpacity,
          transform: `translateY(${cardRise}px)`,
          willChange: "transform, opacity",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: isCenter ? "column" : "row",
            alignItems: isCenter ? "center" : "stretch",
            gap: isCenter ? 0 : 24,
            width: "100%",
            height: "100%",
            background: t.surface,
            borderRadius: t.radius,
            padding: "28px 36px",
            boxSizing: "border-box",
            boxShadow: `0 24px 60px ${t.bg}55`,
            overflow: "hidden",
          }}
        >
          {input.accent_bar ? (
            isCenter ? (
              <div
                style={{
                  width: 120,
                  height: barW,
                  background: t.accent,
                  borderRadius: barW / 2,
                  marginBottom: 18,
                  transform: `scaleX(${barScaleX})`,
                  transformOrigin: "left center",
                  willChange: "transform",
                }}
              />
            ) : (
              <div
                style={{
                  flex: `0 0 ${barW}px`,
                  alignSelf: "stretch",
                  background: t.accent,
                  borderRadius: barW / 2,
                  transform: `scaleX(${barScaleX})`,
                  transformOrigin: "left center",
                  willChange: "transform",
                }}
              />
            )
          ) : null}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: isCenter ? "center" : "flex-start",
              textAlign: isCenter ? "center" : "left",
              minWidth: 0,
              flex: 1,
            }}
          >
            <div
              style={{
                fontSize: 52,
                fontWeight: 700,
                letterSpacing: -0.5,
                lineHeight: 1.1,
                color: t.text,
                opacity: titleOpacity,
                transform: `translateY(${titleRise}px)`,
                willChange: "transform, opacity",
              }}
            >
              {input.title}
            </div>
            {input.subtitle ? (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 30,
                  fontWeight: 600,
                  letterSpacing: 0.2,
                  color: t.textMuted,
                  opacity: subOpacity,
                  transform: `translateY(${subRise}px)`,
                  willChange: "transform, opacity",
                }}
              >
                {input.subtitle}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const lowerThird: MotionComponent<LowerThirdInput> = {
  id: "lower-third/standard",
  category: "lower_third",
  status: "production",
  inputSchema: LowerThirdInput,
  Render: LowerThirdRender,
  defaults: () =>
    LowerThirdInput.parse({
      intent: "Identify the on-screen speaker with name and role",
      style: { family: "glass" },
      // bbox bottom = (0.65 + 0.12) * 1920 = 1478px → above the IG bottom safe zone (y≈1480)
      placement: { bbox_norm: [0.08, 0.65, 0.7, 0.12] },
      title: "Dr. Sarah Chen",
      subtitle: "Lead Researcher",
      accent_bar: true,
      align: "left",
    }),
  specialistId: "mg-lower-third-specialist",
  exemplars: [],
};
