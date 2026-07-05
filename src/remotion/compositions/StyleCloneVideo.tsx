import React, { useCallback } from "react";
import {
  Sequence,
  useVideoConfig,
  useCurrentFrame,
  OffthreadVideo,
  Video,
  interpolate,
  getRemotionEnvironment,
} from "remotion";
import type { TimelineDefinition, TimelineSegment } from "@/lib/types/timeline";
import type { ColorGrade } from "@/lib/types/styleProfile";
import type { RenderConfig } from "@/lib/types/render";
import { CaptionRenderer } from "../components/CaptionRenderer";
import { TextOverlayRenderer } from "../components/TextOverlayRenderer";
import { VDIM } from "../utils/vdim";

export type StyleCloneVideoProps = {
  timeline: TimelineDefinition;
  renderConfig: RenderConfig;
};

/**
 * Use <Video> during server-side rendering to avoid compositor memory issues
 * on machines with limited RAM. Use <OffthreadVideo> for preview (more accurate).
 *
 * <Video> uses Chrome's built-in video decoder (no compositor process).
 * <OffthreadVideo> uses Remotion's Rust compositor (exact frames but ~5MB alloc per frame).
 */
const VideoTag = (() => {
  try {
    const env = getRemotionEnvironment();
    // In rendering mode, use lightweight <Video> to avoid compositor OOM
    if (env.isRendering) return Video;
  } catch {
    // getRemotionEnvironment may throw outside Remotion context
  }
  // In preview (Player), use OffthreadVideo for better performance
  return OffthreadVideo;
})();

/**
 * Composition matching the reference video's structure:
 * 1. ONE continuous B-roll video — position/size/scroll change per segment
 *    (e.g. bottom-half in vertical_split, full-screen in pip_overlay)
 * 2. ONE continuous A-roll video with its own audio — position/size/shape change per segment
 * 3. Text overlays (title cards, labels from reference style)
 * 4. Captions overlay (word-by-word subtitles)
 *
 * IMPORTANT: Both A-roll and B-roll use a SINGLE continuous video element each.
 * This prevents demuxer seek errors that happen when multiple video elements
 * with different startFrom values try to seek into the same MOV file.
 * The natural sequential playback shows different content per segment automatically.
 */
export const StyleCloneVideo: React.FC<StyleCloneVideoProps> = ({
  timeline,
  renderConfig,
}) => {
  const { durationInFrames, fps } = useVideoConfig();

  // Find the A-roll source — all segments reference the same A-roll clip
  const arollSrc = timeline.segments.find((s) => s.aroll)?.aroll?.src ?? "";

  // Find the B-roll source — one continuous video for all segments
  const brollSrc = timeline.segments.find((s) => s.broll?.src)?.broll?.src ?? "";

  // Build CSS filter from color grade
  const colorFilter = buildColorFilter(timeline.color_grade);

  // Error handler for video elements — log but don't crash
  const handleVideoError = useCallback((err: Error) => {
    console.warn("Video playback error (non-fatal):", err.message);
  }, []);

  return (
    <div
      style={{
        width: VDIM.WIDTH,
        height: VDIM.HEIGHT,
        backgroundColor: "#000",
        position: "relative",
        overflow: "hidden",
        filter: colorFilter || undefined,
      }}
    >
      {/* Layer 1: ONE continuous B-Roll — position/size/scroll change per segment */}
      {brollSrc && (
        <Sequence from={0} durationInFrames={durationInFrames} name="B-Roll Continuous">
          <ContinuousBRoll
            src={brollSrc}
            segments={timeline.segments}
            onError={handleVideoError}
          />
        </Sequence>
      )}

      {/* Layer 2: ONE continuous A-roll with its own audio */}
      {arollSrc && (
        <Sequence from={0} durationInFrames={durationInFrames} name="A-Roll Continuous">
          <ContinuousARoll
            src={arollSrc}
            segments={timeline.segments}
            pipStyle={timeline.segments[0]?.aroll}
            onError={handleVideoError}
          />
        </Sequence>
      )}

      {/* Layer 3: Text overlays (title cards from reference style) */}
      <Sequence from={0} durationInFrames={durationInFrames} name="Text Overlays">
        <TextOverlayRenderer segments={timeline.segments} />
      </Sequence>

      {/* Layer 4: Captions (word-by-word subtitles) */}
      <Sequence from={0} durationInFrames={durationInFrames} name="Captions">
        <CaptionRenderer captions={timeline.captions} />
      </Sequence>
    </div>
  );
};

/**
 * Renders B-roll as ONE continuous video.
 * Position, size, and scroll motion change per segment based on the timeline.
 * - In vertical_split: B-roll is smaller, positioned below the A-roll
 * - In pip_overlay: B-roll fills the full screen
 *
 * The natural sequential playback shows different app "steps" per segment
 * without needing per-segment startFrom seeking (which causes demuxer errors).
 */
