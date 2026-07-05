/**
 * reference-decode.ts — THE CANONICAL REFERENCE DECODE (single source of truth).
 *
 * The reference engine used to be a stack of overlapping passes (Gemini blueprint + CV
 * corrections + face bands + layout analyzer) resolved by last-writer-wins. This module
 * replaces that with ONE authoritative decode of the reference's editing STYLE (not its
 * content): layout, pacing, transitions, motion, captions, overlays, look.
 *
 * Design rules (the reason this exists):
 *   1. ONE object, every STYLE component a field.
 *   2. Every field is a DecodedField<T> = { value, source, confidence, method } — so nothing
 *      "wins" by write order; each field has a single declared OWNER and a falsifiable
 *      confidence. This is what makes a 99% target measurable (see decode-accuracy.ts).
 *   3. Deterministic-FIRST: CV (the Layout Analyzer) owns everything geometric (regions,
 *      side, divider, shots, transitions, motion, caption POSITION, overlays). The VLM
 *      (Gemini semantics) owns ONLY what is genuinely semantic (caption TEXT/STYLE/animation,
 *      per-shot content, style keywords). No component is owned by two extractors.
 *
 * This is the object the accuracy gate scores and the Composer should ultimately consume.
 */
import type { LayoutAnalysis, LayoutSemantics } from "./layout-analyzer";
import { analyzeLayout } from "./layout-analyzer";
import { analyzeLayoutSemantics } from "./layout-semantics";
import { analyzeLayoutRegions, type RegionLayout, type RegionBand } from "./layout-regions";
import { matchArchetype, type ArchetypeMatch } from "./layout-archetypes";
import path from "path";

export type DecodeSource = "cv" | "ffmpeg" | "vlm" | "hybrid" | "derived";

/** A single decoded value with its authoritative source and a 0..1 confidence. */
export interface DecodedField<T> {
  value: T;
  source: DecodeSource;
  confidence: number;
  /** Which concrete extractor produced it (for provenance + debugging). */
  method: string;
  /** Cross-extractor disagreement flag (e.g. CV type vs VLM layoutClass) — human-confirm. */
  uncertain?: boolean;
}

export interface Region { x: number; y: number; width: number; height: number }

/** One canonical decoded REGION (v2) — fractions of the source frame, N-region capable. */
export interface DecodedRegion {
  id: string;
  role: string;                                            // header_title | broll | screen_recording | aroll | ...
  rect: { x: number; y: number; w: number; h: number };    // FRACTIONS of source frame
  shape: "rectangle" | "rounded_rect" | "circle" | string;
  cornerRadiusFrac?: number;                               // rounded_rect default ~0.045
  zIndex: number;
  persistent: boolean;
  contentTimeline?: Array<{ start: number; end: number; content: string }>;
  /** Per-region shot rhythm (region_shots.py) — content regions only. */
  shots?: { count: number; boundaries: number[] };
}

/** Canonical layout classes emitted by the unified decode. */
export type UnifiedLayoutClass =
  | "two_region_split" | "single_fullscreen" | "broll_only"
  | "multi_region_stack" | "pip_over_fullscreen" | string;

export interface ReferenceDecode {
  schemaVersion: 2;
  sourceFile: string;

  meta: {
    duration: DecodedField<number>;
    fps: DecodedField<number>;
    dims: DecodedField<[number, number]>;
    aspectRatio: DecodedField<string>;
  };

  /** WHERE things sit — the spatial skeleton. CV-owned. */
  layout: {
    type: DecodedField<string>;                 // split | fullscreen | broll_only
    arollSide: DecodedField<"top" | "bottom">;
    dividerFraction: DecodedField<number | null>;
    arollRegion: DecodedField<Region>;
    brollRegion: DecodedField<Region>;
    brollAspect: DecodedField<number>;
    archetype: DecodedField<string | null>;
    /** v2 — canonical class over ALL layout families (not just the 2-region CV vocabulary). */
    layoutClass: DecodedField<UnifiedLayoutClass>;
    /** v2 — ALWAYS populated: N regions for stacks/PIPs, 2 derived regions for a split. */
    regions: DecodedField<DecodedRegion[]>;
  };

  /** HOW FAST it cuts — the rhythm. CV-owned. */
  pacing: {
    shotCount: DecodedField<number>;
    avgShotSec: DecodedField<number>;
    cutFrequency: DecodedField<string>;
    shotBoundaries: DecodedField<number[]>;      // seconds
  };

