/**
 * mg-render.ts — render a Motion-Graphics component to an mp4 clip from the
 * server-side pipeline (Creative Director). Bundles the Remotion project ONCE
 * (cached), then renders any registered component by id via the MG-Preview
 * harness. Content-hash cached so identical inputs never re-render.
 *
 * This is the production replacement for `npx remotion render` (which re-bundles
 * every call). Used to wire motion-graphics B-roll into /api/clone-style.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";

let _serveUrl: Promise<string> | null = null;

/** Bundle the Remotion entry once (mirrors remotion.config.ts's "@" alias). */
function getServeUrl(): Promise<string> {
  if (!_serveUrl) {
    _serveUrl = bundle({
      entryPoint: path.join(process.cwd(), "src", "remotion", "entry.tsx"),
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          alias: {
            ...(config.resolve?.alias ?? {}),
            "@": path.join(process.cwd(), "src"),
          },
        },
      }),
    });
  }
  return _serveUrl;
}

export interface MgRenderResult {
  path: string;
  cached: boolean;
}

/**
 * Render one MG component (by registry id) with a typed input to an mp4.
 * @param componentId e.g. "data-viz/counter", "caption/kinetic", "media/ken-burns"
 * @param input the component's input payload (validated against its zod schema)
 * @param outDir directory to write the clip into
 */
export async function renderMgClip(
  componentId: string,
  input: Record<string, unknown>,
  outDir: string
): Promise<MgRenderResult> {
  const hash = crypto
    .createHash("md5")
    .update(JSON.stringify({ componentId, input }))
    .digest("hex")
    .slice(0, 10);
  const safe = componentId.replace(/[^\w]+/g, "-");
  const out = path.join(outDir, `mg-${safe}-${hash}.mp4`);

  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    return { path: out, cached: true };
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const serveUrl = await getServeUrl();
  const inputProps = { componentId, input };
  const composition = await selectComposition({ serveUrl, id: "MG-Preview", inputProps });
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: out,
    inputProps,
    overwrite: true,
  });
  return { path: out, cached: false };
}