interface ContinuousBRollProps {
  src: string;
  segments: TimelineDefinition["segments"];
  onError?: (err: Error) => void;
}

const ContinuousBRoll: React.FC<ContinuousBRollProps> = ({
  src,
  segments,
  onError,
}) => {
  const frame = useCurrentFrame();

  // Find which segment we're currently in
  const currentSegment =
    segments.find((s) => frame >= s.start_frame && frame < s.end_frame) ??
    segments[segments.length - 1];

  if (!currentSegment) return null;

  const broll = currentSegment.broll;
  const [bx, by] = broll.position ?? [0, 0];
  const [bw, bh] = broll.size ?? [VDIM.WIDTH, VDIM.HEIGHT];

  // Calculate scroll offset within current segment
  const segStartFrame = currentSegment.start_frame;
  const segEndFrame = currentSegment.end_frame;
  const segDuration = segEndFrame - segStartFrame;
  const relativeFrame = frame - segStartFrame;

  let scrollY = 0;
  if (broll.scroll && broll.scroll.speed > 0) {
    const maxOffset = broll.scroll.maxOffset;
    const direction = broll.scroll.direction === "down" ? 1 : -1;

    scrollY = interpolate(relativeFrame, [0, segDuration], [0, direction * maxOffset], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  // Calculate motion keyframes if present (takes priority over legacy scroll)
  let motionTransform = "";
  if (broll.motion && broll.motion.keyframes.length >= 2) {
    const kf = broll.motion.keyframes;

    const motionX = interpolate(
      relativeFrame,
      [0, segDuration],
      [kf[0].x, kf[kf.length - 1].x],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    const motionY = interpolate(
      relativeFrame,
      [0, segDuration],
      [kf[0].y, kf[kf.length - 1].y],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    const motionScale = interpolate(
      relativeFrame,
      [0, segDuration],
      [kf[0].scale, kf[kf.length - 1].scale],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );

    motionTransform = `translate(${motionX}px, ${motionY}px) scale(${motionScale})`;
    scrollY = 0; // motion overrides legacy scroll
  }

  return (
    <div
      style={{
        position: "absolute",
        left: bx,
        top: by,
        width: bw,
        height: bh,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          transform: motionTransform || (scrollY !== 0 ? `translateY(${scrollY}px)` : undefined),
          transformOrigin: "center center",
        }}
      >
        <VideoTag
          src={src}
          muted
          onError={onError}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </div>
    </div>
  );
};

/**
 * Renders the A-roll as one continuous video.
 * Position, size, and shape change per segment based on reference coordinates.
 * Audio plays naturally — no separate AudioMixer needed.
 */
interface ContinuousARollProps {
  src: string;
  segments: TimelineDefinition["segments"];
  pipStyle?: TimelineDefinition["segments"][0]["aroll"];
  onError?: (err: Error) => void;
}

const ContinuousARoll: React.FC<ContinuousARollProps> = ({
  src,
  segments,
  pipStyle,
  onError,
}) => {
  const frame = useCurrentFrame();

  // Find which segment we're currently in
  const currentSegment =
    segments.find((s) => frame >= s.start_frame && frame < s.end_frame) ??
    segments[segments.length - 1];

  const aroll = currentSegment?.aroll ?? pipStyle;
  if (!aroll) return null;

  const [x, y] = aroll.position;
  const [width, height] = aroll.size;
  const isCircle = aroll.shape === "circle";

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        borderRadius: isCircle ? "50%" : 12,
        overflow: "hidden",
        boxShadow: aroll.shadow ?? "0 4px 20px rgba(0,0,0,0.4)",
        border: aroll.border
          ? `${aroll.border.width}px solid ${aroll.border.color}`
          : undefined,
        zIndex: 10,
      }}
    >
      <VideoTag
        src={src}
        onError={onError}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
    </div>
  );
};

/**
 * Build a CSS filter string from color grade settings.
 * Only applies filters that differ from the default (1.0).
 */
function buildColorFilter(cg: ColorGrade): string {
  const parts: string[] = [];

  if (cg.brightness !== undefined && cg.brightness !== 1) {
    parts.push(`brightness(${cg.brightness})`);
  }
  if (cg.saturation !== undefined && cg.saturation !== 1) {
    parts.push(`saturate(${cg.saturation})`);
  }
  if (cg.contrast !== undefined && cg.contrast !== 1) {
    parts.push(`contrast(${cg.contrast})`);
  }

  // Temperature adjustment via hue-rotate + sepia
  if (cg.temperature === "warm") {
    parts.push("sepia(0.15)");
  } else if (cg.temperature === "cool") {
    parts.push("hue-rotate(10deg)");
  }
  // "neutral" = no temperature adjustment

  return parts.join(" ");
}