  /** HOW shots join. CV-owned. */
  transitions: {
    dominant: DecodedField<string>;              // cut | crossfade | ...
    distribution: DecodedField<Record<string, number>>;
  };

  /** HOW the frame moves within a shot. CV-owned. */
  motion: {
    dominant: DecodedField<string>;              // static | push_in | pan | ...
    distribution: DecodedField<Record<string, number>>;
  };

  /** Burned-in captions — POSITION is CV, TEXT/STYLE/ANIMATION are VLM. */
  captions: {
    present: DecodedField<boolean>;
    bandFraction: DecodedField<[number, number] | null>;  // cv
    position: DecodedField<string | null>;                // vlm
    style: DecodedField<string | null>;                   // vlm
    animation: DecodedField<string | null>;               // vlm
  };

  /** PIP-on-PIP / graphic insets. CV finds regions; VLM names them. */
  overlays: DecodedField<Array<{ kind: string; description: string }>>;

  /** The look, in words. VLM-owned (pure semantics). */
  style: {
    keywords: DecodedField<string[]>;
    summary: DecodedField<string>;
  };

  /** Rolled-up mean field confidence (0..1). NOT the accuracy score — see decode-accuracy.ts. */
  decodeConfidence: number;
}

const F = <T>(value: T, source: DecodeSource, confidence: number, method: string): DecodedField<T> =>
  ({ value, source, confidence, method });

/** Aspect-ratio label from dims. */
function aspectLabel(w: number, h: number): string {
  const r = w / h;
  const cands: Array<[string, number]> = [["9:16", 9 / 16], ["1:1", 1], ["4:5", 4 / 5], ["16:9", 16 / 9]];
  return cands.reduce((best, c) => (Math.abs(Math.log(r / c[1])) < Math.abs(Math.log(r / best[1])) ? c : best))[0];
}

// ────────────────────────────────────────────────────────────────────────────
// v2 UNIFICATION HELPERS — one canonical layoutClass + regions from BOTH paths
// (CV 2-region analyzer + VLM multi-region bands).
// ────────────────────────────────────────────────────────────────────────────

const PIP_LIKE = new Set(["circle_pip", "pip_over_fullscreen", "pip"]);
const MULTI_OR_PIP = (cls: string | undefined | null) =>
  !!cls && (cls === "multi_region_stack" || PIP_LIKE.has(cls));

/** Canvas the CV analyzer reports regions in (scripts/python/layout_analyzer.py CANVAS_W/H). */
const CV_CANVAS_W = 1080, CV_CANVAS_H = 1920;

const isFullFrameBand = (b: RegionBand) =>
  b.yStart <= 0.02 && b.yEnd >= 0.98 && b.xStart <= 0.02 && b.xEnd >= 0.98;

/** A floating overlay band = fully y-covered by a strictly larger band (same rule as coerceBands). */
function isOverlayBand(b: RegionBand, bands: RegionBand[]): boolean {
  return bands.some((other) => other !== b &&
    other.yStart <= b.yStart + 0.02 && other.yEnd >= b.yEnd - 0.02 &&
    (other.yEnd - other.yStart) > (b.yEnd - b.yStart) + 0.02);
}

/** True when the VLM structure is a PIP-over-fullscreen: a full-frame band + a persistent
 * non-full-width aroll/pip band coexist. This is the ONE canonical PIP class (circle_pip /
 * "pip" reports are normalized into it). */
function isPipOverFullscreen(rl: RegionLayout): boolean {
  const full = rl.bands.some(isFullFrameBand);
  const pip = rl.bands.some((b) =>
    (b.role === "aroll" || b.role === "pip_inset") && b.persistent && (b.xEnd - b.xStart) < 0.96);
  return full && pip;
}

export interface UnifiedClassResult {
  layoutClass: UnifiedLayoutClass;
  source: DecodeSource;         // "vlm" when the VLM class won, else "derived" (from CV type)
  /** CV type and VLM layoutClass point at DIFFERENT families (the poisoning case). */
  disagreement: boolean;
}

/** Map the CV 2-region type vocabulary into the canonical class vocabulary. */
export function cvTypeToClass(cvType: string): UnifiedLayoutClass {
  return cvType === "split" ? "two_region_split"
    : cvType === "fullscreen" ? "single_fullscreen"
    : cvType === "broll_only" ? "broll_only"
    : cvType;
}

