/**
 * caption-render.ts — burn the animated 2-row caption track over a composite video from the
 * server-side pipeline, using programmatic Remotion (mirrors mg-render.ts). This productionizes
 * captions INTO /api/clone-style: the route was previously emitting an uncaptioned composite and
 * captions were a separate manual step (scripts/render-captions.mjs).
 *
 * Words come from the MMS forced-aligned transcript; yFraction is measured from the reference
 * divider so the caption sits where the reference puts it (e.g. just below a top/bottom split).
 * Non-blocking: returns null on any failure → the route keeps the uncaptioned composite.
 */
import path from "node:path";
import fs from "node:fs";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";

let _serveUrl: Promise<string> | null = null;
function getServeUrl(): Promise<string> {
  if (!_serveUrl) {
    _serveUrl = bundle({
      entryPoint: path.join(process.cwd(), "src", "remotion", "entry.tsx"),
      webpackOverride: (config) => ({
        ...config,
        resolve: { ...config.resolve, alias: { ...(config.resolve?.alias ?? {}), "@": path.join(process.cwd(), "src") } },
      }),
    });
  }
  return _serveUrl;
}

export interface CaptionWord { word: string; start: number; end: number }
export interface CaptionRenderOpts {
  /** base composite path RELATIVE to public/ (e.g. "exports/styleclone-123.mp4"). */
  baseVideoRelPath: string;
  words: CaptionWord[];
  /** absolute output path for the captioned mp4. */
  outputPath: string;
  durationSec: number;
  /** vertical CENTER of the caption block (0..1) — from the measured reference. */
  yFraction?: number;
  leadSec?: number;
  keywords?: string[];
  fps?: number;
  /** MEASURED reference caption style (from the decode) — so the render matches the reference. */
  fillColor?: string;
  fontWeight?: number;
  animation?: string;
}

/** Render captions over the composite. Returns the output path, or null on failure (non-blocking). */
export async function renderCaptions(opts: CaptionRenderOpts): Promise<string | null> {
  if (!opts.words?.length) return null;
  try {
    const fps = opts.fps ?? 30;
    const durationInFrames = Math.max(1, Math.round(opts.durationSec * fps));
    const inputProps = {
      baseVideo: opts.baseVideoRelPath,
      words: opts.words.map((w) => ({ word: w.word, start: w.start, end: w.end })),
      durationInFrames,
      yFraction: opts.yFraction ?? 0.43,
      leadSec: opts.leadSec ?? 0.15,
      emphasize: false,
      keywords: opts.keywords ?? [],
      maxRowWidthPx: 900,
      fillColor: opts.fillColor ?? "#FFFFFF",
      fontWeight: opts.fontWeight ?? 800,
      animation: opts.animation ?? "word-pop-in",
    };
    const serveUrl = await getServeUrl();
    const composition = await selectComposition({ serveUrl, id: "CaptionedVideo", inputProps });
    await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: opts.outputPath, inputProps, overwrite: true });
    return fs.existsSync(opts.outputPath) && fs.statSync(opts.outputPath).size > 0 ? opts.outputPath : null;
  } catch (e) {
    console.error("[caption-render] failed (non-blocking):", (e as Error).message?.slice(0, 200));
    return null;
  }
}
