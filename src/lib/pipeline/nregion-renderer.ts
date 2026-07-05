/**
 * nregion-renderer.ts — N-REGION FFmpeg renderer (UNIVERSAL-1 Wave 2).
 *
 * Spike-verified architecture (docs/UNIVERSAL-1-MILESTONE.md): FFmpeg IS the
 * timeline compositor. Each decoded region becomes ONE continuous "feeder" mp4
 * at exactly the region's pixel size + the full duration (montage feeders reuse
 * the proven tpad-clone + trim + concat pattern from buildBrollMontageArgs —
 * COPIED here, the legacy R1 function is untouched). The final composite is ONE
 * FFmpeg command: background + per-region overlays in zIndex order; rounded
 * regions via sharp mask PNG + alphamerge (region-mask.ts — proven by
 * public/exports/sp-temp/mask-smoke.mp4). Remotion/sharp only produce STATIC
 * assets (header PNG).
 *
 * HARD RULE: audio maps continuously from the A-roll feeder input
 * (`-map <arollInputIndex>:a`) — never filtered/split.
 */
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import sharp from "sharp";

import type { DecodedRegion } from "@/lib/analysis/reference-decode";
import { ensureRoundedRectMask } from "./region-mask";
import { calculateBandCrop } from "./square-crop";

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArollFaceBox {
  centerX: number; // fraction of source width
  centerY: number;
  height: number; // face height as fraction of source height
  width?: number; // group width fraction
}

/** One region of the final composite. Feeders are pre-rendered to exactly rect size. */
export interface NRegionCompositeRegion {
  id: string;
  /** Path to the feeder: a continuous mp4 at rect size+duration, or a static PNG. */
  feederPath: string;
  /** Static image (header PNG) → looped; video otherwise. */
  isImage?: boolean;
  rect: PixelRect;
  zIndex: number;
  /** Rounded-rect corner mask PNG (region-mask.ts) — omitted for plain rects. */
  maskPath?: string;
  /** The composite maps its audio from THIS input (exactly one region must set it). */
  isAudioSource?: boolean;
}

export interface NRegionCompositeSpec {
  canvas: { w: number; h: number };
  fps: number;
  durationSec: number;
  /** Full-canvas background feeder mp4. Omit → lavfi black. */
  backgroundPath?: string;
  regions: NRegionCompositeRegion[];
  outputPath: string;
}

// ════════════════════════════════════════════════════════════
// GEOMETRY
// ════════════════════════════════════════════════════════════

/** Fractional DecodedRegion rect → even-dimension pixel rect on the canvas. */
export function regionToPixels(
  region: DecodedRegion,
  canvas: { w: number; h: number }
): PixelRect {
  const x = Math.round(region.rect.x * canvas.w) & ~1;
  const y = Math.round(region.rect.y * canvas.h) & ~1;
  let w = Math.round(region.rect.w * canvas.w) & ~1;
  let h = Math.round(region.rect.h * canvas.h) & ~1;
  // clamp inside the canvas
  w = Math.max(2, Math.min(w, canvas.w - x));
  h = Math.max(2, Math.min(h, canvas.h - y));
  w &= ~1;
  h &= ~1;
  return { x, y, w, h };
}

// ════════════════════════════════════════════════════════════
// MONTAGE FEEDER (pattern copied from buildBrollMontageArgs — R1 untouched)
// ════════════════════════════════════════════════════════════

/** Deterministic low-discrepancy motion pick (copy of the montage rule). */
function pickMotion(i: number, mix?: Record<string, number>): "push_in" | "pull_out" | "static" {
  if (!mix || Object.keys(mix).length === 0) return "push_in";
  let wPush = 0, wPull = 0, wStatic = 0;
  for (const [k, v] of Object.entries(mix)) {
    if (k === "pull_out") wPull += v;
    else if (k === "static") wStatic += v;
    else wPush += v;
  }
  const tot = wPush + wPull + wStatic || 1;
  const r = (i * 0.6180339887) % 1;
  const cS = wStatic / tot, cP = cS + wPull / tot;
  return r < cS ? "static" : r < cP ? "pull_out" : "push_in";
}

export interface MontageSegment {
  /** source clip path */
  clip: string;
  /** shot duration on the feeder timeline (seconds) */
  durSec: number;
}

/**
 * FFmpeg args for ONE continuous montage feeder at exactly rect.w x rect.h and
 * exactly opts.durationSec: cycle `clips`, cut every ~targetShotSec, per shot
 * scale-cover-crop → optional Ken-Burns → fps → tpad clone → trim → concat.
 * `opts.segments` overrides the cadence-derived cut list (content-timeline mode).
 */
