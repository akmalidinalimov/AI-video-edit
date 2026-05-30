/**
 * Coordinate Measurer — deterministic computer-vision measurement of the
 * reference video's layout geometry, directly from the pixels.
 *
 * WHY THIS EXISTS:
 * Gemini's visual analysis estimates bounding boxes by eye and is unreliable
 * (observed: circle PIPs measured ~120-150px too high and ~60px too small).
 * The renderer faithfully reproduces whatever coordinates it's given, so wrong
 * measurements → wrong output. This module measures the real pixels instead,
 * giving pixel-accurate coordinates to drive the Layout Map.
 *
 * TECHNIQUES:
 *  - detectCircle(): gradient-Hough circle detection. The circle PIP has a
 *    bright border ring + a strong content/B-roll boundary, both of which
 *    create co-circular edges. Each edge pixel votes (along its gradient
 *    direction, at each candidate radius) for a center; the true center wins
 *    because its perimeter contributes many consistent votes. Radius is then
 *    chosen by perimeter edge-support.
 *  - detectHorizontalBands(): row-wise edge/contrast profile to find the
 *    boundaries between header / A-roll / B-roll regions (for rectangle A-roll
 *    layouts).
 *
 * All measurements are returned in the supplied working resolution; callers
 * scale to the canvas coordinate space.
 */

import sharp from "sharp";

export interface DetectedCircle {
  /** Center X (working-resolution px) */
  cx: number;
  /** Center Y */
  cy: number;
  /** Radius */
  radius: number;
  /** Accumulator peak strength (higher = more confident) */
  score: number;
  /** Perimeter edge-support fraction 0..1 for the chosen radius */
  support: number;
}

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Load a frame as a greyscale raster at the requested working resolution.
 * Uses fit:"fill" so the result is exactly width×height (coordinate space is
 * therefore that resolution; scale back to canvas as needed).
 */
export async function loadGray(
  framePath: string,
  width: number,
  height: number
): Promise<GrayImage> {
  const { data, info } = await sharp(framePath)
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  };
}

interface Gradient {
  gx: Float32Array;
  gy: Float32Array;
  mag: Float32Array;
}

/** Sobel gradient (gx, gy, magnitude). */
function sobel(gray: Uint8Array, W: number, H: number): Gradient {
  const gx = new Float32Array(W * H);
  const gy = new Float32Array(W * H);
  const mag = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const tl = gray[i - W - 1], t = gray[i - W], tr = gray[i - W + 1];
      const l = gray[i - 1], r = gray[i + 1];
      const bl = gray[i + W - 1], b = gray[i + W], br = gray[i + W + 1];
      const sx = tr + 2 * r + br - (tl + 2 * l + bl);
      const sy = bl + 2 * b + br - (tl + 2 * t + tr);
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return { gx, gy, mag };
}

/** 3×3 box blur of a float field (consolidates accumulator votes). */
function boxBlur(field: Float32Array, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      out[i] =
        field[i - W - 1] + field[i - W] + field[i - W + 1] +
        field[i - 1] + field[i] + field[i + 1] +
        field[i + W - 1] + field[i + W] + field[i + W + 1];
    }
  }
  return out;
}

export interface DetectCircleOptions {
  /** Min/max radius to search (working-resolution px) */
  rMin: number;
  rMax: number;
  /** Radius voting step */
  rStep?: number;
  /** Edge magnitude threshold (0..~1442). Auto if omitted. */
  edgeThreshold?: number;
  /** Restrict center search region (working-resolution px) */
  cxMin?: number;
  cxMax?: number;
  cyMin?: number;
  cyMax?: number;
}

/**
 * Detect the most prominent circle via gradient-Hough voting.
 * Returns null if no circle accumulates meaningful support.
 */
