/**
 * style-compare.ts — the FALSIFIABLE style-reproduction metric (the closed loop).
 *
 * The qa gate was right: scoring a decode against itself measures internal consistency, not
 * whether we REPRODUCED the reference's editing style. The only falsifiable answer is the
 * closed loop:
 *
 *     decode(reference) → D_ref
 *     render output using the decode
 *     decode(output)    → D_out
 *     styleReproduction = compareDecodedStyle(D_ref, D_out)
 *
 * This module is the last line. It compares two canonical decodes FIELD BY FIELD and returns a
 * per-field style-match + a weighted overall %. It measures STYLE (layout, pacing, transitions,
 * motion, captions, overlays) — never content. If the output puts the A-roll on the wrong side,
 * cuts at a different rhythm, drops the captions, or loses the split, the number FALLS. That is
 * the point: it can be wrong, so it can be driven to 99.
 */
import type { ReferenceDecode } from "./reference-decode";

export interface FieldMatch {
  field: string;
  match: number;        // 0..1
  weight: number;
  refValue: string;
  outValue: string;
  note: string;
}

export interface StyleComparison {
  overallPct: number;         // 0..100 weighted style-reproduction
  overall: number;            // 0..1
  fields: FieldMatch[];
  mismatches: FieldMatch[];   // ascending match — where the output drifted from the reference style
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
/** 1 when equal, decaying to 0 as |a-b| reaches `span`. */
const numMatch = (a: number, b: number, span: number) => clamp(1 - Math.abs(a - b) / span);
/** ratio-based match for counts (1 when equal, →0 as they diverge). */
const ratioMatch = (a: number, b: number) => (a === 0 && b === 0 ? 1 : clamp(1 - Math.abs(a - b) / Math.max(a, b, 1)));
/** cosine-ish similarity of two label distributions. */
function distMatch(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) { const x = a[k] ?? 0, y = b[k] ?? 0; dot += x * y; na += x * x; nb += y * y; }
  return na && nb ? dot / Math.sqrt(na * nb) : (na === 0 && nb === 0 ? 1 : 0);
}
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a.map((s) => s.toLowerCase())), B = new Set(b.map((s) => s.toLowerCase()));
  if (A.size === 0 && B.size === 0) return 1;
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter);
}

/**
 * Compare the STYLE of two decodes (reference vs rendered output). Returns per-field matches +
 * a weighted overall style-reproduction %.
 */
export function compareDecodedStyle(ref: ReferenceDecode, out: ReferenceDecode): StyleComparison {
  const fields: FieldMatch[] = [];
  const add = (field: string, match: number, weight: number, refValue: unknown, outValue: unknown, note: string) =>
    fields.push({ field, match: clamp(match), weight, refValue: JSON.stringify(refValue), outValue: JSON.stringify(outValue), note });

  const rL = ref.layout, oL = out.layout;

  // ── LAYOUT (the spatial skeleton — heaviest) ──
  add("layout.type", rL.type.value === oL.type.value ? 1 : 0, 0.16, rL.type.value, oL.type.value, "exact match");
  add("layout.arollSide", rL.arollSide.value === oL.arollSide.value ? 1 : 0, 0.18, rL.arollSide.value, oL.arollSide.value, "exact match — the inversion guard");
  {
    const a = rL.dividerFraction.value, b = oL.dividerFraction.value;
    const m = a == null || b == null ? (a === b ? 1 : 0) : numMatch(a, b, 0.15);
    add("layout.dividerFraction", m, 0.10, a, b, "±0.15 tolerance");
  }
  add("layout.brollAspect", numMatch(rL.brollAspect.value, oL.brollAspect.value, 0.5), 0.08, rL.brollAspect.value, oL.brollAspect.value, "±0.5 aspect tolerance");

  // ── PACING (rhythm) ──
  add("pacing.shotCount", ratioMatch(ref.pacing.shotCount.value, out.pacing.shotCount.value), 0.14, ref.pacing.shotCount.value, out.pacing.shotCount.value, "count ratio");
  add("pacing.cutFrequency", ref.pacing.cutFrequency.value === out.pacing.cutFrequency.value ? 1 : 0.5, 0.06, ref.pacing.cutFrequency.value, out.pacing.cutFrequency.value, "class match");

  // ── TRANSITIONS ──
  add("transitions.dominant", ref.transitions.dominant.value === out.transitions.dominant.value ? 1 : 0.4, 0.06, ref.transitions.dominant.value, out.transitions.dominant.value, "dominant type");
  add("transitions.distribution", distMatch(ref.transitions.distribution.value, out.transitions.distribution.value), 0.04, ref.transitions.distribution.value, out.transitions.distribution.value, "distribution cosine");

  // ── MOTION ──
  add("motion.dominant", ref.motion.dominant.value === out.motion.dominant.value ? 1 : 0.4, 0.05, ref.motion.dominant.value, out.motion.dominant.value, "dominant camera");
  add("motion.distribution", distMatch(ref.motion.distribution.value, out.motion.distribution.value), 0.03, ref.motion.distribution.value, out.motion.distribution.value, "distribution cosine");

  // ── CAPTIONS ──
  add("captions.present", ref.captions.present.value === out.captions.present.value ? 1 : 0, 0.06, ref.captions.present.value, out.captions.present.value, "present match");
  {
    const rp = ref.captions.position.value, op = out.captions.position.value;
    const m = rp && op ? (rp === op ? 1 : 0.5) : rp == null && op == null ? 1 : 0.5;
    add("captions.position", m, 0.02, rp, op, "position match (VLM)");
  }

  // ── OVERLAYS + LOOK ──
  {
    const rn = ref.overlays.value.length, on = out.overlays.value.length;
    add("overlays.presence", (rn > 0) === (on > 0) ? 1 : 0.4, 0.02, rn, on, "presence agree");
  }
  add("style.keywords", jaccard(ref.style.keywords.value, out.style.keywords.value), 0.01, ref.style.keywords.value.length, out.style.keywords.value.length, "keyword jaccard");

  const totalW = fields.reduce((s, f) => s + f.weight, 0);
  const overall = fields.reduce((s, f) => s + f.weight * f.match, 0) / (totalW || 1);
  const mismatches = [...fields].sort((a, b) => a.match - b.match).filter((f) => f.match < 0.99).slice(0, 6);
  return {
    overall: Math.round(overall * 1000) / 1000,
    overallPct: Math.round(overall * 1000) / 10,
    fields,
    mismatches,
  };
}
