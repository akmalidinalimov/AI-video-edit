/**
 * Layout Map — Virtual Coordinate Template / Library
 *
 * THE CORE IDEA (user's "virtual dimensioning" concept):
 * A reference video is a SEQUENCE of layout states. Each state has a precise
 * pixel-coordinate description of WHERE every element sits on a fixed virtual
 * canvas (1080×1920 for vertical, 1920×1080 for horizontal):
 *   - A-roll (talking head): shape + x, y, width, height
 *   - B-roll (background/inset): x, y, width, height
 *   - Text / captions: x, y, width, height, style
 *   - Header / black regions
 *
 * Whenever the reference's layout OR scene changes, that's a new state with
 * its own coordinates. We capture all of them into a single LayoutMap, which
 * becomes a reusable RULE SET ("library") that can be applied to ANY edit:
 * the edit knows exactly where to place each element in each segment because
 * the reference told us, in pixels.
 *
 * Two things this module provides:
 *   1. buildLayoutMap()  — extract the coordinate sequence from a blueprint
 *   2. getArollKeyframes() — for an edit range, compute the PIP position
 *      trajectory (so the PIP can smoothly follow the reference's motion
 *      WITHIN a sentence, with no layout-type cut → no audio glitch)
 *
 * The map is saved as JSON so it can be inspected, reused, and built into a
 * cross-reference library over time.
 */

import fs from "fs";
import type { BlueprintSegment, BoundingBox } from "@/lib/types/blueprint";

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export type AspectRatio = "9:16" | "16:9" | "1:1" | "4:5";

export interface LayoutMapText {
  text: string;
  region: BoundingBox;
  fontSize?: number;
  color?: string;
  backgroundColor?: string | null;
  fontWeight?: string;
  isHeadline?: boolean;
  /**
   * True when this text is a genuine EDITOR overlay (headline/caption added on
   * top of the composition) rather than text that is part of the B-roll
   * content (app UI, screen-recording text). Only overlay texts are
   * replicated in the edit — B-roll content text belongs to the (different)
   * B-roll source and must not be re-drawn.
   */
  isOverlay?: boolean;
}

/**
 * One layout state in the reference — a stretch of time during which the
 * on-screen arrangement is stable (no layout/scene change). Coordinates are
 * absolute pixels on the virtual canvas.
 */
export interface LayoutState {
  /** 0-based index in the sequence */
  index: number;
  /** Source segment id (for traceability back to the blueprint) */
  sourceSegmentId: string;
  /** Reference time range this state is active (seconds) */
  refTimeRange: { start: number; end: number };

  /** A-roll element (null when the layout has no talking head) */
  aroll: {
    shape: "rectangle" | "circle";
    region: BoundingBox;
    /** Circle center (only meaningful for shape === "circle") */
    center?: { x: number; y: number };
    /** Circle radius (only meaningful for shape === "circle") */
    radius?: number;
    hasBorder: boolean;
    borderColor?: string | null;
    borderWidth?: number;
  } | null;

  /** B-roll element */
  broll: {
    region: BoundingBox;
    /** True when B-roll covers (nearly) the whole canvas */
    isBackground: boolean;
  } | null;

  /** Text / caption elements */
  texts: LayoutMapText[];

  /** Header / black background regions */
  headerRegions: Array<{ region: BoundingBox; purpose: string }>;
}

export interface LayoutMap {
  /** Schema version */
  version: number;
  /** When this map was built */
  generatedAt: string;
  /** Source reference file name (for the library index) */
  sourceFile?: string;
  /** Virtual canvas the coordinates are expressed against */
  canvas: { width: number; height: number };
  /** Aspect ratio class (vertical vs horizontal template) */
  aspectRatio: AspectRatio;
  /** Total reference duration (seconds) */
  refDuration: number;
  /** Ordered sequence of layout states */
  states: LayoutState[];
}

export interface ArollKeyframe {
  /** Absolute time in the EDIT timeline (seconds) */
  t: number;
  /** A-roll overlay top-left X */
  x: number;
  /** A-roll overlay top-left Y */
  y: number;
}

// ════════════════════════════════════════════════════════════
// BUILD
// ════════════════════════════════════════════════════════════

