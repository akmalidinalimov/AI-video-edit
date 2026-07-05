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

import { type LayoutMap, getArollKeyframes, classifyOverlayText } from "./layout-map";
import { type CadencePlan, planCadence } from "./cadence-planner";

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
    /** Classified typeface style (set by CV/Gemini font classification) */
    fontStyle?: {
      category: "serif" | "display" | "sans" | "rounded" | "script" | "mono";
      italic?: boolean;
      weight?: "light" | "regular" | "bold" | "black";
    };
    /** Multi-color spans within one line (set by CV color-segment detection) */
    spans?: Array<{ text: string; color: string; x: number }>;
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
// DIRECT REPLICATION — BLUEPRINT → LAYOUT OVERRIDE
// ════════════════════════════════════════════════════════════

/**
 * Convert a BlueprintSegment's exact bounding boxes into a per-range
 * layoutOverride. This enables "direct replication" — the renderer
 * uses exact reference coordinates instead of template medians.
 *
 * Returns undefined if the segment lacks usable coordinate data.
 */
function buildLayoutOverride(
  bp: BlueprintSegment,
  canvas: { width: number; height: number }
): LayoutRange["layoutOverride"] | undefined {
  // Need at minimum the A-roll bounding box
  if (!bp.aroll?.boundingBox) return undefined;

  const override: NonNullable<LayoutRange["layoutOverride"]> = {};

  // A-roll region from blueprint
  const arollBB = bp.aroll.boundingBox;
  override.aroll = {
    region: { x: arollBB.x, y: arollBB.y, width: arollBB.width, height: arollBB.height },
    shape: (bp.aroll.shape === "circle" ? "circle" : "rectangle") as "rectangle" | "circle",
    hasBorder: bp.aroll.hasBorder,
    borderColor: bp.aroll.borderColor,
    borderWidth: (bp.aroll as Record<string, unknown>).borderWidth as number | undefined,
  };

  // B-roll region
  if (bp.broll?.boundingBox) {
    const brollBB = bp.broll.boundingBox;
    override.broll = {
      region: { x: brollBB.x, y: brollBB.y, width: brollBB.width, height: brollBB.height },
      // Background when B-roll covers full canvas
      isBackground: brollBB.x <= 10 && brollBB.y <= 10 &&
                    brollBB.width >= 1060 && brollBB.height >= 1880,
    };
  }

  // Header/black regions
  if (bp.blackRegions?.length) {
    const headerRegion = bp.blackRegions.find(r =>
      r.purpose === "header" || r.boundingBox.y < 400
    );
    if (headerRegion) {
      const hBB = headerRegion.boundingBox;
      override.headerZone = {
        region: { x: hBB.x, y: hBB.y, width: hBB.width, height: hBB.height },
      };
    }
  }

  // Text elements — only genuine editor overlays (headlines/captions in a
  // header strip), NOT B-roll content text (app UI / screen-recording text).
  // These are positioned at their exact reference pixel coordinates.
  if (bp.texts?.length) {
    const brollIsBackground = override.broll?.isBackground ?? false;
    const headerRegions = (bp.blackRegions ?? []).map(r => ({
      region: r.boundingBox,
      purpose: r.purpose,
    }));
    const overlayTexts = bp.texts.filter(t =>
      classifyOverlayText({
        box: t.boundingBox,
        isHeadline: t.isHeadline,
        brollIsBackground,
        headerRegions,
        canvas,
      })
    );
    if (overlayTexts.length > 0) {
      override.texts = overlayTexts.map(t => ({
        text: t.text,
        region: {
          x: t.boundingBox.x,
          y: t.boundingBox.y,
          width: t.boundingBox.width,
          height: t.boundingBox.height,
        },
        fontSize: t.estimatedFontSize,
        color: t.color,
        backgroundColor: t.backgroundColor,
        fontWeight: t.fontWeight,
        fontStyle: t.fontStyle,
        spans: (t as { spans?: Array<{ text: string; color: string; x: number }> }).spans,
      }));
    }
  }

  return override;
}

// ════════════════════════════════════════════════════════════
// LAYOUT MAPPING
// ════════════════════════════════════════════════════════════

/**
 * Compute semantic affinity between sentence content and B-roll scene content.
 *
 * V2 ENHANCED: Now uses 3 matching signals:
 * 1. Tag overlap (original) — semantic_tags vs contentTags
 * 2. OCR keyword match (#1 + #4) — speech keywords vs B-roll visible text
 * 3. Substring search — sentence words in B-roll descriptions
 *
 * Returns a score 0-50 (increased from 0-25 to reflect additional signals).
 *
 * @param sentenceTags - Semantic tags from the A-roll sentence
 * @param segmentTags - B-roll content tags from the blueprint segment
 * @param ocrText - OCR text extracted from B-roll scene frames (#1)
 * @param speechKeywords - Specific keywords from the sentence (#4)
 */
