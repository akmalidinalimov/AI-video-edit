import React from "react";
import { OffthreadVideo, useCurrentFrame, spring, useVideoConfig } from "remotion";
import type { TimelineSegment } from "@/lib/types/timeline";

interface ARollPIPProps {
  aroll: NonNullable<TimelineSegment["aroll"]>;
  /** Enable subtle zoom pulse on emphasis frames */
  emphasisFrames?: number[];
}

export const ARollPIP: React.FC<ARollPIPProps> = ({ aroll, emphasisFrames = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const [x, y] = aroll.position;
  const [width, height] = aroll.size;
  const isCircle = aroll.shape === "circle";

  // Dynamic speaker zoom on emphasis
  let emphasisScale = 1.0;
  for (const ef of emphasisFrames) {
    const dist = Math.abs(frame - ef);
    if (dist < 20) {
      const pulse = spring({
        frame: frame - ef,
        fps,
        config: { damping: 12, stiffness: 200 },
      });
      emphasisScale = Math.max(emphasisScale, 1 + 0.08 * pulse * Math.max(0, 1 - dist / 20));
    }
  }

  // Entry animation — scale spring from 0 to 1
  const entryScale = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 100 },
    durationInFrames: 20,
  });

  const totalScale = entryScale * emphasisScale;

  const containerStyle: React.CSSProperties = {
    position: "absolute",
    left: x,
    top: y,
    width,
    height,
    borderRadius: isCircle ? "50%" : aroll.border ? 12 : 0,
    overflow: "hidden",
    transform: `scale(${totalScale})`,
    transformOrigin: "center center",
    boxShadow: aroll.shadow ?? "0 4px 20px rgba(0,0,0,0.4)",
  };

  if (aroll.border) {
    containerStyle.border = `${aroll.border.width}px solid ${aroll.border.color}`;
  }

  return (
    <div style={containerStyle}>
      <OffthreadVideo
        src={aroll.src}
        startFrom={Math.round((aroll.startFrom ?? 0) * fps)}
        muted
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
    </div>
  );
};
