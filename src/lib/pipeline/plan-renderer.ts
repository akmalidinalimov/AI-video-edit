/**
 * Plan Renderer — Phase 3 of the AIvo Pipeline
 *
 * Layout-agnostic single-pass FFmpeg renderer.
 *
 * Takes an EditingPlan + VCSTemplate (static or dynamically generated)
 * and builds the correct FFmpeg filter chain for ANY layout combination.
 *
 * ARCHITECTURE:
 * - ONE FFmpeg command, continuous input streams, zero concatenation
 * - Layout switching via overlay enable='between(t,...)' expressions
 * - Audio maps directly from continuous A-roll input (-map 1:a)
 * - The renderer is a PURE FUNCTION: plan + template → FFmpeg args
 *
 * RENDERING ORDER (z-stack, bottom to top):
 * 1. B-roll (always the base layer, continuous)
 * 2. Header zones (black regions with text — drawn behind A-roll)
 * 3. Circle borders (drawn before circle A-roll so ring is visible)
 * 4. A-roll (rectangle or circle, positioned per layout)
 * 5. Text overlays (drawtext on top of everything)
 *
 * This module does NOT execute FFmpeg — it produces the args array.
 * The caller controls execution, timeout, and error handling.
 */

import type {
  EditingPlan,
  LayoutRange,
  TextOverlay,
} from "./editing-plan";
import { combineEnableExprs } from "./editing-plan";
import type { VCSTemplate, LayoutVariant } from "./vcs-templates";
import { buildOverlayExpr } from "./layout-map";
import { resolveFontForStyle, inferStyleFromHints } from "./font-registry";

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface RenderInput {
  /** The validated editing plan */
  plan: EditingPlan;
  /** The VCS template (static or dynamically generated) */
  template: VCSTemplate;
  /** A-roll source video dimensions (for face-centered crop) */
  arollSourceDimensions: { width: number; height: number };
  /** Path to FFmpeg binary */
  ffmpegPath: string;
  /** Output video path */
  outputPath: string;
  /** Encoding options (optional, sensible defaults) */
  encoding?: Partial<EncodingOptions>;
}

export interface EncodingOptions {
  /** x264 preset (default: "fast") */
  preset: string;
  /** CRF quality (default: 23) */
  crf: number;
  /** Audio bitrate (default: "128k") */
  audioBitrate: string;
  /** Pixel format (default: "yuv420p") */
  pixFmt: string;
}

export interface RenderOutput {
  /** Complete FFmpeg args array (pass to spawn/exec) */
  ffmpegArgs: string[];
  /** The filter_complex string (for debugging/logging) */
  filterComplex: string;
  /** Number of filter stages */
  filterStageCount: number;
  /** Total video duration in seconds */
  duration: number;
  /** Whether layout-aware B-roll positioning is active */
  layoutAwareBroll: boolean;
  /** Grouped layout info for logging */
  layoutGroups: Array<{
    layoutId: string;
    rangeCount: number;
    combinedEnable: string;
    shape: string;
    hasHeader: boolean;
    hasBorder: boolean;
    brollRegion: { x: number; y: number; width: number; height: number };
    brollIsBackground: boolean;
  }>;
}

// ════════════════════════════════════════════════════════════
// FONT PATHS (platform-aware via fonts.ts)
// ════════════════════════════════════════════════════════════

import { FONTS as CENTRAL_FONTS } from "./fonts";

const DEFAULT_FONTS = {
  regular: CENTRAL_FONTS.regular,
  bold: CENTRAL_FONTS.bold,
  headline: CENTRAL_FONTS.headline,
} as const;

// ════════════════════════════════════════════════════════════
// FILTER BUILDER — Layout-agnostic
// ════════════════════════════════════════════════════════════

interface LayoutGroup {
  layoutId: string;
  layout: LayoutVariant;
  ranges: LayoutRange[];
  combinedEnable: string;
}

/**
 * Group plan ranges by layoutId and compute combined enable expressions.
 */
function groupRangesByLayout(
  plan: EditingPlan,
  template: VCSTemplate
): LayoutGroup[] {
  const groups = new Map<string, LayoutRange[]>();

  for (const range of plan.layoutRanges) {
    const existing = groups.get(range.layoutId);
    if (existing) {
      existing.push(range);
    } else {
      groups.set(range.layoutId, [range]);
    }
  }

  const result: LayoutGroup[] = [];

  for (const [layoutId, ranges] of Array.from(groups.entries())) {
    const layout = template.layouts[layoutId];
    if (!layout) {
      throw new Error(
        `Layout "${layoutId}" not found in template "${template.id}". ` +
        `Available: ${Object.keys(template.layouts).join(", ")}`
      );
    }

    const enableExprs = ranges.map((r) => r.enableExpr);
    const combinedEnable = combineEnableExprs(enableExprs);

    result.push({ layoutId, layout, ranges, combinedEnable });
  }

  // Sort by first range start time (rendering order = appearance order)
  result.sort(
    (a, b) => a.ranges[0].timeRange.start - b.ranges[0].timeRange.start
  );

  return result;
}

/**
 * Compute a face-centered crop for the A-roll video.
 *
 * Given the target crop size and the face center in the source video,
 * computes scale + crop parameters that keep the face centered.
 *
 * V5.1 FIX (Issue 3): The original algorithm used `Math.max(scaleW, scaleH)`
 * which could leave zero margin on one axis. For example, scaling a 1920×1080
 * source to fit a 460×460 circle target: scaleH = 0.426, scaledH = 460 — no
 * vertical room to center a face that's above the midpoint.
 *
 * The fix: compute the minimum scale needed so that the face can be centered
 * in BOTH dimensions of the crop. This means the scaled image must be large
 * enough that shifting the crop window to center the face stays within bounds.
 */