/**
 * ONE canonical layoutClass from CV type + (optional) VLM RegionLayout.
 * Rules: VLM wins for multi_region_stack / pip-like structures (the CV cannot see them);
 * CV wins for split/fullscreen/broll_only when the VLM agrees or is absent.
 * CROSS-CHECK: CV split vs VLM multi/pip (or vice versa) ⇒ disagreement=true.
 */
export function unifyLayoutClass(cvType: string, regionLayout?: RegionLayout | null): UnifiedClassResult {
  const cvClass = cvTypeToClass(cvType);
  if (!regionLayout) return { layoutClass: cvClass, source: "derived", disagreement: false };
  const vlm = regionLayout.layoutClass;
  const disagreement =
    (cvType === "split" && MULTI_OR_PIP(vlm)) ||
    (vlm === "two_region_split" && cvType !== "split");
  if (MULTI_OR_PIP(vlm)) {
    const cls: UnifiedLayoutClass = isPipOverFullscreen(regionLayout) ? "pip_over_fullscreen" : "multi_region_stack";
    return { layoutClass: cls, source: "vlm", disagreement };
  }
  return { layoutClass: cvClass, source: "derived", disagreement };
}

/** AGREEMENT gate for archetype auto-learn: CV and VLM independently name the SAME family. */
export function classesAgree(cvType: string, regionLayout?: RegionLayout | null): boolean {
  if (!regionLayout) return false;
  const vlm = regionLayout.layoutClass;
  if (cvType === "split") return vlm === "two_region_split";
  if (cvType === "fullscreen" || cvType === "broll_only")
    return vlm === "single_fullscreen" || vlm === "broll_only";
  return false;
}

/**
 * SEAM-SNAP: refine the VLM's ±0.1 band boundaries against the CV's persistent
 * horizontal-edge profile (edgeProfile, GRID_H rows, normalized 0..1). Each interior
 * boundary of the STACKED bands snaps to the strongest edgeProfile maximum within
 * ±`win`; left unsnapped when no maximum exceeds 1.5x the profile median in that
 * window. Bands stay contiguous. Overlay (floating PIP) bands are never snapped.
 * Pure function — unit-testable with a synthetic profile.
 */
export function snapBandBoundaries(bands: RegionBand[], edgeProfile: number[], win = 0.06): RegionBand[] {
  if (!edgeProfile?.length || bands.length < 2) return bands;
  const N = edgeProfile.length;
  const yOf = (i: number) => i / (N - 1);
  const out = bands.map((b) => ({ ...b }));
  const stack = out.filter((b) => !isOverlayBand(b, out)).sort((a, b) => a.yStart - b.yStart);
  for (let i = 0; i < stack.length - 1; i++) {
    const boundary = stack[i].yEnd;
    if (boundary <= 0.001 || boundary >= 0.999) continue;   // never snap the 0/1 frame edges
    const lo = Math.max(0, Math.ceil((boundary - win) * (N - 1)));
    const hi = Math.min(N - 1, Math.floor((boundary + win) * (N - 1)));
    if (hi <= lo) continue;
    const slice = edgeProfile.slice(lo, hi + 1);
    const sorted = [...slice].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let bestIdx = -1, bestVal = -Infinity;
    for (let j = lo; j <= hi; j++) {
      const v = edgeProfile[j];
      const isLocalMax = v >= (edgeProfile[j - 1] ?? -Infinity) && v >= (edgeProfile[j + 1] ?? -Infinity);
      if (isLocalMax && v > bestVal) { bestVal = v; bestIdx = j; }
    }
    if (bestIdx < 0 || bestVal <= 1.5 * median) continue;   // no decisive seam → leave unsnapped
    const snapped = Math.round(yOf(bestIdx) * 1000) / 1000;
    // keep the stack monotonic/contiguous after snapping
    if (snapped <= stack[i].yStart + 0.01 || snapped >= stack[i + 1].yEnd - 0.01) continue;
    stack[i].yEnd = snapped;
    stack[i + 1].yStart = snapped;
  }
  return out;
}

