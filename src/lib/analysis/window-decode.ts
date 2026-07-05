/**
 * window-decode.ts — a PURE window-scoped view of a canonical ReferenceDecode.
 *
 * The closed loop scores whole videos; per-scene learning (scene-KB spec §4) requires
 * scoring a scene's TIME WINDOW. This module produces a ReferenceDecode restricted to
 * [t0, t1): pacing shotBoundaries filtered + rebased, shotCount/avgShotSec recomputed,
 * per-region contentTimeline/shots cropped, non-persistent regions inactive in the
 * window dropped. compareDecodedStyle needs NO change — the windowed metric is
 * compare(windowDecode(ref, w), windowDecode(out, w)).
 */
import type { ReferenceDecode, DecodedRegion } from "./reference-decode";
import { compareDecodedStyle, type StyleComparison } from "./style-compare";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** True when the region shows content during [t0, t1): persistent, no timeline, or overlap. */
function regionActiveInWindow(r: DecodedRegion, t0: number, t1: number): boolean {
  if (r.persistent) return true;
  if (!r.contentTimeline?.length) return true;
  return r.contentTimeline.some((w) => w.end > t0 && w.start < t1);
}

/** Crop + rebase a region's contentTimeline and shots to window-relative time. */
function cropRegion(r: DecodedRegion, t0: number, t1: number): DecodedRegion {
  const out: DecodedRegion = { ...r, rect: { ...r.rect } };
  if (r.contentTimeline?.length) {
    const cropped = r.contentTimeline
      .filter((w) => w.end > t0 && w.start < t1)
      .map((w) => ({ start: r3(Math.max(w.start, t0) - t0), end: r3(Math.min(w.end, t1) - t0), content: w.content }));
    if (cropped.length) out.contentTimeline = cropped; else delete out.contentTimeline;
  }
  if (r.shots) {
    const boundaries = r.shots.boundaries.filter((t) => t > t0 && t < t1).map((t) => r3(t - t0));
    out.shots = { count: boundaries.length + 1, boundaries };
  }
  return out;
}

/** cutFrequency label from avgShotSec — same coarse classes the decode vocabulary uses. */
function cutFrequencyOf(avgShotSec: number): string {
  return avgShotSec < 1.5 ? "fast" : avgShotSec < 3 ? "medium" : "slow";
}

/**
 * PURE window view of a decode over [t0, t1). Does NOT mutate the input.
 * Global style fields (layout type/side, transitions, motion, captions, style) are kept
 * as-is: they are whole-video measurements that hold for any window of a stable layout;
 * only the TIME-INDEXED fields (pacing, contentTimeline, shots, duration) are windowed.
 */
export function windowDecode(decode: ReferenceDecode, t0: number, t1: number): ReferenceDecode {
  const dur = r3(Math.max(0.001, t1 - t0));
  const boundaries = decode.pacing.shotBoundaries.value
    .filter((t) => t > t0 && t < t1)
    .map((t) => r3(t - t0));
  const shotCount = boundaries.length + 1;
  const avgShotSec = r3(dur / shotCount);
  const regions = decode.layout.regions.value
    .filter((r) => regionActiveInWindow(r, t0, t1))
    .map((r) => cropRegion(r, t0, t1));
  return {
    ...decode,
    meta: { ...decode.meta, duration: { ...decode.meta.duration, value: dur } },
    layout: { ...decode.layout, regions: { ...decode.layout.regions, value: regions } },
    pacing: {
      shotCount: { ...decode.pacing.shotCount, value: shotCount },
      avgShotSec: { ...decode.pacing.avgShotSec, value: avgShotSec },
      cutFrequency: { ...decode.pacing.cutFrequency, value: cutFrequencyOf(avgShotSec) },
      shotBoundaries: { ...decode.pacing.shotBoundaries, value: boundaries },
    },
  };
}

/** The windowed closed-loop metric: compareDecodedStyle over two window views. */
export function compareWindowedStyle(
  ref: ReferenceDecode, out: ReferenceDecode, t0: number, t1: number
): StyleComparison {
  return compareDecodedStyle(windowDecode(ref, t0, t1), windowDecode(out, t0, t1));
}