/**
 * Decide whether a detected text box is a genuine EDITOR overlay
 * (headline/caption to replicate) or B-roll content text (skip).
 *
 * Rules (conservative — false positives would re-draw app UI text on top of
 * our own B-roll, which looks wrong):
 *   1. Over a full-canvas background B-roll → it's B-roll content → NOT overlay.
 *   2. Otherwise → overlay iff the text box sits inside a REAL header/black
 *      strip (purpose "header", or a top band ≤ 40% canvas height anchored
 *      near the top). Editor headlines live in these strips; B-roll UI text
 *      sits over the B-roll/A-roll regions below.
 *
 * Captions placed directly over B-roll (e.g. burned-in subtitles) are not yet
 * classified as overlays here — this reference uses header-zone headlines only.
 */
export function classifyOverlayText(input: {
  box: BoundingBox;
  isHeadline?: boolean;
  brollIsBackground: boolean;
  headerRegions: Array<{ region: BoundingBox; purpose: string }>;
  canvas: { width: number; height: number };
}): boolean {
  const { box, isHeadline, brollIsBackground, headerRegions, canvas } = input;

  // (1) Full-screen B-roll behind it → content text, never an overlay.
  if (brollIsBackground) return false;

  // (2) Inside a real header/black STRIP? A real header is a top band, not a
  // full-canvas region. Require it to be anchored near the top AND short
  // (≤40% canvas height) — this rejects "background" black regions that span
  // the whole canvas (which would otherwise pass app-UI text as overlays).
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const inHeader = headerRegions.some((h) => {
    const r = h.region;
    const isTopStrip = r.y <= canvas.height * 0.12 && r.height <= canvas.height * 0.4;
    if (!isTopStrip) return false;
    return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
  });
  if (inHeader) return true;

  // A clearly-marked headline in the top region also counts.
  if (isHeadline && box.y < canvas.height * 0.4) return true;

  return false;
}

function classifyAspect(width: number, height: number): AspectRatio {
  const r = width / height;
  if (Math.abs(r - 9 / 16) < 0.05) return "9:16";
  if (Math.abs(r - 16 / 9) < 0.1) return "16:9";
  if (Math.abs(r - 1) < 0.05) return "1:1";
  if (Math.abs(r - 4 / 5) < 0.05) return "4:5";
  // Default by orientation
  return height >= width ? "9:16" : "16:9";
}

/**
 * Build a LayoutMap from a blueprint's reference segments.
 *
 * Each blueprint segment already represents a stable layout/scene region
 * (the analysis segments the reference at layout AND scene changes). We
 * formalize those into precise coordinate states.
 */
export function buildLayoutMap(input: {
  segments: BlueprintSegment[];
  canvas: { width: number; height: number };
  refDuration: number;
  sourceFile?: string;
}): LayoutMap {
  const { segments, canvas, refDuration, sourceFile } = input;

  const states: LayoutState[] = segments.map((seg, index) => {
    // ── A-roll ──
    let aroll: LayoutState["aroll"] = null;
    if (seg.aroll?.boundingBox) {
      const bb = seg.aroll.boundingBox;
      const shape: "rectangle" | "circle" =
        seg.aroll.shape === "circle" ? "circle" : "rectangle";
      aroll = {
        shape,
        region: { x: bb.x, y: bb.y, width: bb.width, height: bb.height },
        hasBorder: !!seg.aroll.hasBorder,
        borderColor: seg.aroll.borderColor ?? null,
        borderWidth: seg.aroll.borderWidth,
      };
      if (shape === "circle") {
        aroll.center = {
          x: Math.round(bb.x + bb.width / 2),
          y: Math.round(bb.y + bb.height / 2),
        };
        aroll.radius = Math.round(Math.min(bb.width, bb.height) / 2);
      }
    }

    // ── B-roll ──
    let broll: LayoutState["broll"] = null;
    if (seg.broll?.boundingBox) {
      const bb = seg.broll.boundingBox;
      broll = {
        region: { x: bb.x, y: bb.y, width: bb.width, height: bb.height },
        isBackground:
          bb.x <= 10 &&
          bb.y <= 10 &&
          bb.width >= canvas.width - 20 &&
          bb.height >= canvas.height - 40,
      };
    }

    // ── Header / black regions ──
    const headerRegions = (seg.blackRegions ?? []).map((r) => ({
      region: { ...r.boundingBox },
      purpose: r.purpose,
    }));

    // ── Texts (classified: editor overlay vs B-roll content) ──
    const texts: LayoutMapText[] = (seg.texts ?? []).map((t) => ({
      text: t.text,
      region: { ...t.boundingBox },
      fontSize: t.estimatedFontSize,
      color: t.color,
      backgroundColor: t.backgroundColor,
      fontWeight: t.fontWeight,
      isHeadline: t.isHeadline,
      isOverlay: classifyOverlayText({
        box: t.boundingBox,
        isHeadline: t.isHeadline,
        brollIsBackground: broll?.isBackground ?? false,
        headerRegions,
        canvas,
      }),
    }));

    return {
      index,
      sourceSegmentId: seg.id,
      refTimeRange: { start: seg.start, end: seg.end },
      aroll,
      broll,
      texts,
      headerRegions,
    };
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceFile,
    canvas,
    aspectRatio: classifyAspect(canvas.width, canvas.height),
    refDuration,
    states,
  };
}

// ════════════════════════════════════════════════════════════
// SAVE / LOAD (library persistence)
// ════════════════════════════════════════════════════════════

export function saveLayoutMap(map: LayoutMap, filePath: string): void {
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2), "utf-8");
}

