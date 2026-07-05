/**
 * scene-segmenter.ts — [1] SCENE SEGMENTATION (scene-KB spec §3.1).
 *
 * A reference is a SEQUENCE of timed scene-components. This module cuts the decode into
 * maximal spans of STABLE layout structure (SceneWindow[]), driven by the VLM
 * structureTimeline when the band structure changes over time (rare — layout-regions.ts
 * only emits it for sustained structural changes). Content-class switches inside a
 * persistent structure do NOT split a scene — they remain contentTimeline attributes.
 *
 * Edge rules: min scene MIN_SCENE_SEC (absorb shorter into the longer neighbor);
 * windows contiguous over [0, duration]. Pure function — unit-testable, no I/O.
 */
import type { ReferenceDecode, DecodedRegion } from "./reference-decode";
import { regionsFromBands } from "./reference-decode";
import type { StructureWindow, RegionBand, RegionLayout } from "./layout-regions";

export const MIN_SCENE_SEC = 0.8;

export interface SceneWindow {
  t0: number;
  t1: number;
  /** UnifiedLayoutClass vocabulary (two_region_split | single_fullscreen | multi_region_stack | pip_over_fullscreen | ...) */
  layoutClass: string;
  regions: DecodedRegion[];
}

const isFullFrameBand = (b: RegionBand) =>
  b.yStart <= 0.02 && b.yEnd >= 0.98 && b.xStart <= 0.02 && b.xEnd >= 0.98;

const isOverlayBand = (b: RegionBand, bands: RegionBand[]) =>
  bands.some((other) => other !== b &&
    other.yStart <= b.yStart + 0.02 && other.yEnd >= b.yEnd - 0.02 &&
    (other.yEnd - other.yStart) > (b.yEnd - b.yStart) + 0.02);

/** Canonical layoutClass of ONE structure window, from its band geometry (same rules as
 *  reference-decode's unifier: full-frame + floating persistent panel ⇒ PIP; band count else). */
export function classifyWindowBands(bands: RegionBand[]): string {
  const overlay = bands.find((b) => isOverlayBand(b, bands) && b.persistent);
  if (overlay && bands.some(isFullFrameBand)) return "pip_over_fullscreen";
  const stacked = bands.filter((b) => !isOverlayBand(b, bands));
  if (stacked.length <= 1) return bands.length > 1 ? "pip_over_fullscreen" : "single_fullscreen";
  if (stacked.length === 2) return "two_region_split";
  return "multi_region_stack";
}

function windowToScene(w: StructureWindow): Pick<SceneWindow, "layoutClass" | "regions"> {
  const layoutClass = classifyWindowBands(w.bands);
  const rl: RegionLayout = { layoutClass, bands: w.bands, arollBandIndex: -1, summary: "" };
  return { layoutClass, regions: regionsFromBands(rl) };
}

/**
 * Segment a decode into contiguous scene windows over [0, duration].
 * `structureTimeline` comes from the VLM RegionLayout (it is NOT on the decode —
 * callers pass regionLayout?.structureTimeline). Absent/empty ⇒ ONE window carrying
 * the decode's own canonical layoutClass + regions (the common stable-structure case).
 */
export function segmentScenes(
  decode: ReferenceDecode,
  opts?: { structureTimeline?: StructureWindow[] | null }
): SceneWindow[] {
  const dur = decode.meta.duration.value;
  const tl = (opts?.structureTimeline ?? []).filter((w) => w.end > w.start && w.bands.length > 0);
  if (!tl.length) {
    return [{ t0: 0, t1: dur, layoutClass: decode.layout.layoutClass.value, regions: decode.layout.regions.value }];
  }
  const sorted = [...tl].sort((a, b) => a.start - b.start);
  // contiguity: first window starts at 0; each t0 = previous t1; last clamps/extends to dur.
  const wins: SceneWindow[] = sorted.map((w, i) => ({
    t0: i === 0 ? 0 : 0, // placeholder, fixed in the pass below
    t1: Math.min(w.end, dur),
    ...windowToScene(w),
  }));
  wins[0].t0 = 0;
  for (let i = 1; i < wins.length; i++) wins[i].t0 = wins[i - 1].t1;
  wins[wins.length - 1].t1 = dur;
  // drop degenerate windows created by clamping
  let scenes = wins.filter((w) => w.t1 > w.t0);
  // MIN-SCENE ABSORPTION: fold each sub-0.8s window into its LONGER neighbor.
  for (let i = 0; i < scenes.length && scenes.length > 1; ) {
    const len = scenes[i].t1 - scenes[i].t0;
    if (len >= MIN_SCENE_SEC) { i++; continue; }
    const prev = scenes[i - 1], next = scenes[i + 1];
    const intoPrev = !!prev && (!next || (prev.t1 - prev.t0) >= (next.t1 - next.t0));
    if (intoPrev) prev!.t1 = scenes[i].t1;
    else next!.t0 = scenes[i].t0;
    scenes.splice(i, 1);
    if (i > 0) i--;
  }
  return scenes;
}
