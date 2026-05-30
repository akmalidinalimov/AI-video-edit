/**
 * CV Measurement Helper — runs circle/rectangle detection on a rendered video
 *
 * Called from test-cv-loop.mjs via `npx tsx scripts/helpers/cv-measure-output.mts`
 * Reads input from CV_MEASURE_INPUT environment variable (JSON).
 *
 * Uses the SAME coordinate-measurer module that cv-correction.ts uses for
 * reference measurement, ensuring output measurement uses identical algorithms.
 *
 * Input (via env var):
 * {
 *   videoPath: string,
 *   segments: [{ id, start, end, shape, expected: { cx, cy, radius } | { x, y, w, h } }],
 *   canvas: { width, height },
 *   ffmpegPath: string,
 *   sourceAspect: number
 * }
 *
 * Output (JSON to stdout):
 * { circle: { cx, cy, radius, samples } } | { rect: { top, height } } | null
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

async function main() {
  const inputStr = process.env.CV_MEASURE_INPUT;
  if (!inputStr) {
    console.error("CV_MEASURE_INPUT env var not set");
    process.exit(1);
  }

  const input = JSON.parse(inputStr) as {
    videoPath: string;
    segments: Array<{
      id: string;
      start: number;
      end: number;
      shape: string;
      expected: { cx?: number; cy?: number; radius?: number; x?: number; y?: number; width?: number; height?: number };
    }>;
    canvas: { width: number; height: number };
    ffmpegPath: string;
    sourceAspect: number;
  };

  const tmpDir = path.join(process.cwd(), "public", "exports", "sp-temp", "cv-measure-tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const seg of input.segments) {
    if (seg.shape === "circle") {
      const expected = seg.expected;
      const N = 5;
      const dur = Math.max(0.1, seg.end - seg.start);
      const a = seg.start + dur * 0.15;
      const b = seg.end - dur * 0.15;

      // Search region: generous window around expected (±20% canvas)
      const padX = input.canvas.width * 0.20;
      const padY = input.canvas.height * 0.20;
      const centerRegion = {
        xMin: Math.max(0, (expected.cx ?? input.canvas.width / 2) - padX),
        xMax: Math.min(input.canvas.width, (expected.cx ?? input.canvas.width / 2) + padX),
        yMin: Math.max(0, (expected.cy ?? input.canvas.height / 3) - padY),
        yMax: Math.min(input.canvas.height, (expected.cy ?? input.canvas.height / 3) + padY),
      };
      const expectedR = expected.radius ?? Math.round(input.canvas.width * 0.20);
      const radiusRange = {
        min: Math.max(50, Math.round(expectedR * 0.80)),
        max: Math.round(expectedR * 1.20),
      };

      const dets: Array<{ cx: number; cy: number; r: number }> = [];

      for (let i = 0; i < N; i++) {
        const t = a + ((b - a) * (i + 0.5)) / N;
        const fp = path.join(tmpDir, `cv_${seg.id}_${i}.jpg`);
        if (!extractFrame(input.ffmpegPath, input.videoPath, t, input.canvas, fp)) continue;

        const d = await measureCircleFromFrame({
          framePath: fp,
          canvas: input.canvas,
          downscale: 3,
          radiusRange,
          centerRegion,
        });
        if (d) {
          dets.push({ cx: d.cx, cy: d.cy, r: d.radius });
        }
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      }

      if (dets.length > 0) {
        const result = {
          circle: {
            cx: median(dets.map((d) => d.cx)),
            cy: median(dets.map((d) => d.cy)),
            radius: median(dets.map((d) => d.r)),
            samples: dets.length,
          },
        };
        console.log(JSON.stringify(result));
      } else {
        console.log(JSON.stringify({ circle: null }));
      }
    } else if (seg.shape === "rectangle") {
      const expected = seg.expected;
      const N = 3;
      const dur = Math.max(0.1, seg.end - seg.start);
      const a = seg.start + dur * 0.15;
      const b = seg.end - dur * 0.15;

      const ry = input.canvas.height * 0.12;
      const searchFromY = Math.max(0, (expected.y ?? 0) - ry);
      const searchToY = Math.min(input.canvas.height, (expected.y ?? 0) + (expected.height ?? 600) + ry);

      const tops: number[] = [];
      let lastHeight = expected.height ?? 600;

      for (let i = 0; i < N; i++) {
        const t = a + ((b - a) * (i + 0.5)) / N;
        const fp = path.join(tmpDir, `cv_${seg.id}_${i}.jpg`);
        if (!extractFrame(input.ffmpegPath, input.videoPath, t, input.canvas, fp)) continue;

        const res = await measureArollRectangle({
          framePath: fp,
          canvas: input.canvas,
          sourceAspect: input.sourceAspect,
          searchFromY,
          searchToY,
        });
        if (res) {
          tops.push(res.top);
          lastHeight = res.height;
        }
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      }

      if (tops.length > 0) {
        console.log(JSON.stringify({
          rect: { top: median(tops), height: lastHeight },
        }));
      } else {
        console.log(JSON.stringify({ rect: null }));
      }
    }
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch(err => {
  console.error("CV measure error:", err);
  process.exit(1);
});
