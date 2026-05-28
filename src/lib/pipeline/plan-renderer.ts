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

  // ── Step 1: Group ranges by layout ──
  const groups = groupRangesByLayout(plan, template);

  // ── Step 2: Identify what A-roll branches we need ──
  // Each unique layout with A-roll needs its own crop branch
  const arollBranches: Array<{
    layoutId: string;
    shape: "rectangle" | "circle";
    label: string;
    layout: LayoutVariant;
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
    arollBranches.push({
      layoutId: group.layoutId,
      shape: layout.aroll.shape,
      label: `aroll_${group.layoutId}`,
      layout,
    });
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

    // 3b. Split B-roll into per-range streams
    if (rangeCount === 1) {
      filters.push(`[0:v]setpts=PTS-STARTPTS[br_r0_src]`);
    } else {
      const splitLabels = ranges.map((_r, i) => `[br_r${i}_src]`).join("");
      filters.push(
        `[0:v]setpts=PTS-STARTPTS,split=${rangeCount}${splitLabels}`
      );
    }

    // 3c. For each range: trim to offset, re-timestamp, scale/crop
    for (let i = 0; i < rangeCount; i++) {
      const range = ranges[i];
      const offset = range.brollOffset ?? 0;
      const rangeStart = range.timeRange.start;
      const layout = template.layouts[range.layoutId];
      const brollRegion = layout?.broll?.region ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
      const isFullCanvas = layout?.broll?.isBackground &&
        brollRegion.x <= 1 && brollRegion.y <= 1 &&
        brollRegion.width >= canvas.width - 2 &&
        brollRegion.height >= canvas.height - 2;

      const targetW = isFullCanvas ? canvas.width : brollRegion.width;
      const targetH = isFullCanvas ? canvas.height : brollRegion.height;

      // trim → setpts (shift to range position) → scale/crop
      filters.push(
        `[br_r${i}_src]trim=start=${offset.toFixed(4)},` +
          `setpts=PTS-STARTPTS+${rangeStart.toFixed(4)},` +
          `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,` +
          `crop=${targetW}:${targetH},setsar=1[br_r${i}]`
      );
    }

    // 3d. Overlay each B-roll range on the black base
    lastLabel = "bg_base";
    for (let i = 0; i < rangeCount; i++) {
      const range = ranges[i];
      const layout = template.layouts[range.layoutId];
      const brollRegion = layout?.broll?.region ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
      const isFullCanvas = layout?.broll?.isBackground &&
        brollRegion.x <= 1 && brollRegion.y <= 1 &&
        brollRegion.width >= canvas.width - 2 &&
        brollRegion.height >= canvas.height - 2;

      const overlayX = isFullCanvas ? 0 : brollRegion.x;
      const overlayY = isFullCanvas ? 0 : brollRegion.y;

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
      `[0:v]setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,` +
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
        `[0:v]setpts=PTS-STARTPTS[${brollBranches[0].label}_src]`
      );
    } else {
      const splitLabels = brollBranches
        .map((b) => `[${b.label}_src]`)
        .join("");
      filters.push(
        `[0:v]setpts=PTS-STARTPTS,split=${brollBranches.length}${splitLabels}`
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
        `[1:v]setpts=PTS-STARTPTS[${arollBranches[0].label}_src]`
      );
    } else {
      // Multiple branches — split A-roll
      const splitLabels = arollBranches
        .map((b) => `[${b.label}_src]`)
        .join("");
      filters.push(
        `[1:v]setpts=PTS-STARTPTS,split=${arollBranches.length}${splitLabels}`
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
        // ── RECTANGLE: Scale to fit, NO crop ──
        // scale=targetW:-2 auto-computes height preserving aspect ratio
        // and ensures even dimensions. Full source frame is shown.
        const targetW = region.width;
        // Compute actual height for overlay positioning
        const sourceAspect = arollSourceDimensions.width / arollSourceDimensions.height;
        let scaledH = Math.round(targetW / sourceAspect);
        scaledH = scaledH + (scaledH % 2); // ensure even

        // Store adjusted dimensions on the branch for overlay positioning
        (branch as Record<string, unknown>)._adjustedW = targetW;
        (branch as Record<string, unknown>)._adjustedH = scaledH;

        console.log(
          `  [V6] Rectangle A-roll: scale-to-fit (NO crop). ` +
          `${arollSourceDimensions.width}×${arollSourceDimensions.height} → ${targetW}×${scaledH}`
        );

        filters.push(
          `[${branch.label}_src]scale=${targetW}:-2,setsar=1[${branch.label}]`
        );
      } else {
        // ── CIRCLE: Zoom in and crop around source center ──
        // For circle PIP, we need to zoom in so the face is prominent
        // (reference videos show face filling ~60-70% of the circle).
        //
        // Direct calculation: skip computeFaceCrop, use a zoom factor
        // relative to the base scale. zoomBoost of 2.0x gives a close
        // match to typical reference circle PIP framing.
        const targetW = region.width;
        const targetH = region.height;

        // Store dimensions for overlay positioning
        (branch as Record<string, unknown>)._adjustedW = targetW;
        (branch as Record<string, unknown>)._adjustedH = targetH;

        // Crop center: source center horizontally, upper-35% vertically
        // (faces are typically in the upper portion of talking head footage)
        const cropCenterX = Math.round(arollSourceDimensions.width / 2);
        const cropCenterY = Math.round(arollSourceDimensions.height * 0.35);

        // Zoom: base scale * boost to make face prominent in circle
        const baseScale = Math.max(
          targetW / arollSourceDimensions.width,
          targetH / arollSourceDimensions.height
        );
        const zoomBoost = 2.0;
        const scale = baseScale * zoomBoost;

        let scaledW = Math.round(arollSourceDimensions.width * scale);
        let scaledH = Math.round(arollSourceDimensions.height * scale);
        scaledW += scaledW % 2; // ensure even
        scaledH += scaledH % 2;

        // Center crop on the face position
        const faceX = Math.round(cropCenterX * scale);
        const faceY = Math.round(cropCenterY * scale);
        const cropX = Math.max(0, Math.min(faceX - Math.round(targetW / 2), scaledW - targetW));
        const cropY = Math.max(0, Math.min(faceY - Math.round(targetH / 2), scaledH - targetH));

        console.log(
          `  [V6] Circle A-roll: zoom=${scale.toFixed(3)} (base=${baseScale.toFixed(3)} * ${zoomBoost}x). ` +
          `Center: (${cropCenterX},${cropCenterY}). Scale: ${scaledW}x${scaledH}. ` +
          `Crop: ${targetW}x${targetH} at (${cropX},${cropY}). ` +
          `Face in crop: (${faceX - cropX},${faceY - cropY})`
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
    if (layout.aroll.shape === "circle" && layout.aroll.border) {
      const region = layout.aroll.region;
      const border = layout.aroll.border;
      const bw = border.width;

      const borderW = region.width + bw * 2;
      const borderH = region.height + bw * 2;
      const borderR = Math.min(borderW, borderH) / 2;
      const borderCx = borderW / 2;
      const borderCy = borderH / 2;

      filters.push(
        `color=${border.color}:s=${borderW}x${borderH}:r=${fps}:d=999,` +
          `setpts=PTS-STARTPTS[bdr_${group.layoutId}_color]`
      );
      filters.push(
        `[bdr_${group.layoutId}_color]format=yuva420p,` +
          `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':` +
          `a='if(lt(pow(X-${borderCx},2)+pow(Y-${borderCy},2),pow(${borderR},2)),255,0)'` +
          `[bdr_${group.layoutId}]`
      );
      filters.push(
        `[${lastLabel}][bdr_${group.layoutId}]overlay=${region.x - bw}:${region.y - bw}:` +
          `enable=${enableStr}:format=auto[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // ── 5d. Circle A-roll ──
    if (layout.aroll.shape === "circle" && layout.aroll.region.width > 0) {
      const region = layout.aroll.region;
      const branchLabel = `aroll_${group.layoutId}`;

      filters.push(
        `[${lastLabel}][${branchLabel}]overlay=${region.x}:${region.y}:` +
          `enable=${enableStr}:format=auto[step${stepNum}]`
      );
      lastLabel = `step${stepNum}`;
      stepNum++;
    }

    // ── 5e. Text overlays ──
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
      const bgColor =
        overlay.bgColor ?? slot?.defaultBgColor;
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

  // Build FFmpeg args
  const ffmpegArgs = [
    "-y",
    // Input 0: B-roll (continuous)
    "-i",
    plan.sources.broll,
    // Input 1: A-roll (continuous, also audio source)
    "-i",
    plan.sources.aroll,
    // Filter complex (inline, not script file)
    "-filter_complex",
    filterComplex,
    // Map video from filter output
    "-map",
    "[out]",
    // Map audio from A-roll (input 1) — continuous, never cut
    "-map",
    "1:a",
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
