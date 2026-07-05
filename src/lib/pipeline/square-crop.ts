/**
 * calculateSquareCrop — faithful TS port of the canonical crop rule
 * (scripts/multi-aroll-stage3-4.mjs, per docs/cropping-rules.md).
 *
 * THE rule: ALWAYS crop a talking person to a 1:1 SQUARE around the face —
 * head + shoulders, small top gap, ~90% fill, NO default zoom, centered on the
 * face, clamped inside the frame. Both the circle-PIP and stacked paths consume
 * this. Inputs are RAW YuNet measurements (face box height/center as fractions),
 * which are accurate + consistent so the same target frames identically.
 *
 * ⚠ SINGLE SOURCE OF TRUTH: this must stay byte-for-byte equivalent to the .mjs
 * original. Follow-up (B1 convergence): dedupe by having the .mjs import a shared
 * module. Until then, any change here MUST be mirrored in multi-aroll-stage3-4.mjs.
 */

export interface SquareCrop {
  cropX: number;
  cropY: number;
  cropSize: number;
}
export type CropMode = "circle" | "stack";

/** Per-method tightness offset. Method 2 = reference-matched (default). */
export const METHOD_FF_OFFSET: Record<number, number> = { 1: 0.04, 2: 0.0, 3: -0.04 };

/** Reference-matched circle framing (code default; overridable from a measured reference). */
export const CIRCLE_TARGET_DEFAULT = { faceFraction: 0.54, faceCenterYIn: 0.33 };

/** Fullscreen "stacked" square (a touch more face-dominant than the circle). */
export const STACK_TARGET = { faceFraction: 0.4, faceCenterYIn: 0.36 };

export interface BandCrop { cropX: number; cropY: number; cropW: number; cropH: number }

/**
 * calculateBandCrop — face-safe crop at an ARBITRARY target aspect (region width/height),
 * so the A-roll fills whatever region the REFERENCE actually uses (a wide band, a square, or a
 * 9:16 portrait) instead of a hardcoded 1:1 square. Same face-safety rule as the square crop
 * (head + shoulders, headroom via faceCenterYIn), generalized: the vertical extent is sized
 * from the face, the width is that extent × the target aspect, both clamped inside the source
 * WITHOUT changing the aspect (so scaling to the region never distorts the face).
 */
export function calculateBandCrop(
  srcW: number,
  srcH: number,
  faceHeight: number,
  faceCenterX: number,
  faceCenterY: number,
  /** region.width / region.height — the aspect the A-roll must fill */
  targetAspect: number,
  mode: CropMode = "stack",
  groupWidth?: number,
): BandCrop {
  const faceHeightPx = Math.max(1, faceHeight * srcH);
  const faceCenterXPx = (faceCenterX ?? 0.5) * srcW;
  const faceCenterYPx = (faceCenterY ?? 0.42) * srcH;
  const faceFraction = mode === "stack" ? STACK_TARGET.faceFraction : CIRCLE_TARGET_DEFAULT.faceFraction;
  const faceCenterYIn = mode === "stack" ? STACK_TARGET.faceCenterYIn : CIRCLE_TARGET_DEFAULT.faceCenterYIn;

  // vertical extent from the face (head + shoulders), same as the square path
  let cropH = Math.round(faceHeightPx / faceFraction);
  let cropW = Math.round(cropH * targetAspect);
  // multi-speaker: ensure the whole group fits horizontally (enlarge, keep aspect)
  if (groupWidth && groupWidth > 0) {
    const need = Math.round((groupWidth * srcW) / 0.82);
    if (need > cropW) { cropW = need; cropH = Math.round(cropW / targetAspect); }
  }
  // clamp inside the source, preserving the target aspect
  if (cropW > srcW) { cropW = srcW; cropH = Math.round(cropW / targetAspect); }
  if (cropH > srcH) { cropH = srcH; cropW = Math.round(cropH * targetAspect); }
  cropW = Math.min(cropW, srcW) & ~1; // even
  cropH = Math.min(cropH, srcH) & ~1;
  let cropY = Math.round(faceCenterYPx - cropH * faceCenterYIn);
  cropY = Math.max(0, Math.min(srcH - cropH, cropY));
  let cropX = Math.round(faceCenterXPx - cropW / 2);
  cropX = Math.max(0, Math.min(srcW - cropW, cropX));
  return { cropX, cropY, cropW, cropH };
}

export function calculateSquareCrop(
  srcW: number,
  srcH: number,
  /** face box height as a fraction of srcH (YuNet) */
  faceHeight: number,
  /** face center x as a fraction of srcW */
  faceCenterX: number,
  /** face center y as a fraction of srcH */
  faceCenterY: number,
  method: number = 2,
  mode: CropMode = "circle",
  circleTarget: { faceFraction: number; faceCenterYIn: number } = CIRCLE_TARGET_DEFAULT,
  /** Optional face-GROUP width (fraction of srcW): enlarge the square so it frames
   *  ALL speakers in a multi-person A-roll, not just the single face passed above.
   *  Additive + backward-compatible — when omitted, behaviour is unchanged. */
  groupWidth?: number,
): SquareCrop {
  const faceHeightPx = Math.max(1, faceHeight * srcH);
  const faceCenterXPx = (faceCenterX ?? 0.5) * srcW;
  const faceCenterYPx = (faceCenterY ?? 0.42) * srcH;

  let faceFraction: number;
  let faceCenterYIn: number;
  if (mode === "stack") {
    faceFraction = STACK_TARGET.faceFraction;
    faceCenterYIn = STACK_TARGET.faceCenterYIn;
  } else {
    faceFraction = circleTarget.faceFraction + (METHOD_FF_OFFSET[method] || 0);
    faceCenterYIn = circleTarget.faceCenterYIn;
  }

  // squareSize so the detected face occupies `faceFraction` of the square.
  let squareSize = Math.round(faceHeightPx / faceFraction);
  // Multi-speaker: if a face-GROUP width is given, enlarge the square so the whole
  // group fills ~GROUP_FILL of the width → everyone is framed, not just one face.
  if (groupWidth && groupWidth > 0) {
    const GROUP_FILL = 0.82;
    const groupSide = Math.round((groupWidth * srcW) / GROUP_FILL);
    squareSize = Math.max(squareSize, groupSide);
  }
  // Clamp to the source (never exceed frame); floor guards a wild under-measure.
  squareSize = Math.max(420, Math.min(Math.min(srcW, srcH), squareSize));

  // Vertical: face CENTER sits `faceCenterYIn` of the square below the crop top.
  let cropY = Math.round(faceCenterYPx - squareSize * faceCenterYIn);
  cropY = Math.max(0, Math.min(srcH - squareSize, cropY));

  // Horizontal: center the square on the face, clamped to frame.
  let cropX = Math.round(faceCenterXPx - squareSize / 2);
  cropX = Math.max(0, Math.min(srcW - squareSize, cropX));

  return { cropX, cropY, cropSize: squareSize };
}
