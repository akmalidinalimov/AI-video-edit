/**
 * KenBurns — cinematic pan/zoom on a STILL image (AI-generated or stock). The
 * cheapest motion modality: animate a ~$0.04 still instead of paying for AI video.
 *
 * Motion layers (motion-floor ≥3): scale push/pull · horizontal pan · vertical
 * pan · fade-in entrance. hw-accel only (transform/opacity). honors reduceMotion
 * (snaps to a static mid-frame). Image covers the frame; in a band it center-crops.
 *
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2
 * Specialist: mg-media-specialist
 */
import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { MGBaseInput } from "../../contract";
import type { MotionComponent } from "../../types";

export const KenBurnsInput = MGBaseInput.extend({
  /** public-relative path (served via staticFile) or an http(s) URL. */
  src: z.string(),
  zoom: z.enum(["in", "out"]).default("in"),
  pan: z.enum(["left", "right", "up", "down", "none"]).default("right"),
  start_scale: z.number().default(1.06),
  end_scale: z.number().default(1.22),
  pan_px: z.number().default(64),
});
export type KenBurnsInput = z.infer<typeof KenBurnsInput>;

const KenBurnsRender: React.FC<{ input: KenBurnsInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const reduce = input.reduceMotion;
  const end = Math.max(1, durationInFrames - 1);

  // progress 0→1 across the clip (snaps to mid-frame when motion is reduced)
  const p = reduce ? 0.5 : interpolate(frame, [0, end], [0, 1], { extrapolateRight: "clamp" });

  // Layer 1: scale push-in / pull-out
  const scale =
    input.zoom === "in"
      ? interpolate(p, [0, 1], [input.start_scale, input.end_scale])
      : interpolate(p, [0, 1], [input.end_scale, input.start_scale]);

  // Layers 2+3: horizontal + vertical pan (only the chosen axis travels)
  const hx = input.pan === "left" ? 1 : input.pan === "right" ? -1 : 0;
  const vy = input.pan === "up" ? 1 : input.pan === "down" ? -1 : 0;
  const tx = interpolate(p, [0, 1], [hx * input.pan_px, -hx * input.pan_px]);
  const ty = interpolate(p, [0, 1], [vy * input.pan_px, -vy * input.pan_px]);

  // Layer 4: gentle fade-in entrance
  const opacity = reduce ? 1 : interpolate(frame, [0, Math.round(end * 0.12)], [0, 1], { extrapolateRight: "clamp" });

  const src = /^https?:\/\//.test(input.src) ? input.src : staticFile(input.src);

  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity }}>
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translate(${tx}px, ${ty}px)`,
          transformOrigin: "center center",
          willChange: "transform",
        }}
      />
    </AbsoluteFill>
  );
};

export const kenBurns: MotionComponent<KenBurnsInput> = {
  id: "media/ken-burns",
  category: "media",
  status: "production",
  inputSchema: KenBurnsInput,
  Render: KenBurnsRender,
  defaults: () =>
    KenBurnsInput.parse({
      intent: "Give a still cinematic life with a slow pan/zoom",
      style: { family: "dark" },
      src: "uploads/generated/still-hero.jpg",
      zoom: "in",
      pan: "right",
    }),
  specialistId: "mg-media-specialist",
  exemplars: [],
};
