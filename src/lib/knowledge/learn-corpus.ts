/**
 * learn-corpus.ts — batch corpus learning core (scene-KB spec §3.3), dependency-injected
 * so it is unit-testable with zero cost. The CLI wrapper (scripts/learn-corpus.ts) wires
 * the real cached decode. Per reel: decode → segment → match → (score-gated) learn.
 * Novel families → FamilyProposal list (human review queue). Idempotent by
 * (referenceHash, window) dedup inside SceneKB.learnExemplar.
 */
import type { ReferenceDecode } from "@/lib/analysis/reference-decode";
import type { StructureWindow } from "@/lib/analysis/layout-regions";
import { segmentScenes } from "@/lib/analysis/scene-segmenter";
import { windowDecode } from "@/lib/analysis/window-decode";
import type { SceneKB, DecodedScene, FamilyProposal } from "./scene-kb";

export interface CorpusDecodeResult {
  decode: ReferenceDecode;
  structureTimeline?: StructureWindow[] | null;
  referenceHash: string;
  cvVlmAgree: boolean;
}

export interface CorpusReport {
  ranAt: string;
  perReel: Array<{
    file: string;
    scenes: Array<{ t0: number; t1: number; layoutClass: string; kind: string; family: string | null; distance: number; learned: boolean }>;
  }>;
  totals: { reels: number; scenes: number; known: number; family_new: number; novel: number; learned: number };
}

export async function runLearnCorpus(opts: {
  files: string[];
  kb: SceneKB;
  decodeFor: (file: string) => Promise<CorpusDecodeResult | null>;
  scoreOf?: (file: string, w: { t0: number; t1: number }) => number | null;
}): Promise<{ report: CorpusReport; proposals: FamilyProposal[] }> {
  const report: CorpusReport = {
    ranAt: new Date().toISOString(),
    perReel: [],
    totals: { reels: 0, scenes: 0, known: 0, family_new: 0, novel: 0, learned: 0 },
  };
  const proposals: FamilyProposal[] = [];

  for (const file of opts.files) {
    const dec = await opts.decodeFor(file);
    if (!dec) { report.perReel.push({ file, scenes: [] }); continue; }
    report.totals.reels++;
    const windows = segmentScenes(dec.decode, { structureTimeline: dec.structureTimeline ?? null });
    const rows: CorpusReport["perReel"][number]["scenes"] = [];
    for (const w of windows) {
      const scene: DecodedScene = {
        window: { t0: w.t0, t1: w.t1 },
        layoutClass: w.layoutClass,
        regions: w.regions,
        decode: windowDecode(dec.decode, w.t0, w.t1),
        referenceHash: dec.referenceHash,
      };
      const match = opts.kb.matchScene(scene);
      report.totals.scenes++;
      if (match.kind === "known") report.totals.known++;
      else if (match.kind === "family_new") report.totals.family_new++;
      else { report.totals.novel++; proposals.push(opts.kb.proposeFamily(scene)); }

      let learned = false;
      const score = opts.scoreOf?.(file, scene.window) ?? null;
      if (score != null && match.kind !== "novel") {
        const res = opts.kb.learnExemplar({ scene, closedLoopScore: score, cvVlmAgree: dec.cvVlmAgree, sourceFile: file });
        learned = res.learned;
        if (learned) report.totals.learned++;
      }
      rows.push({ t0: w.t0, t1: w.t1, layoutClass: w.layoutClass, kind: match.kind, family: match.family, distance: match.distance, learned });
    }
    report.perReel.push({ file, scenes: rows });
  }
  return { report, proposals };
}
