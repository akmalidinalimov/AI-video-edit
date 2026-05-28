/**
 * Dynamic Template Generator
 *
 * Takes a visual blueprint (from ANY reference video) and auto-generates
 * a VCSTemplate with the correct layout variants, coordinates, and styles.
 *
 * NO hardcoded coordinates. NO assumption about what layouts exist.
 * The reference video tells US what the template should look like.
 *
 * Algorithm:
 * 1. Read all blueprint segments
 * 2. Classify each segment's visual structure
 * 3. Cluster segments with similar structure → layout variants
 * 4. For each cluster, compute canonical coordinates (median)
 * 5. Extract text styles, borders, header zones
 * 6. Produce a complete VCSTemplate
 */

import type {
  VCSTemplate,
  LayoutVariant,
  TextSlot,
  Rect,
  BorderDef,
  CircleDef,
} from "./vcs-templates";

// ════════════════════════════════════════════════════════════
// INPUT TYPES (matching blueprint.ts structures)
// ════════════════════════════════════════════════════════════

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BlueprintSegment {
  id: string;
  start: number;
  end: number;
  layout: string;
  aroll?: {
    boundingBox: BoundingBox;
    shape: string;
    hasBorder?: boolean;
    borderColor?: string | null;
    borderWidth?: number;
    isCropped?: boolean;
  } | null;
  broll?: {
    boundingBox: BoundingBox;
    contentType?: string;
    isCropped?: boolean;
    hasScrollMotion?: boolean;
  };
  texts?: Array<{
    text: string;
    boundingBox: BoundingBox;
    isHeadline: boolean;
    estimatedFontSize?: number;
    color: string;
    backgroundColor?: string | null;
    fontWeight?: string;
  }>;
  blackRegions?: Array<{
    boundingBox: BoundingBox;
    purpose: string;
  }>;
  /** B-roll content tags from material analysis */
  brollContentTags?: string[];
}

interface FaceInfo {
  /** Face center in the A-roll source video's coordinate space */
  center: { x: number; y: number };
  /** A-roll source resolution */
  sourceResolution: { width: number; height: number };
}

interface TemplateGeneratorInput {
  /** Canvas dimensions (from the reference video) */
  canvas: { width: number; height: number };
  /** FPS of the reference video */
  fps: number;
  /** All blueprint segments from reference analysis */
  segments: BlueprintSegment[];
  /** Face detection result from A-roll analysis */
  faceInfo?: FaceInfo;
  /** Optional: aspect ratio label */
  aspectRatio?: "9:16" | "16:9" | "1:1" | "4:5";
  /**
   * Optional: reference transcription with semantic_tags per sentence.
   * Used to build content profiles for each layout variant —
   * what kinds of content appeared in each layout in the reference.
   */
  referenceTranscription?: {
    sentences: Array<{
      text: string;
      start: number;
      end: number;
      semantic_tags?: string[];
    }>;
  };
}

// ════════════════════════════════════════════════════════════
// LAYOUT CLASSIFIER
// ════════════════════════════════════════════════════════════

interface LayoutFingerprint {
  /** A-roll shape or "none" if no A-roll */
  arollShape: "circle" | "rectangle" | "none";
  /** A-roll position zone on canvas */
  arollPosition: "top" | "bottom" | "left" | "right" | "center" | "top-right" | "top-left" | "bottom-right" | "bottom-left" | "full" | "none";
  /** A-roll size relative to canvas */
  arollSizeClass: "full" | "large" | "medium" | "small" | "none";
  /** Whether a header black region exists */
  hasHeader: boolean;
  /** Whether B-roll fills the entire canvas */
  brollFullCanvas: boolean;
  /** Whether A-roll has a visible border */
  hasBorder: boolean;
}

function classifyPosition(
  bbox: BoundingBox,
  canvas: { width: number; height: number }
): LayoutFingerprint["arollPosition"] {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const canvasCx = canvas.width / 2;
  const canvasCy = canvas.height / 2;

  // Full-width check
  if (bbox.width >= canvas.width * 0.9) {
    if (cy < canvasCy * 0.6) return "top";
    if (cy > canvasCy * 1.4) return "bottom";
    return "full";
  }

  // Quadrant check
  const isRight = cx > canvasCx;
  const isTop = cy < canvasCy;

  if (isTop && isRight) return "top-right" as const;
  if (isTop && !isRight) return "top-left" as const;
  if (!isTop && isRight) return "bottom-right" as const;
  if (!isTop && !isRight) return "bottom-left" as const;

  return "center" as const;
}

function classifySize(
  bbox: BoundingBox,
  canvas: { width: number; height: number }
): "full" | "large" | "medium" | "small" {
  const arollArea = bbox.width * bbox.height;
  const canvasArea = canvas.width * canvas.height;
  const ratio = arollArea / canvasArea;

  if (ratio > 0.6) return "full";
  if (ratio > 0.25) return "large";
  if (ratio > 0.08) return "medium";
  return "small";
}

function classifySegment(
  seg: BlueprintSegment,
  canvas: { width: number; height: number }
): LayoutFingerprint {
  if (!seg.aroll || !seg.aroll.boundingBox) {
    return {
      arollShape: "none",
      arollPosition: "none",
      arollSizeClass: "none",
      hasHeader: false,
      brollFullCanvas: true,
      hasBorder: false,
    };
  }

  const arollBbox = seg.aroll.boundingBox;
  const hasHeader = (seg.blackRegions ?? []).some(br => br.purpose === "header");

  // Determine if B-roll fills the whole canvas
  const brollBbox = seg.broll?.boundingBox;
  const brollFullCanvas = brollBbox
    ? (brollBbox.width >= canvas.width * 0.9 && brollBbox.height >= canvas.height * 0.9)
    : false;

  return {
    arollShape: (seg.aroll.shape as "circle" | "rectangle") || "rectangle",
    arollPosition: classifyPosition(arollBbox, canvas),
    arollSizeClass: classifySize(arollBbox, canvas),
    hasHeader,
    brollFullCanvas,
    hasBorder: seg.aroll.hasBorder ?? false,
  };
}

/**
 * Generate a human-readable layout ID from its fingerprint.
 */
function fingerprintToId(fp: LayoutFingerprint): string {
  if (fp.arollShape === "none") {
    return "broll_only";
  }

  const parts: string[] = [];

  // Shape
  if (fp.arollShape === "circle") {
    parts.push("circle_pip");
  } else if (fp.arollSizeClass === "full" || fp.arollPosition === "full") {
    parts.push("fullscreen_aroll");
  } else if (fp.hasHeader) {
    parts.push("rect_with_header");
  } else {
    parts.push("rect_pip");
  }

  // Position qualifier (skip for full-screen)
  if (fp.arollSizeClass !== "full" && fp.arollPosition !== "full" && fp.arollPosition !== "none") {
    parts.push(fp.arollPosition.replace("-", "_"));
  }

  return parts.join("_");
}

/**
 * Generate a fingerprint key for clustering (same key = same visual structure).
 */
function fingerprintKey(fp: LayoutFingerprint): string {
  return `${fp.arollShape}|${fp.arollPosition}|${fp.arollSizeClass}|${fp.hasHeader}|${fp.brollFullCanvas}`;
}

// ════════════════════════════════════════════════════════════
// COORDINATE AGGREGATION (median for robustness)
// ════════════════════════════════════════════════════════════

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function aggregateBoundingBoxes(boxes: BoundingBox[]): BoundingBox {
  return {
    x: median(boxes.map(b => b.x)),
    y: median(boxes.map(b => b.y)),
    width: median(boxes.map(b => b.width)),
    height: median(boxes.map(b => b.height)),
  };
}

// ════════════════════════════════════════════════════════════
// FONT RESOLUTION (platform-aware via fonts.ts)
// ════════════════════════════════════════════════════════════

import { FONT_ALIASES } from "./fonts";

const DEFAULT_FONTS = {
  normal: FONT_ALIASES.normal,
  bold: FONT_ALIASES.arialBold,
  italic_bold: FONT_ALIASES.italic_bold,
};

function resolveFontFile(fontWeight?: string, isItalic?: boolean): string {
  if (isItalic && fontWeight === "bold") return DEFAULT_FONTS.italic_bold;
  if (fontWeight === "bold") return DEFAULT_FONTS.bold;
  return DEFAULT_FONTS.normal;
}

// ════════════════════════════════════════════════════════════
// TEMPLATE GENERATOR
// ════════════════════════════════════════════════════════════

export function generateTemplate(input: TemplateGeneratorInput): VCSTemplate {
  const { canvas, fps, segments, faceInfo } = input;

  console.log("  ── Dynamic Template Generator ──");
  console.log(`  Canvas: ${canvas.width}×${canvas.height} @ ${fps}fps`);
  console.log(`  Segments to analyze: ${segments.length}`);

  if (faceInfo) {
    console.log(`  Face center: (${faceInfo.center.x}, ${faceInfo.center.y}) in ${faceInfo.sourceResolution.width}×${faceInfo.sourceResolution.height}`);
  }

  const faceCropCenter = faceInfo
    ? { x: faceInfo.center.x, y: faceInfo.center.y }
    : { x: Math.round(canvas.width / 2), y: Math.round(canvas.height * 0.3) }; // default: center-ish

  // ── Step 1: Classify each segment ──
  console.log("\n  Step 1: Classifying segments...");

  const classified = segments.map(seg => {
    const fp = classifySegment(seg, canvas);
    const id = fingerprintToId(fp);
    const key = fingerprintKey(fp);
    console.log(`    ${seg.id} (${seg.start}-${seg.end}s): ${id} [${fp.arollShape}, ${fp.arollPosition}, ${fp.arollSizeClass}]`);
    return { seg, fp, id, key };
  });

  // ── Step 2: Cluster by fingerprint ──
  console.log("\n  Step 2: Clustering by visual structure...");

  const clusters = new Map<string, Array<typeof classified[0]>>();
  for (const c of classified) {
    const existing = clusters.get(c.key) || [];
    existing.push(c);
    clusters.set(c.key, existing);
  }

  console.log(`  Found ${clusters.size} unique layout type(s)`);

  // ── Step 2b: Merge clusters with the same layout ID ──
  // Multiple clusters can produce the same ID (e.g., three clusters all named
  // "circle_pip_top_right" because they differ only in arollSizeClass).
  // Merge them: the dominant cluster (most segments) provides canonical coords.
  const mergedClusters = new Map<string, Array<typeof classified[0]>>();
  for (const [_key, members] of Array.from(clusters.entries())) {
    const layoutId = members[0].id;
    const existing = mergedClusters.get(layoutId);
    if (existing) {
      existing.push(...members);
    } else {
      mergedClusters.set(layoutId, [...members]);
    }
  }
  if (mergedClusters.size < clusters.size) {
    console.log(`  Merged ${clusters.size} clusters → ${mergedClusters.size} unique layout(s)`);
  }

  // ── Step 3: Build layout variants ──
  console.log("\n  Step 3: Building layout variants...");

  const layouts: Record<string, LayoutVariant> = {};

  for (const [layoutId, members] of Array.from(mergedClusters.entries())) {
    // Use the fingerprint from the cluster with the most segments (dominant)
    // Group members back by original fingerprint key to find dominant
    const subGroups = new Map<string, typeof members>();
    for (const m of members) {
      const k = fingerprintKey(m.fp);
      const existing = subGroups.get(k) || [];
      existing.push(m);
      subGroups.set(k, existing);
    }
    // Dominant = largest sub-group
    let dominantGroup = members;
    let maxCount = 0;
    for (const [_k, group] of Array.from(subGroups.entries())) {
      if (group.length > maxCount) {
        maxCount = group.length;
        dominantGroup = group;
      }
    }
    const representative = dominantGroup[0];
    const fp = representative.fp;

    console.log(`\n    Layout: "${layoutId}" (${members.length} segment(s))`);

    // ── A-roll region (median of all members) ──
    let arollRegion: Rect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    let arollShape: "rectangle" | "circle" = "rectangle";
    let circleDef: CircleDef | undefined;
    let borderDef: BorderDef | undefined;

    if (fp.arollShape !== "none") {
      const arollBoxes = members
        .filter(m => m.seg.aroll?.boundingBox)
        .map(m => m.seg.aroll!.boundingBox);

      if (arollBoxes.length > 0) {
        arollRegion = aggregateBoundingBoxes(arollBoxes);
        console.log(`      A-roll region: (${arollRegion.x}, ${arollRegion.y}) ${arollRegion.width}×${arollRegion.height}`);
      }

      arollShape = fp.arollShape === "circle" ? "circle" : "rectangle";

      if (arollShape === "circle") {
        const radius = Math.min(arollRegion.width, arollRegion.height) / 2;
        circleDef = {
          cx: arollRegion.x + arollRegion.width / 2,
          cy: arollRegion.y + arollRegion.height / 2,
          radius: Math.round(radius),
        };
        console.log(`      Circle: center=(${circleDef.cx}, ${circleDef.cy}), radius=${circleDef.radius}`);
      }

      // ── Border ──
      const borderedMembers = members.filter(m => m.seg.aroll?.hasBorder);
      if (borderedMembers.length > 0 || fp.arollShape === "circle") {
        // For circles, always add a subtle border even if the analysis didn't detect one
        const borderWidth = borderedMembers.length > 0
          ? median(borderedMembers.map(m => m.seg.aroll?.borderWidth ?? 4))
          : 4;
        const borderColor = borderedMembers.length > 0
          ? (borderedMembers[0].seg.aroll?.borderColor ?? "0xFFFFFF@0.6")
          : "0xFFFFFF@0.6";

        borderDef = {
          width: borderWidth,
          color: borderColor.startsWith("#")
            ? borderColor.replace("#", "0x") + "@0.6"
            : borderColor.includes("0x") ? borderColor : "0xFFFFFF@0.6",
        };
        console.log(`      Border: ${borderDef.width}px ${borderDef.color}`);
      }
    }

    // ── B-roll region ──
    // For circle PIP layouts, B-roll is ALWAYS full-canvas background.
    // The Gemini analysis sometimes reports a smaller B-roll region because
    // it measures visible area excluding the circle overlay. Force full canvas.
    const isPipLayout = fp.arollShape === "circle" &&
      fp.arollPosition !== "full" &&
      fp.arollPosition !== "center";

    let brollRegion: Rect;
    let brollIsBackground: boolean;

    if (isPipLayout) {
      // Force full-canvas background for PIP layouts
      brollRegion = { x: 0, y: 0, width: canvas.width, height: canvas.height };
      brollIsBackground = true;
    } else {
      const brollBoxes = members
        .filter(m => m.seg.broll?.boundingBox)
        .map(m => m.seg.broll!.boundingBox);
      brollRegion = brollBoxes.length > 0
        ? aggregateBoundingBoxes(brollBoxes)
        : { x: 0, y: 0, width: canvas.width, height: canvas.height };
      brollIsBackground = fp.brollFullCanvas;
    }
    console.log(`      B-roll region: (${brollRegion.x}, ${brollRegion.y}) ${brollRegion.width}×${brollRegion.height} (bg=${brollIsBackground})`);

    // ── Header zone ──
    let headerZone: LayoutVariant["headerZone"] = undefined;

    if (fp.hasHeader) {
      const headerRegions = members
        .flatMap(m => (m.seg.blackRegions ?? []).filter(br => br.purpose === "header"))
        .map(br => br.boundingBox);

      if (headerRegions.length > 0) {
        const headerRect = aggregateBoundingBoxes(headerRegions);
        console.log(`      Header zone: (${headerRect.x}, ${headerRect.y}) ${headerRect.width}×${headerRect.height}`);

        // ── Extract text slots from headline texts in the header zone ──
        const textSlots: TextSlot[] = [];
        const headerBottom = headerRect.y + headerRect.height + 50; // small tolerance

        // Collect all headline texts from all members of this cluster
        const allHeadlines: Array<{
          text: string;
          bbox: BoundingBox;
          fontSize: number;
          color: string;
          bgColor: string | null;
          fontWeight: string;
        }> = [];

        for (const m of members) {
          for (const txt of m.seg.texts ?? []) {
            if (txt.isHeadline && txt.boundingBox.y < headerBottom) {
              allHeadlines.push({
                text: txt.text,
                bbox: txt.boundingBox,
                fontSize: txt.estimatedFontSize ?? 36,
                color: txt.color,
                bgColor: txt.backgroundColor ?? null,
                fontWeight: txt.fontWeight ?? "normal",
              });
            }
          }
        }

        // Deduplicate by similar Y position (within 40px = same slot)
        const slotGroups: typeof allHeadlines[] = [];
        for (const hl of allHeadlines) {
          const existingGroup = slotGroups.find(
            g => Math.abs(g[0].bbox.y - hl.bbox.y) < 40
          );
          if (existingGroup) {
            existingGroup.push(hl);
          } else {
            slotGroups.push([hl]);
          }
        }

        // Sort slot groups by Y position (top to bottom)
        slotGroups.sort((a, b) => a[0].bbox.y - b[0].bbox.y);

        for (let i = 0; i < slotGroups.length; i++) {
          const group = slotGroups[i];
          const representative = group[0];
          const anchorX = median(group.map(g => g.bbox.x + g.bbox.width / 2));
          const anchorY = median(group.map(g => g.bbox.y + g.bbox.height / 2));
          const maxWidth = Math.max(...group.map(g => g.bbox.width));
          const fontSize = median(group.map(g => g.fontSize));
          const fontColor = representative.color.startsWith("#")
            ? representative.color.replace("#", "0x")
            : "0xFFFFFF";

          // Detect if this looks like an italic serif headline (gold color = often serif italic)
          const isGoldish = ["#FDD835", "#FFD700", "#FFEB3B", "#F9A825"].some(
            c => representative.color.toUpperCase() === c
          );

          const slot: TextSlot = {
            id: `headline_${i + 1}`,
            anchor: { x: Math.round(anchorX), y: Math.round(anchorY) },
            maxWidth: Math.round(maxWidth),
            defaultFontSize: fontSize,
            defaultFontColor: fontColor,
            defaultFont: resolveFontFile(
              representative.fontWeight,
              isGoldish // gold text often uses italic
            ),
          };

          if (representative.bgColor) {
            slot.defaultBgColor = representative.bgColor.startsWith("#")
              ? representative.bgColor.replace("#", "0x")
              : representative.bgColor;
            slot.defaultBgPadding = 10;
          }

          textSlots.push(slot);
          console.log(`      Text slot "${slot.id}": anchor=(${slot.anchor.x},${slot.anchor.y}), size=${slot.defaultFontSize}, color=${slot.defaultFontColor}`);
        }

        headerZone = { region: headerRect, textSlots };
      }
    }

    // ── Compute text safe area ──
    const textSafeArea: Rect = fp.hasHeader
      ? { x: 40, y: 10, width: canvas.width - 80, height: (headerZone?.region.height ?? 200) }
      : {
          x: 40,
          y: Math.max(arollRegion.y + arollRegion.height + 20, canvas.height * 0.3),
          width: canvas.width - 80,
          height: canvas.height * 0.6,
        };

    // ── Build content profile from reference transcription ──
    // Collect semantic_tags from all sentences that overlap segments in this cluster
    let contentProfile: string[] | undefined;
    if (input.referenceTranscription?.sentences) {
      const profileTags = new Set<string>();
      for (const member of members) {
        const segStart = member.seg.start;
        const segEnd = member.seg.end;
        for (const sent of input.referenceTranscription.sentences) {
          const overlapStart = Math.max(sent.start, segStart);
          const overlapEnd = Math.min(sent.end, segEnd);
          if (overlapEnd > overlapStart && sent.semantic_tags) {
            for (const tag of sent.semantic_tags) profileTags.add(tag);
          }
        }
        // Also include B-roll content tags from the segment
        if (member.seg.brollContentTags) {
          for (const tag of member.seg.brollContentTags) profileTags.add(tag);
        }
      }
      if (profileTags.size > 0) {
        contentProfile = Array.from(profileTags);
        console.log(`      Content profile: [${contentProfile.join(", ")}]`);
      }
    }

    // ── Assemble layout variant ──
    layouts[layoutId] = {
      id: layoutId,
      name: layoutId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      aroll: {
        region: arollRegion,
        shape: arollShape,
        circle: circleDef,
        border: borderDef,
        faceCropCenter,
      },
      broll: {
        region: brollRegion,
        isBackground: brollIsBackground,
      },
      headerZone,
      textSafeArea,
      contentProfile,
    };
  }

  // ── Determine aspect ratio ──
  const aspectRatio = input.aspectRatio || (
    canvas.width < canvas.height ? "9:16" :
    canvas.width > canvas.height ? "16:9" :
    "1:1"
  );

  // ── Assemble template ──
  const templateId = `auto_${canvas.width}x${canvas.height}_v1`;

  const template: VCSTemplate = {
    id: templateId,
    version: 1,
    name: `Auto-generated ${canvas.width}×${canvas.height} (${Object.keys(layouts).length} layouts)`,
    canvas,
    fps,
    aspectRatio: aspectRatio as VCSTemplate["aspectRatio"],
    layouts,
    globalStyles: {
      defaultFont: DEFAULT_FONTS.normal,
      headlineFont: DEFAULT_FONTS.italic_bold,
      boldFont: DEFAULT_FONTS.bold,
    },
  };

  console.log(`\n  ── Template generated: "${templateId}" ──`);
  console.log(`  Layouts: ${Object.keys(layouts).join(", ")}`);

  return template;
}

// ════════════════════════════════════════════════════════════
// FACE DETECTION HELPER
// ════════════════════════════════════════════════════════════

/**
 * Extract face info from an ARollMaterialAnalysis.
 * Falls back to center of frame if no face frames available.
 */
export function extractFaceInfo(
  arollAnalysis: {
    faceFrames?: Array<{ faceCenter: { x: number; y: number } }>;
    recommendedCrop?: { circle: { centerX: number; centerY: number } };
    resolution: { width: number; height: number };
  }
): FaceInfo {
  // Try recommended crop center first
  if (arollAnalysis.recommendedCrop?.circle) {
    return {
      center: {
        x: arollAnalysis.recommendedCrop.circle.centerX,
        y: arollAnalysis.recommendedCrop.circle.centerY,
      },
      sourceResolution: arollAnalysis.resolution,
    };
  }

  // Try median of face frames
  if (arollAnalysis.faceFrames && arollAnalysis.faceFrames.length > 0) {
    const xs = arollAnalysis.faceFrames.map(f => f.faceCenter.x);
    const ys = arollAnalysis.faceFrames.map(f => f.faceCenter.y);
    return {
      center: { x: median(xs), y: median(ys) },
      sourceResolution: arollAnalysis.resolution,
    };
  }

  // Fallback: assume face is roughly centered, slightly above middle
  return {
    center: {
      x: Math.round(arollAnalysis.resolution.width / 2),
      y: Math.round(arollAnalysis.resolution.height * 0.35),
    },
    sourceResolution: arollAnalysis.resolution,
  };
}
