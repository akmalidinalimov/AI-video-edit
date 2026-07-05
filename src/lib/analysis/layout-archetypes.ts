/**
 * layout-archetypes.ts — Stage 10: the self-learning archetype library ("the professor").
 *
 * The Layout Analyzer measures a reference's layout from the pixels. This module gives that
 * measurement MEMORY: it matches the measured layout against a library of known archetypes
 * (split A-roll-bottom, circle-PIP, fullscreen, …), returns a match score, and FLAGS NOVEL
 * layouts (best score < noveltyThreshold) for human confirmation — the user's chosen autonomy
 * policy: "human-confirm novel patterns; auto on known archetypes."
 *
 * It also CALIBRATES: recordConfirmation() appends the confirmed layout as an exemplar and
 * re-centers the archetype's numeric ranges around the accumulated exemplars, so the matcher's
 * thresholds self-tune as more references are seen. proposeNovelArchetype() drafts a new
 * archetype entry from an unmatched layout for a human to name/approve.
 *
 * The library lives in .knowledge/layout-archetypes.json (same place as other learned knowledge).
 * All file I/O is best-effort and guarded — matching never throws on a missing/corrupt library.
 */
import fs from "fs";
import path from "path";
import type { LayoutAnalysis } from "./layout-analyzer";

const LIB_PATH = path.join(process.cwd(), ".knowledge", "layout-archetypes.json");

export interface ArchetypeSignature {
  type: string;
  arollSide?: "top" | "bottom";
  shape?: string;
  dividerRange?: [number, number] | null;
  brollAspectRange?: [number, number] | null;
  /** v2 (UNIVERSAL-1): unified-decode signatures for N-region archetypes. */
  layoutClass?: string;                      // multi_region_stack | pip_over_fullscreen | ...
  bandCountRange?: [number, number];         // expected number of decoded regions
  arollBandPosition?: "top" | "middle" | "bottom";
  pipWidthRange?: [number, number];          // A-roll rect.w (fraction) for PIP archetypes
  requiresPersistentPip?: boolean;           // persistent non-full-width aroll region
}

/** Minimal region shape the matcher needs (subset of reference-decode's DecodedRegion). */
export interface RegionForMatch {
  role: string;
  rect: { x: number; y: number; w: number; h: number };
  persistent: boolean;
}

/**
 * What the matcher can score: the legacy CV layout, and/or the unified-decode view
 * ({layoutClass, regions}). Both work; N-region archetypes need the unified fields.
 */
export type MatchableLayout = Partial<LayoutAnalysis["layout"]> & {
  layoutClass?: string;
  regions?: RegionForMatch[];
};

const MULTI_OR_PIP_CLASSES = new Set(["multi_region_stack", "pip_over_fullscreen", "circle_pip", "pip"]);
export interface Archetype {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  /** False when the deterministic CV core can't emit this type (e.g. circle_pip — no HoughCircles). */
  detectedByCoreCV?: boolean;
  signature: ArchetypeSignature;
  confirmedCount: number;
  exemplars: Array<{ dividerFraction?: number; brollAspect?: number; source?: string }>;
}
export interface ArchetypeLibrary {
  version: number;
  note?: string;
  noveltyThreshold: number;
  archetypes: Archetype[];
}
export interface ArchetypeMatch {
  id: string;
  name: string;
  matchScore: number;
  novel: boolean;
  /** Per-archetype scores, best-first, for transparency. */
  ranked: Array<{ id: string; score: number }>;
}

export function loadLibrary(): ArchetypeLibrary | null {
  try {
    return JSON.parse(fs.readFileSync(LIB_PATH, "utf8")) as ArchetypeLibrary;
  } catch {
    return null;
  }
}

function saveLibrary(lib: ArchetypeLibrary): boolean {
  try {
    fs.writeFileSync(LIB_PATH, JSON.stringify(lib, null, 2));
    return true;
  } catch (e) {
    console.error("[layout-archetypes] save failed:", (e as Error).message);
    return false;
  }
}

/** Distance of a value to a [lo,hi] range: 0 inside, growing outside, normalized by range width. */
function rangeDist(v: number, range: [number, number]): number {
  const [lo, hi] = range;
  if (v >= lo && v <= hi) return 0;
  const w = Math.max(1e-3, hi - lo);
  return Math.min(1, (v < lo ? lo - v : v - hi) / w);
}