/** DecodedRegion[] from a VLM RegionLayout (bands → regions; overlays get zIndex 1 + role aroll). */
export function regionsFromBands(regionLayout: RegionLayout, edgeProfile?: number[]): DecodedRegion[] {
  const bands = edgeProfile ? snapBandBoundaries(regionLayout.bands, edgeProfile) : regionLayout.bands;
  return bands.map((b, i) => {
    const overlay = isOverlayBand(b, bands);
    const role = overlay && b.role === "pip_inset" ? "aroll" : b.role;
    const region: DecodedRegion = {
      id: `${role}_${i}`,
      role,
      rect: {
        x: Math.round(b.xStart * 1000) / 1000,
        y: Math.round(b.yStart * 1000) / 1000,
        w: Math.round((b.xEnd - b.xStart) * 1000) / 1000,
        h: Math.round((b.yEnd - b.yStart) * 1000) / 1000,
      },
      shape: b.shape || "rectangle",
      zIndex: overlay ? 1 : 0,   // the floating PIP sits ABOVE the background band
      persistent: b.persistent,
    };
    if (region.shape === "rounded_rect") region.cornerRadiusFrac = 0.045;
    if (b.contentTimeline?.length) region.contentTimeline = b.contentTimeline.map((w) => ({ ...w }));
    return region;
  });
}

/** DecodedRegion[] DERIVED from the CV 2-region fields (split → 2, fullscreen/broll_only → 1). */
export function regionsFromCvLayout(L: LayoutAnalysis["layout"]): DecodedRegion[] {
  const toFrac = (r: Region) => ({
    x: Math.round((r.x / CV_CANVAS_W) * 1000) / 1000,
    y: Math.round((r.y / CV_CANVAS_H) * 1000) / 1000,
    w: Math.round((r.width / CV_CANVAS_W) * 1000) / 1000,
    h: Math.round((r.height / CV_CANVAS_H) * 1000) / 1000,
  });
  if (L.type === "split") {
    const pair = [
      { role: "broll", rect: toFrac(L.brollRegion), persistent: false },
      { role: "aroll", rect: toFrac(L.arollRegion), persistent: true },
    ].sort((a, b) => a.rect.y - b.rect.y);
    return pair.map((p, i) => ({
      id: `${p.role}_${i}`, role: p.role, rect: p.rect, shape: "rectangle",
      zIndex: 0, persistent: p.persistent,
    }));
  }
  const role = L.type === "broll_only" ? "broll" : "aroll";
  return [{
    id: `${role}_0`, role, rect: { x: 0, y: 0, w: 1, h: 1 }, shape: "rectangle",
    zIndex: 0, persistent: role === "aroll",
  }];
}

/**
 * Build the unified regions view: VLM bands when the VLM decoded a multi-region/PIP
 * structure, else the CV-derived 2-region view. Legacy fields stay CV-owned regardless.
 */
export function buildDecodedRegions(layout: LayoutAnalysis, regionLayout?: RegionLayout | null): DecodedRegion[] {
  if (regionLayout && MULTI_OR_PIP(regionLayout.layoutClass)) {
    return regionsFromBands(regionLayout, layout.edgeProfile);
  }
  return regionsFromCvLayout(layout.layout);
}

/**
 * Assemble the canonical decode from the authoritative extractors.
 * @param layout   deterministic CV decode (analyzeLayout) — the geometry owner.
 * @param opts.semantics  optional Gemini semantics (analyzeLayoutSemantics) — the text/style owner.
 * @param opts.archetype  optional matched archetype (matchArchetype).
 * @param opts.regionLayout  optional VLM multi-region decomposition (analyzeLayoutRegions) —
 *                           the v2 unifier input for layoutClass + regions.
 */
