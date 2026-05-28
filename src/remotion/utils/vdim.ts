export const VDIM = {
  WIDTH: 1080,
  HEIGHT: 1920,
  FPS: 30,
} as const;

export function secondsToFrames(seconds: number, fps = VDIM.FPS): number {
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames: number, fps = VDIM.FPS): number {
  return frames / fps;
}

export function clampPosition(x: number, y: number): [number, number] {
  return [
    Math.max(0, Math.min(x, VDIM.WIDTH)),
    Math.max(0, Math.min(y, VDIM.HEIGHT)),
  ];
}

export function scaleForPreview(
  value: number,
  previewWidth: number
): number {
  return (value / VDIM.WIDTH) * previewWidth;
}