export function loadLayoutMap(filePath: string): LayoutMap {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as LayoutMap;
}

// ════════════════════════════════════════════════════════════
// PIP KEYFRAME EXTRACTION
// ════════════════════════════════════════════════════════════

/**
 * Map an edit time to the reference timeline proportionally.
 *
 * The edit (user's content) and the reference (style source) have their own
 * durations. We assume the choreography is meant to play out over the whole
 * video, so we map proportionally: edit 30% → reference 30%.
 */
function editTimeToRefTime(
  tEdit: number,
  editDuration: number,
  refDuration: number
): number {
  if (editDuration <= 0) return tEdit;
  return (tEdit / editDuration) * refDuration;
}

function refTimeToEditTime(
  tRef: number,
  editDuration: number,
  refDuration: number
): number {
  if (refDuration <= 0) return tRef;
  return (tRef / refDuration) * editDuration;
}

/**
 * Compute A-roll PIP position keyframes for an edit range, by replaying the
 * reference's circle trajectory (across all reference states that overlap the
 * range's proportionally-mapped reference window) onto the edit timeline.
 *
 * Returns keyframes in EDIT time. The renderer interpolates position linearly
 * between them. Layout-TYPE changes are NOT encoded here — only position
 * motion of the same circle, which is glitch-free.
 *
 * Size: the renderer keeps ONE crop size per range (animating circle size in
 * single-pass FFmpeg is unreliable), so we only return x/y. The size used is
 * decided by the caller (typically the dominant/representative state).
 *
 * Returns [] when fewer than 2 distinct positions exist (no animation needed).
 */
