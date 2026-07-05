/**
 * decode-accuracy.ts — Step 3: the STYLE-DECODE ACCURACY GATE.
 *
 * "99% accurate" is only meaningful if it is MEASURABLE. This scores the canonical decode
 * (reference-decode.ts) against the reference itself, component by component, and returns a
 * per-component style-accuracy % + an overall score + the WEAKEST links (what to fix next).
 *
 * The honest method — with no human ground truth, accuracy = AGREEMENT BETWEEN INDEPENDENT
 * MEASUREMENTS of the same thing. Each component is checked by a DIFFERENT signal than the one
 * that produced it:
 *   - pacing.shots  → F1 vs an INDEPENDENT FFmpeg scene detector cropped to the B-roll band
 *                     (totally different algorithm than the analyzer's band-diff). THE ANCHOR.
 *   - layout.side   → face-based side vs the independent temporal-thirds side (sideAgree)
 *   - layout.divider→ seam vs geometry (Hough) agreement, else seam prominence
 *   - layout.type   → decisiveness of splitScore away from the 0.5 boundary
 *   - captions      → CV band vs VLM position/presence agreement
 *   - overlays      → CV vs VLM presence agreement
 *   - transitions / motion → decisiveness proxies (flagged as the weaker checks — the point of
 *                     the scorer is to SURFACE where the decode is soft, not to flatter it)
 *
 * This is self-supervised cross-validation, not absolute truth — but it is falsifiable and it
 * moves: raise a component's number only by making two independent methods agree.
 */
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import type { LayoutAnalysis } from "./layout-analyzer";
import type { ReferenceDecode } from "./reference-decode";

export interface ComponentScore {
  name: string;
  score: number;      // 0..1
  weight: number;
  method: string;     // the check used
  detail: string;
  /** TRUE only when checked against a DIFFERENT signal than the one that produced the value.
   *  FALSE = self-reported confidence (the analyzer grading its own label) — NOT accuracy. */
  independent: boolean;
}

/**
 * NOTE: this is DECODE SELF-CONSISTENCY / TRUST — is the decode internally reliable? It is NOT
 * style-reproduction accuracy (that requires rendering + re-decoding — see style-compare.ts).
 * `verifiedPct` counts ONLY independently cross-checked components; `selfReportedPct` is the
 * analyzer's own confidence in the rest. They are reported separately ON PURPOSE.
 */
export interface DecodeAccuracy {
  verifiedPct: number;            // 0..100 over independently cross-checked components only
  selfReportedPct: number;       // 0..100 over self-reported (uncross-checked) components
  components: ComponentScore[];
  weakest: ComponentScore[];      // ascending score — the fix-next list
  external: {
    shotF1: number; precision: number; recall: number;
    analyzerShots: number; ffmpegShots: number; toleranceSec: number; note?: string;
  } | null;
}

