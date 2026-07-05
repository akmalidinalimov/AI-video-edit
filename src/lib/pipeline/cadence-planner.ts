/**
 * cadence-planner.ts — STEP 1 of the deliberate B-roll planning pipeline.
 *
 * The reference reel has a CUT RHYTHM: it changes the visual every ~N seconds. We
 * already MEASURE it (editing_rhythm.avg_segment_duration / pacing) but historically
 * threw it away and hardcoded TARGET_SHOT_SEC = 1.5 for every video. This module
 * derives the output's B-roll shot cadence FROM THE REFERENCE, so a fast reel yields
 * a fast montage and a calm reel yields longer holds — matching the reference's energy
 * instead of imposing one rhythm on everything.
 *
 * Pure + deterministic so it is unit-verifiable. Backward-safe: with no reference data
 * it returns exactly the legacy 1.5s / 2.4s values, so wiring it in changes nothing
 * until a real rhythm is supplied.
 */

export interface EditingRhythmInput {
  avg_segment_duration?: number | null;
  cut_style?: string | null;
  pacing?: string | null;
}

export interface CadencePlan {
  /** target B-roll shot length (seconds) — drives range subdivision */
  targetShotSec: number;
  /** only subdivide ranges longer than this (seconds) */
  minSubdivideSec: number;
  pacing: "fast" | "moderate" | "slow";
  /** where targetShotSec came from */
  source: "reference" | "pacing" | "default";
  notes: string;
}

const SHOT_MIN = 1.0; // a B-roll shot shorter than this reads as a glitch
const SHOT_MAX = 5.0; // longer than this stops feeling like a "cut" rhythm
const PACING_SHOT: Record<"fast" | "moderate" | "slow", number> = { fast: 1.2, moderate: 2.0, slow: 3.0 };
const LEGACY_SHOT_SEC = 1.5; // the old hardcoded value — the no-data default

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function normalizePacing(p?: string | null): "fast" | "moderate" | "slow" {
  const s = (p ?? "").toLowerCase();
  if (/(fast|quick|rapid|snappy|energetic)/.test(s)) return "fast";
  if (/(slow|calm|relaxed|gentle)/.test(s)) return "slow";
  return "moderate";
}

/**
 * Derive the output B-roll cadence from the reference's measured editing rhythm.
 * Priority: measured avg_segment_duration → pacing bucket → legacy default.
 */
export function planCadence(rhythm?: EditingRhythmInput | null): CadencePlan {
  const pacing = normalizePacing(rhythm?.pacing);
  const avg = rhythm?.avg_segment_duration;

  let targetShotSec: number;
  let source: CadencePlan["source"];
  let notes: string;

  if (typeof avg === "number" && Number.isFinite(avg) && avg > 0) {
    targetShotSec = clamp(avg, SHOT_MIN, SHOT_MAX);
    source = "reference";
    notes = `from reference avg_segment_duration=${avg.toFixed(2)}s` +
      (targetShotSec !== avg ? ` (clamped to ${targetShotSec.toFixed(2)}s)` : "");
  } else if (rhythm?.pacing) {
    targetShotSec = PACING_SHOT[pacing];
    source = "pacing";
    notes = `no avg duration; derived from pacing="${pacing}"`;
  } else {
    targetShotSec = LEGACY_SHOT_SEC;
    source = "default";
    notes = "no reference rhythm; legacy default 1.5s";
  }

  // Only subdivide ranges clearly longer than a single shot. 1.5 * 1.6 = 2.4 → exactly
  // reproduces the legacy MIN_SUBDIVIDE_SEC when targetShotSec is the legacy default.
  const minSubdivideSec = round2(targetShotSec * 1.6);

  return { targetShotSec: round2(targetShotSec), minSubdivideSec, pacing, source, notes };
}

/**
 * How many B-roll shots a span of `spanSec` should be cut into under this cadence.
 * Mirrors plan-builder's existing subdivision math exactly:
 *   span < minSubdivide → 1 shot; else round(span / targetShotSec).
 */
export function estimateShots(spanSec: number, plan: CadencePlan): number {
  if (spanSec < plan.minSubdivideSec) return 1;
  return Math.max(1, Math.round(spanSec / plan.targetShotSec));
}
