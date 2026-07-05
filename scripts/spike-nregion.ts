/**
 * spike-nregion.ts — Wave-2 feasibility spike: server-render an N-region multi-video composite
 * (R2-shaped: header band + B-roll window + screen-strip window + rounded-rect A-roll PIP) and
 * MEASURE render time. Decision rule: < ~4x realtime on this machine = architecture stands.
 *
 * Usage: (esbuild-bundled) node tmp.mjs [durationSec]
 */
import path from "node:path";
import fs from "node:fs";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";

const durationSec = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? 20);
const fps = 30;
const root = process.cwd();

const regions = [
  // R2-shaped layout (fractions from the verified decode of DownReels_20260701_191828)
  { id: "header", kind: "static_band", rect: { x: 0, y: 0, w: 1, h: 0.10 }, bg: "#0a0a0a", label: "Grok generates continuous AI videos", z: 3 },
  { id: "broll", kind: "content_window", rect: { x: 0, y: 0.10, w: 1, h: 0.40 }, source: "uploads/generated/broll-s0-hook.mp4", z: 1 },
  { id: "strip", kind: "content_window", rect: { x: 0.04, y: 0.52, w: 0.92, h: 0.11 }, source: "uploads/generated/broll-s2b-desk.mp4", cornerRadiusFrac: 0.02, z: 2 },
  { id: "aroll", kind: "aroll", rect: { x: 0.11, y: 0.68, w: 0.62, h: 0.30 }, source: "uploads/aroll-clean.mp4", cornerRadiusFrac: 0.045, z: 4 },
];

void (async () => {
  console.log(`spike: ${durationSec}s @ ${fps}fps, ${regions.length} regions (3 videos + 1 styled band)`);
  const t0 = Date.now();
  const serveUrl = await bundle({
    entryPoint: path.join(root, "src", "remotion", "entry.tsx"),
    webpackOverride: (config) => ({
      ...config,
      resolve: { ...config.resolve, alias: { ...(config.resolve?.alias ?? {}), "@": path.join(root, "src") } },
    }),
  });
  const tBundle = Date.now();
  console.log(`bundle: ${((tBundle - t0) / 1000).toFixed(1)}s`);

  const inputProps = { regions, durationInFrames: Math.round(durationSec * fps), muted: true };
  const composition = await selectComposition({ serveUrl, id: "NRegionSpike", inputProps });
  const out = path.join(root, "public", "exports", "spike-nregion.mp4");
  const tSel = Date.now();
  await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: out, inputProps, overwrite: true });
  const tRender = Date.now();

  const renderSec = (tRender - tSel) / 1000;
  const ratio = renderSec / durationSec;
  const size = fs.existsSync(out) ? (fs.statSync(out).size / 1024 / 1024).toFixed(1) : "0";
  console.log(`render: ${renderSec.toFixed(1)}s for ${durationSec}s of video → ${ratio.toFixed(2)}x realtime | ${size}MB`);
  console.log(`OUTPUT: ${out}`);
  console.log(ratio < 4 ? "VERDICT: PASS — N-region Remotion composite is feasible (<4x realtime)" : "VERDICT: MARGINAL/FAIL — consider FFmpeg-side compositing or optimization");
})().catch((e) => { console.error("SPIKE FAILED:", e?.message ?? e); process.exit(1); });