export function buildReferenceDecode(
  sourceFile: string,
  layout: LayoutAnalysis,
  opts?: { semantics?: LayoutSemantics | null; archetype?: ArchetypeMatch | null; regionLayout?: RegionLayout | null }
): ReferenceDecode {
  const L = layout.layout;
  const sem = opts?.semantics ?? null;
  const arch = opts?.archetype ?? null;
  const regionLayout = opts?.regionLayout ?? null;
  const [w, h] = layout.dims;

  // ── layout (CV) — confidence is the analyzer's own measured confidence ──
  const layoutConf = L.confidence;
  const sideConf = L.evidence.sideAgree ? Math.min(0.99, layoutConf + 0.05) : Math.max(0.2, layoutConf - 0.2);

  // ── v2 unification: ONE canonical layoutClass + regions from both decode paths ──
  const unified = unifyLayoutClass(L.type, regionLayout);
  if (unified.disagreement) {
    console.warn(
      `[reference-decode] CROSS-CHECK DISAGREEMENT: CV type "${L.type}" vs VLM layoutClass ` +
      `"${regionLayout?.layoutClass}" — preferring "${unified.layoutClass}" for layoutClass; ` +
      `layout.type flagged uncertain.`
    );
  }
  const typeUncertain = L.typeUncertain || unified.disagreement;
  const regions = buildDecodedRegions(layout, regionLayout);
  const regionsFromVlm = !!regionLayout && MULTI_OR_PIP(regionLayout.layoutClass);

  // ── captions: POSITION band is CV (best-effort); TEXT/STYLE/ANIM are VLM ──
  const cvCap = layout.captions;
  const vlmCap = sem?.captions ?? null;
  const capPresent = vlmCap ? vlmCap.present : cvCap.present; // VLM authoritative on presence (reads text)

  // ── style keywords / summary: VLM only ──
  const kw = sem?.styleKeywords ?? [];

  const meanConf = (fields: DecodedField<unknown>[]) =>
    fields.reduce((s, f) => s + f.confidence, 0) / Math.max(1, fields.length);

  const decode: ReferenceDecode = {
    schemaVersion: 2,
    sourceFile,
    meta: {
      duration: F(layout.duration, "ffmpeg", 0.99, "opencv-frame-count"),
      fps: F(layout.fps, "ffmpeg", 0.99, "opencv-fps"),
      dims: F([w, h], "ffmpeg", 0.99, "opencv-dims"),
      aspectRatio: F(aspectLabel(w, h), "derived", 0.99, "dims-ratio"),
    },
    layout: {
      type: {
        ...F(L.type, "cv", typeUncertain ? Math.min(0.6, L.splitScore + 0.1) : layoutConf, "layout-analyzer:splitScore"),
        ...(typeUncertain ? { uncertain: true } : {}),
      },
      arollSide: F(L.arollSide, "cv", sideConf, "layout-analyzer:face+independent-thirds"),
      dividerFraction: F(L.dividerFraction, "cv", L.evidence.geometryAgree ? Math.min(0.99, layoutConf + 0.1) : layoutConf, "layout-analyzer:seam"),
      arollRegion: F(L.arollRegion, "cv", layoutConf, "layout-analyzer:regions"),
      brollRegion: F(L.brollRegion, "cv", layoutConf, "layout-analyzer:regions"),
      brollAspect: F(L.brollAspect, "cv", layoutConf, "layout-analyzer:regions"),
      archetype: F(arch?.id ?? null, "derived", arch ? arch.matchScore : 0.0, "archetype-match"),
      layoutClass: {
        ...F(
          unified.layoutClass,
          unified.source,
          unified.disagreement ? 0.6 : unified.source === "vlm" ? 0.75 : layoutConf,
          unified.source === "vlm" ? "layout-regions:vlm-bands" : "layout-analyzer:type-derived"
        ),
        ...(unified.disagreement ? { uncertain: true } : {}),
      },
      regions: F(
        regions,
        regionsFromVlm ? (layout.edgeProfile ? "hybrid" : "vlm") : "derived",
        regionsFromVlm ? (layout.edgeProfile ? 0.8 : 0.7) : layoutConf,
        regionsFromVlm
          ? (layout.edgeProfile ? "layout-regions:vlm-bands+cv-seam-snap" : "layout-regions:vlm-bands")
          : "layout-analyzer:2-region-derived"
      ),
    },
    pacing: {
      shotCount: F(layout.rhythm.shots, "cv", 0.8, "layout-analyzer:band-diff"),
      avgShotSec: F(layout.rhythm.avgShotSec, "cv", 0.8, "layout-analyzer:band-diff"),
      cutFrequency: F(layout.rhythm.cutFrequency, "derived", 0.85, "avgShotSec-threshold"),
      shotBoundaries: F(layout.segments.map((s) => s.start).filter((t) => t > 0), "cv", 0.75, "layout-analyzer:band-diff"),
    },
    transitions: {
      dominant: F(layout.transitions.dominant, "cv", 0.7, "layout-analyzer:diff-concentration"),
      distribution: F(layout.transitions.summary, "cv", 0.7, "layout-analyzer:diff-concentration"),
    },
    motion: {
      dominant: F(layout.motion.dominant, "cv", 0.65, "layout-analyzer:optical-flow"),
      distribution: F(layout.motion.summary, "cv", 0.65, "layout-analyzer:optical-flow"),
    },
    captions: {
      present: F(capPresent, vlmCap ? "vlm" : "cv", vlmCap ? 0.9 : (cvCap.present ? cvCap.strength ? Math.min(0.8, cvCap.strength / 3) : 0.5 : 0.6), vlmCap ? "gemini" : "layout-analyzer:edge-band"),
      bandFraction: F(cvCap.bandFrac ?? null, "cv", cvCap.present ? 0.6 : 0.3, "layout-analyzer:edge-band"),
      position: F(vlmCap?.position ?? null, "vlm", vlmCap ? 0.85 : 0.0, "gemini"),
      style: F(vlmCap?.style ?? null, "vlm", vlmCap ? 0.8 : 0.0, "gemini"),
      animation: F(vlmCap?.animation ?? null, "vlm", vlmCap ? 0.75 : 0.0, "gemini"),
    },
    overlays: F(
      (sem?.overlays ?? layout.overlays.map((o) => ({ kind: "inset", description: `region ${JSON.stringify(o.approxRegion)}` }))),
      sem?.overlays ? "vlm" : "cv",
      layout.overlays.length || (sem?.overlays?.length ?? 0) ? 0.6 : 0.9, // high conf when BOTH agree there are none
      sem?.overlays ? "gemini" : "layout-analyzer:corner-contours"
    ),
    style: {
      keywords: F(kw, "vlm", kw.length ? 0.8 : 0.0, "gemini"),
      summary: F(sem?.summary ?? "", "vlm", sem?.summary ? 0.8 : 0.0, "gemini"),
    },
    decodeConfidence: 0,
  };

  // rolled-up mean confidence across the load-bearing STYLE fields
  decode.decodeConfidence = Math.round(
    meanConf([
      decode.layout.type, decode.layout.arollSide, decode.layout.dividerFraction, decode.layout.brollAspect,
      decode.pacing.shotCount, decode.transitions.dominant, decode.motion.dominant,
      decode.captions.present, decode.style.keywords,
    ]) * 1000
  ) / 1000;

  return decode;
}

