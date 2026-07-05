/**
 * scene-kb-route.ts — the ONE glue helper the route phases call (spec §3.4).
 * Kept out of analyze-reference.ts so it is unit-testable without running the route.
 */
import fs from "fs";
import path from "path";
import type { ReferenceDecode } from "@/lib/analysis/reference-decode";
import type { StructureWindow } from "@/lib/analysis/layout-regions";
import { segmentScenes, type SceneWindow } from "@/lib/analysis/scene-segmenter";
import { windowDecode } from "@/lib/analysis/window-decode";
import type { SceneKB, DecodedScene, SceneMatch, FamilyProposal } from "./scene-kb";

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

/**
 * Queue a novel scene for human review (spec §4, learning gates).
 * Called by verify-output when a scene's match.kind === "novel".
 *
 * Dedup approach: read the queue file, extract existing (referenceHash, window.t0),
 * skip if already present, append new proposals.
 *
 * Returns the proposal that was created (for logging).
 */
export function queueNovelProposal(kb: SceneKB, scene: DecodedScene, queuePath: string): FamilyProposal {
  const proposal = kb.proposeFamily(scene);

  try {
    // Read existing queue (if any)
    const existing: unknown[] = fs.existsSync(queuePath)
      ? JSON.parse(fs.readFileSync(queuePath, "utf8"))
      : [];

    // Dedup by (referenceHash, window.t0) — same reference at same start time
    const dedup = new Set(
      (existing as Array<{ referenceHash?: string; window?: { t0: number } }>)
        .map((p) => `${p.referenceHash}_${p.window?.t0}`)
    );

    // Only append if new
    if (!dedup.has(`${scene.referenceHash}_${scene.window.t0}`)) {
      existing.push(proposal);
      fs.mkdirSync(path.dirname(queuePath), { recursive: true });
      fs.writeFileSync(queuePath, JSON.stringify(existing, null, 2));
    }
  } catch (err) {
    // Non-blocking: log error but don't fail
    console.error(`[scene-kb] Failed to queue novel proposal: ${(err as Error).message}`);
  }

  return proposal;
}