export function detectCircle(
  img: GrayImage,
  opts: DetectCircleOptions
): DetectedCircle | null {
  const { data: gray, width: W, height: H } = img;
  const { gx, gy, mag } = sobel(gray, W, H);

  const rMin = Math.max(4, Math.round(opts.rMin));
  const rMax = Math.round(opts.rMax);
  const rStep = opts.rStep ?? 2;

  // Auto edge threshold: 80th percentile of non-zero magnitudes (sampled).
  let thr = opts.edgeThreshold ?? 0;
  if (!opts.edgeThreshold) {
    const sample: number[] = [];
    for (let i = 0; i < mag.length; i += 7) {
      if (mag[i] > 0) sample.push(mag[i]);
    }
    sample.sort((a, b) => a - b);
    thr = sample.length ? sample[Math.floor(sample.length * 0.8)] : 100;
    thr = Math.max(thr, 60);
  }

  const cxMin = Math.floor(Math.max(0, opts.cxMin ?? 0));
  const cxMax = Math.ceil(Math.min(W, opts.cxMax ?? W));
  const cyMin = Math.floor(Math.max(0, opts.cyMin ?? 0));
  const cyMax = Math.ceil(Math.min(H, opts.cyMax ?? H));

  // ── Gradient-Hough vote for centers ──
  const accum = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const m = mag[i];
      if (m < thr) continue;
      const ux = gx[i] / m;
      const uy = gy[i] / m;
      for (let r = rMin; r <= rMax; r += rStep) {
        // Center lies along ±gradient from the edge pixel
        let cx = (x - ux * r) | 0;
        let cy = (y - uy * r) | 0;
        if (cx >= cxMin && cx < cxMax && cy >= cyMin && cy < cyMax) {
          accum[cy * W + cx] += 1;
        }
        cx = (x + ux * r) | 0;
        cy = (y + uy * r) | 0;
        if (cx >= cxMin && cx < cxMax && cy >= cyMin && cy < cyMax) {
          accum[cy * W + cx] += 1;
        }
      }
    }
  }

  // Consolidate votes and find the peak center
  const sm = boxBlur(accum, W, H);
  let best = -1, bcx = 0, bcy = 0;
  for (let y = cyMin; y < cyMax; y++) {
    for (let x = cxMin; x < cxMax; x++) {
      const v = sm[y * W + x];
      if (v > best) {
        best = v;
        bcx = x;
        bcy = y;
      }
    }
  }
  if (best <= 0) return null;

  // ── Choose radius by MEAN perimeter edge strength ──
  // The true boundary (white ring + content/B-roll transition) has high mean
  // edge magnitude around the perimeter. Using the mean (not a count) avoids
  // biasing toward larger radii that merely sweep more cluttered pixels.
  let brad = rMin, bestMean = -1, bestSupport = 0;
  const samples = 180;
  for (let r = rMin; r <= rMax; r++) {
    let sum = 0, cnt = 0, hits = 0;
    for (let a = 0; a < samples; a++) {
      const ang = (a / samples) * 2 * Math.PI;
      const px = (bcx + Math.cos(ang) * r) | 0;
      const py = (bcy + Math.sin(ang) * r) | 0;
      if (px < 1 || px >= W - 1 || py < 1 || py >= H - 1) continue;
      const m = mag[py * W + px];
      sum += m;
      cnt++;
      if (m >= thr) hits++;
    }
    if (cnt === 0) continue;
    const mean = sum / cnt;
    if (mean > bestMean) {
      bestMean = mean;
      brad = r;
      bestSupport = hits / cnt;
    }
  }

  return { cx: bcx, cy: bcy, radius: brad, score: best, support: bestSupport };
}

export interface DetectCircleAtScaleResult {
  /** Circle in CANVAS coordinate space */
  cx: number;
  cy: number;
  radius: number;
  /** Bounding box (top-left) in canvas space */
  box: { x: number; y: number; width: number; height: number };
  score: number;
  support: number;
  /** Working resolution used */
  work: { width: number; height: number };
}

/**
 * Convenience: load a frame, detect the circle at a downscaled working
 * resolution (fast), and return the result scaled to the canvas space.
 */
export async function measureCircleFromFrame(input: {
  framePath: string;
  canvas: { width: number; height: number };
  /** Working downscale factor (e.g. 3 → 360×640 for a 1080×1920 canvas) */
  downscale?: number;
  /** Expected radius range in CANVAS px */
  radiusRange?: { min: number; max: number };
  /** Optional center-search region in CANVAS px */
  centerRegion?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number };
}): Promise<DetectCircleAtScaleResult | null> {
  const { framePath, canvas } = input;
  const ds = input.downscale ?? 3;
  const W = Math.round(canvas.width / ds);
  const H = Math.round(canvas.height / ds);

  const img = await loadGray(framePath, W, H);

  const rMinC = input.radiusRange?.min ?? Math.round(canvas.width * 0.13);
  const rMaxC = input.radiusRange?.max ?? Math.round(canvas.width * 0.27);

  const det = detectCircle(img, {
    rMin: rMinC / ds,
    rMax: rMaxC / ds,
    rStep: 1,
    cxMin: input.centerRegion?.xMin ? input.centerRegion.xMin / ds : undefined,
    cxMax: input.centerRegion?.xMax ? input.centerRegion.xMax / ds : undefined,
    cyMin: input.centerRegion?.yMin ? input.centerRegion.yMin / ds : undefined,
    cyMax: input.centerRegion?.yMax ? input.centerRegion.yMax / ds : undefined,
  });
  if (!det) return null;

  // Scale back to canvas space
  const cx = Math.round(det.cx * ds);
  const cy = Math.round(det.cy * ds);
  const radius = Math.round(det.radius * ds);

  return {
    cx,
    cy,
    radius,
    box: {
      x: cx - radius,
      y: cy - radius,
      width: radius * 2,
      height: radius * 2,
    },
    score: det.score,
    support: det.support,
    work: { width: W, height: H },
  };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ════════════════════════════════════════════════════════════
// RECTANGLE A-ROLL + TEXT BAND DETECTION (row-profile based)
// ════════════════════════════════════════════════════════════

/** Per-row mean brightness over the full width. */
function rowBrightness(gray: Uint8Array, W: number, H: number): Float32Array {
  const out = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) s += gray[y * W + x];
    out[y] = s / W;
  }
  return out;
}

/** Per-row count of bright pixels (> thr). */
function rowBrightCount(gray: Uint8Array, W: number, H: number, thr: number): Float32Array {
  const out = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) if (gray[y * W + x] > thr) c++;
    out[y] = c;
  }
  return out;
}

export interface ArollRectResult {
  /** Top Y in CANVAS px */
  top: number;
  /** Height in CANVAS px (from source aspect, full-frame display) */
  height: number;
}

/**
 * Detect the full-width rectangle A-roll's TOP edge from a frame.
 *
 * The talking-head video is a long, sustained bright band (lit scene), unlike
 * the short bright bands of header text / colored boxes above it. We find the
 * longest contiguous run of bright rows; its start is the video top. Height is
 * derived from the source aspect ratio (the reference shows the full frame at
 * full width), which is more stable than detecting the dark lower edge.
 */