function ffmpegPath(): string {
  const root = process.cwd();
  const p = path.join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
  return fs.existsSync(p) ? p : "ffmpeg";
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** INDEPENDENT shot boundaries: FFmpeg scene detection cropped to the B-roll band. */
function ffmpegSceneCuts(videoPath: string, decode: ReferenceDecode, threshold = 0.4): number[] | null {
  try {
    const [W, H] = decode.meta.dims.value;
    const div = decode.layout.dividerFraction.value;
    const side = decode.layout.arollSide.value;
    // crop to the B-roll band (same domain the analyzer segments), else whole frame
    let crop = `crop=${W}:${H}:0:0`;
    if (decode.layout.type.value === "split" && div != null) {
      if (side === "bottom") crop = `crop=${W}:${Math.max(2, Math.round(div * H))}:0:0`;              // B-roll on top
      else crop = `crop=${W}:${Math.max(2, Math.round((1 - div) * H))}:0:${Math.round(div * H)}`;     // B-roll on bottom
    }
    // showinfo prints the selected-frame timestamps to STDERR (ffmpeg log), so capture stderr.
    const r = spawnSync(
      ffmpegPath(),
      ["-i", videoPath, "-vf", `${crop},select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
    );
    const log = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    if (!log) return null;
    return parsePtsTimes(log);
  } catch {
    return null;
  }
}

function parsePtsTimes(s: string): number[] {
  const times: number[] = [];
  const re = /pts_time:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) times.push(parseFloat(m[1]));
  return times;
}

/** F1 of predicted boundaries vs reference boundaries with a matching tolerance. */
function boundaryF1(pred: number[], ref: number[], tol: number): { f1: number; precision: number; recall: number } {
  if (pred.length === 0 && ref.length === 0) return { f1: 1, precision: 1, recall: 1 };
  const usedRef = new Set<number>();
  let tp = 0;
  for (const p of pred) {
    let bestJ = -1, bestD = tol + 1;
    for (let j = 0; j < ref.length; j++) {
      if (usedRef.has(j)) continue;
      const d = Math.abs(ref[j] - p);
      if (d <= tol && d < bestD) { bestD = d; bestJ = j; }
    }
    if (bestJ >= 0) { usedRef.add(bestJ); tp++; }
  }
  const precision = pred.length ? tp / pred.length : 0;
  const recall = ref.length ? tp / ref.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { f1, precision, recall };
}

/**
 * Score the canonical decode against the reference. `layout` provides the CV EVIDENCE (sideAgree,
 * seamProminence, geometryAgree, splitScore) the independent checks lean on.
 */
export function scoreDecodeAccuracy(videoPath: string, layout: LayoutAnalysis, decode: ReferenceDecode): DecodeAccuracy {
  const L = layout.layout;
  const comps: ComponentScore[] = [];

  // ── layout.side — INDEPENDENT: face-side vs the fixed temporal-thirds side ──
  comps.push({
    name: "layout.arollSide", weight: 0.14, independent: true,
    score: L.evidence.sideAgree ? 0.95 : 0.35,
    method: "face-side vs independent temporal-thirds",
    detail: `face=${L.evidence.face?.side} thirds=${L.evidence.independentSide} agree=${L.evidence.sideAgree}`,
  });

  // ── layout.type — SELF-REPORTED: decisiveness of the analyzer's OWN splitScore (not a
  //    second signal). Honestly not an independent check (qa M3). ──
  {
    const decisive = clamp(Math.abs(L.splitScore - 0.5) / 0.35);
    comps.push({
      name: "layout.type", weight: 0.10, independent: false,
      score: L.typeUncertain ? Math.min(0.6, 0.5 + 0.5 * decisive) : 0.5 + 0.5 * decisive,
      method: "splitScore decisiveness (self-reported)",
      detail: `type=${L.type} splitScore=${L.splitScore} uncertain=${L.typeUncertain}`,
    });
  }

  // ── layout.divider — INDEPENDENT only when geometry (Hough) independently agrees; otherwise
  //    self-reported via seam prominence (geometry was rejected → no second signal). ──
  {
    const seamProm = L.evidence.seamProminence ?? 0;
    const geoChecked = L.dividerFraction != null && L.evidence.geometryAgree;
    const score = L.dividerFraction == null
      ? 0.9 // non-split: "no divider" is decisive
      : geoChecked
        ? 0.95
        : clamp(0.4 + (seamProm - 1.3) * 0.35, 0.35, 0.9);
    comps.push({
      name: "layout.dividerFraction", weight: 0.11, independent: geoChecked,
      score, method: geoChecked ? "seam↔geometry (independent)" : "seam prominence (self-reported; geometry rejected)",
      detail: `divider=${L.dividerFraction} geoAgree=${L.evidence.geometryAgree} seamProm=${seamProm}`,
    });
  }

  // ── pacing.shots (THE ANCHOR: F1 vs independent FFmpeg scene detector) ──
  const tol = 0.4;
  const ffmpegCuts = ffmpegSceneCuts(videoPath, decode);
  let external: DecodeAccuracy["external"] = null;
  if (ffmpegCuts) {
    const analyzerCuts = decode.pacing.shotBoundaries.value;
    const { f1, precision, recall } = boundaryF1(analyzerCuts, ffmpegCuts, tol);
    external = { shotF1: round(f1), precision: round(precision), recall: round(recall), analyzerShots: analyzerCuts.length, ffmpegShots: ffmpegCuts.length, toleranceSec: tol };
    // Precision is inflated when ffmpeg fires densely (its cut windows cover much of the timeline),
    // so recall carries the signal. We report all three; the score is the F1 (honest, if imperfect).
    comps.push({
      name: "pacing.shots", weight: 0.25, independent: true,
      score: f1, method: `shot-boundary F1 vs independent FFmpeg scene-cut (±${tol}s; recall-dominated, P inflated by density)`,
      detail: `analyzer=${analyzerCuts.length} ffmpeg=${ffmpegCuts.length} P=${round(precision)} R=${round(recall)}`,
    });
  } else {
    comps.push({
      name: "pacing.shots", weight: 0.25, independent: false,
      score: decode.pacing.shotCount.confidence, method: "FFmpeg cross-check UNAVAILABLE → analyzer self-confidence",
      detail: "ffmpeg scene detection failed",
    });
    external = { shotF1: 0, precision: 0, recall: 0, analyzerShots: decode.pacing.shotBoundaries.value.length, ffmpegShots: 0, toleranceSec: tol, note: "ffmpeg unavailable" };
  }

  // ── transitions — SELF-REPORTED: label homogeneity of the analyzer's OWN output. No
  //    independent transition oracle → not a real correctness check (qa M1). ──
  {
    const dist = decode.transitions.distribution.value;
    const total = Object.values(dist).reduce((s, n) => s + n, 0);
    const dom = Math.max(0, ...Object.values(dist));
    const consistency = total ? dom / total : 0;
    comps.push({
      name: "transitions", weight: 0.12, independent: false,
      score: total === 0 ? 0.5 : clamp(0.5 + 0.4 * consistency),
      method: "dominant-type homogeneity (self-reported — no independent transition oracle)",
      detail: `dist=${JSON.stringify(dist)}`,
    });
  }

  // ── motion — SELF-REPORTED: share of non-ambiguous labels in the analyzer's OWN output.
  //    Not independently verified against a second optical-flow measure (qa M1). ──
  {
    const dist = decode.motion.distribution.value;
    const total = Object.values(dist).reduce((s, n) => s + n, 0);
    const ambiguous = (dist["slow_move"] ?? 0);
    comps.push({
      name: "motion", weight: 0.10, independent: false,
      score: total === 0 ? 0.5 : clamp(0.55 + 0.4 * (1 - ambiguous / total)),
      method: "non-ambiguous share (self-reported — optical-flow labels not independently checked)",
      detail: `dist=${JSON.stringify(dist)}`,
    });
  }

  // ── captions (CV band ↔ VLM presence/position agreement) ──
  {
    const cvPresent = layout.captions.present;
    const vlmPos = decode.captions.position.value; // null unless semantics ran
    const vlmPresent = decode.captions.present.source === "vlm" ? decode.captions.present.value : null;
    let acc: number, method: string, detail: string;
    if (vlmPresent != null) {
      const presenceAgree = cvPresent === vlmPresent;
      // position sanity: VLM lower-third/below-divider ↔ CV band in the lower/mid frame
      const band = layout.captions.bandFrac;
      const posSane = !vlmPos ? true : /lower|below|bottom|center/i.test(vlmPos) ? (band ? band[0] >= 0.3 : true) : true;
      acc = (presenceAgree ? 0.7 : 0.35) + (posSane ? 0.2 : 0);
      method = "CV band ↔ VLM presence/position agreement";
      detail = `cvPresent=${cvPresent} vlmPresent=${vlmPresent} vlmPos=${vlmPos} bandOk=${posSane}`;
    } else {
      acc = cvPresent ? 0.55 : 0.5;
      method = "CV-only constant (no VLM cross-check — run withSemantics for a real check)";
      detail = `cvPresent=${cvPresent} (no semantics)`;
    }
    comps.push({ name: "captions", weight: 0.12, independent: vlmPresent != null, score: clamp(acc), method, detail });
  }

  // ── overlays (CV ↔ VLM presence agreement; constant lookup without VLM) ──
  {
    const cvN = layout.overlays.length;
    const vlmN = decode.overlays.source === "vlm" ? decode.overlays.value.length : null;
    let acc: number, detail: string;
    if (vlmN != null) {
      const bothNone = cvN === 0 && vlmN === 0;
      const bothSome = cvN > 0 && vlmN > 0;
      acc = bothNone ? 0.9 : bothSome ? 0.7 : 0.45; // disagreement on presence = soft
      detail = `cv=${cvN} vlm=${vlmN}`;
    } else {
      acc = cvN === 0 ? 0.7 : 0.55;
      detail = `cv=${cvN} (no VLM)`;
    }
    comps.push({ name: "overlays", weight: 0.06, independent: vlmN != null, score: clamp(acc), method: "CV↔VLM overlay presence", detail });
  }

  // Report VERIFIED (independent) and SELF-REPORTED separately — never blended into one headline.
  const wsum = (cs: ComponentScore[]) => cs.reduce((s, c) => s + c.weight, 0);
  const wscore = (cs: ComponentScore[]) => { const w = wsum(cs); return w ? cs.reduce((s, c) => s + c.weight * c.score, 0) / w : 0; };
  const verified = comps.filter((c) => c.independent);
  const selfrep = comps.filter((c) => !c.independent);
  const weakest = [...comps].sort((a, b) => a.score - b.score).slice(0, 4);
  return {
    verifiedPct: Math.round(wscore(verified) * 1000) / 10,
    selfReportedPct: Math.round(wscore(selfrep) * 1000) / 10,
    components: comps.map((c) => ({ ...c, score: round(c.score) })),
    weakest: weakest.map((c) => ({ ...c, score: round(c.score) })),
    external,
  };
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }
