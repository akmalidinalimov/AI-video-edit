/**
 * Plan Builder — Phase 2 of the AIvo Pipeline
 *
 * Takes the outputs of Phase 1 (analysis) and produces a validated
 * Editing Plan that Phase 3 (renderer) can execute as a pure function.
 *
 * Inputs:
 * - Visual blueprint (from Gemini analysis of reference video)
 * - A-roll transcription (word/sentence-level timestamps)
 * - VCS template selection
 * - Source file paths
 *
 * Outputs:
 * - A complete, validated EditingPlan
 *
 * Key decisions made here:
 * 1. Which layout to use for each sentence (based on reference overlap)
 * 2. Where transitions happen (snapped to sentence boundaries)
 * 3. What text overlays appear and when
 * 4. Pre-computed enable expressions for FFmpeg
 */

import {
  type VCSTemplate,
  type LayoutVariant,
  getVCSTemplate,
  registerDynamicTemplate,
} from "./vcs-templates";

import {
  type EditingPlan,
  type LayoutRange,
  type TransitionPoint,
  type SentenceInfo,
  type TextOverlay,
  type SourceFiles,
  alignToFrame,
  frameMidpoint,
  buildEnableExprForRange,
  validateEditingPlan,
  printEditingPlan,
} from "./editing-plan";

// ════════════════════════════════════════════════════════════
// TYPES FOR ANALYSIS INPUT
// ════════════════════════════════════════════════════════════

/** A segment from the visual blueprint (Gemini analysis of reference) */
export interface BlueprintSegment {
  id: string;
  start: number;
  end: number;
  layout: string;
  aroll?: {
    boundingBox: { x: number; y: number; width: number; height: number };
    shape: string;
    hasBorder?: boolean;
    borderColor?: string | null;
  };
  broll?: {
    boundingBox: { x: number; y: number; width: number; height: number };
    contentType?: string;
  };
  texts?: Array<{
    text: string;
    boundingBox: { x: number; y: number; width: number; height: number };
    isHeadline: boolean;
    estimatedFontSize?: number;
    color: string;
    backgroundColor?: string | null;
    fontWeight?: string;
  }>;
  blackRegions?: Array<{
    boundingBox: { x: number; y: number; width: number; height: number };
    purpose: string;
  }>;
  /** B-roll content tags from material analysis */
  brollContentTags?: string[];
}

/** Transcription output (from Gemini or other STT) */
export interface Transcription {
  words: Array<{ word: string; start: number; end: number }>;
  sentences: Array<{
    text: string;
    start: number;
    end: number;
    /** Semantic tags describing sentence content (e.g., ["app_demo", "tutorial_step"]) */
    semantic_tags?: string[];
  }>;
}

// ════════════════════════════════════════════════════════════
// LAYOUT MAPPING
// ════════════════════════════════════════════════════════════

/**
 * Compute semantic affinity between sentence tags and B-roll content tags.
 *
 * Returns a score 0-25 based on how many tags overlap between the sentence's
 * semantic_tags and the segment's brollContentTags. This allows the plan builder
 * to prefer layouts where the content type matches what appeared in that layout
 * in the reference video.
 *
 * @param sentenceTags - Semantic tags from the A-roll sentence
 * @param segmentTags - B-roll content tags from the blueprint segment
 */
function computeSemanticAffinity(
  sentenceTags?: string[],
  segmentTags?: string[]
): number {
  if (!sentenceTags?.length || !segmentTags?.length) return 0;

  const sentSet = new Set(sentenceTags.map(t => t.toLowerCase()));
  const segSet = new Set(segmentTags.map(t => t.toLowerCase()));

  let matches = 0;
  for (const tag of sentSet) {
    if (segSet.has(tag)) {
      matches++;
    } else {
      // Partial match: check if any segment tag contains the sentence tag or vice versa
      for (const segTag of segSet) {
        if (segTag.includes(tag) || tag.includes(segTag)) {
          matches += 0.5;
          break;
        }
      }
    }
  }

  // Normalize: max 25 points for perfect overlap
  const maxPossible = Math.max(sentSet.size, segSet.size);
  return maxPossible > 0 ? Math.min(25, (matches / maxPossible) * 25) : 0;
}