export async function measureArollRectangle(input: {
  framePath: string;
  canvas: { width: number; height: number };
  sourceAspect: number; // sourceWidth / sourceHeight
  downscale?: number;
  /** Don't search above this canvas Y (skip header text) */
  searchFromY?: number;
  /** Don't search below this canvas Y */
  searchToY?: number;
}): Promise<ArollRectResult | null> {
  const ds = input.downscale ?? 3;
  const W = Math.round(input.canvas.width / ds);
  const H = Math.round(input.canvas.height / ds);
  const img = await loadGray(input.framePath, W, H);
  const bright = rowBrightness(img.data, W, H);

  const yFrom = Math.floor((input.searchFromY ?? 0) / ds);
  const yTo = Math.ceil((input.searchToY ?? input.canvas.height * 0.65) / ds);

  // Threshold: midpoint between the dark header and the bright video.
  // Use a robust fixed-ish threshold scaled to data.
  let maxB = 0;
  for (let y = yFrom; y < yTo; y++) maxB = Math.max(maxB, bright[y]);
  const thr = Math.max(35, maxB * 0.55);

  // Find the longest contiguous run of rows with brightness > thr.
  let bestStart = -1, bestLen = 0;
  let curStart = -1, curLen = 0;
  for (let y = yFrom; y < yTo; y++) {
    if (bright[y] > thr) {
      if (curStart < 0) curStart = y;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestStart < 0) return null;

  // Refine the top edge: step back to where brightness crosses half-threshold.
  let topWork = bestStart;
  while (topWork > yFrom && bright[topWork - 1] > thr * 0.5) topWork--;

  const top = Math.round(topWork * ds);
  const height = Math.round(input.canvas.width / input.sourceAspect);
  return { top, height };
}

export interface TextBand {
  /** CANVAS-space bounding box */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ColorSegment {
  /** Color class label */
  klass: "white" | "yellow" | "other";
  /** Representative color as 0xRRGGBB */
  color: string;
  /** CANVAS-space horizontal extent of this color run */
  xStart: number;
  xEnd: number;
}

function classifyInk(r: number, g: number, b: number): "white" | "yellow" | "other" | null {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx < 70) return null; // too dark → background, not ink
  // Yellow first (warm, low blue) so off-white-warm isn't mistaken for white
  if (r > 130 && g > 100 && r - b > 45 && g - b > 25) return "yellow";
  // White / near-white (incl. anti-aliased grays of thin strokes)
  if (mn > 125 && mx - mn < 70) return "white";
  return "other";
}

/**
 * Detect distinct ink-color runs along a single text line. Used to reproduce
 * multi-color headlines (e.g. "2026-yil" yellow + "SMM" white on one line).
 *
 * Scans each column within the band, finds the dominant ink color of that
 * column, and groups contiguous same-color columns into segments. Returns
 * segments left-to-right. A single segment means the line is one color.
 */
export async function measureTextColorSegments(input: {
  framePath: string;
  canvas: { width: number; height: number };
  band: TextBand;
  downscale?: number;
}): Promise<ColorSegment[]> {
  const ds = input.downscale ?? 2;
  const W = Math.round(input.canvas.width / ds);
  const H = Math.round(input.canvas.height / ds);
  const { data, info } = await sharp(input.framePath)
    .resize(W, H, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const px = new Uint8Array(data.buffer, data.byteOffset, data.length);

  const x0 = Math.max(0, Math.floor(input.band.x / ds));
  const x1 = Math.min(W, Math.ceil((input.band.x + input.band.width) / ds));
  const y0 = Math.max(0, Math.floor(input.band.y / ds));
  const y1 = Math.min(H, Math.ceil((input.band.y + input.band.height) / ds));

  // Per-column dominant ink color + accumulated RGB for representative color
  const colClass: Array<"white" | "yellow" | "other" | null> = [];
  const colRGB: Array<[number, number, number]> = [];
  for (let x = x0; x < x1; x++) {
    let cw = 0, cy = 0, co = 0;
    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * W + x) * ch;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const k = classifyInk(r, g, b);
      if (!k) continue;
      if (k === "white") cw++;
      else if (k === "yellow") cy++;
      else co++;
      rs += r; gs += g; bs += b; n++;
    }
    if (n < 1) {
      colClass.push(null);
      colRGB.push([0, 0, 0]);
      continue;
    }
    const dom = cw >= cy && cw >= co ? "white" : cy >= co ? "yellow" : "other";
    colClass.push(dom);
    colRGB.push([rs / n, gs / n, bs / n]);
  }

  // Group contiguous columns of the same class (tolerate small gaps/noise)
  const segments: ColorSegment[] = [];
  let curClass: "white" | "yellow" | "other" | null = null;
  let segStartIdx = 0;
  let gap = 0;
  // Bridge inter-letter gaps within a same-color word (italic serifs leave
  // wide gaps), so a word isn't fragmented into sub-min segments.
  const gapTol = Math.max(6, Math.round((x1 - x0) * 0.09));
  const rgbAcc: number[] = [0, 0, 0, 0]; // r,g,b,count

  const flush = (endIdx: number) => {
    if (curClass && rgbAcc[3] > 0) {
      const r = Math.round(rgbAcc[0] / rgbAcc[3]);
      const g = Math.round(rgbAcc[1] / rgbAcc[3]);
      const b = Math.round(rgbAcc[2] / rgbAcc[3]);
      const hex =
        "0x" +
        [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
      segments.push({
        klass: curClass,
        color: hex,
        xStart: (x0 + segStartIdx) * ds,
        xEnd: (x0 + endIdx) * ds,
      });
    }
  };

  for (let idx = 0; idx < colClass.length; idx++) {
    const c = colClass[idx];
    if (c === null) {
      gap++;
      if (curClass && gap > gapTol) {
        flush(idx - gap);
        curClass = null;
        rgbAcc[0] = rgbAcc[1] = rgbAcc[2] = rgbAcc[3] = 0;
      }
      continue;
    }
    gap = 0;
    if (curClass === null) {
      curClass = c;
      segStartIdx = idx;
      rgbAcc[0] = rgbAcc[1] = rgbAcc[2] = rgbAcc[3] = 0;
    } else if (c !== curClass) {
      flush(idx - 1);
      curClass = c;
      segStartIdx = idx;
      rgbAcc[0] = rgbAcc[1] = rgbAcc[2] = rgbAcc[3] = 0;
    }
    rgbAcc[0] += colRGB[idx][0];
    rgbAcc[1] += colRGB[idx][1];
    rgbAcc[2] += colRGB[idx][2];
    rgbAcc[3] += 1;
  }
  flush(colClass.length - 1);

  // Drop only very thin noise segments
  const minSegW = input.band.width * 0.05;
  return segments.filter((s) => s.xEnd - s.xStart >= minSegW);
}

/**
 * Detect horizontal text/overlay bands within a vertical region (e.g. the
 * header above the A-roll). Returns one box per text line, top-to-bottom.
 *
 * A "text row" has enough bright pixels (white/colored text or a colored
 * background box). Contiguous text rows form a band; the band's horizontal
 * extent comes from the columns containing bright pixels.
 */
export async function measureTextBands(input: {
  framePath: string;
  canvas: { width: number; height: number };
  regionTopY: number;
  regionBottomY: number;
  downscale?: number;
  /** Brightness threshold for "ink" pixels */
  inkThreshold?: number;
}): Promise<TextBand[]> {
  const ds = input.downscale ?? 3;
  const W = Math.round(input.canvas.width / ds);
  const H = Math.round(input.canvas.height / ds);
  const img = await loadGray(input.framePath, W, H);
  const g = img.data;

  const inkThr = input.inkThreshold ?? 120;
  const yTop = Math.max(0, Math.floor(input.regionTopY / ds));
  const yBot = Math.min(H, Math.ceil(input.regionBottomY / ds));

  const counts = rowBrightCount(g, W, H, inkThr);
  const minRowInk = Math.max(3, W * 0.03);

  // Group contiguous "ink" rows into bands (allow small vertical gaps).
  const bands: Array<{ y0: number; y1: number }> = [];
  let start = -1;
  let gap = 0;
  const gapTol = Math.max(2, Math.round(H * 0.008));
  for (let y = yTop; y < yBot; y++) {
    const isInk = counts[y] >= minRowInk;
    if (isInk) {
      if (start < 0) start = y;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap > gapTol) {
        bands.push({ y0: start, y1: y - gap });
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0) bands.push({ y0: start, y1: yBot - 1 });

  // For each band, compute horizontal extent from ink columns.
  const result: TextBand[] = [];
  for (const b of bands) {
    if (b.y1 - b.y0 < 2) continue; // too thin
    let xMin = W, xMax = 0;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = 0; x < W; x++) {
        if (g[y * W + x] > inkThr) {
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
        }
      }
    }
    if (xMax <= xMin) continue;
    result.push({
      x: Math.round(xMin * ds),
      y: Math.round(b.y0 * ds),
      width: Math.round((xMax - xMin) * ds),
      height: Math.round((b.y1 - b.y0) * ds),
    });
  }
  return result;
}

