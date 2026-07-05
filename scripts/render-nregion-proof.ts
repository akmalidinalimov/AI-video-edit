/**
 * render-nregion-proof.ts — UNIVERSAL-1 Wave 2 PROOF: the N-region FFmpeg renderer
 * on R2 (multi_region_stack) and R3 (pip_over_fullscreen) with existing local assets.
 *
 * No credits, no dev server, no new Gemini calls: decodeReference consumes the
 * WARM layout_regions cache (same getCached pattern as test-unified-decode.ts).
 *
 * Run (esbuild-bundle pattern):
 *   node_modules/.bin/esbuild scripts/render-nregion-proof.ts --bundle --platform=node \
 *     --format=cjs --alias:@=./src --external:sharp --outfile=.tmp/render-nregion-proof.cjs
 *   node .tmp/render-nregion-proof.cjs
 *
 * Outputs:
 *   public/exports/nregion-r2-proof.mp4 + nregion-r3-proof.mp4
 *   public/exports/sp-temp/nregion-{r2,r3}-{2,8,15}s.jpg (frames)
 *   public/exports/sp-temp/nregion-filter-{r2,r3}.txt (composite filtergraph debug)
 *   public/exports/sp-temp/nregion-plan-{r2,r3}.json (pixel rects — regression input)
 */
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { analyzeLayout } from "../src/lib/analysis/layout-analyzer";
import { analyzeLayoutRegions, type RegionLayout } from "../src/lib/analysis/layout-regions";
import { getCached, setCache } from "../src/lib/analysis/analysisCache";
import { decodeReference, type DecodedRegion } from "../src/lib/analysis/reference-decode";
import { getVideoMetadata } from "../src/lib/analysis/frameExtractor";
import { detectArollGroup } from "../src/lib/pipeline/yunet-face";
import {
  regionToPixels, renderNRegion,
  type NRegionRenderRegion, type MontageSegment, type ArollFaceBox, type PixelRect,
} from "../src/lib/pipeline/nregion-renderer";

// ── .env.local ──
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}

const ROOT = process.cwd();
const R2 = path.join(ROOT, "public/uploads/DownReels_20260701_191828.mp4");
const R3 = path.join(ROOT, "public/uploads/ref3-aipipeline.mp4");
const AROLL = path.join(ROOT, "public/uploads/aroll-clean.mp4");
const GEN = path.join(ROOT, "public/uploads/generated");
const EXPORTS = path.join(ROOT, "public/exports");
const SPTEMP = path.join(EXPORTS, "sp-temp");
const FFMPEG = path.join(ROOT, "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe");

const CANVAS = { w: 1080, h: 1920 };
const FPS = 30;

const clip = (n: string) => path.join(GEN, n);
const LIFESTYLE = [clip("broll-s0-hook.mp4"), clip("broll-s1a-kitchen.mp4"), clip("broll-s1b-coworking.mp4"), clip("broll-s2a-park.mp4")];
const SCREENREC_PLACEHOLDER = [clip("broll-s2b-desk.mp4"), clip("broll-s2c-street.mp4")];

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++;
};

// ── cached VLM region layout (identical pattern to test-unified-decode.ts) ──
async function getRegionLayout(video: string, validate: (rl: RegionLayout) => boolean): Promise<RegionLayout | null> {
  const name = path.basename(video);
  const cached = getCached<RegionLayout>(video, "layout_regions");
  if (cached && validate(cached)) { console.log(`[cache] layout_regions hit for ${name} (no Gemini call)`); return cached; }
  console.log(`[cache] layout_regions MISS for ${name} — ONE Gemini call`);
  const rl = await analyzeLayoutRegions(video);
  if (rl && validate(rl)) { setCache(video, "layout_regions", rl); return rl; }
  return rl;
}

/** R2 header text from decode-semantics artifacts (prefer over placeholder). */
function headerTextFromArtifacts(): string {
  try {
    const p = path.join(SPTEMP, "reference-decode.json");
    const raw = readFileSync(p, "utf8");
    // e.g. overlay description: "Grok logo and text 'Grok generates continuous AI videos' at the top left."
    const m = raw.match(/text '([^']{8,80})'/);
    if (m) { console.log(`[proof] R2 header text ← decode artifact: "${m[1]}"`); return m[1]; }
  } catch { /* fall through */ }
  console.log(`[proof] R2 header text: placeholder (no decode artifact text found)`);
  return "Your headline here";
}

function extractFrames(video: string, tag: string) {
  for (const t of [2, 8, 15]) {
    const out = path.join(SPTEMP, `nregion-${tag}-${t}s.jpg`);
    const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(t), "-i", video, "-frames:v", "1", "-q:v", "3", out]);
    if (r.status !== 0) console.error(`frame extract ${tag}@${t}s failed: ${r.stderr}`);
  }
}