export function buildRegionMontageArgs(
  clips: string[],
  rect: { w: number; h: number },
  opts: {
    targetShotSec: number;
    durationSec: number;
    fps: number;
    motionMix?: Record<string, number>;
    /** Explicit shot list (e.g. from a decoded contentTimeline). */
    segments?: MontageSegment[];
    /** Source durations (sec) per clip path — offsets for REUSED clips wrap inside
     *  the clip instead of seeking past EOF (empty stream → ffmpeg crash). */
    clipDurations?: Record<string, number>;
  },
  outputPath: string
): string[] {
  if (clips.length === 0) throw new Error("buildRegionMontageArgs: no clips");
  const { fps, durationSec } = opts;
  const shotSec = Math.max(0.4, opts.targetShotSec);

  // Build the shot list: explicit segments, else cycle clips every ~shotSec.
  let segments: MontageSegment[];
  if (opts.segments && opts.segments.length > 0) {
    segments = opts.segments;
  } else {
    segments = [];
    let t = 0, i = 0;
    while (t < durationSec - 1e-6) {
      const d = Math.min(shotSec, durationSec - t);
      segments.push({ clip: clips[i % clips.length], durSec: d });
      t += d;
      i++;
    }
  }
  // Normalize total to exactly durationSec (stretch/trim the last shot).
  const total = segments.reduce((s, x) => s + x.durSec, 0);
  if (Math.abs(total - durationSec) > 1e-3 && segments.length > 0) {
    segments[segments.length - 1].durSec += durationSec - total;
    if (segments[segments.length - 1].durSec <= 0.1) segments.pop();
  }

  const inputs: string[] = [];
  const parts: string[] = [];
  const useCount = new Map<string, number>();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Advance the in-clip offset each time the same clip is reused so repeats
    // show different footage; tpad-clone guards any source shortfall. The
    // offset WRAPS inside the clip's usable window — seeking past EOF makes an
    // EMPTY stream, which crashes the zoompan/tpad/concat chain (0xC0000005).
    const used = useCount.get(seg.clip) ?? 0;
    useCount.set(seg.clip, used + 1);
    let off = used * shotSec;
    const clipDur = opts.clipDurations?.[seg.clip];
    if (clipDur && clipDur > 0) {
      const usable = clipDur - seg.durSec - 0.35; // keep the full shot inside the source
      off = usable > 0.05 ? (used * shotSec) % usable : 0;
    }
    const srcDur = seg.durSec + 0.3; // consume a touch extra for safety
    inputs.push("-ss", off.toFixed(3), "-t", srcDur.toFixed(3), "-i", seg.clip);

    // Ken-Burns per the measured motion mix (same zoompan pattern as the montage).
    const durFrames = Math.max(1, Math.round(seg.durSec * fps));
    const motion = pickMotion(i, opts.motionMix);
    let frame: string;
    if (motion === "static") {
      frame = `scale=${rect.w}:${rect.h}:force_original_aspect_ratio=increase,crop=${rect.w}:${rect.h},setsar=1`;
    } else {
      const zp =
        motion === "pull_out"
          ? `zoompan=z='max(1.12-0.10*on/${durFrames}\\,1.0)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${rect.w}x${rect.h}:fps=${fps}`
          : `zoompan=z='min(1.0+0.10*on/${durFrames}\\,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${rect.w}x${rect.h}:fps=${fps}`;
      const sw = Math.round(rect.w * 1.12) & ~1;
      const sh = Math.round(rect.h * 1.12) & ~1;
      frame = `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},${zp},setsar=1`;
    }
    // tpad clone-hold for the FULL shot + exact trim (the proven anti-black pattern).
    parts.push(
      `[${i}:v]${frame},fps=${fps},tpad=stop_mode=clone:stop_duration=${seg.durSec.toFixed(4)},` +
        `trim=duration=${seg.durSec.toFixed(4)},setpts=PTS-STARTPTS,format=yuv420p[s${i}]`
    );
  }

  const concat =
    segments.map((_, i) => `[s${i}]`).join("") + `concat=n=${segments.length}:v=1:a=0[bg]`;
  const filter = parts.join(";") + ";" + concat;

  return [
    "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex", filter,
    "-map", "[bg]",
    "-t", durationSec.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", String(fps),
    outputPath,
  ];
}

// ════════════════════════════════════════════════════════════
// A-ROLL FEEDER
// ════════════════════════════════════════════════════════════

/**
 * FFmpeg args for the continuous A-roll feeder at exactly rect size: face-safe
 * crop at the rect's aspect (calculateBandCrop — head+shoulders, headroom),
 * scale to rect, keep the ORIGINAL audio (the composite maps it continuously).
 */
