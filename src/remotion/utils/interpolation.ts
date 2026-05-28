import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export function useSpringAnimation(
  from: number,
  to: number,
  delay = 0
) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 15, stiffness: 120 },
  });

  return interpolate(progress, [0, 1], [from, to]);
}

export function useEaseOut(
  from: number,
  to: number,
  durationFrames: number,
  delay = 0
) {
  const frame = useCurrentFrame();

  return interpolate(
    frame - delay,
    [0, durationFrames],
    [from, to],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
}

export function useFadeIn(durationFrames = 15, delay = 0) {
  const frame = useCurrentFrame();
  return interpolate(frame - delay, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