async function assertOutput(tag: string, outPath: string, targetSec: number, wallMs: number) {
  ok(`${tag} output exists`, existsSync(outPath), outPath);
  if (!existsSync(outPath)) return;
  const meta = await getVideoMetadata(outPath);
  ok(`${tag} duration within 0.5s of ${targetSec.toFixed(2)}s`, Math.abs(meta.duration - targetSec) <= 0.5, meta.duration);
  ok(`${tag} streams valid (parsed ${meta.resolution.width}x${meta.resolution.height})`,
    meta.resolution.width === CANVAS.w && meta.resolution.height === CANVAS.h, meta.resolution);
  ok(`${tag} render wall time < 5 min`, wallMs < 300_000, `${(wallMs / 1000).toFixed(1)}s`);
  console.log(`[proof] ${tag}: ${(statSync(outPath).size / 1e6).toFixed(2)} MB, ${meta.duration.toFixed(2)}s, wall ${(wallMs / 1000).toFixed(1)}s`);
}

function writePlanDebug(tag: string, regions: Array<{ id: string; role: string; rect: PixelRect; zIndex: number }>) {
  writeFileSync(path.join(SPTEMP, `nregion-plan-${tag}.json`), JSON.stringify({ canvas: CANVAS, regions }, null, 2));
}

