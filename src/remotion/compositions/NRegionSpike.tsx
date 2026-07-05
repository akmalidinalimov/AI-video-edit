/**
 * NRegionSpike — Wave-2 feasibility spike for the N-REGION composite renderer.
 *
 * The UNIVERSAL-1 architecture decision (Remotion composite over FFmpeg feeder tracks) rests on
 * an UNPROVEN extrapolation: this repo has only ever server-rendered seconds-long MG clips, never
 * a 45-70s multi-<OffthreadVideo> composite. This composition exists to measure that: N absolute-
 * positioned regions (static styled bands, video windows, a rounded-rect PIP) rendered for the
 * full reel duration. If render time is acceptable (< ~4x realtime), the architecture stands.
 *
 * This is also the seed of the real NRegionComposite: the RegionSpec shape below is the adapter
 * target for DecodedRegion (fractional decode geometry → pixels at the render canvas).
 */
import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useVideoConfig } from "remotion";

export interface SpikeRegionSpec {
  id: string;
  kind: "static_band" | "content_window" | "aroll";
  /** Fractional geometry (0..1 of canvas) — matches the decode's fractional rects. */
  rect: { x: number; y: number; w: number; h: number };
  /** public-relative video path for content_window/aroll (pre-baked feeder track). */
  source?: string;
  /** corner radius as a fraction of canvas width (rounded-rect PIP). */
  cornerRadiusFrac?: number;
  bg?: string;
  label?: string;
  z: number;
}

export interface NRegionSpikeProps {
  regions: SpikeRegionSpec[];
  durationInFrames?: number;
  muted?: boolean;
}

export const NRegionSpike: React.FC<NRegionSpikeProps> = ({ regions, muted = true }) => {
  const { width, height } = useVideoConfig();
  const sorted = [...(regions ?? [])].sort((a, b) => a.z - b.z);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {sorted.map((r) => {
        const px = {
          left: Math.round(r.rect.x * width),
          top: Math.round(r.rect.y * height),
          width: Math.round(r.rect.w * width),
          height: Math.round(r.rect.h * height),
        };
        const radius = r.cornerRadiusFrac ? Math.round(r.cornerRadiusFrac * width) : 0;
        const common: React.CSSProperties = {
          position: "absolute",
          ...px,
          borderRadius: radius,
          overflow: "hidden",
          zIndex: r.z,
        };
        if (r.kind === "static_band") {
          return (
            <div key={r.id} style={{ ...common, background: r.bg ?? "#111", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {r.label ? (
                <span style={{ color: "#fff", fontFamily: "Arial, sans-serif", fontWeight: 700, fontSize: Math.round(px.height * 0.42) }}>
                  {r.label}
                </span>
              ) : null}
            </div>
          );
        }
        // content_window / aroll: fill the region with the video (cover behavior).
        return (
          <div key={r.id} style={common}>
            {r.source ? (
              <OffthreadVideo
                src={staticFile(r.source)}
                muted={muted && r.kind !== "aroll"}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : null}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