export interface RobustCircleResult extends DetectCircleAtScaleResult {
  /** Number of frames that produced a detection */
  samples: number;
  /** Per-axis spread (max-min) of the kept detections, canvas px */
  spread: { cx: number; cy: number; radius: number };
}

/**
 * Robustly measure the circle across MULTIPLE frames and take the median.
 *
 * The PIP stays in place during a layout state while the B-roll behind it
 * scrolls/changes — so clutter-induced false detections vary frame-to-frame
 * and are rejected by the median, while the true circle is consistent.
 *
 * Pass already-extracted frame paths (all at canvas resolution).
 */
export async function measureCircleRobust(input: {
  framePaths: string[];
  canvas: { width: number; height: number };
  downscale?: number;
  radiusRange?: { min: number; max: number };
  centerRegion?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number };
  /** Drop detections whose center is >2× MAD from the median before re-medianing */
  rejectOutliers?: boolean;
}): Promise<RobustCircleResult | null> {
  const dets: DetectCircleAtScaleResult[] = [];
  for (const fp of input.framePaths) {
    const d = await measureCircleFromFrame({
      framePath: fp,
      canvas: input.canvas,
      downscale: input.downscale,
      radiusRange: input.radiusRange,
      centerRegion: input.centerRegion,
    });
    if (d) dets.push(d);
  }
  if (dets.length === 0) return null;

  // First-pass medians
  let cxs = dets.map((d) => d.cx);
  let cys = dets.map((d) => d.cy);
  let rs = dets.map((d) => d.radius);
  let mcx = median(cxs), mcy = median(cys), mr = median(rs);

  // Outlier rejection: keep detections within a tolerance of the median, then
  // re-median. This removes the occasional false peak.
  let kept = dets;
  if (input.rejectOutliers !== false) {
    const tol = Math.max(40, mr * 0.35);
    kept = dets.filter(
      (d) =>
        Math.abs(d.cx - mcx) <= tol &&
        Math.abs(d.cy - mcy) <= tol &&
        Math.abs(d.radius - mr) <= tol
    );
    if (kept.length >= 1) {
      cxs = kept.map((d) => d.cx);
      cys = kept.map((d) => d.cy);
      rs = kept.map((d) => d.radius);
      mcx = median(cxs);
      mcy = median(cys);
      mr = median(rs);
    } else {
      kept = dets;
    }
  }

  const spread = {
    cx: Math.max(...cxs) - Math.min(...cxs),
    cy: Math.max(...cys) - Math.min(...cys),
    radius: Math.max(...rs) - Math.min(...rs),
  };
  const avgSupport = kept.reduce((s, d) => s + d.support, 0) / kept.length;
  const avgScore = kept.reduce((s, d) => s + d.score, 0) / kept.length;

  return {
    cx: mcx,
    cy: mcy,
    radius: mr,
    box: { x: mcx - mr, y: mcy - mr, width: mr * 2, height: mr * 2 },
    score: avgScore,
    support: avgSupport,
    work: dets[0].work,
    samples: kept.length,
    spread,
  };
}
