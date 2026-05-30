/**
 * CV Coordinate Correction — replaces the reference blueprint's LLM-estimated
 * geometry with deterministic computer-vision measurements from the real
 * reference pixels.
 *
 * WHY: Gemini's bounding-box estimates are unreliable (circles measured
 * ~120-150px too high and ~60px too small; rectangle A-roll ~80px too high;
 * header text too high and half-size). The renderer faithfully reproduces
 * whatever coordinates it's given, so wrong measurements → wrong output. This
 * module measures the real pixels and OVERRIDES the blueprint segments in place
 * BEFORE template generation / plan building.
 *
 * Corrects:
 *   - Circle PIP boxes (gradient-Hough + multi-frame median + locked constants)
 *   - Rectangle A-roll box (brightness-profile top edge + source-aspect height)
 *   - Header text boxes (row-projection bands, matched to overlay texts)
 *   - Per-text typeface style (Gemini font classification)
 *   - Multi-color word spans within a line (strict-gated color-segment split)
 *
 * Shared by scripts/render-content-aware.ts and /api/clone-style so both the
 * test harness and the production pipeline behave identically.
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

import {
  measureReferenceCircles,
  measureReferenceRectangle,
  type MeasuredCircle,
} from "@/lib/analysis/reference-measurer";
import { measureTextColorSegments } from "@/lib/analysis/coordinate-measurer";
import { classifyFontStyle } from "@/lib/analysis/font-classifier";
import { classifyOverlayText } from "@/lib/pipeline/layout-map";
// pip-locator (Gemini-based face/circle detection) removed per KB-005/KB-006:
// single-frame Gemini Vision is unreliable for videos with multiple faces or
// circles. Replaced by temporal-persistence clustering in reference-measurer.

export interface CvCorrectionInput {
  ffmpegPath: string;
  refVideoPath: string;
  canvas: { width: number; height: number };
  /** Blueprint reference segments — MUTATED IN PLACE with corrected geometry */
  segments: Array<Record<string, unknown>>;
  /** A-roll source aspect ratio (width/height) for rectangle height */
  sourceAspect: number;
  /** Scratch directory for frame extraction */
  tmpDir: string;
}

export interface CvCorrectionResult {
  logs: string[];
}

/**
 * Measure the reference and overwrite blueprint segment coordinates in place.
 */
