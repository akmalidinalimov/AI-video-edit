/**
 * Reference Measurer — corrects the reference blueprint's layout geometry by
 * measuring the actual pixels (CV), replacing Gemini's unreliable estimates.
 *
 * For each CIRCLE-PIP segment we sample several frames across the segment's
 * time range, detect the circle robustly (multi-frame median), then apply
 * cross-segment constraints: the PIP's horizontal position and radius are
 * effectively constant across a video, so we lock them to the median of the
 * confident detections and keep each segment's own vertical position (the
 * circle's vertical slide is the real motion we want to preserve).
 *
 * Returns corrected bounding boxes per segment id, in CANVAS coordinate space.
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import {
  measureCircleFromFrame,
  measureArollRectangle,
  measureTextBands,
  type ArollRectResult,
  type TextBand,
} from "./coordinate-measurer";

export interface RefSegmentInput {
  id: string;
  start: number;
  end: number;
  shape: "circle" | "rectangle" | string;
}

export interface MeasuredCircle {
  segmentId: string;
  box: { x: number; y: number; width: number; height: number };
  cx: number;
  cy: number;
  radius: number;
  samples: number;
  support: number;
  /** True when this segment's own detection was confident (else constrained/borrowed) */
  confident: boolean;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Greedy nearest-neighbor spatial clustering.
 *
 * Assigns each detection to the nearest existing cluster (by running-mean
 * centroid) if it is within `proximityPx`, otherwise starts a new cluster.
 * Returns clusters sorted by size (largest first).
 *
 * Used by the temporal-persistence path: the speaker's circular PIP is
 * stationary across all sampled frames → dense cluster; B-roll thumbnails
 * scroll/change frame-to-frame → sparse clusters.
 */
function clusterByPosition(
  dets: Array<{ cx: number; cy: number; r: number; support: number }>,
  proximityPx: number
): Array<{ members: Array<{ cx: number; cy: number; r: number; support: number }>; cx: number; cy: number; r: number }> {
  // Each running entry stores mean center for incremental assignment
  const entries: Array<{
    sumCx: number;
    sumCy: number;
    n: number;
    members: Array<{ cx: number; cy: number; r: number; support: number }>;
  }> = [];

  for (const det of dets) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let ci = 0; ci < entries.length; ci++) {
      const mcx = entries[ci].sumCx / entries[ci].n;
      const mcy = entries[ci].sumCy / entries[ci].n;
      const dist = Math.hypot(det.cx - mcx, det.cy - mcy);
      if (dist < proximityPx && dist < bestDist) {
        bestDist = dist;
        bestIdx = ci;
      }
    }
    if (bestIdx >= 0) {
      entries[bestIdx].members.push(det);
      entries[bestIdx].sumCx += det.cx;
      entries[bestIdx].sumCy += det.cy;
      entries[bestIdx].n++;
    } else {
      entries.push({ sumCx: det.cx, sumCy: det.cy, n: 1, members: [det] });
    }
  }

  return entries
    .map((e) => ({
      members: e.members,
      cx: median(e.members.map((d) => d.cx)),
      cy: median(e.members.map((d) => d.cy)),
      r: median(e.members.map((d) => d.r)),
    }))
    .sort((a, b) => b.members.length - a.members.length);
}

function extractFrame(
  ffmpegPath: string,
  video: string,
  t: number,
  canvas: { width: number; height: number },
  outPath: string
): boolean {
  const r = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-ss",
      String(t),
      "-i",
      video,
      "-frames:v",
      "1",
      "-vf",
      `scale=${canvas.width}:${canvas.height}`,
      outPath,
    ],
    { encoding: "utf-8" }
  );
  return r.status === 0 && fs.existsSync(outPath);
}

