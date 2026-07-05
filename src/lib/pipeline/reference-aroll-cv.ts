/**
 * reference-aroll-cv.ts — deterministic, FACE-ANCHORED A-roll position for the
 * reference (replaces Gemini's unreliable rectangle bbox, which inverts top/bottom
 * splits). Shells to scripts/python/assess_reference.py (venv YuNet) with the
 * reference's per-segment boundaries and returns, for each segment, the measured
 * A-roll band + layout type. states[i] ↔ segment i (consecutive boundary pairs).
 *
 * This is the audit's must-fix-first: measure A-roll position from the actual
 * talking-head face, multi-frame median per segment, not from the LLM. See
 * docs/style-cloning-principles.md rules 2-6.
 */
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

export type RefArollType = "top_split" | "bottom_split" | "fullscreen_aroll" | "broll_only";

export interface RefArollBand {
  index: number;
  type: RefArollType;
  /** A-roll band [x,y,w,h] as fractions of the canvas (present unless broll_only) */
  bandNorm?: [number, number, number, number];
  /** complementary B-roll region [x,y,w,h] fractions (null for fullscreen) */
  brollNorm?: [number, number, number, number] | null;
  faceHeightFrac?: number;
  persistence?: number;
}

const VENV_PY = path.join(process.cwd(), "scripts", "python", ".venv", "Scripts", "python.exe");
const SCRIPT = path.join(process.cwd(), "scripts", "python", "assess_reference.py");

/**
 * Detect the A-roll band per reference segment.
 * @param videoPath  reference video
 * @param boundaries segment boundary times (seconds) incl. the first start and final end
 * @returns one RefArollBand per segment (boundaries.length - 1), or null on failure
 */
export function detectReferenceArollBands(
  videoPath: string,
  boundaries: number[]
): RefArollBand[] | null {
  if (!fs.existsSync(VENV_PY) || !fs.existsSync(SCRIPT)) {
    console.error("[reference-aroll-cv] venv or assess_reference.py missing — run Phase A setup");
    return null;
  }
  if (boundaries.length < 2) return null;
  const outDir = path.join(os.tmpdir(), `refaroll_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    execFileSync(
      VENV_PY,
      [SCRIPT, videoPath, outDir, boundaries.map((b) => b.toFixed(3)).join(",")],
      { stdio: "pipe", timeout: 180_000 }
    );
    const j = JSON.parse(fs.readFileSync(path.join(outDir, "layout-map.json"), "utf8")) as {
      states: Array<{
        index: number;
        type: string;
        aroll?: { bandNorm?: number[]; faceHeightFrac?: number; persistence?: number };
        brollNorm?: number[] | null;
      }>;
    };
    return j.states.map((s) => ({
      index: s.index,
      type: s.type as RefArollType,
      bandNorm: s.aroll?.bandNorm as RefArollBand["bandNorm"],
      brollNorm: (s.brollNorm ?? null) as RefArollBand["brollNorm"],
      faceHeightFrac: s.aroll?.faceHeightFrac,
      persistence: s.aroll?.persistence,
    }));
  } catch (e) {
    console.error("[reference-aroll-cv] detection failed:", (e as Error).message);
    return null;
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
