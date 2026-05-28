import type { BRollMotion } from "@/lib/types/timeline";
import type { BRollCatalogEntry } from "@/lib/types/project";

const FPS = 30;

export function computeMotionKeyframes(
  entry: BRollCatalogEntry,
  segmentDurationSec: number,
  startFrame: number
): BRollMotion {
  const totalFrames = Math.round(segmentDurationSec * FPS);
  const endFrame = startFrame + totalFrames;

  // Screen recordings — scroll upward
  if (entry.classification === "screen_recording" || entry.camera_motion === "scroll") {
    const maxOffset = entry.crop_recommendation?.crop?.height
      ? Math.max(entry.crop_recommendation.crop.height - 1920, 300)
      : 800;

    return {
      type: "scroll",
      keyframes: [
        { frame: startFrame, x: 0, y: 0, scale: 1 },
        { frame: endFrame, x: 0, y: -maxOffset, scale: 1 },
      ],
      easing: "ease-in-out",
    };
  }

  // Static images — Ken Burns (slow zoom + slight pan)
  if (entry.type === "image") {
    const panX = segmentDurationSec > 3 ? 30 : 15;
    const panY = segmentDurationSec > 3 ? 20 : 10;
    const zoomEnd = segmentDurationSec > 4 ? 1.08 : 1.04;

    return {
      type: "ken_burns",
      keyframes: [
        { frame: startFrame, x: 0, y: 0, scale: 1.0 },
        { frame: endFrame, x: panX, y: panY, scale: zoomEnd },
      ],
      easing: "ease-in-out",
    };
  }

  // Videos with camera motion detected
  if (entry.camera_motion === "pan_left" || entry.camera_motion === "pan_right") {
    const direction = entry.camera_motion === "pan_left" ? -1 : 1;
    return {
      type: "pan",
      keyframes: [
        { frame: startFrame, x: 0, y: 0, scale: 1 },
        { frame: endFrame, x: direction * 60, y: 0, scale: 1 },
      ],
      easing: "linear",
    };
  }

  // Videos with zoom
  if (entry.camera_motion === "zoom_in") {
    return {
      type: "zoom_in",
      keyframes: [
        { frame: startFrame, x: 0, y: 0, scale: 1.0 },
        { frame: endFrame, x: 0, y: 0, scale: 1.15 },
      ],
      easing: "ease-out",
    };
  }

  if (entry.camera_motion === "zoom_out") {
    return {
      type: "zoom_out",
      keyframes: [
        { frame: startFrame, x: 0, y: 0, scale: 1.1 },
        { frame: endFrame, x: 0, y: 0, scale: 1.0 },
      ],
      easing: "ease-out",
    };
  }

  // Default — very subtle zoom for videos with no detected motion
  return {
    type: "static",
    keyframes: [
      { frame: startFrame, x: 0, y: 0, scale: 1.0 },
      { frame: endFrame, x: 0, y: 0, scale: 1.02 },
    ],
    easing: "linear",
  };
}
