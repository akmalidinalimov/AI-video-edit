/**
 * CV Blueprint Correction Helper
 *
 * Runs cv-correction.ts on a blueprint's reference segments, replacing
 * LLM-estimated bounding boxes with CV-measured pixel coordinates.
 *
 * Called from test-dynamic-pipeline.mjs via:
 *   npx tsx scripts/helpers/cv-correct-blueprint.mts
 *
 * Reads input from CV_CORRECT_INPUT env var:
 * {
 *   refVideoPath: string,
 *   canvas: { width, height },
 *   segments: BlueprintSegment[],  // blueprint.data.reference.segments
 *   ffmpegPath: string,
 *   sourceAspect: number
 * }
 *
 * Outputs corrected segments as JSON to stdout.
 * The segments array is MUTATED IN PLACE by applyCvCorrections, then printed.
 */

import { applyCvCorrections } from "@/lib/pipeline/cv-correction.js";
import path from "path";
import fs from "fs";

async function main() {
  const inputStr = process.env.CV_CORRECT_INPUT;
  if (!inputStr) {
    console.error("CV_CORRECT_INPUT env var not set");
    process.exit(1);
  }

  const input = JSON.parse(inputStr) as {
    refVideoPath: string;
    canvas: { width: number; height: number };
    segments: Array<Record<string, unknown>>;
    ffmpegPath: string;
    sourceAspect: number;
  };

  const tmpDir = path.join(process.cwd(), "public", "exports", "sp-temp", "cv-correct-tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  // applyCvCorrections mutates segments in place
  const result = await applyCvCorrections({
    ffmpegPath: input.ffmpegPath,
    refVideoPath: input.refVideoPath,
    canvas: input.canvas,
    segments: input.segments,
    sourceAspect: input.sourceAspect,
    tmpDir,
  });

  // Log corrections to stderr (so stdout stays clean for JSON)
  for (const log of result.logs) {
    process.stderr.write(`  [cv-correct] ${log}\n`);
  }

  // Output corrected segments as JSON to stdout
  console.log(JSON.stringify(input.segments));

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch(err => {
  console.error("CV correction error:", err);
  process.exit(1);
});
