import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { StyleCloneVideo, type StyleCloneVideoProps } from "./compositions/StyleCloneVideo";
import { Reel2Video, type Reel2Props } from "./compositions/Reel2Video";
import { MotionLibraryProbe, PROBE_DURATION } from "./compositions/MotionLibraryProbe";
import { VDIM } from "./utils/vdim";
import { DEFAULT_RENDER_CONFIG } from "@/lib/types/render";
import type { CaptionStyle } from "@/lib/types/timeline";

/**
 * Dynamic metadata: read timeline.duration and timeline.fps from props
 * to set the correct durationInFrames at render time.
 * Falls back to 300 frames (10s @ 30fps) if no timeline data.
 */
const calculateVideoMetadata: CalculateMetadataFunction<StyleCloneVideoProps> = async ({
  props,
}) => {
  const fps = props.timeline?.fps || VDIM.FPS;
  const duration = props.timeline?.duration || 10;
  return {
    durationInFrames: Math.max(1, Math.round(duration * fps)),
    fps,
  };
};

/**
 * Remotion Root — registers all compositions.
 *
 * The main "StyleCloneVideo" composition is used by both
 * the preview player and the server-side renderer.
 * calculateMetadata dynamically sets duration from timeline props.
 */
export const RemotionRoot: React.FC = () => {
  // Cast to satisfy Remotion's loose component typing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const VideoComponent = StyleCloneVideo as unknown as React.ComponentType<Record<string, unknown>>;

  // Reel 2 — IMG_6298 split-screen/tutorial grammar (distinct per-segment sources)
  const Reel2Component = Reel2Video as unknown as React.ComponentType<Record<string, unknown>>;
  const calcReel2: CalculateMetadataFunction<Reel2Props> = async ({ props }) => ({
    durationInFrames: Math.max(1, props.durationInFrames || 300),
    fps: props.fps || VDIM.FPS,
  });

  const MotionProbeComponent = MotionLibraryProbe as unknown as React.ComponentType<Record<string, unknown>>;

  return (
    <>
      {/* Motion-library render-test probe — 16 self-contained pattern segments (Step B). */}
      <Composition
        id="MotionLibraryProbe"
        component={MotionProbeComponent}
        durationInFrames={PROBE_DURATION}
        fps={VDIM.FPS}
        width={VDIM.WIDTH}
        height={VDIM.HEIGHT}
      />

      {/* Reel 2: cloned IMG_6298 editing style */}
      <Composition
        id="Reel2Video"
        component={Reel2Component}
        durationInFrames={300}
        fps={VDIM.FPS}
        width={VDIM.WIDTH}
        height={VDIM.HEIGHT}
        calculateMetadata={calcReel2 as CalculateMetadataFunction<Record<string, unknown>>}
        defaultProps={{ fps: VDIM.FPS, width: VDIM.WIDTH, height: VDIM.HEIGHT, durationInFrames: 300, logoText: "M", topPillText: "Real Video", bottomPillText: "Lip Sync Seedance 2.0", segments: [] }}
      />

      {/* Main 9:16 vertical video */}
      <Composition
        id="StyleCloneVideo"
        component={VideoComponent}
        durationInFrames={300}
        fps={VDIM.FPS}
        width={VDIM.WIDTH}
        height={VDIM.HEIGHT}
        calculateMetadata={calculateVideoMetadata as CalculateMetadataFunction<Record<string, unknown>>}
        defaultProps={{
          timeline: {
            id: "preview",
            duration: 10,
            fps: VDIM.FPS,
            width: VDIM.WIDTH,
            height: VDIM.HEIGHT,
            segments: [],
            audio: [],
            captions: { lines: [], style: defaultCaptionStyle(), position: [540, 1600] as [number, number] },
            hook: null,
            color_grade: { temperature: "neutral" as const, saturation: 1, contrast: 1, brightness: 1 },
          },
          renderConfig: DEFAULT_RENDER_CONFIG,
        }}
      />

      {/* Square 1:1 export variant */}
      <Composition
        id="StyleCloneVideo-1x1"
        component={VideoComponent}
        durationInFrames={300}
        fps={VDIM.FPS}
        width={1080}
        height={1080}
        calculateMetadata={calculateVideoMetadata as CalculateMetadataFunction<Record<string, unknown>>}
        defaultProps={{
          timeline: {
            id: "preview-1x1",
            duration: 10,
            fps: VDIM.FPS,
            width: 1080,
            height: 1080,
            segments: [],
            audio: [],
            captions: { lines: [], style: defaultCaptionStyle(), position: [540, 900] as [number, number] },
            hook: null,
            color_grade: { temperature: "neutral" as const, saturation: 1, contrast: 1, brightness: 1 },
          },
          renderConfig: { ...DEFAULT_RENDER_CONFIG, format: "1:1" as const },
        }}
      />

      {/* Landscape 16:9 export variant */}
      <Composition
        id="StyleCloneVideo-16x9"
        component={VideoComponent}
        durationInFrames={300}
        fps={VDIM.FPS}
        width={1920}
        height={1080}
        calculateMetadata={calculateVideoMetadata as CalculateMetadataFunction<Record<string, unknown>>}
        defaultProps={{
          timeline: {
            id: "preview-16x9",
            duration: 10,
            fps: VDIM.FPS,
            width: 1920,
            height: 1080,
            segments: [],
            audio: [],
            captions: { lines: [], style: defaultCaptionStyle(), position: [960, 950] as [number, number] },
            hook: null,
            color_grade: { temperature: "neutral" as const, saturation: 1, contrast: 1, brightness: 1 },
          },
          renderConfig: { ...DEFAULT_RENDER_CONFIG, format: "16:9" as const },
        }}
      />
    </>
  );
};

function defaultCaptionStyle(): CaptionStyle {
  return {
    fontSize: 42,
    fontWeight: "bold",
    color: "#FFFFFF",
    highlightColor: "#FFD700",
    backgroundColor: "rgba(0,0,0,0.6)",
    padding: 12,
    borderRadius: 8,
    textAlign: "center",
    maxWidth: 900,
  };
}