export function buildArollTrackArgs(
  arollPath: string,
  rect: { w: number; h: number },
  faceCrop: { srcW: number; srcH: number; face?: ArollFaceBox | null },
  durationSec: number,
  fps: number,
  outputPath: string
): string[] {
  const { srcW, srcH, face } = faceCrop;
  const aspect = rect.w / Math.max(1, rect.h);
  let cropExpr: string;
  if (face) {
    const bc = calculateBandCrop(srcW, srcH, face.height, face.centerX, face.centerY, aspect, "stack", face.width);
    cropExpr = `crop=${bc.cropW}:${bc.cropH}:${bc.cropX}:${bc.cropY}`;
  } else {
    // center-crop fallback at the rect aspect
    let cw = srcW, ch = Math.round(cw / aspect);
    if (ch > srcH) { ch = srcH; cw = Math.round(ch * aspect); }
    cw &= ~1; ch &= ~1;
    cropExpr = `crop=${cw}:${ch}:${Math.round((srcW - cw) / 2)}:${Math.round((srcH - ch) / 2)}`;
  }
  return [
    "-y", "-loglevel", "error",
    "-t", (durationSec + 0.2).toFixed(3), "-i", arollPath,
    "-filter_complex",
    `[0:v]${cropExpr},scale=${rect.w}:${rect.h},setsar=1,fps=${fps},` +
      `tpad=stop_mode=clone:stop_duration=1,trim=duration=${durationSec.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v]`,
    "-map", "[v]", "-map", "0:a?",
    "-t", durationSec.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "160k",
    outputPath,
  ];
}