export async function measureReferenceCircles(input: {
  ffmpegPath: string;
  refVideoPath: string;
  canvas: { width: number; height: number };
  segments: RefSegmentInput[];
  tmpDir: string;
  /** Frames sampled per segment (default 12) */
  framesPerSegment?: number;
  /** Search constraints (canvas px) — generous defaults for a top-right PIP */
  radiusRange?: { min: number; max: number };
  centerRegion?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number };
  /**
   * Per-segment semantic seed from the PIP locator (Gemini Vision). When
   * provided for a segment, that segment uses a TIGHT search window around
   * its own seed (cx ±200, cy ±200, r within ±30% of seed) instead of the
   * global centerRegion. This is how we satisfy KB-001 and KB-002: each
   * segment's CV search is anchored on a semantic identification, so the
   * speaker's PIP is found even when it moves between segments and B-roll
   * false circles are excluded by the tight window.
   */
  perSegmentSeeds?: Map<string, { cx: number; cy: number; radius: number }>;
  /**
   * When true, use TEMPORAL-PERSISTENCE CLUSTERING instead of global-cx
   * median or Gemini seeds. Samples more frames per segment (default 20),
   * runs full-canvas Hough detection on each, then clusters detections by
   * spatial proximity. The speaker's PIP is stationary across frames →
   * densest cluster. B-roll thumbnails scroll/change → sparse clusters.
   *
   * Resolves KB-005 and KB-006: bypasses Gemini Vision entirely. The
   * centerRegion constraint is IGNORED in this mode so that segments whose
   * PIP sits outside the LLM-estimated zone are still detected correctly.
   */
  useTemporalClustering?: boolean;
}): Promise<Map<string, MeasuredCircle>> {
  const {
    ffmpegPath,
    refVideoPath,
    canvas,
    segments,
    tmpDir,
  } = input;
  // Temporal clustering needs more frames for reliable density discrimination.
  const N = input.framesPerSegment ?? (input.useTemporalClustering ? 20 : 12);
  const radiusRange =
    input.radiusRange ?? {
      min: Math.round(canvas.width * 0.16),
      max: Math.round(canvas.width * 0.27),
    };
  const centerRegion =
    input.centerRegion ?? {
      xMin: Math.round(canvas.width * 0.40),
      xMax: Math.round(canvas.width * 0.99),
      yMin: Math.round(canvas.height * 0.10),
      yMax: Math.round(canvas.height * 0.50),
    };
  const perSegmentSeeds = input.perSegmentSeeds;

  fs.mkdirSync(tmpDir, { recursive: true });

  const circleSegs = segments.filter((s) => s.shape === "circle");

  // ── Detect circle in every sampled frame (single loose pass) ──
  // Per-frame detections grouped by segment. When a per-segment semantic seed
  // is supplied (Gemini Vision PIP locator), use a TIGHT window around it so
  // B-roll false circles are excluded by geometry. Otherwise fall back to the
  // global centerRegion (legacy path).
  interface FrameDet { cx: number; cy: number; r: number; support: number }
  const perSeg = new Map<string, FrameDet[]>();
  const allDets: FrameDet[] = [];

  for (const seg of circleSegs) {
    const seed = perSegmentSeeds?.get(seg.id);
    let segCenterRegion: typeof centerRegion | undefined = centerRegion;
    let segRadiusRange = radiusRange;
    if (seed) {
      // Per KB-005 the face-anchored seed can still be off by ~150 px in the
      // worst case (face detection at frame edges, hijab fold ambiguity).
      // ±300 px pad keeps the real circle inside the CV search window while
      // still being tight enough to exclude most B-roll false circles which
      // live at canvas extremes.
      const pad = 300;
      segCenterRegion = {
        xMin: Math.max(0, seed.cx - pad),
        xMax: Math.min(canvas.width, seed.cx + pad),
        yMin: Math.max(0, seed.cy - pad),
        yMax: Math.min(canvas.height, seed.cy + pad),
      };
      segRadiusRange = {
        min: Math.max(40, Math.round(seed.radius * 0.6)),
        max: Math.round(seed.radius * 1.4),
      };
    } else if (input.useTemporalClustering) {
      // Temporal-persistence mode: use the caller-supplied centerRegion
      // (cv-correction computes a position-independent upper-half zone that
      // doesn't depend on the current bbox positions). Explicitly set to
      // undefined only when no caller region was provided, to fall back to
      // the global centerRegion.
      segCenterRegion = centerRegion; // keep the position-independent region from caller
    }

    const dur = Math.max(0.1, seg.end - seg.start);
    const a = seg.start + dur * 0.1;
    const b = seg.end - dur * 0.1;
    const dets: FrameDet[] = [];
    for (let i = 0; i < N; i++) {
      const t = a + ((b - a) * (i + 0.5)) / N;
      const fp = path.join(tmpDir, `refmeas_${seg.id}_${i}.jpg`);
      if (!extractFrame(ffmpegPath, refVideoPath, t, canvas, fp)) continue;
      const d = await measureCircleFromFrame({
        framePath: fp,
        canvas,
        downscale: 3,
        radiusRange: segRadiusRange,
        centerRegion: segCenterRegion,
      });
      if (d) {
        const fd = { cx: d.cx, cy: d.cy, r: d.radius, support: d.support };
        dets.push(fd);
        allDets.push(fd);
      }
      try { fs.unlinkSync(fp); } catch { /* ignore */ }
    }
    perSeg.set(seg.id, dets);
  }

  // When per-segment seeds were provided, each segment is independently
  // anchored — skip the global-cx lock and compute cx/cy/r per segment from
  // its own detections (fallback to the seed itself if no agreeing frames).
  // The global-lock pass is only run when no seeds are supplied (legacy path
  // for videos where the PIP truly is in the same position throughout).
  const result = new Map<string, MeasuredCircle>();

  // ── Temporal-persistence clustering (KB-005/KB-006 resolution) ──
  // No Gemini — pure CV. For each segment, cluster all per-frame detections
  // by spatial proximity. The speaker's PIP is in every frame at a stable
  // position → densest cluster wins. B-roll thumbnails scroll / change
  // frame-to-frame → sparse clusters.
  if (input.useTemporalClustering && !perSegmentSeeds) {
    // Proximity threshold: 10% of canvas width (~108px for 1080px canvas).
    // Large enough to group the same circle across frames with minor Hough
    // noise; small enough that distinct circles don't merge.
    const clusterThreshold = Math.round(canvas.width * 0.10);

    for (const seg of circleSegs) {
      const dets = perSeg.get(seg.id) ?? [];

      if (dets.length === 0) {
        console.warn(`[refmeas-temporal] ${seg.id}: no detections in ${N} frames — using placeholder`);
        const r = Math.round(canvas.width * 0.22);
        const cx = Math.round(canvas.width * 0.5);
        const cy = Math.round(canvas.height * 0.3);
        result.set(seg.id, {
          segmentId: seg.id,
          cx,
          cy,
          radius: r,
          box: { x: cx - r, y: cy - r, width: r * 2, height: r * 2 },
          samples: 0,
          support: 0,
          confident: false,
        });
        continue;
      }

      const clusters = clusterByPosition(dets, clusterThreshold);
      // clusters is sorted by member count (largest first)
      const best = clusters[0];

      // Secondary tie-break: if two clusters have similar size (within 20%),
      // prefer the one with higher mean Hough support (better edge quality).
      // This handles the edge case where a static B-roll image has a circle
      // in the same position throughout the segment.
      let chosen = best;
      if (clusters.length >= 2) {
        const runner = clusters[1];
        if (runner.members.length >= best.members.length * 0.8) {
          const bestSupport = best.members.reduce((s, m) => s + m.support, 0) / best.members.length;
          const runnerSupport = runner.members.reduce((s, m) => s + m.support, 0) / runner.members.length;
          if (runnerSupport > bestSupport * 1.25) {
            console.log(
              `[refmeas-temporal] ${seg.id}: tie-break: cluster 2 has higher support ` +
              `(${runnerSupport.toFixed(3)} vs ${bestSupport.toFixed(3)}) → using cluster 2`
            );
            chosen = runner;
          }
        }
      }

      const cx = chosen.cx;
      const cy = chosen.cy;
      const r = chosen.r;
      const confident = chosen.members.length >= Math.max(3, Math.round(N * 0.35));

      // Log all clusters (cap at top 5) so we can see what false circles exist
      const clusterSummary = clusters
        .slice(0, 5)
        .map((c, i) => `[${i}] n=${c.members.length} (${c.cx},${c.cy},r=${c.r})`)
        .join("  ");
      console.log(
        `[refmeas-temporal] ${seg.id}: ${dets.length} dets → ${clusters.length} clusters: ${clusterSummary}`
      );
      console.log(
        `[refmeas-temporal] ${seg.id}: chosen=(${cx},${cy},r=${r}) ${confident ? "✓confident" : "⚠uncertain"}`
      );

      result.set(seg.id, {
        segmentId: seg.id,
        cx,
        cy,
        radius: r,
        box: { x: cx - r, y: cy - r, width: r * 2, height: r * 2 },
        samples: chosen.members.length,
        support: chosen.members.reduce((s, m) => s + m.support, 0) / chosen.members.length,
        confident,
      });
    }
    return result;
  }

  if (perSegmentSeeds && perSegmentSeeds.size > 0) {
    for (const seg of circleSegs) {
      const seed = perSegmentSeeds.get(seg.id);
      const dets = perSeg.get(seg.id) ?? [];
      let cx: number, cy: number, r: number, samples: number, confident: boolean;

      if (dets.length >= Math.max(3, Math.round(N * 0.3))) {
        cx = median(dets.map((d) => d.cx));
        cy = median(dets.map((d) => d.cy));
        r = median(dets.map((d) => d.r));
        samples = dets.length;
        confident = true;
      } else if (seed) {
        // CV didn't find enough agreeing detections — fall back to the
        // semantic seed itself. Gemini's rough numbers beat the wrong-zone
        // LLM bbox or a noisy partial CV result.
        cx = seed.cx;
        cy = seed.cy;
        r = seed.radius;
        samples = dets.length;
        confident = false;
      } else {
        // No seed AND no detections — neutral canvas-centre placeholder.
        cx = Math.round(canvas.width * 0.5);
        cy = Math.round(canvas.height * 0.3);
        r = Math.round(canvas.width * 0.22);
        samples = 0;
        confident = false;
      }

      result.set(seg.id, {
        segmentId: seg.id,
        cx,
        cy,
        radius: r,
        box: { x: cx - r, y: cy - r, width: r * 2, height: r * 2 },
        samples,
        support: 0,
        confident,
      });
    }
    return result;
  }

  // ── Legacy path: no semantic seeds, use global-lock heuristic ──
  // Pass 1: global horizontal position & radius (constant across video).
  // Median over ALL frames; the real circle dominates so false peaks wash out.
  const globalCx = allDets.length ? median(allDets.map((d) => d.cx)) : Math.round(canvas.width * 0.72);
  const globalR = allDets.length ? median(allDets.map((d) => d.r)) : Math.round(canvas.width * 0.24);

  // Pass 2: per-segment vertical position from agreeing frames only.
  const cxTol = Math.max(50, globalR * 0.35);
  const rTol = Math.max(35, globalR * 0.25);

  const segCy = new Map<string, { cy: number; samples: number }>();
  for (const seg of circleSegs) {
    const dets = perSeg.get(seg.id) ?? [];
    const agree = dets.filter(
      (d) => Math.abs(d.cx - globalCx) <= cxTol && Math.abs(d.r - globalR) <= rTol
    );
    if (agree.length > 0) {
      segCy.set(seg.id, { cy: median(agree.map((d) => d.cy)), samples: agree.length });
    }
  }

  for (const seg of circleSegs) {
    let entry = segCy.get(seg.id);
    let confident = !!entry && entry.samples >= Math.max(3, Math.round(N * 0.4));
    if (!entry) {
      let nearestCy = Math.round(canvas.height * 0.28);
      let bestDist = Infinity;
      const mid = (seg.start + seg.end) / 2;
      for (const other of circleSegs) {
        const oe = segCy.get(other.id);
        if (!oe) continue;
        const omid = (other.start + other.end) / 2;
        const d = Math.abs(omid - mid);
        if (d < bestDist) { bestDist = d; nearestCy = oe.cy; }
      }
      entry = { cy: nearestCy, samples: 0 };
      confident = false;
    }

    const cx = globalCx;
    const r = globalR;
    const cy = entry.cy;
    result.set(seg.id, {
      segmentId: seg.id,
      cx,
      cy,
      radius: r,
      box: { x: cx - r, y: cy - r, width: r * 2, height: r * 2 },
      samples: entry.samples,
      support: 0,
      confident,
    });
  }

  return result;
}