async function main() {
  // ── shared: A-roll metadata + face ──
  const arollMeta = await getVideoMetadata(AROLL);
  const durationSec = Math.min(27, arollMeta.duration);
  console.log(`[proof] A-roll: ${arollMeta.duration.toFixed(2)}s ${arollMeta.resolution.width}x${arollMeta.resolution.height} → proof duration ${durationSec.toFixed(2)}s`);
  let face: ArollFaceBox | null = null;
  const g = detectArollGroup(AROLL);
  if (g) { face = { centerX: g.centerX, centerY: g.centerY, height: g.faceHeight, width: g.width }; console.log(`[proof] YuNet face: center=(${g.centerX.toFixed(3)},${g.centerY.toFixed(3)}) faceH=${g.faceHeight.toFixed(3)}`); }
  else console.warn("[proof] YuNet unavailable — center-crop fallback");

  // ════════════════════════════════════════════════════════════
  // R2 — multi_region_stack (4 layers)
  // ════════════════════════════════════════════════════════════
  console.log("\n════ R2 (multi_region_stack) ════");
  const cv2 = analyzeLayout(R2);
  if (!cv2) throw new Error("analyzeLayout(R2) null");
  const rl2 = await getRegionLayout(R2, (rl) => rl.layoutClass === "multi_region_stack" && rl.bands.length === 4);
  const d2 = await decodeReference(R2, { layout: cv2, regionLayout: rl2 });
  if (!d2) throw new Error("decodeReference(R2) null");
  const regs2 = d2.layout.regions.value;
  const shotSec2 = Math.min(2.5, Math.max(0.6, d2.pacing.avgShotSec.value || 1));
  console.log(`[proof] R2 decode: ${regs2.length} regions, avgShotSec ${d2.pacing.avgShotSec.value} → montage cut ${shotSec2.toFixed(2)}s`);

  const px2 = regs2.map((r: DecodedRegion) => ({ id: r.id, role: r.role, rect: regionToPixels(r, CANVAS), zIndex: r.zIndex, shape: r.shape }));
  writePlanDebug("r2", px2);

  console.warn("[proof] ⚠ R2 screen_recording strip: PLACEHOLDER content (desk/street clips) — real screen capture is post-demo.");
  const r2Regions: NRegionRenderRegion[] = px2.map((p): NRegionRenderRegion => {
    if (p.role === "header_title") {
      return { id: p.id, kind: "header", rect: p.rect, zIndex: p.zIndex, text: headerTextFromArtifacts() };
    }
    if (p.role === "screen_recording") {
      return {
        id: p.id, kind: "montage", rect: p.rect, zIndex: p.zIndex,
        clips: SCREENREC_PLACEHOLDER, targetShotSec: Math.max(2, shotSec2 * 2),
        cornerRadiusPx: p.shape === "rounded_rect" ? Math.round(0.02 * CANVAS.w) : undefined,
      };
    }
    if (p.role === "aroll") {
      return {
        id: p.id, kind: "aroll", rect: p.rect, zIndex: p.zIndex,
        arollPath: AROLL, srcDims: { w: arollMeta.resolution.width, h: arollMeta.resolution.height }, face,
      };
    }
    // broll window
    return {
      id: p.id, kind: "montage", rect: p.rect, zIndex: p.zIndex,
      clips: LIFESTYLE, targetShotSec: shotSec2, motionMix: d2.motion.distribution.value,
    };
  });

  const r2Out = path.join(EXPORTS, "nregion-r2-proof.mp4");
  const t2 = Date.now();
  const res2 = await renderNRegion({
    canvas: CANVAS, fps: FPS, durationSec, ffmpegPath: FFMPEG,
    tempDir: path.join(SPTEMP, "nregion-r2"),
    outputPath: r2Out,
    regions: r2Regions,
    filterDebugPath: path.join(SPTEMP, "nregion-filter-r2.txt"),
  });
  const wall2 = Date.now() - t2;
  console.log(`[proof] R2 rendered: composite ${(res2.compositeMs / 1000).toFixed(1)}s, total ${(res2.totalMs / 1000).toFixed(1)}s`);
  extractFrames(r2Out, "r2");
  await assertOutput("R2", r2Out, durationSec, wall2);

  // ════════════════════════════════════════════════════════════
  // R3 — pip_over_fullscreen (time-varying background + rounded PIP)
  // ════════════════════════════════════════════════════════════
  console.log("\n════ R3 (pip_over_fullscreen) ════");
  const cv3 = analyzeLayout(R3);
  if (!cv3) throw new Error("analyzeLayout(R3) null");
  const rl3 = await getRegionLayout(R3, (rl) =>
    ["multi_region_stack", "circle_pip", "pip_over_fullscreen", "pip"].includes(rl.layoutClass) &&
    rl.bands.some((b) => (b.contentTimeline?.length ?? 0) >= 2));
  const d3 = await decodeReference(R3, { layout: cv3, regionLayout: rl3 });
  if (!d3) throw new Error("decodeReference(R3) null");
  const regs3 = d3.layout.regions.value;
  const bg3 = regs3.find((r) => (r.contentTimeline?.length ?? 0) >= 1 && r.zIndex === 0) ?? regs3.find((r) => r.zIndex === 0);
  const pip3 = regs3.find((r) => r.role === "aroll" && r.zIndex > 0) ?? regs3.find((r) => r.role === "aroll");
  if (!bg3 || !pip3) throw new Error(`R3 decode missing bg/pip region (${regs3.map((r) => r.role).join(",")})`);

  // Background segments from the decoded contentTimeline: broll-ish classes →
  // lifestyle clips; diagram_graphic/screen_recording → desk/street PLACEHOLDERS.
  console.warn("[proof] ⚠ R3 diagram_graphic/screen_recording windows: PLACEHOLDER content (desk/street clips) — real capture post-demo.");
  const segments: MontageSegment[] = [];
  let li = 0, si = 0;
  const timeline = (bg3.contentTimeline ?? []).filter((w) => w.start < durationSec);
  for (const w of timeline) {
    const wEnd = Math.min(w.end, durationSec);
    let t = Math.min(w.start, durationSec);
    const isScreen = /screen_recording|diagram_graphic/.test(w.content);
    while (t < wEnd - 1e-6) {
      const d = Math.min(3, wEnd - t); // subdivide long windows into ≤3s shots
      const src = isScreen ? SCREENREC_PLACEHOLDER[si++ % SCREENREC_PLACEHOLDER.length] : LIFESTYLE[li++ % LIFESTYLE.length];
      segments.push({ clip: src, durSec: d });
      t += d;
    }
  }
  if (segments.length === 0) segments.push({ clip: LIFESTYLE[0], durSec: durationSec });
  console.log(`[proof] R3 background: ${timeline.length} timeline window(s) → ${segments.length} montage shot(s)`);

  const pipRect = regionToPixels(pip3, CANVAS);
  const px3 = [
    { id: bg3.id, role: bg3.role, rect: { x: 0, y: 0, w: CANVAS.w, h: CANVAS.h }, zIndex: 0 },
    { id: pip3.id, role: "aroll", rect: pipRect, zIndex: Math.max(1, pip3.zIndex) },
  ];
  writePlanDebug("r3", px3);
  const maskRadius = Math.round((pip3.cornerRadiusFrac ?? 0.045) * CANVAS.w);
  console.log(`[proof] R3 PIP: ${JSON.stringify(pipRect)} rounded r=${maskRadius}px (shape=${pip3.shape})`);

  const r3Out = path.join(EXPORTS, "nregion-r3-proof.mp4");
  const t3 = Date.now();
  const res3 = await renderNRegion({
    canvas: CANVAS, fps: FPS, durationSec, ffmpegPath: FFMPEG,
    tempDir: path.join(SPTEMP, "nregion-r3"),
    outputPath: r3Out,
    background: { clips: LIFESTYLE, segments, motionMix: d3.motion.distribution.value },
    regions: [{
      id: pip3.id, kind: "aroll", rect: pipRect, zIndex: Math.max(1, pip3.zIndex),
      cornerRadiusPx: pip3.shape === "rounded_rect" ? maskRadius : undefined,
      arollPath: AROLL, srcDims: { w: arollMeta.resolution.width, h: arollMeta.resolution.height }, face,
    }],
    filterDebugPath: path.join(SPTEMP, "nregion-filter-r3.txt"),
  });
  const wall3 = Date.now() - t3;
  console.log(`[proof] R3 rendered: composite ${(res3.compositeMs / 1000).toFixed(1)}s, total ${(res3.totalMs / 1000).toFixed(1)}s`);
  extractFrames(r3Out, "r3");
  await assertOutput("R3", r3Out, durationSec, wall3);

  console.log(fails === 0 ? "\n✅ N-REGION PROOF: ALL PASS" : `\n❌ ${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