function computeFaceCrop(
  targetW: number,
  targetH: number,
  faceCenterX: number,
  faceCenterY: number,
  sourceW: number,
  sourceH: number
): { scaledW: number; scaledH: number; cropX: number; cropY: number } {
  // Base scale: ensure source covers target area
  const scaleW = targetW / sourceW;
  const scaleH = targetH / sourceH;
  const baseScale = Math.max(scaleW, scaleH);

  // Face-centering scale: ensure enough room to center the face.
  // After scaling, the face must be at least targetW/2 from both edges
  // horizontally, and targetH/2 from both edges vertically.
  const faceFractionX = faceCenterX / sourceW; // 0..1, where face is horizontally
  const faceFractionY = faceCenterY / sourceH; // 0..1, where face is vertically

  // Minimum scaled width so face can be centered: face needs targetW/2 pixels
  // on each side. If face is at fraction f, scaled width must be at least
  // targetW / (2 * min(f, 1-f)) — but clamp to avoid infinite when face is at edge.
  let faceScale = baseScale;

  const fxClamped = Math.max(0.1, Math.min(0.9, faceFractionX));
  const fyClamped = Math.max(0.1, Math.min(0.9, faceFractionY));

  const neededScaleForX = targetW / (2 * Math.min(fxClamped, 1 - fxClamped) * sourceW);
  const neededScaleForY = targetH / (2 * Math.min(fyClamped, 1 - fyClamped) * sourceH);

  // Use the maximum of base scale and face-centering requirements,
  // but cap at 2x the base scale to avoid excessive zoom
  faceScale = Math.min(
    baseScale * 2,
    Math.max(baseScale, neededScaleForX, neededScaleForY)
  );

  const scaledW = Math.round(sourceW * faceScale);
  const scaledH = Math.round(sourceH * faceScale);

  // Ensure even dimensions for FFmpeg
  const evenScaledW = scaledW + (scaledW % 2);
  const evenScaledH = scaledH + (scaledH % 2);

  const faceX = Math.round(faceCenterX * faceScale);
  const faceY = Math.round(faceCenterY * faceScale);

  const cropX = Math.max(
    0,
    Math.min(faceX - Math.round(targetW / 2), evenScaledW - targetW)
  );
  const cropY = Math.max(
    0,
    Math.min(faceY - Math.round(targetH / 2), evenScaledH - targetH)
  );

  return { scaledW: evenScaledW, scaledH: evenScaledH, cropX, cropY };
}

/**
 * Escape text for FFmpeg drawtext filter.
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/'/g, "’")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .trim();
}

/**
 * Normalize a color string for FFmpeg drawtext.
 * Converts "#RRGGBB" → "0xRRGGBB"; passes through "0x..." and color names.
 */
function normalizeColor(c?: string | null): string | undefined {
  if (!c) return undefined;
  const s = c.trim();
  if (s.startsWith("#")) return "0x" + s.slice(1);
  return s;
}

/**
 * Pick a font file for a map-driven overlay text based on its color/weight.
 * Gold/yellow → headline font; bold → bold; otherwise regular.
 */
function pickOverlayFont(fontColor: string, isBold: boolean): string {
  const c = fontColor.toUpperCase();
  if (c.includes("FDD835") || c.includes("FFD700") || c.includes("FFEB3B")) {
    return DEFAULT_FONTS.headline;
  }
  return isBold ? DEFAULT_FONTS.bold : DEFAULT_FONTS.regular;
}

/**
 * Determine the font file path for a text overlay.
 */
function resolveFontFile(
  overlay: TextOverlay,
  layout: LayoutVariant,
  _template: VCSTemplate
): string {
  // Explicit override
  if (overlay.fontFile) return overlay.fontFile;

  // Find matching slot in layout
  const slot = layout.headerZone?.textSlots.find(
    (s) => s.id === overlay.slotId
  );
  if (slot?.defaultFont) return slot.defaultFont;

  // Color-based heuristic (gold = headline font)
  const color = (overlay.fontColor ?? "").toUpperCase();
  if (
    color.includes("FDD835") ||
    color.includes("FFD700") ||
    color.includes("FFEB3B")
  ) {
    return DEFAULT_FONTS.headline;
  }

  return DEFAULT_FONTS.regular;
}

/**
 * Build the complete filter_complex string for a plan + template.
 *
 * This is the core of the layout-agnostic renderer. It inspects each
 * layout's properties (shape, header, border, text slots) and generates
 * the appropriate FFmpeg filters dynamically.
 */