export interface RectangleMeasurement {
  /** Full-width A-roll rectangle in canvas space */
  rect: { x: number; y: number; width: number; height: number } | null;
  /** Detected overlay text bands (top-to-bottom), canvas space */
  textBands: TextBand[];
}

/**
 * Measure a rectangle (full-screen-A-roll) segment: the talking-head video
 * region's top edge (height from source aspect) and the header text bands.
 * The rect top is medianed over a few frames for stability; text bands come
 * from the segment midpoint (text is static within the segment).
 */
export async function measureReferenceRectangle(input: {
  ffmpegPath: string;
  refVideoPath: string;
  canvas: { width: number; height: number };
  segment: { start: number; end: number };
  sourceAspect: number;
  tmpDir: string;
  frames?: number;
  /** Vertical search bounds for the A-roll band (canvas px). Defaults to a
   *  generic top-third window when omitted. Seed from the LLM rough box to
   *  generalize to non-top layouts. */
  searchFromY?: number;
  searchToY?: number;
}): Promise<RectangleMeasurement> {
  const { ffmpegPath, refVideoPath, canvas, segment, sourceAspect, tmpDir } = input;
  const F = input.frames ?? 3;
  const searchFromY = input.searchFromY ?? Math.round(canvas.height * 0.18);
  const searchToY = input.searchToY ?? Math.round(canvas.height * 0.65);
  fs.mkdirSync(tmpDir, { recursive: true });

  const dur = Math.max(0.1, segment.end - segment.start);
  const a = segment.start + dur * 0.15;
  const b = segment.end - dur * 0.15;

  const tops: number[] = [];
  let height = Math.round(canvas.width / sourceAspect);
  let midFrame: string | null = null;

  for (let i = 0; i < F; i++) {
    const t = a + ((b - a) * (i + 0.5)) / F;
    const fp = path.join(tmpDir, `refrect_${i}.jpg`);
    if (!extractFrame(ffmpegPath, refVideoPath, t, canvas, fp)) continue;
    if (i === Math.floor(F / 2)) midFrame = fp;
    const rectRes: ArollRectResult | null = await measureArollRectangle({
      framePath: fp,
      canvas,
      sourceAspect,
      searchFromY,
      searchToY,
    });
    if (rectRes) {
      tops.push(rectRes.top);
      height = rectRes.height;
    }
    if (fp !== midFrame) {
      try { fs.unlinkSync(fp); } catch { /* ignore */ }
    }
  }

  let rect: RectangleMeasurement["rect"] = null;
  let textBands: TextBand[] = [];
  if (tops.length > 0) {
    const top = median(tops);
    rect = { x: 0, y: top, width: canvas.width, height };
    if (midFrame) {
      textBands = await measureTextBands({
        framePath: midFrame,
        canvas,
        regionTopY: 0,
        regionBottomY: top,
      });
    }
  }

  if (midFrame) {
    try { fs.unlinkSync(midFrame); } catch { /* ignore */ }
  }

  return { rect, textBands };
}
