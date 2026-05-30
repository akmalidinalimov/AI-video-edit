/**
 * CV Reference Measurement Helper
 *
 * Measures the reference video's circle/rectangle positions with WIDE search
 * windows (not the tight constraints of cv-correction.ts). This gives the
 * most accurate ground truth coordinates.
 *
 * The key difference from cv-correction.ts:
 *   - cv-correction uses tight ±7% radius and position-constrained search
 *     to avoid false positives when there are many competing circles
 *   - This helper uses ±20% search windows because we're measuring a
 *     KNOWN circle (the one we want to reproduce) and accuracy matters
 *     more than false-positive rejection
 *
 * Input via CV_REF_MEASURE_INPUT env var:
 * {
 *   refVideoPath: string,
 *   canvas: { width, height },
 *   segments: [{ id, start, end, shape }],
 *   ffmpegPath: string,
 *   sourceAspect: number,
 *   framesPerSegment?: number (default 7)
 * }
 *
 * Output (JSON to stdout):
 * [
 *   { segmentId, shape, circle: { cx, cy, radius, samples } },
 *   { segmentId, shape, rect: { top, height } },
 *   ...
 * ]
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import {
  measureCircleFromFrame,
  measureArollRectangle,
} from "@/lib/analysis/coordinate-measurer.js";

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function extractFrame(
  ffmpegPath: string,
  video: string,
  t: number,
  canvas: { width: number; height: number },
  outPath: string
): boolean {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    ffmpegPath,
    ["-y", "-ss", String(t), "-i", video, "-frames:v", "1",
     "-vf", `scale=${canvas.width}:${canvas.height}`, outPath],
    { encoding: "utf-8" }
  );
  return r.status === 0 && fs.existsSync(outPath);
}

interface SegmentInput {
  id: string;
  start: number;
  end: number;
  shape: string;
}

interface MeasurementResult {
  segmentId: string;
  shape: string;
  circle?: { cx: number; cy: number; radius: number; samples: number };
  rect?: { top: number; height: number };
}

async function main() {
  const inputStr = process.env.CV_REF_MEASURE_INPUT;
  if (!inputStr) {
    console.error("CV_REF_MEASURE_INPUT env var not set");
    process.exit(1);
  }

  const input = JSON.parse(inputStr) as {
    refVideoPath: string;
    canvas: { width: number; height: number };
    segments: SegmentInput[];
    ffmpegPath: string;
    sourceAspect: number;
    framesPerSegment?: number;
  };

  const N = input.framesPerSegment ?? 7;
  const tmpDir = path.join(process.cwd(), "public", "exports", "sp-temp", "cv-ref-tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const results: MeasurementResult[] = [];

  for (const seg of input.segments) {
    if (seg.shape === "circle") {
      const dur = Math.max(0.1, seg.end - seg.start);
      const a = seg.start + dur * 0.1;
      const b = seg.end - dur * 0.1;

      // WIDE search: cover the entire right half + upper 60% of canvas
      // This is deliberately loose because accuracy > false-positive-rejection
      const centerRegion = {
        xMin: Math.round(input.canvas.width * 0.35),  // left 35% excluded
        xMax: Math.round(input.canvas.width * 0.95),   // right 5% excluded
        yMin: Math.round(input.canvas.height * 0.05),  // top 5% excluded
        yMax: Math.round(input.canvas.height * 0.55),  // bottom 45% excluded
      };
      // Wide radius: ±25%
      const radiusRange = {
        min: Math.round(input.canvas.width * 0.14),  // ~150px
        max: Math.round(input.canvas.width * 0.28),  // ~302px
      };

      const dets: Array<{ cx: number; cy: number; r: number; support: number }> = [];

      for (let i = 0; i < N; i++) {
        const t = a + ((b - a) * (i + 0.5)) / N;
        const fp = path.join(tmpDir, `ref_${seg.id}_${i}.jpg`);
        if (!extractFrame(input.ffmpegPath, input.refVideoPath, t, input.canvas, fp)) continue;

        const d = await measureCircleFromFrame({
          framePath: fp,
          canvas: input.canvas,
          downscale: 3,
          radiusRange,
          centerRegion,
        });
        if (d) {
          dets.push({ cx: d.cx, cy: d.cy, r: d.radius, support: d.support });
        }
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      }

      if (dets.length > 0) {
        // Use spatial clustering to find the dominant circle
        // (same approach as reference-measurer but simpler)
        const clusterThreshold = Math.round(input.canvas.width * 0.10);

        // Simple clustering: group by proximity to first detection
        const clusters: Array<Array<typeof dets[0]>> = [];
        for (const det of dets) {
          let found = false;
          for (const cluster of clusters) {
            const centroid = {
              cx: cluster.reduce((s, d) => s + d.cx, 0) / cluster.length,
              cy: cluster.reduce((s, d) => s + d.cy, 0) / cluster.length,
            };
            if (Math.hypot(det.cx - centroid.cx, det.cy - centroid.cy) < clusterThreshold) {
              cluster.push(det);
              found = true;
              break;
            }
          }
          if (!found) {
            clusters.push([det]);
          }
        }

        // Pick the largest cluster
        clusters.sort((a, b) => b.length - a.length);
        const best = clusters[0];

        results.push({
          segmentId: seg.id,
          shape: "circle",
          circle: {
            cx: median(best.map(d => d.cx)),
            cy: median(best.map(d => d.cy)),
            radius: median(best.map(d => d.r)),
            samples: best.length,
          },
        });

        // Log to stderr
        process.stderr.write(
          `  ${seg.id}: ${dets.length} dets, ${clusters.length} clusters, ` +
          `best=${best.length} → cx=${median(best.map(d => d.cx))},cy=${median(best.map(d => d.cy))},r=${median(best.map(d => d.r))}\n`
        );
      } else {
        process.stderr.write(`  ${seg.id}: NO DETECTIONS\n`);
        results.push({ segmentId: seg.id, shape: "circle" });
      }
    } else if (seg.shape === "rectangle") {
      const dur = Math.max(0.1, seg.end - seg.start);
      const a = seg.start + dur * 0.15;
      const b = seg.end - dur * 0.15;

      const tops: number[] = [];
      let lastHeight = 0;

      for (let i = 0; i < 3; i++) {
        const t = a + ((b - a) * (i + 0.5)) / 3;
        const fp = path.join(tmpDir, `ref_${seg.id}_${i}.jpg`);
        if (!extractFrame(input.ffmpegPath, input.refVideoPath, t, input.canvas, fp)) continue;

        const res = await measureArollRectangle({
          framePath: fp,
          canvas: input.canvas,
          sourceAspect: input.sourceAspect,
          searchFromY: Math.round(input.canvas.height * 0.10),
          searchToY: Math.round(input.canvas.height * 0.65),
        });
        if (res) {
          tops.push(res.top);
          lastHeight = res.height;
        }
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      }

      if (tops.length > 0) {
        results.push({
          segmentId: seg.id,
          shape: "rectangle",
          rect: { top: median(tops), height: lastHeight },
        });
      } else {
        results.push({ segmentId: seg.id, shape: "rectangle" });
      }
    }
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Output as JSON
  console.log(JSON.stringify(results));
}

main().catch(err => {
  console.error("CV reference measurement error:", err);
  process.exit(1);
});
