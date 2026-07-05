/**
 * region-mask.ts — alpha-mask PNGs for N-REGION FFmpeg compositing (UNIVERSAL-1 Wave 2).
 *
 * The Remotion full-timeline composite was spiked and FAILED (10.25x realtime — see
 * docs/UNIVERSAL-1-MILESTONE.md), so rounded-rect PIP corners are done the FFmpeg way:
 * a sharp-generated grayscale mask PNG (white = opaque, black = transparent, anti-aliased
 * corners) fed to `alphamerge`:
 *
 *   [pip]format=yuva420p... ; movie=mask.png[m] ; [pip][m]alphamerge[pipa] ; [bg][pipa]overlay=x:y
 *
 * One static PNG per region size+radius, content-hash cached — zero per-frame cost.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import sharp from "sharp";

export interface MaskSpec {
  width: number;          // pixels (even numbers recommended for yuv chroma)
  height: number;
  /** corner radius in px. 0 = plain rect (mask unnecessary — callers should skip). */
  radius: number;
}

/** Deterministic cache path for a mask spec. */
export function maskCachePath(spec: MaskSpec, dir: string): string {
  const hash = crypto.createHash("md5").update(`${spec.width}x${spec.height}r${spec.radius}`).digest("hex").slice(0, 8);
  return path.join(dir, `mask-${spec.width}x${spec.height}-r${spec.radius}-${hash}.png`);
}

/**
 * Generate (or reuse) a rounded-rect alpha mask PNG. Returns the file path.
 * White rounded-rect on black, anti-aliased — alphamerge reads luminance as alpha.
 */
export async function ensureRoundedRectMask(spec: MaskSpec, dir: string): Promise<string> {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = maskCachePath(spec, dir);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  const r = Math.max(0, Math.min(spec.radius, Math.floor(Math.min(spec.width, spec.height) / 2)));
  const svg = `<svg width="${spec.width}" height="${spec.height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="black"/>
  <rect x="0" y="0" width="${spec.width}" height="${spec.height}" rx="${r}" ry="${r}" fill="white"/>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(out);
  return out;
}

/**
 * FFmpeg filter fragment applying the mask to a labeled stream.
 * Input stream must already be scaled to exactly spec.width x spec.height.
 * Consumes an extra `-i <maskPath>` input at index `maskInputIndex`.
 */
export function alphamergeFragment(inLabel: string, maskInputIndex: number, outLabel: string): string {
  return `[${inLabel}]format=rgba[${outLabel}_rgb];[${maskInputIndex}:v]format=gray[${outLabel}_m];[${outLabel}_rgb][${outLabel}_m]alphamerge[${outLabel}]`;
}