function computeSemanticAffinity(
  sentenceTags?: string[],
  segmentTags?: string[],
  ocrText?: string[],
  speechKeywords?: string[]
): number {
  let score = 0;

  // ── Signal 1: Tag overlap (original, max 25 pts) ──
  if (sentenceTags?.length && segmentTags?.length) {
    const sentSet = new Set(sentenceTags.map(t => t.toLowerCase()));
    const segSet = new Set(segmentTags.map(t => t.toLowerCase()));

    let tagMatches = 0;
    for (const tag of sentSet) {
      if (segSet.has(tag)) {
        tagMatches++;
      } else {
        for (const segTag of segSet) {
          if (segTag.includes(tag) || tag.includes(segTag)) {
            tagMatches += 0.5;
            break;
          }
        }
      }
    }

    const maxPossible = Math.max(sentSet.size, segSet.size);
    score += maxPossible > 0 ? Math.min(25, (tagMatches / maxPossible) * 25) : 0;
  }

  // ── Signal 2: OCR keyword match (#1 + #4, max 25 pts) ──
  // This is the HIGHEST precision signal: if the B-roll screen literally
  // shows text that matches what the speaker is saying, it's almost
  // certainly the right B-roll.
  if (ocrText?.length && speechKeywords?.length) {
    const ocrLower = ocrText.map(t => t.toLowerCase()).join(" ");
    let kwMatches = 0;

    for (const kw of speechKeywords) {
      const kwLower = kw.toLowerCase();
      if (kwLower.length < 2) continue; // skip single chars

      if (ocrLower.includes(kwLower)) {
        kwMatches += 2; // Exact substring match = strong signal
      } else {
        // Try individual words from multi-word keywords
        const words = kwLower.split(/\s+/);
        for (const word of words) {
          if (word.length >= 3 && ocrLower.includes(word)) {
            kwMatches += 1;
            break;
          }
        }
      }
    }

    score += Math.min(25, kwMatches * 5);
  }

  return Math.min(50, score);
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
 * Match B-roll scenes to layout ranges using the best available strategy.
 *
 * Strategy hierarchy (best → fallback):
 * 1. Narrative context (Gemini-produced relevance map) — understands WHY
 * 2. Semantic tag affinity — string overlap between tags
 * 3. Time-proportional mapping — position-based fallback
 *
 * Supports multi-B-roll: each scene carries a `sourceIndex` that maps to
 * the correct FFmpeg input. When using narrative context, the relevance map
 * already accounts for which source each scene came from.
 *
 * @param layoutRanges - The ranges to assign B-roll offsets to (mutated in place)
 * @param brollScenes - Available B-roll scenes with content tags (from all sources)
 * @param brollDuration - Total B-roll video duration (for proportional fallback)
 * @param totalDuration - Total output video duration (for proportional fallback)
 * @param narrativeContext - Optional Gemini-produced narrative understanding
 */
function matchBrollScenes(
  layoutRanges: LayoutRange[],
  brollScenes: BRollScene[],
  brollDuration: number,
  totalDuration: number,
  narrativeContext?: NarrativeContext
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

  // Build a fast lookup from the narrative context relevance map
  // sentenceIndex → ranked scene indices with scores
  const narrativeMap = new Map<number, Array<{ sceneIndex: number; relevanceScore: number; reason: string }>>();
  if (narrativeContext?.relevanceMap) {
    for (const entry of narrativeContext.relevanceMap) {
      narrativeMap.set(entry.sentenceIndex, entry.rankedScenes);
    }
    console.log(`    Using narrative context: ${narrativeContext.theme} (${narrativeContext.narrativePhases.length} phases)`);
  }

  // ── Source pairing: determine the dominant A-roll clip index per range ──
  // If sentences in a range came from A-roll clip N, prefer B-roll source N.
  function getRangeArollClipIndex(range: LayoutRange): number | undefined {
    const clipIndices = range.sentences
      .map(s => s.arollClipIndex)
      .filter((idx): idx is number => idx !== undefined);
    if (clipIndices.length === 0) return undefined;
    // Use the most common clip index (majority vote)
    const counts = new Map<number, number>();
    for (const idx of clipIndices) {
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    let bestIdx = clipIndices[0];
    let bestCount = 0;
    for (const [idx, count] of counts) {
      if (count > bestCount) { bestCount = count; bestIdx = idx; }
    }
    return bestIdx;
  }

  for (const range of layoutRanges) {
    let bestScene = brollScenes[0];
    let bestScore = -1;
    let bestIdx = 0;
    let matchType = "proportional";

    // Source pairing: bonus for B-roll from the same-index source as the A-roll clip
    const rangeArollClipIdx = getRangeArollClipIndex(range);

    // ── Strategy 1: Narrative context (best) ──
    if (narrativeMap.size > 0 && range.sentences.length > 0) {
      // Collect relevance scores from all sentences in this range
      const aggregatedScores = new Map<number, { total: number; reasons: string[] }>();

      for (const sentence of range.sentences) {
        const ranked = narrativeMap.get(sentence.index);
        if (!ranked) continue;
        for (const entry of ranked) {
          const existing = aggregatedScores.get(entry.sceneIndex) ?? { total: 0, reasons: [] };
          existing.total += entry.relevanceScore;
          if (entry.reason && existing.reasons.length < 2) existing.reasons.push(entry.reason);
          aggregatedScores.set(entry.sceneIndex, existing);
        }
      }

      // Find best scene from narrative scores
      for (const [sceneIdx, scores] of aggregatedScores) {
        if (sceneIdx >= brollScenes.length) continue;

        let score = scores.total;

        // Source pairing bonus: +30 if B-roll source matches A-roll clip index
        if (rangeArollClipIdx !== undefined && brollScenes[sceneIdx].sourceIndex === rangeArollClipIdx) {
          score += 30;
        }

        // Penalize heavily-reused scenes
        const usage = sceneUsageCount.get(sceneIdx) ?? 0;
        score *= Math.max(0.3, 1 - usage * 0.2);

        if (score > bestScore) {
          bestScore = score;
          bestScene = brollScenes[sceneIdx];
          bestIdx = sceneIdx;
          matchType = "narrative";
        }
      }
    }

    // ── Strategy 2: Enhanced semantic + OCR affinity (fallback) ──
    if (bestScore <= 0) {
      const rangeTags = [
        ...(range.semanticTags ?? []),
        ...(range.brollContentTags ?? []),
      ];

      // Collect speech keywords from sentences in this range
      const rangeKeywords: string[] = [];
      for (const sentence of range.sentences) {
        // Extract meaningful words from sentence text (> 3 chars)
        const words = sentence.text.split(/\s+/).filter(w => w.length > 3);
        rangeKeywords.push(...words);
      }

      if (rangeTags.length > 0 || rangeKeywords.length > 0) {
        for (let i = 0; i < brollScenes.length; i++) {
          const scene = brollScenes[i];

          // Enhanced: pass OCR text and keywords for multi-signal matching
          let score = computeSemanticAffinity(
            rangeTags.length > 0 ? rangeTags : undefined,
            scene.contentTags?.length ? scene.contentTags : undefined,
            scene.visibleText,       // #1: OCR text from B-roll
            rangeKeywords.length > 0 ? rangeKeywords : undefined  // #4: speech keywords
          );

          if (score <= 0) continue;

          // Source pairing bonus: +30 if B-roll source matches A-roll clip index
          if (rangeArollClipIdx !== undefined && scene.sourceIndex === rangeArollClipIdx) {
            score += 30;
          }

          // Penalize heavily-reused scenes to encourage variety
          const usage = sceneUsageCount.get(i) ?? 0;
          score *= Math.max(0.3, 1 - usage * 0.25);

          if (score > bestScore) {
            bestScore = score;
            bestScene = scene;
            bestIdx = i;
            matchType = score >= 20 ? "keyword+ocr" : "semantic";
          }
        }
      }
    }

    // ── Strategy 3: Time-proportional mapping (last resort) ──
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
      matchType = "proportional";
    }

    // ── Per-sentence B-roll trimming (Improvement #2) ──
    // Instead of using the scene's start offset, find the exact frame within
    // the scene whose OCR/tags best match the sentence keywords.
    let trimmedOffset = bestScene.start;
    if (bestScene.frameContent?.length && range.sentences.length > 0) {
      // Collect keywords from all sentences in this range
      const keywords: string[] = [];
      for (const sentence of range.sentences) {
        const words = sentence.text.split(/\s+/).filter(w => w.length > 3);
        keywords.push(...words.map(w => w.toLowerCase()));
      }

      if (keywords.length > 0) {
        let bestFrameScore = -1;
        let bestFrameTimestamp = bestScene.start;

        for (const frame of bestScene.frameContent) {
          // Only consider frames within the scene boundaries
          if (frame.timestamp < bestScene.start || frame.timestamp > bestScene.end) continue;

          let frameScore = 0;
          const frameText = [
            ...(frame.visibleText ?? []),
            ...frame.contentTags,
          ].map(t => t.toLowerCase()).join(" ");

          for (const kw of keywords) {
            if (frameText.includes(kw)) {
              frameScore += 2;
            }
          }

          if (frameScore > bestFrameScore) {
            bestFrameScore = frameScore;
            bestFrameTimestamp = frame.timestamp;
          }
        }

        if (bestFrameScore > 0) {
          trimmedOffset = bestFrameTimestamp;
        }
      }
    }

    range.brollOffset = trimmedOffset;
    range.brollSourceIndex = bestScene.sourceIndex ?? 0;

    // Track usage
    sceneUsageCount.set(bestIdx, (sceneUsageCount.get(bestIdx) ?? 0) + 1);

    const tagInfo = (range.semanticTags?.length ?? 0) > 0 ? ` [tags: ${range.semanticTags!.slice(0, 3).join(", ")}]` : "";
    const sceneInfo = bestScene.contentTags?.length
      ? ` → scene [${bestScene.contentTags.slice(0, 3).join(", ")}]`
      : "";
    const srcInfo = bestScene.sourceIndex !== undefined && bestScene.sourceIndex > 0 ? ` (broll #${bestScene.sourceIndex})` : "";
    console.log(
      `    ${range.id}: offset=${trimmedOffset.toFixed(2)}s (${matchType})${tagInfo}${sceneInfo}${srcInfo}`
    );
  }
}

/**
 * Enforce B-roll VARIETY (user feedback: B-roll repeated after ~18s while several
 * clips were never used). No two consecutive ranges may use the same B-roll
 * source, and usage is spread across ALL available sources. Relevance is kept
 * where it doesn't conflict — a range is only reassigned on a consecutive repeat
 * or heavy over-use, choosing the least-used source that isn't the previous one.
 */
/**
 * Determine which B-roll SOURCES (clips) are on-topic, per the narrative context.
 * A scene is "relevant" if the narrative ranked it for some sentence above the
 * floor, or its scenePhase is a real narrative phase (not "general"). A source is
 * usable if it owns at least one relevant scene. Off-topic clips (which the
 * narrative marks "general"/unrelated — e.g. an athlete clip, an abstract graphic,
 * a cartoon) are excluded so the variety pass can't pull them in just because they
 * are unused. Falls back to "all sources" when there is no narrative context.
 */
function computeUsableBrollSources(
  brollScenes: BRollScene[],
  narrativeContext?: NarrativeContext
): Set<number> {
  const allSources = new Set(brollScenes.map((s) => s.sourceIndex ?? 0));
  if (!narrativeContext) return allSources;
  const RELEVANCE_FLOOR = 55;
  const relevantScenes = new Set<number>();
  for (const e of narrativeContext.relevanceMap ?? []) {
    for (const s of e.rankedScenes ?? []) {
      if (s.relevanceScore >= RELEVANCE_FLOOR) relevantScenes.add(s.sceneIndex);
    }
  }
  const scenePhases = (narrativeContext as { scenePhases?: Array<{ sceneIndex: number; phase: string }> }).scenePhases;
  for (const sp of scenePhases ?? []) {
    if (sp.phase && sp.phase !== "general") relevantScenes.add(sp.sceneIndex);
  }
  const usable = new Set<number>();
  for (const idx of relevantScenes) {
    const src = brollScenes[idx]?.sourceIndex;
    if (src !== undefined) usable.add(src);
  }
  return usable.size > 0 ? usable : allSources;
}

/**
 * Spread B-roll across ON-TOPIC clips only: no consecutive repeats, no clip
 * over-used, and any range that was assigned an off-topic source is pulled back
 * onto a usable one. `usableSources` is the relevance-filtered source allowlist.
 */
function enforceBrollVariety(layoutRanges: LayoutRange[], usableSources: number[]): void {
  const allowed = usableSources.filter((s) => s >= 0);
  if (allowed.length === 0) return;
  if (allowed.length === 1) {
    // Only one on-topic clip — force every range onto it.
    for (const r of layoutRanges) {
      if (!allowed.includes(r.brollSourceIndex ?? -1)) { r.brollSourceIndex = allowed[0]; r.brollOffset = 0; }
    }
    return;
  }
  const usage = new Map<number, number>();
  for (const s of allowed) usage.set(s, 0);
  // First pass: pull any range using an OFF-TOPIC source onto the least-used allowed one.
  for (const r of layoutRanges) {
    let s = r.brollSourceIndex ?? 0;
    if (!usage.has(s)) {
      let best = allowed[0], bestUse = Infinity;
      for (const k of allowed) { const u = usage.get(k)!; if (u < bestUse) { bestUse = u; best = k; } }
      r.brollSourceIndex = best; r.brollOffset = 0; s = best;
    }
    usage.set(s, (usage.get(s) ?? 0) + 1);
  }
  // Second pass: break consecutive repeats + over-use, swapping only among allowed.
  const cap = Math.ceil(layoutRanges.length / allowed.length) + 1;
  let prev = -1;
  let swaps = 0;
  for (const r of layoutRanges) {
    let s = r.brollSourceIndex ?? 0;
    const overused = (usage.get(s) ?? 0) > cap;
    if (s === prev || overused) {
      let best = -1;
      let bestUse = Infinity;
      for (const k of allowed) {
        if (k === prev) continue;
        const u = usage.get(k) ?? 0;
        if (u < bestUse) { bestUse = u; best = k; }
      }
      if (best >= 0 && best !== s) {
        usage.set(s, (usage.get(s) ?? 0) - 1);
        usage.set(best, (usage.get(best) ?? 0) + 1);
        r.brollSourceIndex = best;
        r.brollOffset = 0; // fresh source — start of clip
        s = best;
        swaps++;
      }
    }
    prev = s;
  }
  if (swaps > 0) {
    console.log(`    B-roll variety: reassigned ${swaps} range(s) — spread across ${allowed.length} on-topic clip(s)`);
  }
}

/**
 * Align B-roll frames to specific speech moments (Improvement #3).
 *
 * For each layout range, if the range has multiple sentences with different
 * keywords, find B-roll frames that match specific keywords and create
 * sub-offset keyframes within the range. This enables the renderer to
 * show the right B-roll frame at the exact moment the speaker says a keyword.
 *
 * @param layoutRanges - Ranges with brollOffset already assigned (mutated in place)
 * @param brollScenes - Available B-roll scenes (with frameContent for lookup)
 */
function alignBrollToSpeech(
  layoutRanges: LayoutRange[],
  brollScenes: BRollScene[]
): void {
  for (const range of layoutRanges) {
    if (range.brollOffset === undefined) continue;
    if (range.sentences.length < 1) continue;

    // Find the matched scene for this range
    const matchedScene = brollScenes.find(
      s => s.sourceIndex === (range.brollSourceIndex ?? 0) &&
           s.start <= (range.brollOffset ?? 0) &&
           s.end >= (range.brollOffset ?? 0)
    );
    if (!matchedScene?.frameContent?.length) continue;

    const keyframes: Array<{ speechTime: number; brollTime: number; keyword: string }> = [];

    // For each sentence in the range, extract its top keywords and find matching frames
    for (const sentence of range.sentences) {
      const words = sentence.text.split(/\s+/).filter(w => w.length > 3);
      if (words.length === 0) continue;

      for (const word of words) {
        const wordLower = word.toLowerCase();
        // Find the B-roll frame whose OCR text best matches this word
        for (const frame of matchedScene.frameContent) {
          const frameText = [
            ...(frame.visibleText ?? []),
            ...frame.contentTags,
          ].map(t => t.toLowerCase()).join(" ");

          if (frameText.includes(wordLower)) {
            // Use the midpoint of the sentence as the speech time for this keyword
            const speechTime = (sentence.start + sentence.end) / 2;
            keyframes.push({
              speechTime,
              brollTime: frame.timestamp,
              keyword: word,
            });
            break; // One match per keyword is sufficient
          }
        }
      }
    }

    // Only attach keyframes if we found meaningful alignments
    if (keyframes.length > 0) {
      // Deduplicate by brollTime (keep the first occurrence)
      const seen = new Set<number>();
      range.brollKeyframes = keyframes.filter(kf => {
        if (seen.has(kf.brollTime)) return false;
        seen.add(kf.brollTime);
        return true;
      });
    }
  }
}

/**
 * Smart region cropping for B-roll (Improvement #4).
 *
 * When the B-roll shows a full app screen but the speech is about one specific
 * feature, determine an approximate crop region based on where the matching
 * OCR text or content tags appear in the frame. Uses a heuristic approach
 * based on UI element positioning (top/middle/bottom of screen).
 *
 * @param layoutRanges - Ranges with brollOffset already assigned (mutated in place)
 * @param brollScenes - Available B-roll scenes (with frameContent for lookup)
 */
function assignBrollCropRegions(
  layoutRanges: LayoutRange[],
  brollScenes: BRollScene[]
): void {
  for (const range of layoutRanges) {
    if (range.brollOffset === undefined) continue;
    if (range.sentences.length === 0) continue;

    // Find the matched scene
    const matchedScene = brollScenes.find(
      s => s.sourceIndex === (range.brollSourceIndex ?? 0) &&
           s.start <= (range.brollOffset ?? 0) &&
           s.end >= (range.brollOffset ?? 0)
    );
    if (!matchedScene?.frameContent?.length) continue;

    // Get keywords from sentences
    const keywords: string[] = [];
    for (const sentence of range.sentences) {
      const words = sentence.text.split(/\s+/).filter(w => w.length > 3);
      keywords.push(...words.map(w => w.toLowerCase()));
    }
    if (keywords.length === 0) continue;

    // Find the best matching frame at the brollOffset
    const targetFrame = matchedScene.frameContent.find(
      f => Math.abs(f.timestamp - (range.brollOffset ?? 0)) < 1.0
    );
    if (!targetFrame) continue;

    // Check if the matching content is localized to a portion of the screen
    // by analyzing contentTags for positional hints (navigation, header, sidebar, etc.)
    const tags = targetFrame.contentTags.map(t => t.toLowerCase()).join(" ");
    const visText = (targetFrame.visibleText ?? []).join(" ").toLowerCase();

    // Heuristic: if content tags suggest a specific UI region, create a crop
    // that zooms into that region. Use thirds-based positioning.
    let region: { x: number; y: number; width: number; height: number } | undefined;

    // Default assumption: 1080x1920 canvas (9:16), B-roll occupies a region within
    // We don't have exact pixel coordinates from OCR, so use coarse positioning
    if (tags.includes("navigation") || tags.includes("nav") || tags.includes("menu") || tags.includes("sidebar")) {
      // Navigation/sidebar: left or top portion
      region = { x: 0, y: 0, width: 100, height: 50 }; // percentage-based
    } else if (tags.includes("footer") || tags.includes("bottom") || tags.includes("action") || tags.includes("button")) {
      // Bottom portion of screen
      region = { x: 0, y: 60, width: 100, height: 40 }; // percentage-based
    } else if (tags.includes("header") || tags.includes("title") || tags.includes("top")) {
      // Top portion
      region = { x: 0, y: 0, width: 100, height: 40 }; // percentage-based
    } else if (tags.includes("chart") || tags.includes("graph") || tags.includes("analytics")) {
      // Center-focused
      region = { x: 10, y: 20, width: 80, height: 60 }; // percentage-based
    }

    // Only apply crop if we have a specific region hint AND a keyword match
    if (region) {
      let hasKeywordMatch = false;
      for (const kw of keywords) {
        if (visText.includes(kw) || tags.includes(kw)) {
          hasKeywordMatch = true;
          break;
        }
      }
      if (hasKeywordMatch) {
        range.brollCropRegion = region;
      }
    }
  }
}

/**
 * Duration-aware B-roll speed adjustment (Improvement #5).
 *
 * If a sentence is 8s but the best B-roll scene is only 3s, adjust playback
 * speed to cover the gap. For screen recordings with natural motion (scroll,
 * animation), prefer using natural speed. For static content, allow slight
 * slowdown to fill the duration.
 *
 * @param layoutRanges - Ranges with brollOffset already assigned (mutated in place)
 * @param brollScenes - Available B-roll scenes
 */
function adjustBrollSpeed(
  layoutRanges: LayoutRange[],
  brollScenes: BRollScene[]
): void {
  for (const range of layoutRanges) {
    if (range.brollOffset === undefined) continue;

    const rangeDuration = range.timeRange.end - range.timeRange.start;
    if (rangeDuration <= 0) continue;

    // Find the matched scene
    const matchedScene = brollScenes.find(
      s => s.sourceIndex === (range.brollSourceIndex ?? 0) &&
           s.start <= (range.brollOffset ?? 0) &&
           s.end >= (range.brollOffset ?? 0)
    );
    if (!matchedScene) continue;

    // Available B-roll duration from the offset to scene end
    const availableBrollDuration = matchedScene.end - (range.brollOffset ?? matchedScene.start);

    if (availableBrollDuration <= 0) continue;

    // If B-roll has enough duration, no speed adjustment needed
    if (availableBrollDuration >= rangeDuration) continue;

    // B-roll is shorter than the range — need to handle the gap
    const ratio = availableBrollDuration / rangeDuration;

    // Check if the scene has motion (based on content tags)
    const tags = (matchedScene.contentTags ?? []).join(" ").toLowerCase();
    const hasMotion = tags.includes("scroll") || tags.includes("animation") ||
                      tags.includes("transition") || tags.includes("pan") ||
                      tags.includes("typing") || tags.includes("cursor");

    if (hasMotion) {
      // For motion content: keep natural speed, the renderer will handle
      // by freezing/extending the last frame past the B-roll's end
      // (no speed change — natural speed is more important)
      continue;
    }

    // For static/slow content: slow down slightly to fill the gap
    // But never slower than 0.5x (half speed)
    const speed = Math.max(0.5, ratio);

    // Only apply if the slowdown is meaningful (not too extreme)
    if (speed < 0.95) {
      range.brollSpeed = Math.round(speed * 100) / 100; // round to 2 decimals
      console.log(
        `    ${range.id}: B-roll ${availableBrollDuration.toFixed(1)}s < range ${rangeDuration.toFixed(1)}s → speed=${range.brollSpeed}x`
      );
    }
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
  /** Which B-roll source this scene comes from (0-based, for multi-B-roll) */
  sourceIndex?: number;
  /** OCR text extracted from frames in this scene (#1: B-roll OCR) */
  visibleText?: string[];
  /** UI elements detected in this scene */
  uiElements?: string[];
  /** Per-frame content data for precise trimming (Improvement #2) */
  frameContent?: Array<{
    timestamp: number;
    visibleText?: string[];
    contentTags: string[];
  }>;
}

/**
 * Narrative context map — produced by Gemini to understand the overall
 * story flow across all A-roll clips and all B-roll sources.
 *
 * This enables intelligent matching: instead of just string-overlap on tags,
 * the system understands WHY a B-roll scene should accompany specific speech.
 */
export interface NarrativeContext {
  /** Overall content theme/topic */
  theme: string;
  /** Narrative arc phases detected across all A-roll clips */
  narrativePhases: Array<{
    phase: string; // e.g., "hook", "problem", "solution", "demo", "cta"
    sentenceIndices: number[];
    description: string;
  }>;
  /** Pre-computed relevance map: sentence index → ranked B-roll scene indices */
  relevanceMap: Array<{
    sentenceIndex: number;
    rankedScenes: Array<{
      sceneIndex: number;
      relevanceScore: number; // 0-100
      reason: string;
    }>;
  }>;
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
   * For multi-B-roll, scenes from all sources are included with sourceIndex set.
   */
  brollScenes?: BRollScene[];
  /** Optional: total B-roll duration (for fallback uniform division) */
  brollDuration?: number;
  /**
   * Optional: narrative context from Gemini analysis of ALL clips together.
   * When provided, the plan builder uses the pre-computed relevance map
   * for intelligent B-roll matching instead of shallow tag overlap.
   */
  narrativeContext?: NarrativeContext;
  /**
   * Optional: per-sentence A-roll clip index mapping.
   * Maps global sentence index → A-roll clip index (0-based).
   * Used for source pairing: B-roll N is preferred for A-roll N's sentences.
   */
  sentenceArollClipMap?: Map<number, number>;
  /**
   * Optional: the reference Layout Map (virtual coordinate template/library).
   * When provided, the plan builder computes per-range A-roll PIP position
   * keyframes so the circle can smoothly follow the reference's motion within
   * a sentence (glitch-free, since it's a reposition, not a layout-type cut).
   */
  layoutMap?: LayoutMap;
  /**
   * Optional: B-roll shot cadence derived from the reference's editing rhythm
   * (cadence-planner). Drives how finely long ranges are subdivided into B-roll
   * shots. Omit → legacy 1.5s/2.4s behavior (backward-safe).
   */
  cadence?: CadencePlan;
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
    arollClipIndex: input.sentenceArollClipMap?.get(i),
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

  // ── Step 2: Create per-sentence ranges (dynamic B-roll per sentence) ──
  // Each sentence gets its own LayoutRange so B-roll can change at every
  // sentence boundary, reflecting what is being said in the A-roll.
  console.log("\n  Step 2: Creating per-sentence layout ranges (dynamic B-roll)...");

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
    console.log(
      `    S${sl.sentence.index + 1}: own range '${sl.layoutId}' [${sl.sentence.start.toFixed(2)}-${sl.sentence.end.toFixed(2)}s]`
    );
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

  // ── Step 4b: Subdivide long ranges into B-roll shots (PACING) ──
  // One range per sentence cuts B-roll only ~once per sentence — far slower than
  // a reference reel, which cuts a fast B-roll montage every ~1–2s. Subdivide
  // each long range into ~TARGET_SHOT_SEC sub-shots that keep the SAME layout +
  // PIP override (NO mid-sentence PIP cut — only the B-roll behind changes, which
  // is exactly the reference's style). B-roll matching (Step 5b) then assigns a
  // varied, relevant clip to each sub-shot (its reuse penalty drives variety).
  // Reference-derived cadence (cadence-planner). Falls back to the legacy 1.5s/2.4s
  // when no cadence is supplied, so a fast reel cuts faster and a calm reel holds longer.
  const cadence = input.cadence ?? planCadence(null);
  const TARGET_SHOT_SEC = cadence.targetShotSec; // target B-roll shot length (reference-matched)
  {
    const beforeCount = mergedRanges.length;
    const subRanges: MergedRange[] = [];
    for (const mr of mergedRanges) {
      const dur = mr.end - mr.start;
      // CEIL (not round) so a range meaningfully longer than one shot cuts an extra time —
      // the reference cuts B-roll WITHIN sentences (26 shots vs ~18 sentence-ranges), so a
      // ~1.5s range at a ~1s cadence must yield 2 B-roll shots, not 1. Gated by MIN_SUBDIVIDE
      // so calm references (long target) still hold. Validated: matches the reference's 26 shots.
      // round-half-up with a subdivide gate: subdivide when a range is >1.5× a shot, and round
      // to the nearest shot count (ceil overshot the reference's shot total by ~2).
      const nShots =
        dur > TARGET_SHOT_SEC * 1.5
          ? Math.max(2, Math.round(dur / TARGET_SHOT_SEC))
          : 1;
      if (nShots <= 1) {
        subRanges.push(mr);
        continue;
      }
      const shotDur = dur / nShots;
      for (let k = 0; k < nShots; k++) {
        subRanges.push({
          ...mr, // same layoutId / blueprintSegment / sentences / tags
          start: mr.start + k * shotDur,
          end: k === nShots - 1 ? mr.end : mr.start + (k + 1) * shotDur,
        });
      }
    }
    mergedRanges.length = 0;
    mergedRanges.push(...subRanges);
    console.log(
      `    Subdivided ${beforeCount} sentence ranges → ${mergedRanges.length} B-roll shots (~${TARGET_SHOT_SEC}s/shot)`
    );
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

    // ── Direct replication: carry exact blueprint coordinates ──
    const layoutOverride = buildLayoutOverride(mr.blueprintSegment, template.canvas);

    layoutRanges.push({
      id: `range_${i + 1}`,
      layoutId: mr.layoutId,
      timeRange: { start: mr.start, end: mr.end },
      sentences: mr.sentences,
      textOverlays,
      reasoning: mr.reasoning,
      semanticTags: mr.semanticTags.length > 0 ? mr.semanticTags : undefined,
      brollContentTags: mr.brollContentTags.length > 0 ? mr.brollContentTags : undefined,
      layoutOverride,
      startFrame,
      endFrame,
      enableExpr,
    });

    console.log(
      `    range_${i + 1}: ${mr.start.toFixed(2)}-${mr.end.toFixed(2)}s | ` +
      `${mr.layoutId} | enable='${enableExpr}'`
    );
  }

  // ── Step 6a: Per-range PIP position logging ──
  // Each range keeps its own blueprint coordinates from buildLayoutOverride().
  // The renderer uses per-range override positions for circle overlays,
  // so each segment's PIP matches its specific reference position.
  console.log("\n  Step 5a: Per-range PIP positions (direct replication)...");
  {
    const layoutGroups = new Map<string, LayoutRange[]>();
    for (const range of layoutRanges) {
      const group = layoutGroups.get(range.layoutId) ?? [];
      group.push(range);
      layoutGroups.set(range.layoutId, group);
    }

    for (const [layoutId, ranges] of layoutGroups) {
      if (ranges.length <= 1) continue;
      const withOverrides = ranges.filter(r => r.layoutOverride?.aroll?.region);
      if (withOverrides.length === 0) continue;

      for (const r of withOverrides) {
        const region = r.layoutOverride!.aroll!.region;
        console.log(
          `    ${r.id} [${layoutId}]: A-roll at (${region.x},${region.y},${region.width}x${region.height})`
        );
      }
    }
  }

  // ── Step 6a': PIP motion keyframes (smooth animation within a sentence) ──
  // When the reference's circle PIP drifts across multiple reference states
  // that fall inside a single edit range, animate the overlay position to
  // follow that motion. This is a reposition (not a layout-type cut), so it
  // is glitch-free. Requires the Layout Map.
  if (input.layoutMap) {
    console.log("\n  Step 5a': Computing PIP motion keyframes from Layout Map...");
    const editDuration = layoutRanges[layoutRanges.length - 1]?.timeRange.end ?? 0;
    for (const range of layoutRanges) {
      const shape = range.layoutOverride?.aroll?.shape
        ?? (range.layoutId.includes("circle") ? "circle" : "rectangle");
      if (shape !== "circle") continue;

      const keyframes = getArollKeyframes({
        map: input.layoutMap,
        editStart: range.timeRange.start,
        editEnd: range.timeRange.end,
        editDuration,
        shape: "circle",
      });

      if (keyframes.length >= 2) {
        range.arollKeyframes = keyframes;
        const path = keyframes
          .map(k => `(${Math.round(k.x)},${Math.round(k.y)})@${k.t.toFixed(1)}s`)
          .join(" → ");
        console.log(`    ${range.id}: PIP animates ${path}`);
      }
    }
  }

  // ── Step 6b: Match B-roll scenes (content-aware offsets) ──
  if (input.brollScenes?.length || input.brollDuration) {
    console.log("\n  Step 5b: Matching B-roll scenes to layout ranges...");
    const brollScenes = input.brollScenes ?? [];
    const brollDuration = input.brollDuration ?? 0;
    const totalDur = layoutRanges[layoutRanges.length - 1]?.timeRange.end ?? 0;

    if (brollDuration > 0) {
      matchBrollScenes(layoutRanges, brollScenes, brollDuration, totalDur, input.narrativeContext);

      // ── B-roll VARIETY: spread across ON-TOPIC clips only ──
      // A source is "usable" only if the narrative context found at least one
      // on-topic scene in it; off-topic clips (cartoon, abstract graphics, the
      // "unrelated" athlete footage) are dropped so variety can't pull them in.
      const usableSources = computeUsableBrollSources(brollScenes, input.narrativeContext);
      console.log(`    On-topic B-roll sources: [${[...usableSources].sort((a, b) => a - b).join(", ")}] of ${new Set(brollScenes.map((s) => s.sourceIndex ?? 0)).size} clips`);
      enforceBrollVariety(layoutRanges, [...usableSources]);

      // ── Step 6c: Frame-level keyword sync (Improvement #3) ──
      console.log("\n  Step 5c: Aligning B-roll frames to speech keywords...");
      alignBrollToSpeech(layoutRanges, brollScenes);
      const keyframeCount = layoutRanges.filter(r => r.brollKeyframes?.length).length;
      if (keyframeCount > 0) {
        console.log(`    ${keyframeCount}/${layoutRanges.length} ranges have keyword-aligned keyframes`);
      }

      // ── Step 6d: Smart region cropping (Improvement #4) ──
      console.log("\n  Step 5d: Assigning B-roll crop regions...");
      assignBrollCropRegions(layoutRanges, brollScenes);
      const cropCount = layoutRanges.filter(r => r.brollCropRegion).length;
      if (cropCount > 0) {
        console.log(`    ${cropCount}/${layoutRanges.length} ranges have smart crop regions`);
      }

      // ── Step 6e: Duration-aware B-roll handling (Improvement #5) ──
      console.log("\n  Step 5e: Adjusting B-roll speed for duration mismatches...");
      adjustBrollSpeed(layoutRanges, brollScenes);
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
