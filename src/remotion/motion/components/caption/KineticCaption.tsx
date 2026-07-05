/**
 * KineticCaption — word-by-word kinetic caption (our re-implementation of
 * ReelStack's StaggeredWords idea). The captions gap the data-viz components
 * don't cover. Same MGCS pattern: typed contract → token variant → hw-accel
 * render → descriptor.
 *
 * Motion layers (motion-floor ≥3): container fade-in · per-word translateY+scale
 * entrance · active-word color + scale bump. hw-accel only (transform/opacity).
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2
 * Specialist: mg-caption-specialist
 */
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { Hex, MGBaseInput } from "../../contract";
import { resolveTokens } from "../../tokens";
import type { MotionComponent } from "../../types";

export const KineticCaptionInput = MGBaseInput.extend({
  text: z.string(),
  mode: z.enum(["word_by_word", "all"]).default("word_by_word"),
  font_size: z.number().default(64),
  uppercase: z.boolean().default(false),
  active_word_color: Hex.optional(),
  per_word_ms: z.number().default(140),
});
export type KineticCaptionInput = z.infer<typeof KineticCaptionInput>;

const KineticCaptionRender: React.FC<{ input: KineticCaptionInput }> = ({ input }) => {
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

  const activeColor = input.active_word_color ?? t.accent;
  const words = input.text.split(/\s+/).filter(Boolean);

  // per-word stagger in frames; in "all" mode every word shares delay 0.
  const stepF = input.mode === "all" || reduce ? 0 : Math.max(1, Math.round((input.per_word_ms / 1000) * fps));
  const wordDurF = Math.max(1, Math.round(enterF * 0.9));

  // index of the most-recently-revealed word (the emphasized one).
  const activeIndex = reduce ? words.length - 1 : Math.min(words.length - 1, Math.floor(frame / Math.max(1, stepF)));

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
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          alignContent: "center",
          gap: `${Math.round(input.font_size * 0.18)}px ${Math.round(input.font_size * 0.32)}px`,
          textAlign: "center",
          opacity: containerOpacity,
          willChange: "opacity",
        }}
      >
        {words.map((w, i) => {
          const delay = i * stepF;
          const enter = reduce
            ? 1
            : spring({ frame: frame - delay, fps, config: t.spring, durationInFrames: wordDurF });

          const ty = interpolate(enter, [0, 1], [16, 0]);
          const scale = interpolate(enter, [0, 1], [0.9, 1]);

          const isActive = !reduce && i === activeIndex;
          // active word: color + slight scale bump that settles as the next word lands.
          const bumpRaw = isActive
            ? spring({ frame: frame - delay, fps, config: t.spring, durationInFrames: Math.max(1, stepF) })
            : 1;
          const bump = isActive ? 1 + 0.08 * (1 - Math.min(1, bumpRaw)) : 1;

          const color = i === activeIndex ? activeColor : t.text;

          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                fontSize: input.font_size,
                fontWeight: 700,
                lineHeight: 1.08,
                letterSpacing: -0.5,
                textTransform: input.uppercase ? "uppercase" : "none",
                color,
                opacity: enter,
                transform: `translateY(${ty}px) scale(${scale * bump})`,
                transformOrigin: "center bottom",
                willChange: "transform, opacity",
              }}
            >
              {w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

export const kineticCaption: MotionComponent<KineticCaptionInput> = {
  id: "caption/kinetic",
  category: "kinetic_caption",
  status: "production",
  inputSchema: KineticCaptionInput,
  Render: KineticCaptionRender,
  defaults: () =>
    KineticCaptionInput.parse({
      intent: "Punch the key line in word-by-word for retention",
      style: { family: "dark" },
      placement: { bbox_norm: [0.1, 0.58, 0.8, 0.18] },
      text: "This changes everything",
      uppercase: true,
    }),
  specialistId: "mg-caption-specialist",
  exemplars: [],
};