/**
 * Map a blueprint segment to the BEST MATCHING layout in the VCS template.
 *
 * Instead of hardcoding layout names, this function scores each template layout
 * against the segment's visual properties and picks the best match.
 *
 * Scoring criteria (max 125 points):
 * - Shape match (50 pts): circle→circle, rectangle→rectangle
 * - Header presence match (20 pts)
 * - B-roll coverage match (15 pts)
 * - Position match (15 pts): IoU of bounding boxes
 * - Semantic affinity bonus (25 pts): sentence tags match B-roll content tags
 *
 * The semantic bonus is additive — if semantic data is missing, scoring falls
 * back to pure geometry (backward compatible).
 */
function mapBlueprintToTemplateLayout(
  segment: BlueprintSegment,
  template: VCSTemplate,
  sentenceTags?: string[]
): string {
  const layoutIds = Object.keys(template.layouts);
  if (layoutIds.length === 0) return "unknown";
  if (layoutIds.length === 1) return layoutIds[0];

  let bestId = layoutIds[0];
  let bestScore = -1;

  for (const id of layoutIds) {
    const layout = template.layouts[id];
    let score = 0;

    // Shape match (most important)
    const segShape = segment.aroll?.shape ?? "none";
    const layoutShape = layout.aroll.shape;

    if (segShape === layoutShape) {
      score += 50;
    } else if (segShape === "none" && !layout.headerZone) {
      // No A-roll → might match broll_only layout
      score += 10;
    }

    // Header presence match
    const segHasHeader = (segment.blackRegions ?? []).some(br => br.purpose === "header");
    const layoutHasHeader = !!layout.headerZone;
    if (segHasHeader === layoutHasHeader) {
      score += 20;
    }

    // B-roll coverage match
    const segBrollFull = segment.broll
      ? (segment.broll.boundingBox.width >= template.canvas.width * 0.9 &&
         segment.broll.boundingBox.height >= template.canvas.height * 0.9)
      : false;
    if (segBrollFull === layout.broll.isBackground) {
      score += 15;
    }

    // Position similarity (IoU-like: overlap area / union area)
    if (segment.aroll?.boundingBox && layout.aroll.region) {
      const a = segment.aroll.boundingBox;
      const b = layout.aroll.region;
      const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const overlapArea = overlapX * overlapY;
      const unionArea = a.width * a.height + b.width * b.height - overlapArea;
      const iou = unionArea > 0 ? overlapArea / unionArea : 0;
      score += iou * 15;
    }

    // Semantic affinity bonus (up to +25 points)
    // If the sentence talks about the same topic as what appeared in this layout
    // in the reference video, boost the score
    const semanticBonus = computeSemanticAffinity(sentenceTags, segment.brollContentTags);
    score += semanticBonus;

    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  return bestId;
}

// ════════════════════════════════════════════════════════════
// B-ROLL SCENE MATCHING
// ════════════════════════════════════════════════════════════

/**
 * Match B-roll scenes to layout ranges based on semantic tag affinity.
 *
 * For each layout range, finds the B-roll scene whose content tags best
 * match the range's semantic tags (from sentences) and brollContentTags
 * (from the reference blueprint). Sets `brollOffset` on each range to
 * the matched scene's start time.
 *
 * Fallback when no semantic match is found: uses time-proportional
 * mapping (maps the range's relative position in the video to the
 * corresponding position in the B-roll timeline).
 *
 * @param layoutRanges - The ranges to assign B-roll offsets to (mutated in place)
 * @param brollScenes - Available B-roll scenes with content tags
 * @param brollDuration - Total B-roll video duration (for proportional fallback)
 * @param totalDuration - Total output video duration (for proportional fallback)
 */
function matchBrollScenes(
  layoutRanges: LayoutRange[],
  brollScenes: BRollScene[],
  brollDuration: number,
  totalDuration: number
): void {
  if (!brollScenes.length) {
    // No scene data: divide B-roll evenly across ranges
    console.log("    No B-roll scenes available — using uniform division");
    const segDuration = brollDuration / layoutRanges.length;
    for (let i = 0; i < layoutRanges.length; i++) {
      layoutRanges[i].brollOffset = Math.min(i * segDuration, brollDuration - 0.1);
      layoutRanges[i].brollSourceIndex = 0;
    }
    return;
  }

  // Track which scenes have been used to encourage variety
  const sceneUsageCount = new Map<number, number>();

  for (const range of layoutRanges) {
    // Collect all tags from the range (sentences + B-roll content)
    const rangeTags = [
      ...(range.semanticTags ?? []),
      ...(range.brollContentTags ?? []),
    ];

    let bestScene = brollScenes[0];
    let bestScore = -1;
    let bestIdx = 0;

    // Try semantic matching
    if (rangeTags.length > 0) {
      for (let i = 0; i < brollScenes.length; i++) {
        const scene = brollScenes[i];
        if (!scene.contentTags?.length) continue;

        let score = computeSemanticAffinity(rangeTags, scene.contentTags);

        // Penalize heavily-reused scenes to encourage variety
        const usage = sceneUsageCount.get(i) ?? 0;
        score *= Math.max(0.3, 1 - usage * 0.25);

        if (score > bestScore) {
          bestScore = score;
          bestScene = scene;
          bestIdx = i;
        }
      }
    }

    // Fallback: time-proportional mapping when no semantic match (score = 0)
    if (bestScore <= 0) {
      const rangeMidpoint = (range.timeRange.start + range.timeRange.end) / 2;
      const proportionalBrollTime = (rangeMidpoint / totalDuration) * brollDuration;

      let closestDist = Infinity;
      for (let i = 0; i < brollScenes.length; i++) {
        const scene = brollScenes[i];
        const sceneMid = (scene.start + scene.end) / 2;
        const dist = Math.abs(sceneMid - proportionalBrollTime);
        if (dist < closestDist) {
          closestDist = dist;
          bestScene = scene;
          bestIdx = i;
        }
      }
    }

    range.brollOffset = bestScene.start;
    range.brollSourceIndex = 0;

    // Track usage
    sceneUsageCount.set(bestIdx, (sceneUsageCount.get(bestIdx) ?? 0) + 1);

    const matchType = bestScore > 0 ? "semantic" : "proportional";
    const tagInfo = rangeTags.length > 0 ? ` [tags: ${rangeTags.slice(0, 3).join(", ")}]` : "";
    const sceneInfo = bestScene.contentTags?.length
      ? ` → scene [${bestScene.contentTags.slice(0, 3).join(", ")}]`
      : "";
    console.log(
      `    ${range.id}: offset=${bestScene.start.toFixed(2)}s (${matchType})${tagInfo}${sceneInfo}`
    );
  }
}

// ════════════════════════════════════════════════════════════
// PLAN BUILDER
// ════════════════════════════════════════════════════════════

/** B-roll scene info for content matching */
export interface BRollScene {
  /** Start time in the B-roll video */
  start: number;
  /** End time in the B-roll video */
  end: number;
  /** Content tags describing what appears in this scene */
  contentTags: string[];
  /** Human-readable description */
  description?: string;
}

export interface PlanBuilderInput {
  /** Visual blueprint segments from reference analysis */
  blueprintSegments: BlueprintSegment[];
  /** A-roll transcription (from the actual A-roll, NOT reference) */
  transcription: Transcription;
  /** VCS template ID to use (looked up in registry) */
  templateId: string;
  /** Source file paths */
  sources: SourceFiles;
  /** Optional: override text overlays for specific layout ranges */
  textOverrides?: Record<string, TextOverlay[]>;
  /**
   * Optional: provide a VCSTemplate directly (e.g., from generateTemplate()).
   * When provided, this takes precedence over templateId registry lookup.
   * The template is auto-registered so downstream code can still use templateId.
   */
  template?: VCSTemplate;
  /**
   * Optional: B-roll scene information for content-aware matching.
   * When provided, the plan builder matches B-roll scenes to sentence ranges
   * based on semantic tag affinity and sets brollOffset per LayoutRange.
   */
  brollScenes?: BRollScene[];
  /** Optional: total B-roll duration (for fallback uniform division) */
  brollDuration?: number;
}

/**
 * Build a complete, validated editing plan.
 *
 * Algorithm:
 * 1. For each sentence, find which blueprint segment has most time overlap
 * 2. Map that segment to a VCS template layout ID
 * 3. Merge consecutive sentences with same layout (no unnecessary transitions)
 * 4. Close gaps between sentences (extend previous layout through pauses)
 * 5. Frame-align all boundaries
 * 6. Pre-compute enable expressions using midpoint boundaries
 * 7. Extract text overlays from blueprint for header layouts
 * 8. Validate the complete plan
 */
export function buildEditingPlan(input: PlanBuilderInput): EditingPlan {
  // Use provided template directly, or look up from registry by ID.
  // When a dynamic template is provided, register it so getVCSTemplate()
  // calls downstream (e.g., in validation) can also find it.
  let template: VCSTemplate;
  if (input.template) {
    template = input.template;
    registerDynamicTemplate(template);
  } else {
    template = getVCSTemplate(input.templateId);
  }
  const { blueprintSegments, transcription, sources } = input;
  const fps = template.fps;

  console.log("  ── Plan Builder ──");
  console.log(`  Template: ${template.name} (${template.id})`);
  console.log(`  Blueprint segments: ${blueprintSegments.length}`);
  console.log(`  Sentences: ${transcription.sentences.length}`);

  // ── Step 1: Map sentences to layouts ──
  console.log("\n  Step 1: Mapping sentences to layouts...");

  const sentenceInfos: SentenceInfo[] = transcription.sentences.map((s, i) => ({
    text: s.text,
    start: s.start,
    end: s.end,
    index: i,
    semanticTags: s.semantic_tags?.length ? s.semantic_tags : undefined,
  }));

  interface SentenceLayout {
    sentence: SentenceInfo;
    layoutId: string;
    blueprintSegment: BlueprintSegment;
    reasoning: string;
  }

  const sentenceLayouts: SentenceLayout[] = [];

  for (const sentence of sentenceInfos) {
    // Find all blueprint segments that overlap this sentence
    const overlaps: Array<{
      segment: BlueprintSegment;
      overlap: number;
      layoutId: string;
    }> = [];

    for (const bpSeg of blueprintSegments) {
      const overlapStart = Math.max(bpSeg.start, sentence.start);
      const overlapEnd = Math.min(bpSeg.end, sentence.end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      if (overlap > 0) {
        overlaps.push({
          segment: bpSeg,
          overlap,
          layoutId: mapBlueprintToTemplateLayout(bpSeg, template, sentence.semanticTags),
        });
      }
    }

    // Sort by overlap (most = best match)
    overlaps.sort((a, b) => b.overlap - a.overlap);

    const best = overlaps[0] || {
      segment: blueprintSegments[0],
      overlap: 0,
      layoutId: Object.keys(template.layouts)[0],
    };

    // Check if reference changes layout mid-sentence
    const uniqueLayouts = Array.from(new Set(overlaps.map(o => o.layoutId)));
    let reasoning: string;

    if (uniqueLayouts.length > 1) {
      reasoning =
        `Reference changes layout mid-sentence (${uniqueLayouts.join(" → ")}). ` +
        `Snapped to '${best.layoutId}' (dominant: ${best.overlap.toFixed(2)}s overlap).`;
    } else {
      reasoning = `Matches reference: '${best.layoutId}' (${best.overlap.toFixed(2)}s overlap).`;
    }

    const tagStr = sentence.semanticTags?.length ? ` [tags: ${sentence.semanticTags.join(", ")}]` : "";
    console.log(
      `    S${sentence.index + 1} [${sentence.start.toFixed(2)}-${sentence.end.toFixed(2)}s]: ` +
      `${best.layoutId} | ${reasoning}${tagStr}`
    );

    sentenceLayouts.push({
      sentence,
      layoutId: best.layoutId,
      blueprintSegment: best.segment,
      reasoning,
    });
  }

  // ── Step 2: Merge consecutive same-layout sentences ──
  console.log("\n  Step 2: Merging consecutive same-layout sentences...");

  interface MergedRange {
    layoutId: string;
    start: number;
    end: number;
    sentences: SentenceInfo[];
    blueprintSegment: BlueprintSegment;
    reasoning: string;
    /** Aggregated semantic tags from all sentences in this range */
    semanticTags: string[];
    /** B-roll content tags from the blueprint segment */
    brollContentTags: string[];
  }

  const mergedRanges: MergedRange[] = [];

  for (const sl of sentenceLayouts) {
    const prev = mergedRanges[mergedRanges.length - 1];
    if (prev && prev.layoutId === sl.layoutId) {
      console.log(
        `    Merging S${sl.sentence.index + 1} into previous range: same layout '${sl.layoutId}'`
      );
      prev.end = sl.sentence.end;
      prev.sentences.push(sl.sentence);
      // Merge semantic tags (deduplicate)
      if (sl.sentence.semanticTags) {
        for (const tag of sl.sentence.semanticTags) {
          if (!prev.semanticTags.includes(tag)) prev.semanticTags.push(tag);
        }
      }
    } else {
      mergedRanges.push({
        layoutId: sl.layoutId,
        start: sl.sentence.start,
        end: sl.sentence.end,
        sentences: [sl.sentence],
        blueprintSegment: sl.blueprintSegment,
        reasoning: sl.reasoning,
        semanticTags: sl.sentence.semanticTags ? [...sl.sentence.semanticTags] : [],
        brollContentTags: sl.blueprintSegment.brollContentTags ? [...sl.blueprintSegment.brollContentTags] : [],
      });
    }
  }

  // ── Step 3: Ensure first range starts at 0 ──
  if (mergedRanges.length > 0 && mergedRanges[0].start > 0) {
    console.log(
      `    Extending first range start from ${mergedRanges[0].start.toFixed(2)}s to 0s`
    );
    mergedRanges[0].start = 0;
  }

  // ── Step 4: Close gaps between adjacent ranges ──
  console.log("\n  Step 3: Closing gaps between ranges...");

  for (let i = 0; i < mergedRanges.length - 1; i++) {
    const curr = mergedRanges[i];
    const next = mergedRanges[i + 1];
    const gap = next.start - curr.end;
    if (gap > 0 && gap < 2.0) {
      console.log(
        `    Closing ${gap.toFixed(3)}s gap: extending '${curr.layoutId}' ` +
        `end ${curr.end.toFixed(2)}→${next.start.toFixed(2)}s`
      );
      curr.end = next.start;
    }
  }

  // Extend last range slightly past its end
  if (mergedRanges.length > 0) {
    const last = mergedRanges[mergedRanges.length - 1];
    last.end = Math.max(last.end, last.end + 0.5);
  }

  // ── Step 5: Frame-align all boundaries ──
  console.log("\n  Step 4: Frame-aligning boundaries...");

  for (const r of mergedRanges) {
    r.start = alignToFrame(r.start, fps);
    r.end = alignToFrame(r.end, fps);
  }
  // Ensure adjacent ranges share exact boundary
  for (let i = 0; i < mergedRanges.length - 1; i++) {
    mergedRanges[i].end = mergedRanges[i + 1].start;
  }

  // ── Step 6: Build layout ranges with enable expressions ──
  console.log("\n  Step 5: Building layout ranges with enable expressions...");

  const layoutRanges: LayoutRange[] = [];

  for (let i = 0; i < mergedRanges.length; i++) {
    const mr = mergedRanges[i];
    const isLast = i === mergedRanges.length - 1;
    const startFrame = Math.round(mr.start * fps);
    const endFrame = Math.round(mr.end * fps);

    const enableExpr = buildEnableExprForRange(startFrame, endFrame, isLast, fps);

    // ── Extract text overlays for header layouts ──
    const textOverlays: TextOverlay[] = [];

    if (input.textOverrides?.[mr.layoutId]) {
      textOverlays.push(...input.textOverrides[mr.layoutId]);
    } else {
      // Auto-extract headline texts from blueprint
      const layout = template.layouts[mr.layoutId];
      if (layout?.headerZone) {
        const headerTexts = mr.blueprintSegment.texts?.filter(
          t => t.isHeadline && t.boundingBox.y < (layout.headerZone!.region.height + 150)
        ) ?? [];

        for (let j = 0; j < headerTexts.length; j++) {
          const ht = headerTexts[j];
          const slot = layout.headerZone.textSlots[j];
          if (!slot) continue;

          textOverlays.push({
            slotId: slot.id,
            text: ht.text,
            fontSize: ht.estimatedFontSize || slot.defaultFontSize,
            fontColor: ht.color.startsWith("#")
              ? ht.color.replace("#", "0x")
              : slot.defaultFontColor,
            bgColor: ht.backgroundColor
              ? (ht.backgroundColor.startsWith("#")
                ? ht.backgroundColor.replace("#", "0x")
                : undefined)
              : undefined,
          });
        }
      }
    }

    layoutRanges.push({
      id: `range_${i + 1}`,
      layoutId: mr.layoutId,
      timeRange: { start: mr.start, end: mr.end },
      sentences: mr.sentences,
      textOverlays,
      reasoning: mr.reasoning,
      semanticTags: mr.semanticTags.length > 0 ? mr.semanticTags : undefined,
      brollContentTags: mr.brollContentTags.length > 0 ? mr.brollContentTags : undefined,
      startFrame,
      endFrame,
      enableExpr,
    });

    console.log(
      `    range_${i + 1}: ${mr.start.toFixed(2)}-${mr.end.toFixed(2)}s | ` +
      `${mr.layoutId} | enable='${enableExpr}'`
    );
  }

  // ── Step 6b: Match B-roll scenes (content-aware offsets) ──
  if (input.brollScenes?.length || input.brollDuration) {
    console.log("\n  Step 5b: Matching B-roll scenes to layout ranges...");
    const brollScenes = input.brollScenes ?? [];
    const brollDuration = input.brollDuration ?? 0;
    const totalDur = layoutRanges[layoutRanges.length - 1]?.timeRange.end ?? 0;

    if (brollDuration > 0) {
      matchBrollScenes(layoutRanges, brollScenes, brollDuration, totalDur);
    } else {
      console.log("    Skipped: no B-roll duration available");
    }
  }

  // ── Step 7: Build transition points ──
  const transitions: TransitionPoint[] = [];

  for (let i = 0; i < layoutRanges.length - 1; i++) {
    const curr = layoutRanges[i];
    const next = layoutRanges[i + 1];

    if (curr.layoutId !== next.layoutId) {
      const transTime = curr.timeRange.end;
      const transFrame = Math.round(transTime * fps);
      const midpoint = frameMidpoint(transFrame, fps);

      transitions.push({
        time: transTime,
        frame: transFrame,
        fromLayoutId: curr.layoutId,
        toLayoutId: next.layoutId,
        sentenceBoundary: {
          endingSentence: curr.sentences[curr.sentences.length - 1],
          startingSentence: next.sentences[0],
        },
        midpointTime: midpoint,
      });
    }
  }

  // ── Step 8: Assemble the plan ──
  const totalDuration = layoutRanges[layoutRanges.length - 1].timeRange.end;
  const totalFrames = Math.round(totalDuration * fps);

  const plan: EditingPlan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    templateId: input.templateId,
    canvas: { ...template.canvas },
    fps,
    sources,
    sentences: sentenceInfos,
    totalDuration,
    totalFrames,
    layoutRanges,
    transitions,
    validated: false,
    validationErrors: [],
  };

  // ── Step 9: Validate ──
  console.log("\n  Step 6: Validating plan...");

  const validation = validateEditingPlan(plan, template);
  plan.validated = true;
  plan.validationErrors = validation.errors;

  if (validation.errors.length > 0) {
    console.log("    VALIDATION FAILED:");
    for (const err of validation.errors) {
      console.log(`      ✗ ${err}`);
    }
  } else {
    console.log("    ✓ Plan is valid");
  }

  if (validation.warnings.length > 0) {
    console.log("    Warnings:");
    for (const warn of validation.warnings) {
      console.log(`      ⚠ ${warn}`);
    }
  }

  return plan;
}