export async function applyCvCorrections(
  input: CvCorrectionInput
): Promise<CvCorrectionResult> {
  const { ffmpegPath, refVideoPath, canvas, segments, sourceAspect, tmpDir } = input;
  const logs: string[] = [];
  const refmeasDir = path.join(tmpDir, "refmeas");
  fs.mkdirSync(refmeasDir, { recursive: true });

  // ── Derive circle search hints from the LLM's rough boxes ──
  // The LLM's absolute coordinates are unreliable (off by 100-150px), but its
  // ROUGH position (which quadrant) and approximate size are trustworthy. We
  // seed a GENEROUS search region around the LLM centers (±30% canvas to absorb
  // its error) so the same code works for any layout — top-right, bottom-left,
  // centered — instead of a hardcoded top-right assumption. The robust two-pass
  // median inside measureReferenceCircles refines to pixel accuracy.
  type Box = { x: number; y: number; width: number; height: number };
  const circleBoxes: Box[] = segments
    .filter((s) => {
      const a = s.aroll as { shape?: string; boundingBox?: Box } | undefined;
      return a?.shape === "circle" && !!a?.boundingBox;
    })
    .map((s) => (s.aroll as { boundingBox: Box }).boundingBox);

  let centerRegion: { xMin: number; xMax: number; yMin: number; yMax: number } | undefined;
  let radiusRange: { min: number; max: number } | undefined;
  if (circleBoxes.length > 0) {
    const cxs = circleBoxes.map((b) => b.x + b.width / 2);
    const cys = circleBoxes.map((b) => b.y + b.height / 2);
    const rs = circleBoxes.map((b) => Math.min(b.width, b.height) / 2);
    const maxR = Math.max(...rs);
    const minR = Math.min(...rs);
    const marginX = Math.max(maxR, canvas.width * 0.15);
    const marginY = Math.max(maxR, canvas.height * 0.18);
    centerRegion = {
      xMin: Math.max(0, Math.min(...cxs) - marginX),
      xMax: Math.min(canvas.width, Math.max(...cxs) + marginX),
      yMin: Math.max(0, Math.min(...cys) - marginY),
      yMax: Math.min(canvas.height, Math.max(...cys) + marginY),
    };
    radiusRange = {
      min: Math.max(60, Math.round(minR * 0.85)),
      max: Math.min(
        Math.round(Math.min(canvas.width, canvas.height) * 0.4),
        Math.round(maxR * 1.4)
      ),
    };
    logs.push(
      `circle search (LLM-seeded): center x[${Math.round(centerRegion.xMin)}-${Math.round(centerRegion.xMax)}] ` +
        `y[${Math.round(centerRegion.yMin)}-${Math.round(centerRegion.yMax)}] r[${radiusRange.min}-${radiusRange.max}]`
    );
  }

  // ── Circle PIPs: temporal-persistence clustering (pure CV, no Gemini) ──
  //
  // KB-001: LLM layout label unreliable for search region.
  // KB-002: Full-canvas CV search with global median admits B-roll false circles.
  // KB-005/KB-006: Gemini Vision single-frame queries unreliable for multi-face/
  //   multi-circle frames (wrong face, wrong circle, "safe middle" bias).
  //
  // Resolution (temporal-persistence): sample 20 frames per segment, run
  // Hough detection within a POSITION-INDEPENDENT upper-half constraint, then
  // cluster detections spatially. Speaker's PIP = stationary → densest cluster;
  // B-roll thumbnails = scrolling/changing → sparse clusters.
  //
  // POSITION-INDEPENDENT region (breaks circular-dependency with bbox corruption):
  // For portrait-orientation videos (9:16), the speaker's PIP circle center is
  // ALWAYS in the upper half of the canvas — this is a universal UI convention.
  // All false B-roll circles observed in testing were in the lower half (cy > 50%
  // of canvas height). So constraining y < 50% of canvas height is a reliable
  // general filter that does NOT depend on the current (possibly wrong) bboxes.
  //
  // Radius: use the MEDIAN of all LLM-estimated radii (robust to position-outliers;
  // the LLM's size estimate is more reliable than its position estimate).
  const allLlmRadii = circleBoxes.map((b) => Math.min(b.width, b.height) / 2);
  const medianLlmR = allLlmRadii.length > 0
    ? (() => {
        const s = [...allLlmRadii].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      })()
    : Math.round(canvas.width * 0.20);

  // ── Two-pass detection strategy ──
  //
  // Pass A (xMax=84% width ≈ 907px): wide search catches the most common PIP
  // position.  Excludes right-edge artifacts (cx≈912 false cluster for seg_5).
  //
  // Pass B (xMax=75% width ≈ 810px): narrower search for segments where Pass A
  // returned a circle whose center is too far right (cx > 75% width). This
  // flips the false-cluster situation for seg_5: the phantom right-side cluster
  // at cx=813 is excluded, and the true cluster at cx=672 wins.
  //
  // Left-edge filter: Pass B can produce a spurious cluster at cx≈590 from
  // B-roll sidebar content. Reject any Pass B result where cx < 55% width.
  //
  // yMin=10%: eliminates phantom centers at cy<192 caused by Hough outer-
  // direction votes from the PIP's inner ring edge (dark ring → face boundary
  // votes to a center ~r above the real center, often landing at cy≈150-200).

  // Use the LLM-seeded xMin (≈50% of canvas width in practice) so that far-left
  // edge artifacts (B-roll sidebar circles at cx≈83) are excluded from the
  // Hough peak search.  The LLM rough estimate reliably identifies which
  // horizontal half the PIP lives in; its absolute position may be off, but the
  // rough xMin (LLM-center-minus-margin) always excludes the far-left artefacts.
  // Fall back to 50% canvas width if no LLM hint is available.
  const temporalXMin = centerRegion?.xMin ?? Math.round(canvas.width * 0.50);
  const temporalRegion = {
    xMin: temporalXMin,
    xMax: Math.round(canvas.width * 0.84),   // ≈907px — excludes far-right artifacts
    // Upper 50% of canvas: covers all standard "top" PIP positions while
    // excluding the lower-half B-roll false circles universally observed.
    yMin: Math.round(canvas.height * 0.10),  // ≈192px — excludes inner-ring phantoms
    yMax: Math.round(canvas.height * 0.50),
  };
  // Tight radius range (±7%): observed false circles had r≈171 (too small)
  // and r≈252-264 (too large) while real PIP circles measure r=204-219.
  // The ±7% window rejects both outlier classes while keeping the true radius
  // comfortably inside. Wider windows (±12/18%) admit false circles at r=201
  // that win over the true circle in temporal clustering.
  const temporalRadiusRange = {
    min: Math.max(60, Math.round(medianLlmR * 0.93)),  // e.g. 0.93*215=200
    max: Math.round(medianLlmR * 1.07),                // e.g. 1.07*215=230
  };

  logs.push(
    `circle measurement: temporal-persistence clustering ` +
    `(30 frames/segment, x[${temporalRegion.xMin}-${temporalRegion.xMax}] y[${temporalRegion.yMin}-${temporalRegion.yMax}], ` +
    `r[${temporalRadiusRange.min}-${temporalRadiusRange.max}], medianLlmR=${Math.round(medianLlmR)})`
  );

  const circleSegmentInputs = segments.map((s) => ({
    id: s.id as string,
    start: s.start as number,
    end: s.end as number,
    shape: ((s.aroll as Record<string, unknown> | undefined)?.shape as string) ?? "none",
  }));

  const passA = await measureReferenceCircles({
    ffmpegPath,
    refVideoPath,
    canvas,
    segments: circleSegmentInputs,
    tmpDir: refmeasDir,
    centerRegion: temporalRegion,
    radiusRange: temporalRadiusRange,
    framesPerSegment: 30,
    useTemporalClustering: true,
  });

  // Pass B: re-run with xMax=75% for any segment whose Pass A center landed
  // too far right (likely a right-edge false cluster from B-roll content).
  const xMaxNarrow = Math.round(canvas.width * 0.75);  // ≈810px
  const xMinLeftFilter = Math.round(canvas.width * 0.55); // ≈594px (reject left-edge artifacts)
  const needsPassB = circleSegmentInputs.filter((s) => {
    if (s.shape !== "circle") return false;
    const m = passA.get(s.id);
    return !m || !m.confident || m.cx > xMaxNarrow;
  });

  let passB: Map<string, MeasuredCircle> | null = null;
  if (needsPassB.length > 0) {
    logs.push(
      `circle measurement: pass B (xMax=${xMaxNarrow}) for ${needsPassB.length} uncertain segment(s): ` +
      needsPassB.map((s) => s.id).join(", ")
    );
    const passBMap = await measureReferenceCircles({
      ffmpegPath,
      refVideoPath,
      canvas,
      segments: needsPassB,
      tmpDir: refmeasDir,
      centerRegion: { ...temporalRegion, xMax: xMaxNarrow },
      radiusRange: temporalRadiusRange,
      framesPerSegment: 30,
      useTemporalClustering: true,
    });
    // Filter out left-edge artifacts (cx < 55% width)
    passB = new Map();
    for (const [id, m] of Array.from(passBMap.entries())) {
      if (m.cx >= xMinLeftFilter) {
        passB.set(id, m);
      } else {
        logs.push(`  ${id}: pass B result cx=${m.cx} < ${xMinLeftFilter} — rejected (left-edge artifact)`);
      }
    }
  }

  // Merge: for each segment, use Pass B if it's more confident than Pass A
  const measured: Map<string, MeasuredCircle> = new Map(passA);
  if (passB) {
    for (const [id, mb] of Array.from(passB.entries())) {
      const ma = passA.get(id);
      if (!ma || !ma.confident || (mb.confident && mb.samples > ma.samples)) {
        measured.set(id, mb);
        logs.push(`  ${id}: using pass B result (cx=${mb.cx},cy=${mb.cy},r=${mb.radius}, n=${mb.samples}) over pass A (cx=${ma?.cx ?? "—"},n=${ma?.samples ?? 0})`);
      }
    }
  }

  // Confidence gate: only replace the LLM bbox when the temporal cluster is
  // clearly dominant (confident=true means the chosen cluster holds ≥35% of
  // all sampled frames, i.e. ≥11 of 30 frames).  Non-confident detections are
  // unreliable (B-roll false circles competing with the true PIP); in those
  // cases the LLM estimate is usually better than a noisy CV result.
  //
  // Sanity-clamp: also reject detections whose circle extends significantly
  // outside the canvas (5% tolerance) — these are always false positives
  // from near-edge B-roll artifacts.
  const sanityTol = 0.05;
  for (const seg of segments) {
    const aroll = seg.aroll as { boundingBox?: { x: number; y: number; width: number; height: number } } | undefined;
    const m = measured.get(seg.id as string);
    if (m && aroll?.boundingBox) {
      const before = aroll.boundingBox;

      // Gate 1: confidence — skip uncertain detections
      if (!m.confident) {
        logs.push(
          `${seg.id}: circle detection uncertain (n=${m.samples}) — keeping LLM bbox`
        );
        continue;
      }

      // Gate 2: on-canvas sanity check
      const topY = m.box.y;
      const bottomY = m.box.y + m.box.height;
      const leftX = m.box.x;
      const rightX = m.box.x + m.box.width;
      const inside =
        topY >= -m.radius * sanityTol &&
        bottomY <= canvas.height + m.radius * sanityTol &&
        leftX >= -m.radius * sanityTol &&
        rightX <= canvas.width + m.radius * sanityTol;
      if (!inside) {
        logs.push(
          `${seg.id}: REJECTED off-canvas CV box (${m.box.x},${m.box.y},${m.box.width}x${m.box.height}) — keeping LLM bbox`
        );
        continue;
      }

      // Gate 3: circle center too close to the top of the canvas.
      // The inner-ring-phantom filter (yMin=10%) excludes peaks at cy<192,
      // but B-roll UI elements (icons, avatars near the top of the screen)
      // can create confident false clusters at cy=220-240.  Real speaker PIPs
      // are NEVER that close to the top — the minimum observed is cy≈275 for
      // seg_5 layouts in all tested reference videos.  Use 13% height (≈249px)
      // as the result-level gate (keeps seg_5 at cy≈294, rejects cy≈234).
      const yMinResult = Math.round(canvas.height * 0.13);
      if (m.cy < yMinResult) {
        logs.push(
          `${seg.id}: REJECTED near-top CV circle cy=${m.cy} < ${yMinResult} — keeping LLM bbox`
        );
        continue;
      }

      aroll.boundingBox = { ...m.box };
      logs.push(
        `${seg.id}: circle (${before.x},${before.y},${before.width}x${before.height}) ` +
          `→ CV (${m.box.x},${m.box.y},${m.box.width}x${m.box.height}) ` +
          `[confident, ${m.samples} frames]`
      );
    }
  }

  // ── Rectangle A-roll + header text ──
  for (const seg of segments) {
    const aroll = seg.aroll as
      | { shape?: string; boundingBox?: { x: number; y: number; width: number; height: number } }
      | undefined;
    if (aroll?.shape !== "rectangle" || !aroll?.boundingBox) continue;

    // Seed the vertical A-roll search window from the LLM's rough rect box
    // (±12% canvas) so it works for non-top rectangles too.
    const llm = aroll.boundingBox;
    const ry = canvas.height * 0.12;
    const searchFromY = Math.max(0, llm.y - ry);
    const searchToY = Math.min(canvas.height, llm.y + llm.height + ry);

    const { rect, textBands } = await measureReferenceRectangle({
      ffmpegPath,
      refVideoPath,
      canvas,
      segment: { start: seg.start as number, end: seg.end as number },
      sourceAspect,
      tmpDir: refmeasDir,
      searchFromY,
      searchToY,
    });

    if (rect) {
      const before = aroll.boundingBox;
      aroll.boundingBox = { ...rect };
      logs.push(
        `${seg.id}: rect (${before.x},${before.y},${before.width}x${before.height}) ` +
          `→ CV (${rect.x},${rect.y},${rect.width}x${rect.height})`
      );
    }

    const texts = seg.texts as Array<Record<string, unknown>> | undefined;
    if (textBands.length > 0 && Array.isArray(texts)) {
      const broll = seg.broll as { boundingBox?: { x: number; y: number; width: number; height: number } } | undefined;
      const brollIsBackground =
        !!broll?.boundingBox &&
        broll.boundingBox.x <= 10 && broll.boundingBox.y <= 10 &&
        broll.boundingBox.width >= canvas.width - 20 &&
        broll.boundingBox.height >= canvas.height - 40;
      const headerRegions = ((seg.blackRegions as Array<{ boundingBox: { x: number; y: number; width: number; height: number }; purpose: string }>) ?? []).map((r) => ({
        region: r.boundingBox,
        purpose: r.purpose,
      }));
      const overlayTexts = texts
        .filter((t) =>
          classifyOverlayText({
            box: t.boundingBox as { x: number; y: number; width: number; height: number },
            isHeadline: t.isHeadline as boolean | undefined,
            brollIsBackground,
            headerRegions,
            canvas,
          })
        )
        .sort((a, b) =>
          (a.boundingBox as { y: number }).y - (b.boundingBox as { y: number }).y
        );
      const bands = [...textBands].sort((a, b) => a.y - b.y);
      const pairN = Math.min(overlayTexts.length, bands.length);

      // One frame for font classification + color-segment detection
      const clsMid = ((seg.start as number) + (seg.end as number)) / 2;
      const clsFrame = path.join(refmeasDir, `fontcls_${seg.id}.jpg`);
      spawnSync(ffmpegPath, [
        "-y", "-ss", String(clsMid), "-i", refVideoPath, "-frames:v", "1",
        "-vf", `scale=${canvas.width}:${canvas.height}`, clsFrame,
      ], { encoding: "utf-8" });

      for (let i = 0; i < pairN; i++) {
        const t = overlayTexts[i];
        const band = bands[i];
        t.boundingBox = { x: band.x, y: band.y, width: band.width, height: band.height };

        // Typeface style classification
        let styleStr = "(none)";
        try {
          const pad = 8;
          const cropX = Math.max(0, band.x - pad);
          const cropY = Math.max(0, band.y - pad);
          const cropW = Math.min(canvas.width - cropX, band.width + pad * 2);
          const cropH = Math.min(canvas.height - cropY, band.height + pad * 2);
          const cropPath = path.join(refmeasDir, `fontcrop_${seg.id}_${i}.jpg`);
          const cr = spawnSync(ffmpegPath, [
            "-y", "-i", clsFrame, "-vf", `crop=${cropW}:${cropH}:${cropX}:${cropY}`, cropPath,
          ], { encoding: "utf-8" });
          if (cr.status === 0) {
            const style = await classifyFontStyle(cropPath);
            if (style) {
              t.fontStyle = style;
              styleStr = `${style.category}${style.italic ? "/italic" : ""}/${style.weight}`;
            }
            try { fs.unlinkSync(cropPath); } catch { /* ignore */ }
          }
        } catch { /* best-effort */ }

        // Multi-color word spans (strict-gated)
        let spanStr = "";
        try {
          const colorSegs = await measureTextColorSegments({ framePath: clsFrame, canvas, band });
          const bandWForGate = band.width || 1;
          const byClass = new Map<string, { min: number; max: number; color: string }>();
          for (const s of colorSegs) {
            const cur = byClass.get(s.klass);
            if (cur) { cur.min = Math.min(cur.min, s.xStart); cur.max = Math.max(cur.max, s.xEnd); }
            else byClass.set(s.klass, { min: s.xStart, max: s.xEnd, color: s.color });
          }
          const classBlocks = Array.from(byClass.entries())
            .map(([klass, v]) => ({ klass, ...v, w: (v.max - v.min) / bandWForGate }))
            .sort((a, b) => a.min - b.min);
          const blocksOverlap = classBlocks.some((a, ai) =>
            classBlocks.some((b2, bj) => ai < bj && a.max > b2.min + bandWForGate * 0.05)
          );
          const eachBigEnough = classBlocks.every((b2) => b2.w >= 0.18);
          const coverage = classBlocks.reduce((s2, b2) => s2 + b2.w, 0);
          const confidentMultiColor =
            classBlocks.length >= 2 && !blocksOverlap && eachBigEnough && coverage >= 0.6;

          if (confidentMultiColor) {
            const words = String(t.text).split(/\s+/).filter(Boolean);
            const totalChars = words.join(" ").length || 1;
            const bandW = band.width || 1;
            const snapColor = (klass: string, color: string) =>
              klass === "white" ? "#FFFFFF" : color;
            const blockFrac = classBlocks.map((b2) => ({
              klass: b2.klass, color: b2.color, xStart: b2.min,
              f0: (b2.min - band.x) / bandW, f1: (b2.max - band.x) / bandW,
            }));
            const assign: number[] = [];
            let accChars = 0;
            for (const w of words) {
              const startFrac = accChars / totalChars;
              accChars += w.length + 1;
              const endFrac = Math.min(1, accChars / totalChars);
              const mid = (startFrac + endFrac) / 2;
              let best = 0, bestDist = Infinity;
              blockFrac.forEach((b2, bi) => {
                const dist = mid < b2.f0 ? b2.f0 - mid : mid > b2.f1 ? mid - b2.f1 : 0;
                if (dist < bestDist) { bestDist = dist; best = bi; }
              });
              assign.push(best);
            }
            const spans: Array<{ text: string; color: string; x: number }> = [];
            let wi = 0;
            while (wi < words.length) {
              const blkIdx = assign[wi];
              const group: string[] = [];
              while (wi < words.length && assign[wi] === blkIdx) { group.push(words[wi]); wi++; }
              const b2 = blockFrac[blkIdx];
              spans.push({
                text: group.join(" "),
                color: snapColor(b2.klass, b2.color),
                x: spans.length === 0 ? band.x : b2.xStart,
              });
            }
            const distinctSpanColors = new Set(spans.map((s) => s.color));
            if (spans.length >= 2 && distinctSpanColors.size >= 2) {
              t.spans = spans;
              spanStr = " spans=[" + spans.map((s) => `"${s.text}"@${s.color}`).join(",") + "]";
            }
          }
        } catch { /* best-effort */ }

        logs.push(
          `${seg.id}: text "${String(t.text).slice(0, 24)}" ` +
            `→ CV (${band.x},${band.y},${band.width}x${band.height}) font=${styleStr}${spanStr}`
        );
      }
      try { fs.unlinkSync(clsFrame); } catch { /* ignore */ }
    }
  }

  return { logs };
}
