/**
 * scene-kb-route.ts — the ONE glue helper the route phases call (spec §3.4).
 * Kept out of analyze-reference.ts so it is unit-testable without running the route.
 */
import type { ReferenceDecode } from "@/lib/analysis/reference-decode";
import type { StructureWindow } from "@/lib/analysis/layout-regions";
import { segmentScenes, type SceneWindow } from "@/lib/analysis/scene-segmenter";
import { windowDecode } from "@/lib/analysis/window-decode";
import type { SceneKB, DecodedScene, SceneMatch } from "./scene-kb";

export interface SceneMatchEntry { scene: DecodedScene; match: SceneMatch }

export function buildSceneMatches(opts: {
  decode: ReferenceDecode;
  structureTimeline?: StructureWindow[] | null;
  referenceHash: string;
  kb: SceneKB;
}): { sceneWindows: SceneWindow[]; sceneMatches: SceneMatchEntry[] } {
  const sceneWindows = segmentScenes(opts.decode, { structureTimeline: opts.structureTimeline ?? null });
  const sceneMatches = sceneWindows.map((w) => {
    const scene: DecodedScene = {
      window: { t0: w.t0, t1: w.t1 },
      layoutClass: w.layoutClass,
      regions: w.regions,
      decode: windowDecode(opts.decode, w.t0, w.t1),
      referenceHash: opts.referenceHash,
    };
    return { scene, match: opts.kb.matchScene(scene) };
  });
  return { sceneWindows, sceneMatches };
}