// ════════════════════════════════════════════════════════════
// HEADER ASSET (static PNG via sharp SVG)
// ════════════════════════════════════════════════════════════

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Static header band PNG: dark bg (#0a0a0aE6), white bold centered text. */
export async function makeHeaderAsset(
  text: string,
  rect: { w: number; h: number },
  outPath: string
): Promise<string> {
  // ~42% of band height, capped so long titles FIT the band width
  // (bold sans avg glyph width ≈ 0.58em → usable width / (0.58 * chars)).
  const byHeight = rect.h * 0.42;
  const byWidth = (rect.w * 0.92) / (0.58 * Math.max(1, text.length));
  const fontSize = Math.max(12, Math.round(Math.min(byHeight, byWidth)));
  const svg = `<svg width="${rect.w}" height="${rect.h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#0a0a0a" fill-opacity="0.9"/>
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif" font-weight="bold"
        font-size="${fontSize}" fill="#ffffff">${escapeXml(text)}</text>
</svg>`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

// ════════════════════════════════════════════════════════════
// FINAL COMPOSITE (one FFmpeg command)
// ════════════════════════════════════════════════════════════

export interface NRegionCompositeArgs {
  ffmpegArgs: string[];
  filterComplex: string;
  arollInputIndex: number;
}

/**
 * The single final FFmpeg command: background (or lavfi black) + each region
 * feeder overlaid in zIndex order. Rounded regions use the exact mask-smoke
 * pattern: `[pip]scale=W:H,format=rgba[p];[mask]format=gray[m];[p][m]alphamerge[pa];[bg][pa]overlay=x:y`.
 * AUDIO: `-map <arollInputIndex>:a` continuous (hard rule).
 */
export function buildNRegionCompositeArgs(spec: NRegionCompositeSpec): NRegionCompositeArgs {
  const { canvas, fps, durationSec } = spec;
  const inputs: string[] = [];
  let inputIdx = 0;

  // Input 0: background feeder or lavfi black.
  let bgLabel: string;
  if (spec.backgroundPath) {
    inputs.push("-i", spec.backgroundPath);
  } else {
    inputs.push("-f", "lavfi", "-i", `color=black:s=${canvas.w}x${canvas.h}:r=${fps}:d=${durationSec.toFixed(3)}`);
  }
  const bgInput = inputIdx++;

  const ordered = [...spec.regions].sort((a, b) => a.zIndex - b.zIndex);

  // Region inputs (in zIndex order), then mask inputs.
  const regionInput = new Map<string, number>();
  let arollInputIndex = -1;
  for (const r of ordered) {
    if (r.isImage) inputs.push("-loop", "1", "-t", durationSec.toFixed(3), "-i", r.feederPath);
    else inputs.push("-i", r.feederPath);
    regionInput.set(r.id, inputIdx);
    if (r.isAudioSource) arollInputIndex = inputIdx;
    inputIdx++;
  }
  const maskInput = new Map<string, number>();
  for (const r of ordered) {
    if (r.maskPath) {
      inputs.push("-i", r.maskPath);
      maskInput.set(r.id, inputIdx++);
    }
  }
  if (arollInputIndex < 0) {
    throw new Error("buildNRegionCompositeArgs: exactly one region must set isAudioSource (the A-roll feeder)");
  }

  // Filtergraph: normalize bg, then overlay each region.
  const filters: string[] = [];
  filters.push(
    `[${bgInput}:v]scale=${canvas.w}:${canvas.h},setsar=1,fps=${fps},format=yuv420p[bg0]`
  );
  bgLabel = "bg0";
  let step = 0;
  for (const r of ordered) {
    const i = regionInput.get(r.id)!;
    let srcLabel: string;
    if (r.maskPath) {
      const m = maskInput.get(r.id)!;
      // exact mask-smoke alphamerge pattern
      filters.push(`[${i}:v]scale=${r.rect.w}:${r.rect.h},format=rgba[p${step}]`);
      filters.push(`[${m}:v]format=gray[m${step}]`);
      filters.push(`[p${step}][m${step}]alphamerge[pa${step}]`);
      srcLabel = `pa${step}`;
    } else {
      filters.push(`[${i}:v]scale=${r.rect.w}:${r.rect.h},setsar=1[p${step}]`);
      srcLabel = `p${step}`;
    }
    const out = `st${step}`;
    filters.push(`[${bgLabel}][${srcLabel}]overlay=${r.rect.x}:${r.rect.y}:format=auto[${out}]`);
    bgLabel = out;
    step++;
  }
  filters.push(`[${bgLabel}]format=yuv420p[out]`);
  const filterComplex = filters.join(";\n");

  const ffmpegArgs = [
    "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-map", `${arollInputIndex}:a`, // HARD RULE: continuous A-roll audio
    "-t", durationSec.toFixed(3),
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-movflags", "+faststart",
    spec.outputPath,
  ];

  return { ffmpegArgs, filterComplex, arollInputIndex };
}

// ════════════════════════════════════════════════════════════
// EXECUTION HELPERS (feeders → composite), shared by the proof
// script and the route's N-region branch.
// ════════════════════════════════════════════════════════════

/** Probe a video's duration in seconds via `ffmpeg -i` stderr parse (cached). */
const durationCache = new Map<string, number>();
export function probeDurationSec(ffmpegPath: string, videoPath: string): number {
  const hit = durationCache.get(videoPath);
  if (hit !== undefined) return hit;
  let dur = 0;
  try {
    const r = spawnSync(ffmpegPath, ["-i", videoPath], { encoding: "utf8" });
    const m = (r.stderr ?? "").match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) dur = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  } catch { /* dur stays 0 → offset wrapping disabled for this clip */ }
  durationCache.set(videoPath, dur);
  return dur;
}

export function runFFmpeg(ffmpegPath: string, args: string[], timeoutMs = 300_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { cwd: process.cwd(), shell: false });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`FFmpeg timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.split("\n").slice(-8).join("; ").slice(0, 800)}`));
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** High-level region spec consumed by renderNRegion (feeder generation + composite). */
export interface NRegionRenderRegion {
  id: string;
  kind: "montage" | "aroll" | "header";
  rect: PixelRect;
  zIndex: number;
  /** rounded_rect corner radius in px → alphamerge mask */
  cornerRadiusPx?: number;
  /** montage */
  clips?: string[];
  targetShotSec?: number;
  motionMix?: Record<string, number>;
  segments?: MontageSegment[];
  /** aroll */
  arollPath?: string;
  srcDims?: { w: number; h: number };
  face?: ArollFaceBox | null;
  /** header */
  text?: string;
}

export interface NRegionRenderSpec {
  canvas: { w: number; h: number };
  fps: number;
  durationSec: number;
  ffmpegPath: string;
  /** working dir for feeders + masks */
  tempDir: string;
  outputPath: string;
  /** Full-canvas background montage (kind fields as montage) — else black. */
  background?: Omit<NRegionRenderRegion, "id" | "rect" | "zIndex" | "kind"> & { clips: string[] };
  regions: NRegionRenderRegion[];
  /** write the composite filtergraph here for debugging/regression */
  filterDebugPath?: string;
}

export interface NRegionRenderResult {
  outputPath: string;
  feederPaths: Record<string, string>;
  compositeMs: number;
  totalMs: number;
  arollInputIndex: number;
}