/** Score a measured layout against one archetype signature → 0..1 (1 = perfect). */
export function scoreAgainst(layout: MatchableLayout, a: Archetype): number {
  const sig = a.signature;

  // ── v2 N-REGION archetypes (signature.layoutClass set): scored ONLY on the unified
  // view. A plain split (or any input without a matching layoutClass) NEVER matches. ──
  if (sig.layoutClass) {
    if (!layout.layoutClass || layout.layoutClass !== sig.layoutClass) return 0;
    let dist = 0, weight = 0.5;                       // class equality carries half the weight
    const regions = layout.regions ?? [];
    const aroll = regions.find((r) => r.role === "aroll");
    if (sig.bandCountRange) { dist += rangeDist(regions.length, sig.bandCountRange) * 0.2; weight += 0.2; }
    if (sig.arollBandPosition) {
      const cy = aroll ? aroll.rect.y + aroll.rect.h / 2 : NaN;
      const pos = !Number.isFinite(cy) ? "unknown" : cy < 0.45 ? "top" : cy > 0.55 ? "bottom" : "middle";
      dist += (pos === sig.arollBandPosition ? 0 : 1) * 0.15; weight += 0.15;
    }
    if (sig.pipWidthRange) {
      dist += (aroll ? rangeDist(aroll.rect.w, sig.pipWidthRange) : 1) * 0.15; weight += 0.15;
    }
    if (sig.requiresPersistentPip) {
      const okPip = !!aroll && aroll.persistent && aroll.rect.w < 0.96;
      dist += (okPip ? 0 : 1) * 0.15; weight += 0.15;
    }
    return Math.max(0, 1 - dist / weight);
  }

  // ── legacy 2-region archetypes: an N-region/PIP unified input never matches them ──
  if (layout.layoutClass && MULTI_OR_PIP_CLASSES.has(layout.layoutClass)) return 0;

  let dist = 0;
  let weight = 0;
  // categorical: layout type (heaviest — a split is never a circle_pip)
  dist += (layout.type === sig.type ? 0 : 1) * 0.45; weight += 0.45;
  // categorical: A-roll side (only when the archetype constrains it)
  if (sig.arollSide) { dist += (layout.arollSide === sig.arollSide ? 0 : 1) * 0.25; weight += 0.25; }
  // categorical: shape
  if (sig.shape) { dist += (layout.shape === sig.shape ? 0 : 1) * 0.1; weight += 0.1; }
  // numeric: divider fraction (only when both the archetype constrains it AND we measured one)
  if (sig.dividerRange && layout.dividerFraction != null) { dist += rangeDist(layout.dividerFraction, sig.dividerRange) * 0.1; weight += 0.1; }
  // numeric: B-roll aspect
  if (sig.brollAspectRange && layout.brollAspect != null) { dist += rangeDist(layout.brollAspect, sig.brollAspectRange) * 0.1; weight += 0.1; }
  return Math.max(0, 1 - dist / (weight || 1));
}

/** Match a measured layout to the library. Novel if the best score < noveltyThreshold.
 *  Accepts the legacy CV layout AND/OR the unified-decode view ({layoutClass, regions}). */
export function matchArchetype(layout: MatchableLayout, lib?: ArchetypeLibrary | null): ArchetypeMatch | null {
  const L = lib ?? loadLibrary();
  if (!L || !L.archetypes.length) return null;
  const ranked = L.archetypes
    .map((a) => ({ id: a.id, score: Math.round(scoreAgainst(layout, a) * 1000) / 1000 }))
    .sort((x, y) => y.score - x.score);
  const best = ranked[0];
  const arch = L.archetypes.find((a) => a.id === best.id)!;
  return {
    id: best.id,
    name: arch.name,
    matchScore: best.score,
    novel: best.score < (L.noveltyThreshold ?? 0.6),
    ranked,
  };
}

/** Re-center an archetype's numeric ranges around its accumulated exemplars (calibration). */
export function recenter(a: Archetype): void {
  const divs = a.exemplars.map((e) => e.dividerFraction).filter((v): v is number => typeof v === "number");
  const ars = a.exemplars.map((e) => e.brollAspect).filter((v): v is number => typeof v === "number");
  const pad = (vals: number[], minPad: number): [number, number] => {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const p = Math.max(minPad, (hi - lo) * 0.5);
    return [Math.round((lo - p) * 1000) / 1000, Math.round((hi + p) * 1000) / 1000];
  };
  if (divs.length >= 2 && a.signature.dividerRange) a.signature.dividerRange = pad(divs, 0.03);
  if (ars.length >= 2 && a.signature.brollAspectRange) a.signature.brollAspectRange = pad(ars, 0.05);
}

/**
 * Record a CONFIRMED analysis as an exemplar of an archetype and re-calibrate its ranges.
 * Call after a human (or a high-confidence auto-match) confirms the layout belongs to `id`.
 */
export function recordConfirmation(id: string, layout: LayoutAnalysis["layout"], source?: string): boolean {
  const lib = loadLibrary();
  if (!lib) return false;
  const a = lib.archetypes.find((x) => x.id === id);
  if (!a) return false;
  // Dedup by source so re-processing the SAME reference doesn't bloat the library / skew calibration.
  if (source && a.exemplars.some((e) => e.source === source)) return false;
  a.exemplars.push({ dividerFraction: layout.dividerFraction ?? undefined, brollAspect: layout.brollAspect, source });
  a.confirmedCount = (a.confirmedCount ?? 0) + 1;
  recenter(a);
  return saveLibrary(lib);
}

/** Draft a new archetype from an unmatched (novel) layout, for a human to name/approve. */
export function proposeNovelArchetype(layout: LayoutAnalysis["layout"], source?: string): Archetype {
  const side = layout.arollSide;
  const div = layout.dividerFraction;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    id: `novel_${layout.type}_${side}_${Date.now().toString(36)}`,
    name: `(proposed) ${layout.type} — A-roll ${side}`,
    description: `Auto-proposed from an unmatched reference. Divider ${div ?? "n/a"}, B-roll aspect ${layout.brollAspect}. Needs human naming + approval.`,
    whenToUse: "TBD — confirm before relying on this archetype.",
    signature: {
      type: layout.type,
      arollSide: side,
      shape: layout.shape,
      dividerRange: div != null ? [r3(div - 0.05), r3(div + 0.05)] : null,
      brollAspectRange: [r3(layout.brollAspect - 0.1), r3(layout.brollAspect + 0.1)],
    },
    confirmedCount: 0,
    exemplars: source ? [{ dividerFraction: div ?? undefined, brollAspect: layout.brollAspect, source }] : [],
  };
}

/** Append a proposed archetype to the library (after human approval). */
export function addArchetype(a: Archetype): boolean {
  const lib = loadLibrary();
  if (!lib) return false;
  if (lib.archetypes.some((x) => x.id === a.id)) return false;
  lib.archetypes.push(a);
  return saveLibrary(lib);
}