export function getArollKeyframes(input: {
  map: LayoutMap;
  /** Edit range start/end (seconds) */
  editStart: number;
  editEnd: number;
  /** Total edit duration (seconds) */
  editDuration: number;
  /** Only animate when the range's layout type is circle */
  shape: "rectangle" | "circle";
  /** Minimum position delta (px) to treat two states as distinct */
  minDelta?: number;
}): ArollKeyframe[] {
  const { map, editStart, editEnd, editDuration, shape } = input;
  const minDelta = input.minDelta ?? 8;

  if (shape !== "circle") return [];
  if (map.states.length === 0) return [];

  // Map the edit range into reference time
  const refStart = editTimeToRefTime(editStart, editDuration, map.refDuration);
  const refEnd = editTimeToRefTime(editEnd, editDuration, map.refDuration);

  // Find all CIRCLE reference states overlapping [refStart, refEnd]
  const overlapping = map.states.filter((s) => {
    if (!s.aroll || s.aroll.shape !== "circle") return false;
    return s.refTimeRange.end > refStart && s.refTimeRange.start < refEnd;
  });

  if (overlapping.length === 0) return [];

  // Sort overlapping states by time
  overlapping.sort((a, b) => a.refTimeRange.start - b.refTimeRange.start);

  // ── HOLD-then-MOVE model ──
  //
  // The reference holds each state's position for the state's full duration,
  // then transitions to the next state's position at the boundary. We mirror
  // that: hold each position, with a short linear transition at each boundary
  // (so it's smooth, not a jarring jump). This matches the reference at every
  // mid-state moment — which is exactly where structural verification samples.
  //
  // Transition duration (seconds) — short enough to feel like a snap-slide,
  // long enough to avoid a hard cut.
  const T = 0.4;

  const keyframes: ArollKeyframe[] = [];
  const pos = (s: (typeof overlapping)[number]) => ({
    x: s.aroll!.region.x,
    y: s.aroll!.region.y,
  });

  // Start: position of the state active at the range start
  keyframes.push({ t: editStart, ...pos(overlapping[0]) });

  // For each boundary between consecutive overlapping states, hold the
  // previous position until just before the boundary, then move to the next.
  for (let i = 0; i < overlapping.length - 1; i++) {
    const prev = overlapping[i];
    const next = overlapping[i + 1];
    // Boundary in reference time ≈ where prev ends / next starts
    const boundaryRef = (prev.refTimeRange.end + next.refTimeRange.start) / 2;
    const tb = refTimeToEditTime(boundaryRef, editDuration, map.refDuration);

    // Clamp the transition window inside the range
    const holdEnd = Math.max(editStart, tb - T / 2);
    const moveEnd = Math.min(editEnd, tb + T / 2);
    if (holdEnd > editStart) keyframes.push({ t: holdEnd, ...pos(prev) });
    keyframes.push({ t: moveEnd, ...pos(next) });
  }

  // End: hold the last position to the range end
  keyframes.push({ t: editEnd, ...pos(overlapping[overlapping.length - 1]) });

  // Enforce strictly increasing time and collapse exact duplicates
  const cleaned: ArollKeyframe[] = [];
  for (const kf of keyframes) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && kf.t <= prev.t) {
      // Skip non-increasing time (keep the later position by overwriting)
      cleaned[cleaned.length - 1] = { ...kf, t: prev.t };
      continue;
    }
    cleaned.push(kf);
  }

  // Need at least 2 keyframes with at least one real position change
  const hasMotion = cleaned.some(
    (k) =>
      Math.abs(k.x - cleaned[0].x) >= minDelta ||
      Math.abs(k.y - cleaned[0].y) >= minDelta
  );
  if (cleaned.length < 2 || !hasMotion) return [];

  return cleaned;
}

/**
 * Build an FFmpeg overlay coordinate expression (piecewise-linear) from
 * keyframes for one axis ("x" or "y").
 *
 * Produces a nested if() that linearly interpolates between consecutive
 * keyframes and clamps to the endpoints outside the range. The variable `t`
 * is FFmpeg's frame timestamp in seconds.
 *
 * Example (2 keyframes): if(lt(t,10),442,if(lt(t,18),442+(579-442)*(t-10)/8,579))
 *
 * `offset` is added to every position value (used for the border which sits
 * a few px up-left of the A-roll).
 */
export function buildOverlayExpr(
  keyframes: ArollKeyframe[],
  axis: "x" | "y",
  offset = 0
): string {
  const pts = keyframes.map((k) => ({ t: k.t, v: (axis === "x" ? k.x : k.y) + offset }));
  if (pts.length === 0) return "0";
  if (pts.length === 1) return `${pts[0].v}`;

  // Build from the last segment backward into nested ifs
  // Outside-left clamp: before first keyframe → first value
  // Each segment [i, i+1]: linear interp
  // Outside-right clamp: after last keyframe → last value
  let expr = `${pts[pts.length - 1].v}`; // value at/after last keyframe
  for (let i = pts.length - 2; i >= 0; i--) {
    const t0 = pts[i].t;
    const t1 = pts[i + 1].t;
    const v0 = pts[i].v;
    const v1 = pts[i + 1].v;
    const dt = t1 - t0;
    let segExpr: string;
    if (dt <= 1e-6) {
      segExpr = `${v0}`;
    } else {
      // v0 + (v1-v0)*(t-t0)/dt
      const slope = (v1 - v0) / dt;
      // Round constants to 2 decimals to keep the expression compact
      const s = slope.toFixed(4);
      segExpr = `(${v0}+(${s})*(t-${t0.toFixed(4)}))`;
    }
    expr = `if(lt(t,${t1.toFixed(4)}),${segExpr},${expr})`;
  }
  // Clamp before the first keyframe to the first value
  expr = `if(lt(t,${pts[0].t.toFixed(4)}),${pts[0].v},${expr})`;
  return expr;
}