/** Full N-region pipeline: build every feeder, then the single composite pass. */
export async function renderNRegion(spec: NRegionRenderSpec): Promise<NRegionRenderResult> {
  const t0 = Date.now();
  const { ffmpegPath, fps, durationSec, tempDir } = spec;
  fs.mkdirSync(tempDir, { recursive: true });
  const feederPaths: Record<string, string> = {};

  // Probe every montage source once → offsets for reused clips wrap inside them.
  const allClips = new Set<string>();
  for (const c of spec.background?.clips ?? []) allClips.add(c);
  for (const s of spec.background?.segments ?? []) allClips.add(s.clip);
  for (const r of spec.regions) {
    for (const c of r.clips ?? []) allClips.add(c);
    for (const s of r.segments ?? []) allClips.add(s.clip);
  }
  const clipDurations: Record<string, number> = {};
  for (const c of allClips) clipDurations[c] = probeDurationSec(ffmpegPath, c);

  // ── background feeder ──
  let backgroundPath: string | undefined;
  if (spec.background) {
    backgroundPath = path.join(tempDir, "nregion-bg.mp4");
    const args = buildRegionMontageArgs(
      spec.background.clips,
      { w: spec.canvas.w, h: spec.canvas.h },
      {
        targetShotSec: spec.background.targetShotSec ?? 2,
        durationSec, fps,
        motionMix: spec.background.motionMix,
        segments: spec.background.segments,
        clipDurations,
      },
      backgroundPath
    );
    console.log(`[nregion] background feeder: ${spec.background.clips.length} clip(s) → ${backgroundPath}`);
    await runFFmpeg(ffmpegPath, args);
    feederPaths["__background"] = backgroundPath;
  }

  // ── per-region feeders ──
  const compositeRegions: NRegionCompositeRegion[] = [];
  for (const r of spec.regions) {
    let feederPath: string;
    let isImage = false;
    if (r.kind === "header") {
      feederPath = path.join(tempDir, `nregion-${r.id}.png`);
      await makeHeaderAsset(r.text ?? "", { w: r.rect.w, h: r.rect.h }, feederPath);
      isImage = true;
    } else if (r.kind === "montage") {
      feederPath = path.join(tempDir, `nregion-${r.id}.mp4`);
      const args = buildRegionMontageArgs(
        r.clips ?? [],
        { w: r.rect.w, h: r.rect.h },
        { targetShotSec: r.targetShotSec ?? 1, durationSec, fps, motionMix: r.motionMix, segments: r.segments, clipDurations },
        feederPath
      );
      console.log(`[nregion] montage feeder ${r.id}: ${r.rect.w}x${r.rect.h} @ ${r.targetShotSec ?? 1}s cuts`);
      await runFFmpeg(ffmpegPath, args);
    } else {
      feederPath = path.join(tempDir, `nregion-${r.id}.mp4`);
      const args = buildArollTrackArgs(
        r.arollPath!,
        { w: r.rect.w, h: r.rect.h },
        { srcW: r.srcDims?.w ?? 1920, srcH: r.srcDims?.h ?? 1080, face: r.face },
        durationSec, fps, feederPath
      );
      console.log(`[nregion] aroll feeder ${r.id}: ${r.rect.w}x${r.rect.h} (face-safe band crop)`);
      await runFFmpeg(ffmpegPath, args);
    }
    feederPaths[r.id] = feederPath;

    let maskPath: string | undefined;
    if (r.cornerRadiusPx && r.cornerRadiusPx > 0) {
      maskPath = await ensureRoundedRectMask(
        { width: r.rect.w, height: r.rect.h, radius: Math.round(r.cornerRadiusPx) },
        path.join(tempDir, "masks")
      );
    }
    compositeRegions.push({
      id: r.id,
      feederPath,
      isImage,
      rect: r.rect,
      zIndex: r.zIndex,
      maskPath,
      isAudioSource: r.kind === "aroll",
    });
  }

  // ── composite ──
  const { ffmpegArgs, filterComplex, arollInputIndex } = buildNRegionCompositeArgs({
    canvas: spec.canvas, fps, durationSec,
    backgroundPath,
    regions: compositeRegions,
    outputPath: spec.outputPath,
  });
  if (spec.filterDebugPath) {
    fs.mkdirSync(path.dirname(spec.filterDebugPath), { recursive: true });
    fs.writeFileSync(spec.filterDebugPath, filterComplex);
  }
  const tc = Date.now();
  console.log(`[nregion] composite: ${compositeRegions.length} region(s), audio ← input ${arollInputIndex}`);
  await runFFmpeg(ffmpegPath, ffmpegArgs);
  const now = Date.now();
  return {
    outputPath: spec.outputPath,
    feederPaths,
    compositeMs: now - tc,
    totalMs: now - t0,
    arollInputIndex,
  };
}