export function buildFilterComplex(
  plan: EditingPlan,
  template: VCSTemplate,
  arollSourceDimensions: { width: number; height: number }
): { filterComplex: string; groups: LayoutGroup[]; allBrollIsFullCanvas: boolean } {
  const { canvas, fps } = plan;
  const filters: string[] = [];
  let lastLabel = "bg";
  let stepNum = 1;

  // ── Input index mapping ──
  // Multi-B-roll: each B-roll is a separate FFmpeg input (0, 1, 2, ...)
  // A-roll inputs start after all B-roll inputs
  const brollInputCount = plan.sources.brollClips?.length ?? 1;
  const arollInputBase = brollInputCount; // First A-roll input index (e.g., 1 for single B-roll)
  const brollInputBase = 0; // First B-roll input index

  // ── Multi-A-roll concat ──
  // When >1 A-roll clip is uploaded each is a separate FFmpeg input. The filter
  // graph must concatenate them into one continuous video+audio stream so the
  // single-pass renderer can treat them as one. Downstream filters reference
  // [aroll_v] (video) and [aroll_a] (audio) instead of the raw input.
  // For single-A-roll setups [aroll_v]/[aroll_a] are simple passthroughs of
  // input [arollInputBase:v/a] — same behavior, uniform downstream API.
  const arollClipCount = plan.sources.arollClips?.length ?? 1;
  const arollVideoLabel = "aroll_v";
  const arollAudioLabel = "aroll_a";

  // Emit the concat / passthrough stage now so downstream filters see a uniform
  // [aroll_v]/[aroll_a] interface regardless of clip count. Each input is
  // normalized to the timeline fps and to the first clip's pixel dimensions
  // (concat needs uniform tb/size). Audio resampled to 44.1k stereo fltp.
  const _aw = arollSourceDimensions.width;
  const _ah = arollSourceDimensions.height;
  if (arollClipCount > 1) {
    const concatPairs: string[] = [];
    for (let i = 0; i < arollClipCount; i++) {
      const ii = arollInputBase + i;
      const vl = `a${i}vp`;
      const al = `a${i}ap`;
      filters.push(
        `[${ii}:v]fps=${fps},scale=${_aw}:${_ah}:force_original_aspect_ratio=decrease,` +
          `pad=${_aw}:${_ah}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[${vl}]`
      );
      filters.push(
        `[${ii}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[${al}]`
      );
      concatPairs.push(`[${vl}][${al}]`);
    }
    filters.push(
      `${concatPairs.join("")}concat=n=${arollClipCount}:v=1:a=1[${arollVideoLabel}][${arollAudioLabel}]`
    );
  } else {
    // Passthrough so downstream reference [aroll_v]/[aroll_a] is always valid.
    filters.push(`[${arollInputBase}:v]copy[${arollVideoLabel}]`);
    filters.push(`[${arollInputBase}:a]anull[${arollAudioLabel}]`);
  }

  // ── Step 1: Group ranges by layout ──
  const groups = groupRangesByLayout(plan, template);

  // Log direct replication overrides if present
  const rangesWithOverrides = plan.layoutRanges.filter(r => r.layoutOverride);
  if (rangesWithOverrides.length > 0) {
    console.log(`  [Direct replication] ${rangesWithOverrides.length}/${plan.layoutRanges.length} ranges have coordinate overrides from blueprint`);
    for (const r of rangesWithOverrides) {
      const ov = r.layoutOverride!;
      const parts: string[] = [];
      if (ov.aroll) parts.push(`aroll=${ov.aroll.shape}(${ov.aroll.region.x},${ov.aroll.region.y},${ov.aroll.region.width}x${ov.aroll.region.height})`);
      if (ov.broll) parts.push(`broll(${ov.broll.region.x},${ov.broll.region.y},${ov.broll.region.width}x${ov.broll.region.height})`);
      if (ov.texts?.length) parts.push(`${ov.texts.length} texts`);
      console.log(`    ${r.id} [${r.layoutId}]: ${parts.join(", ")}`);
    }
  }

  // ── Step 2: Identify what A-roll branches we need ──
  //
  // RECTANGLE layouts: ONE branch per layout group (all ranges share dimensions)
  // CIRCLE layouts: ONE branch PER RANGE — each range uses its own blueprint
  // dimensions (x, y, width, height) for pixel-precise replication of the
  // reference video's PIP placement. This is critical because the reference
  // video may have different circle sizes and positions per segment.
  const arollBranches: Array<{
    layoutId: string;
    shape: "rectangle" | "circle";
    label: string;
    layout: LayoutVariant;
    /** Per-range override region (for circles with per-range branches) */
    overrideRegion?: { x: number; y: number; width: number; height: number };
    /** Range ID (for per-range branches) */
    rangeId?: string;
    /** Enable expression (for per-range branches) */
    enableExpr?: string;
  }> = [];

  for (const group of groups) {
    const { layout } = group;
    // Skip layouts with no A-roll region (pure B-roll layouts)
    if (
      !layout.aroll.region ||
      (layout.aroll.region.width === 0 && layout.aroll.region.height === 0)
    ) {
      continue;
    }

    if (layout.aroll.shape === "circle") {
      // Per-range branches for circles — each gets its own dimensions
      for (const range of group.ranges) {
        const overrideRegion = range.layoutOverride?.aroll?.region;
        arollBranches.push({
          layoutId: group.layoutId,
          shape: "circle",
          label: `aroll_${range.id}`,
          layout,
          overrideRegion: overrideRegion ?? undefined,
          rangeId: range.id,
          enableExpr: range.enableExpr,
        });
      }
    } else {
      // Rectangle: one branch per group
      arollBranches.push({
        layoutId: group.layoutId,
        shape: layout.aroll.shape,
        label: `aroll_${group.layoutId}`,
        layout,
      });
    }
  }

  // ── Step 3: B-roll preparation ──
  // Check if any range has per-range B-roll offsets (V3 content matching)
  const hasBrollOffsets = plan.layoutRanges.some(r => r.brollOffset !== undefined);

  // Identify per-layout B-roll branches (needed for both offset and non-offset paths)
  const brollBranches = groups.map((g) => ({
    layoutId: g.layoutId,
    region: g.layout.broll.region,
    isBackground: g.layout.broll.isBackground,
    label: `broll_${g.layoutId}`,
    combinedEnable: g.combinedEnable,
  }));

  // Fast-path check: if ALL layouts have full-canvas background B-roll,
  // keep the simple single-scale approach (zero regression risk)
  const allBrollIsFullCanvas = brollBranches.every(
    (b) =>
      b.isBackground &&
      b.region.x <= 1 &&
      b.region.y <= 1 &&
      b.region.width >= canvas.width - 2 &&
      b.region.height >= canvas.height - 2
  );

  if (hasBrollOffsets) {
    // ── Per-range B-roll offsets (V3: content-matched B-roll) ──
    //
    // Each layout range shows a different portion of the B-roll video,
    // determined by the brollOffset field. We:
    // 1. Create a black base canvas
    // 2. Split B-roll into N streams (one per range)
    // 3. Each stream: trim to offset → reset PTS → scale/crop
    // 4. Overlay each at the right time using per-range enable
    //
    // The result is [bg], which downstream overlays (header, A-roll, text)
    // use unchanged — only B-roll sourcing changes.

    const ranges = plan.layoutRanges;
    const rangeCount = ranges.length;

    // 3a. Black canvas base
    filters.push(
      `color=black:s=${canvas.width}x${canvas.height}:r=${fps}:d=999,` +
        `setpts=PTS-STARTPTS[bg_base]`
    );

    // 3b. Multi-B-roll: group ranges by their brollSourceIndex
    // Each unique source index maps to a different FFmpeg input
    const sourceGroups = new Map<number, number[]>(); // sourceIndex → range indices
    for (let i = 0; i < rangeCount; i++) {
      const srcIdx = ranges[i].brollSourceIndex ?? 0;
      const existing = sourceGroups.get(srcIdx) ?? [];
      existing.push(i);
      sourceGroups.set(srcIdx, existing);
    }

    // For each source, split into per-range streams
    for (const [srcIdx, rangeIndices] of sourceGroups) {
      const inputIdx = brollInputBase + srcIdx;
      if (rangeIndices.length === 1) {
        filters.push(`[${inputIdx}:v]setpts=PTS-STARTPTS[br_r${rangeIndices[0]}_src]`);
      } else {
        const splitLabels = rangeIndices.map((ri) => `[br_r${ri}_src]`).join("");
        filters.push(
          `[${inputIdx}:v]setpts=PTS-STARTPTS,split=${rangeIndices.length}${splitLabels}`
        );
      }
    }

    // 3c. For each range: trim to offset, re-timestamp, scale/crop
    for (let i = 0; i < rangeCount; i++) {
      const range = ranges[i];
      const offset = range.brollOffset ?? 0;
      const rangeStart = range.timeRange.start;
      const layout = template.layouts[range.layoutId];
      // When the template layout says B-roll is background, always use full
      // canvas — override coordinates from individual blueprint segments may
      // have slightly smaller regions that leave black bars.
      const templateBg = layout?.broll?.isBackground ?? false;
      const overrideBg = range.layoutOverride?.broll?.isBackground;
      const isBackground = overrideBg ?? templateBg;
      const brollRegion = isBackground
        ? { x: 0, y: 0, width: canvas.width, height: canvas.height }
        : (range.layoutOverride?.broll?.region
            ?? layout?.broll?.region
            ?? { x: 0, y: 0, width: canvas.width, height: canvas.height });
      const isFullCanvas = isBackground;

      const targetW = isFullCanvas ? canvas.width : brollRegion.width;
      const targetH = isFullCanvas ? canvas.height : brollRegion.height;

      // Build the filter chain: trim → speed → setpts → scale/crop
      let filterChain = `[br_r${i}_src]trim=start=${offset.toFixed(4)},`;

      // Improvement #5: Apply speed adjustment if B-roll is shorter than range
      if (range.brollSpeed && range.brollSpeed !== 1.0) {
        const ptsFactor = (1 / range.brollSpeed).toFixed(4);
        filterChain += `setpts=${ptsFactor}*PTS,`;
      }

      filterChain += `setpts=PTS-STARTPTS+${rangeStart.toFixed(4)},`;

      // Improvement #4: Smart region cropping — zoom into relevant region
      if (range.brollCropRegion) {
        // brollCropRegion is percentage-based, convert to pixels relative to source
        // First scale to a larger size to allow cropping with zoom effect
        const cr = range.brollCropRegion;
        const zoomW = Math.round(targetW * (100 / cr.width));
        const zoomH = Math.round(targetH * (100 / cr.height));
        const cropX = Math.round(zoomW * cr.x / 100);
        const cropY = Math.round(zoomH * cr.y / 100);

        filterChain += `scale=${zoomW}:${zoomH}:force_original_aspect_ratio=increase,` +
          `crop=${targetW}:${targetH}:${cropX}:${cropY},setsar=1[br_r${i}]`;
      } else {
        filterChain += `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,` +
          `crop=${targetW}:${targetH},setsar=1[br_r${i}]`;
      }

      filters.push(filterChain);
    }

    // 3d. Overlay each B-roll range on the black base
    lastLabel = "bg_base";
    for (let i = 0; i < rangeCount; i++) {
      const range = ranges[i];
      const layout = template.layouts[range.layoutId];
      // Same logic as 3c: background B-roll always uses full canvas
      const templateBg2 = layout?.broll?.isBackground ?? false;
      const overrideBg2 = range.layoutOverride?.broll?.isBackground;
      const isBackground2 = overrideBg2 ?? templateBg2;
      const isFullCanvas = isBackground2;

      const overlayX = isFullCanvas ? 0 : (range.layoutOverride?.broll?.region?.x ?? layout?.broll?.region?.x ?? 0);
      const overlayY = isFullCanvas ? 0 : (range.layoutOverride?.broll?.region?.y ?? layout?.broll?.region?.y ?? 0);

      filters.push(
        `[${lastLabel}][br_r${i}]overlay=${overlayX}:${overlayY}:` +
          `enable='${range.enableExpr}'[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // Rename to [bg] for downstream consistency
    filters.push(`[${lastLabel}]copy[bg]`);
    lastLabel = "bg";

  } else if (allBrollIsFullCanvas) {
    // Fast path: single full-canvas B-roll (original behavior, no offsets)
    filters.push(
      `[${brollInputBase}:v]setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,` +
        `crop=${canvas.width}:${canvas.height},setsar=1[bg]`
    );
  } else {
    // Layout-aware path: black base + per-layout B-roll branches with enable
    // 3a. Black canvas base (covers uncovered areas)
    filters.push(
      `color=black:s=${canvas.width}x${canvas.height}:r=${fps}:d=999,` +
        `setpts=PTS-STARTPTS[bg_base]`
    );

    // 3b. Split B-roll into per-layout branches (or single passthrough)
    if (brollBranches.length === 1) {
      filters.push(
        `[${brollInputBase}:v]setpts=PTS-STARTPTS[${brollBranches[0].label}_src]`
      );
    } else {
      const splitLabels = brollBranches
        .map((b) => `[${b.label}_src]`)
        .join("");
      filters.push(
        `[${brollInputBase}:v]setpts=PTS-STARTPTS,split=${brollBranches.length}${splitLabels}`
      );
    }

    // 3c. Scale/crop each B-roll branch to its target region dimensions
    for (const branch of brollBranches) {
      const r = branch.region;
      filters.push(
        `[${branch.label}_src]scale=${r.width}:${r.height}:force_original_aspect_ratio=increase,` +
          `crop=${r.width}:${r.height},setsar=1[${branch.label}]`
      );
    }

    // 3d. Overlay each B-roll branch at (region.x, region.y) with enable
    lastLabel = "bg_base";
    for (const branch of brollBranches) {
      const r = branch.region;
      const enableStr = `'${branch.combinedEnable}'`;
      filters.push(
        `[${lastLabel}][${branch.label}]overlay=${r.x}:${r.y}:` +
          `enable=${enableStr}[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // Rename the final B-roll composite to [bg] for downstream consistency
    filters.push(`[${lastLabel}]copy[bg]`);
    lastLabel = "bg";
  }

  // ── Step 4: A-roll split and crop ──
  if (arollBranches.length > 0) {
    if (arollBranches.length === 1) {
      // Single branch — no split needed
      filters.push(
        `[${arollVideoLabel}]setpts=PTS-STARTPTS[${arollBranches[0].label}_src]`
      );
    } else {
      // Multiple branches — split A-roll
      const splitLabels = arollBranches
        .map((b) => `[${b.label}_src]`)
        .join("");
      filters.push(
        `[${arollVideoLabel}]setpts=PTS-STARTPTS,split=${arollBranches.length}${splitLabels}`
      );
    }

    // ── V6: Direct replication — use source video as-is ──
    //
    // RECTANGLE: Scale to fit width, NO crop. Show the full original frame.
    //   The speaker was framed well in their source video — zooming/cropping
    //   based on (potentially inaccurate) face detection makes things worse.
    //   Just: scale=targetW:-2 (auto-height preserving aspect ratio).
    //
    // CIRCLE: Scale down and crop a square around the source center.
    //   Use center-of-source (sourceW/2, sourceH/2) as the default crop point
    //   instead of Gemini face detection which may be inaccurate.
    //   computeFaceCrop() is still used for circles since we MUST extract
    //   a small region from a wide frame — but with a reliable center point.

    for (const branch of arollBranches) {
      const region = branch.layout.aroll.region;

      if (branch.shape === "rectangle") {
        // ── RECTANGLE: Scale to fill and crop to region ──
        // Scale so the source fills the target region in both dimensions,
        // then crop to the exact region size. This matches the reference
        // more closely — the reference had tighter framing.
        const targetW = region.width;
        const targetH = region.height;
        // Compute actual scaled size after fill
        const sourceAspect = arollSourceDimensions.width / arollSourceDimensions.height;
        const targetAspect = targetW / targetH;
        let scaledW: number, scaledH: number;
        if (sourceAspect > targetAspect) {
          // Source is wider — scale by height, crop width
          scaledH = targetH;
          scaledW = Math.round(targetH * sourceAspect);
        } else {
          // Source is taller — scale by width, crop height
          scaledW = targetW;
          scaledH = Math.round(targetW / sourceAspect);
        }
        scaledW = scaledW + (scaledW % 2); // ensure even
        scaledH = scaledH + (scaledH % 2);

        // Center crop
        const cropX = Math.round((scaledW - targetW) / 2);
        const cropY = Math.round((scaledH - targetH) / 2);

        // Store adjusted dimensions on the branch for overlay positioning
        (branch as Record<string, unknown>)._adjustedW = targetW;
        (branch as Record<string, unknown>)._adjustedH = targetH;

        console.log(
          `  [V6] Rectangle A-roll: scale-to-fill + crop. ` +
          `${arollSourceDimensions.width}×${arollSourceDimensions.height} → scale ${scaledW}×${scaledH} → crop ${targetW}×${targetH}`
        );

        filters.push(
          `[${branch.label}_src]scale=${scaledW}:${scaledH},crop=${targetW}:${targetH}:${cropX}:${cropY},setsar=1[${branch.label}]`
        );
      } else {
        // ── CIRCLE: Center-crop from 16:9 source → square → circle mask ──
        //
        // Simple approach: scale the source so the shorter dimension (height)
        // matches the circle target size, then center-crop a square from the
        // wider dimension (width). This preserves the natural camera distance
        // and framing — shoulders remain visible, no artificial zoom.
        //
        // Per-range: each branch may have its own dimensions from the blueprint.
        const circleRegion = branch.overrideRegion ?? region;
        const targetW = circleRegion.width;
        const targetH = circleRegion.height;

        // Store dimensions for overlay positioning
        (branch as Record<string, unknown>)._adjustedW = targetW;
        (branch as Record<string, unknown>)._adjustedH = targetH;

        // Scale so shorter source dimension fills the target square
        // For 16:9 source (1920×1080), height is shorter → scale by height
        const scale = Math.max(
          targetW / arollSourceDimensions.width,
          targetH / arollSourceDimensions.height
        );

        let scaledW = Math.round(arollSourceDimensions.width * scale);
        let scaledH = Math.round(arollSourceDimensions.height * scale);
        scaledW += scaledW % 2; // ensure even
        scaledH += scaledH % 2;

        // Center crop — take the middle square from the scaled frame
        const cropX = Math.max(0, Math.round((scaledW - targetW) / 2));
        const cropY = Math.max(0, Math.round((scaledH - targetH) / 2));

        const rangeInfo = branch.rangeId ? ` (${branch.rangeId})` : "";
        console.log(
          `  [V4] Circle A-roll${rangeInfo}: center-crop, no zoom. ` +
          `${arollSourceDimensions.width}×${arollSourceDimensions.height} → ` +
          `scale ${scaledW}×${scaledH} → crop ${targetW}×${targetH} at (${cropX},${cropY})`
        );

        // Circle: crop to square, then apply circular mask
        const radius = Math.min(targetW, targetH) / 2;
        const cx = targetW / 2;
        const cy = targetH / 2;

        filters.push(
          `[${branch.label}_src]scale=${scaledW}:${scaledH},` +
            `crop=${targetW}:${targetH}:${cropX}:${cropY},setsar=1[${branch.label}_raw]`
        );
        filters.push(
          `[${branch.label}_raw]format=yuva420p,` +
            `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':` +
            `a='if(lt(pow(X-${cx},2)+pow(Y-${cy},2),pow(${radius},2)),255,0)'` +
            `[${branch.label}]`
        );
      }
    }
  }

  // ── Step 5: Build overlays in z-order ──
  //
  // For each layout group, render its elements in order:
  //   a. Header zone (black background region)
  //   b. Rectangle A-roll (if shape=rectangle)
  //   c. Circle border (if shape=circle and has border)
  //   d. Circle A-roll (if shape=circle)
  //   e. Text overlays (drawtext)
  //
  // All overlays use the group's combined enable expression.

  for (const group of groups) {
    const { layout, combinedEnable } = group;
    const enableStr = `'${combinedEnable}'`;

    // ── 5a. Header zone ──
    if (layout.headerZone) {
      const hdr = layout.headerZone.region;

      // When layout-aware B-roll is active, the header only needs to cover
      // the header zone itself (B-roll won't bleed into it because B-roll
      // starts at its own y position). In fast-path mode, we need the
      // extended cover because B-roll fills the whole canvas.
      const coverHeight = allBrollIsFullCanvas
        ? layout.aroll.shape === "rectangle"
          ? layout.aroll.region.y + layout.aroll.region.height
          : hdr.height
        : hdr.height;

      filters.push(
        `color=black:s=${canvas.width}x${coverHeight}:r=${fps}:d=999,` +
          `setpts=PTS-STARTPTS[hdr_${group.layoutId}]`
      );
      filters.push(
        `[${lastLabel}][hdr_${group.layoutId}]overlay=0:0:` +
          `enable=${enableStr}[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // ── 5b. Rectangle A-roll ──
    if (layout.aroll.shape === "rectangle" && layout.aroll.region.width > 0) {
      const region = layout.aroll.region;
      const branchLabel = `aroll_${group.layoutId}`;

      // V5.1: When A-roll aspect ratio was preserved, the crop may be taller
      // than the template region. Keep the original overlay Y (don't center)
      // so the A-roll extends downward into the B-roll area rather than
      // moving up into the header zone. This preserves the reference's
      // header-to-aroll spatial relationship while showing more of the
      // talking head's native aspect ratio.
      const overlayY = region.y;

      filters.push(
        `[${lastLabel}][${branchLabel}]overlay=${region.x}:${overlayY}:` +
          `enable=${enableStr}[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // ── 5c. Circle border ──
    // V4: Per-range borders — each range has its own circle size and position
    // from the blueprint. Border dimensions match the range's circle dimensions.
    if (layout.aroll.shape === "circle" && layout.aroll.border) {
      const border = layout.aroll.border;
      const bw = border.width;

      for (let ri = 0; ri < group.ranges.length; ri++) {
        const range = group.ranges[ri];
        const circleRegion = range.layoutOverride?.aroll?.region ?? layout.aroll.region;
        const rangeEnable = `'${range.enableExpr}'`;

        const borderW = circleRegion.width + bw * 2;
        const borderH = circleRegion.height + bw * 2;
        const borderR = Math.min(borderW, borderH) / 2;
        const borderCx = borderW / 2;
        const borderCy = borderH / 2;

        filters.push(
          `color=${border.color}:s=${borderW}x${borderH}:r=${fps}:d=999,` +
            `setpts=PTS-STARTPTS[bdr_${range.id}_color]`
        );
        filters.push(
          `[bdr_${range.id}_color]format=yuva420p,` +
            `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':` +
            `a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderR},2)),255,0)'` +
            `[bdr_${range.id}]`
        );

        // V4: animate position if the range has PIP motion keyframes
        const kf = range.arollKeyframes;
        const xExpr = kf && kf.length >= 2
          ? `'${buildOverlayExpr(kf, "x", -bw)}'`
          : `${circleRegion.x - bw}`;
        const yExpr = kf && kf.length >= 2
          ? `'${buildOverlayExpr(kf, "y", -bw)}'`
          : `${circleRegion.y - bw}`;

        filters.push(
          `[${lastLabel}][bdr_${range.id}]overlay=${xExpr}:${yExpr}:` +
            `enable=${rangeEnable}:format=auto[step${stepNum}]`
        );
        lastLabel = `step${stepNum}`;
        stepNum++;
      }
    }

    // ── 5d. Circle A-roll ──
    // V4: Per-range A-roll overlay — each range has its own A-roll branch
    // (created in step 2) with its own dimensions, and is overlaid at its
    // own blueprint position.
    if (layout.aroll.shape === "circle" && layout.aroll.region.width > 0) {
      for (let ri = 0; ri < group.ranges.length; ri++) {
        const range = group.ranges[ri];
        const circleRegion = range.layoutOverride?.aroll?.region ?? layout.aroll.region;
        const branchLabel = `aroll_${range.id}`;
        const rangeEnable = `'${range.enableExpr}'`;

        // V4: animate position if the range has PIP motion keyframes
        const kf = range.arollKeyframes;
        const xExpr = kf && kf.length >= 2
          ? `'${buildOverlayExpr(kf, "x", 0)}'`
          : `${circleRegion.x}`;
        const yExpr = kf && kf.length >= 2
          ? `'${buildOverlayExpr(kf, "y", 0)}'`
          : `${circleRegion.y}`;

        filters.push(
          `[${lastLabel}][${branchLabel}]overlay=${xExpr}:${yExpr}:` +
            `enable=${rangeEnable}:format=auto[step${stepNum}]`
        );
        lastLabel = `step${stepNum}`;
        stepNum++;
      }
    }

    // ── 5e. Text overlays ──
    //
    // PRIMARY (map-driven): when ranges carry exact overlay-text coordinates
    // from the Layout Map (layoutOverride.texts — already filtered to genuine
    // editor overlays, B-roll content text excluded), render each at its exact
    // reference pixel position with its own color/weight/background. Rendered
    // per-range so positions can differ per segment.
    //
    // FALLBACK (slot-based): when no map texts exist, use the template's
    // header text slots (backward compatible).
    const groupHasMapTexts = group.ranges.some(
      (r) => (r.layoutOverride?.texts?.length ?? 0) > 0
    );

    // Authoritative gate: on a full-screen background-B-roll layout, any
    // detected text is B-roll content (app UI), NOT an editor overlay — never
    // re-draw it. The template's isBackground flag is the reliable signal
    // (blueprint per-segment bboxes can be imprecise).
    const layoutIsBackgroundBroll = layout.broll.isBackground;

    if (groupHasMapTexts && !layoutIsBackgroundBroll) {
      for (const range of group.ranges) {
        const rangeEnable = `'${range.enableExpr}'`;
        const mapTexts = range.layoutOverride?.texts ?? [];
        for (const t of mapTexts) {
          const cleanText = escapeDrawtext(t.text);
          if (!cleanText) continue;

          // Size the font to fill the reference text box height. Headlines
          // fill their bounding box, so box height is a more reliable size
          // signal than the (often-underestimated) per-glyph estimate.
          const boxFont = Math.round(t.region.height * 0.92);
          const fontSize = Math.max(t.fontSize ?? 0, boxFont, 18);
          const fontColor = normalizeColor(t.color) ?? "0xFFFFFF";
          const isBold = (t.fontWeight ?? "").toLowerCase().includes("bold");
          // Resolve a matching local font: prefer the classified style, else
          // infer from color/weight hints.
          const style = t.fontStyle ?? inferStyleFromHints({
            fontColor,
            bold: isBold,
            isHeadline: true,
          });
          const fontFile = resolveFontForStyle(style);

          // Exact pixel position: top-left of the reference text box
          const tx = Math.round(t.region.x);
          const ty = Math.round(t.region.y);

          // Background box (drawn tight around text)
          let bgOpts = "";
          const bg = normalizeColor(t.backgroundColor);
          if (bg) {
            bgOpts = `:box=1:boxcolor=${bg}:boxborderw=12`;
          }

          // Multi-color line: render each color span separately at its measured
          // x with its own color (e.g. "2026-yil" yellow + "SMM" white).
          if (t.spans && t.spans.length >= 2) {
            for (const span of t.spans) {
              const spanText = escapeDrawtext(span.text);
              if (!spanText) continue;
              const spanColor = normalizeColor(span.color) ?? fontColor;
              const sx = Math.round(span.x);
              filters.push(
                `[${lastLabel}]drawtext=fontfile='${fontFile}':` +
                  `text='${spanText}':fontsize=${fontSize}:fontcolor=${spanColor}:` +
                  `x=${sx}:y=${ty}:enable=${rangeEnable}[step${stepNum}]`
              );
              lastLabel = `step${stepNum}`;
              stepNum++;
            }
          } else {
            filters.push(
              `[${lastLabel}]drawtext=fontfile='${fontFile}':` +
                `text='${cleanText}':fontsize=${fontSize}:fontcolor=${fontColor}:` +
                `x=${tx}:y=${ty}${bgOpts}:enable=${rangeEnable}[step${stepNum}]`
            );
            lastLabel = `step${stepNum}`;
            stepNum++;
          }
        }
      }
    } else {
      // Collect text overlays from all ranges in this group
      const allTextOverlays: TextOverlay[] = [];
      for (const range of group.ranges) {
        if (range.textOverlays && range.textOverlays.length > 0) {
          allTextOverlays.push(...range.textOverlays);
        }
      }

      // Deduplicate by slotId (same slot with same text = same overlay)
      const seenSlots = new Set<string>();
      const uniqueOverlays: TextOverlay[] = [];
      for (const overlay of allTextOverlays) {
        const key = `${overlay.slotId}:${overlay.text}`;
        if (!seenSlots.has(key)) {
          seenSlots.add(key);
          uniqueOverlays.push(overlay);
        }
      }

      for (const overlay of uniqueOverlays) {
        const cleanText = escapeDrawtext(overlay.text);
        if (!cleanText) continue;

        // Find the slot definition for positioning
        const slot = layout.headerZone?.textSlots.find(
          (s) => s.id === overlay.slotId
        );

        const fontSize = overlay.fontSize ?? slot?.defaultFontSize ?? 36;
        const fontColor =
          overlay.fontColor ?? slot?.defaultFontColor ?? "0xFFFFFF";
        const fontFile = resolveFontFile(overlay, layout, template);

        // Position: center text on the slot anchor
        const textX = slot?.anchor.x ?? canvas.width / 2;
        const textY = slot?.anchor.y ?? canvas.height / 2;

        // Background box
        let bgOpts = "";
        const bgColor = overlay.bgColor ?? slot?.defaultBgColor;
        if (bgColor) {
          const bgPad = overlay.bgPadding ?? slot?.defaultBgPadding ?? 10;
          bgOpts = `:box=1:boxcolor=${bgColor}:boxborderw=${bgPad}`;
        }

        filters.push(
          `[${lastLabel}]drawtext=fontfile='${fontFile}':` +
            `text='${cleanText}':fontsize=${fontSize}:fontcolor=${fontColor}:` +
            `x=${Math.round(textX)}-(tw/2):y=${Math.round(textY)}-(th/2)` +
            `${bgOpts}:enable=${enableStr}[step${stepNum}]`
        );
        lastLabel = `step${stepNum}`;
        stepNum++;
      }
    }
  }

  // ── Step 6: Final output ──
  filters.push(`[${lastLabel}]copy[out]`);

  return {
    filterComplex: filters.join(";\n"),
    groups,
    allBrollIsFullCanvas,
  };
}

// ════════════════════════════════════════════════════════════
// FFMPEG ARGS BUILDER
// ════════════════════════════════════════════════════════════

/**
 * Build complete FFmpeg arguments from a plan + template.
 *
 * This is the main entry point for the renderer.
 * Returns everything needed to spawn FFmpeg — the caller handles execution.
 */
export function buildRenderArgs(input: RenderInput): RenderOutput {
  const { plan, template, arollSourceDimensions, outputPath } = input;

  const encoding: EncodingOptions = {
    preset: input.encoding?.preset ?? "fast",
    crf: input.encoding?.crf ?? 23,
    audioBitrate: input.encoding?.audioBitrate ?? "128k",
    pixFmt: input.encoding?.pixFmt ?? "yuv420p",
  };

  // Build filter complex
  const { filterComplex, groups, allBrollIsFullCanvas } = buildFilterComplex(
    plan,
    template,
    arollSourceDimensions
  );

  const filterLines = filterComplex.split(";\n");

  // Build layout group info for logging
  const layoutGroups = groups.map((g) => ({
    layoutId: g.layoutId,
    rangeCount: g.ranges.length,
    combinedEnable: g.combinedEnable,
    shape: g.layout.aroll.shape,
    hasHeader: !!g.layout.headerZone,
    hasBorder: !!(g.layout.aroll.shape === "circle" && g.layout.aroll.border),
    brollRegion: g.layout.broll.region,
    brollIsBackground: g.layout.broll.isBackground,
  }));

  // ── Build FFmpeg input args ──
  // Multi-B-roll: each B-roll source is a separate input.
  // Input order: [B-roll 0, B-roll 1, ..., A-roll 0, A-roll 1, ...]
  // The filter references [0:v] for first B-roll, [N:v] for first A-roll, etc.
  const inputArgs: string[] = [];

  // B-roll inputs
  const brollClips = plan.sources.brollClips ?? [{ path: plan.sources.broll, duration: 0, inputIndex: 0 }];
  for (const clip of brollClips) {
    inputArgs.push("-i", clip.path);
  }

  // A-roll inputs (one -i per uploaded clip; concat happens inside filtergraph)
  const arollClips = plan.sources.arollClips ?? [{ path: plan.sources.aroll, duration: 0, timelineStart: 0 }];
  for (const clip of arollClips) {
    inputArgs.push("-i", clip.path);
  }

  // Build FFmpeg args
  const ffmpegArgs = [
    "-y",
    ...inputArgs,
    // Filter complex (inline, not script file)
    "-filter_complex",
    filterComplex,
    // Map video from filter output
    "-map",
    "[out]",
    // Map audio from the concatenated A-roll stream (works for 1..N clips).
    // The filter graph emits [aroll_a] regardless of clip count.
    "-map",
    `[aroll_a]`,
    // Duration
    "-t",
    plan.totalDuration.toFixed(3),
    // Encoding
    "-c:v",
    "libx264",
    "-preset",
    encoding.preset,
    "-crf",
    encoding.crf.toString(),
    "-c:a",
    "aac",
    "-b:a",
    encoding.audioBitrate,
    "-pix_fmt",
    encoding.pixFmt,
    "-r",
    plan.fps.toString(),
    "-movflags",
    "+faststart",
    outputPath,
  ];

  return {
    ffmpegArgs,
    filterComplex,
    filterStageCount: filterLines.length,
    duration: plan.totalDuration,
    layoutAwareBroll: !allBrollIsFullCanvas,
    layoutGroups,
  };
}

/**
 * Build FFmpeg args using a filter_complex_script file instead of inline.
 *
 * Useful when the filter is too long for command-line args (Windows limit ~8192 chars).
 * The caller must write filterComplex to filterScriptPath before spawning FFmpeg.
 */
export function buildRenderArgsWithScript(
  input: RenderInput,
  filterScriptPath: string
): RenderOutput {
  const result = buildRenderArgs(input);

  // Replace -filter_complex with -filter_complex_script
  const idx = result.ffmpegArgs.indexOf("-filter_complex");
  if (idx !== -1) {
    result.ffmpegArgs[idx] = "-filter_complex_script";
    result.ffmpegArgs[idx + 1] = filterScriptPath;
  }

  return result;
}

// ════════════════════════════════════════════════════════════
// RENDER LOGGER
// ════════════════════════════════════════════════════════════

/**
 * Print a human-readable summary of what the renderer will do.
 */
export function logRenderPlan(output: RenderOutput): void {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║          PLAN RENDERER                            ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Filter stages: ${output.filterStageCount}`);
  console.log(`  Duration: ${output.duration.toFixed(2)}s`);
  console.log(`  Layout groups: ${output.layoutGroups.length}`);
  console.log(`  B-roll mode: ${output.layoutAwareBroll ? "LAYOUT-AWARE" : "full-canvas (fast path)"}`);
  console.log();

  for (const group of output.layoutGroups) {
    const features: string[] = [];
    features.push(group.shape);
    if (group.hasHeader) features.push("header");
    if (group.hasBorder) features.push("border");
    const broll = group.brollRegion;
    const brollInfo = group.brollIsBackground
      ? "bg-full"
      : `broll=(${broll.x},${broll.y}) ${broll.width}×${broll.height}`;

    console.log(
      `  ${group.layoutId}: ${group.rangeCount} range(s) | ${features.join(", ")} | ${brollInfo} | enable=${group.combinedEnable}`
    );
  }
  console.log();
}