/**
 * DECODE A REFERENCE (Step 2 entry point). Runs each component's ONE authoritative extractor
 * and assembles the canonical decode:
 *   - CV geometry  → analyzeLayout()          (required; returns null → whole decode null)
 *   - derived      → matchArchetype()
 *   - VLM semantics→ analyzeLayoutSemantics()  (optional; skipped unless withSemantics)
 * Non-blocking on the VLM half — semantic fields fall back to CV/empty with confidence 0.
 */
export async function decodeReference(
  videoPath: string,
  opts?: {
    withSemantics?: boolean;
    /** Pre-computed CV analysis — pass it to kill the double-CV-run (audit G7). */
    layout?: LayoutAnalysis | null;
    /** Pre-computed VLM region decomposition; or set withRegions to run it here. */
    regionLayout?: RegionLayout | null;
    withRegions?: boolean;
  }
): Promise<ReferenceDecode | null> {
  const layout = opts?.layout ?? analyzeLayout(videoPath);
  if (!layout) return null;
  const regionLayout = opts?.regionLayout ?? (opts?.withRegions ? await analyzeLayoutRegions(videoPath) : null);
  const unified = unifyLayoutClass(layout.layout.type, regionLayout);
  const regions = buildDecodedRegions(layout, regionLayout);
  const archetype = matchArchetype({ ...layout.layout, layoutClass: unified.layoutClass, regions });
  let semantics: LayoutSemantics | null = null;
  if (opts?.withSemantics) {
    semantics = await analyzeLayoutSemantics(videoPath, {
      segments: layout.segments,
      arollSide: layout.layout.arollSide,
      dividerFraction: layout.layout.dividerFraction ?? undefined,
    });
  }
  return buildReferenceDecode(path.basename(videoPath), layout, { semantics, archetype, regionLayout });
}

/** Flatten to a compact provenance table (component → value · source · confidence). */
export function decodeProvenance(d: ReferenceDecode): Array<{ field: string; value: string; source: string; confidence: number }> {
  const rows: Array<{ field: string; value: string; source: string; confidence: number }> = [];
  const add = (field: string, f: DecodedField<unknown>) =>
    rows.push({ field, value: JSON.stringify(f.value), source: f.source, confidence: f.confidence });
  add("layout.type", d.layout.type);
  add("layout.layoutClass", d.layout.layoutClass);
  add("layout.arollSide", d.layout.arollSide);
  add("layout.dividerFraction", d.layout.dividerFraction);
  add("layout.brollAspect", d.layout.brollAspect);
  add("layout.archetype", d.layout.archetype);
  add("pacing.shotCount", d.pacing.shotCount);
  add("pacing.cutFrequency", d.pacing.cutFrequency);
  add("transitions.dominant", d.transitions.dominant);
  add("motion.dominant", d.motion.dominant);
  add("captions.present", d.captions.present);
  add("captions.position", d.captions.position);
  add("captions.style", d.captions.style);
  add("style.keywords", d.style.keywords);
  return rows;
}
