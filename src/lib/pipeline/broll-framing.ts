/**
 * broll-framing.ts — fit the generated B-roll to the ON-SCREEN REGION it will occupy.
 *
 * The B-roll is composited into a REGION of the 9:16 canvas — often a SQUARE (1:1) or a
 * WIDE band, NOT the full portrait frame. If we generate a tall 9:16 close-up and the
 * region is square/wide, the renderer's cover-crop scales-to-fill and crops the top/bottom
 * — the person's HEAD gets cut (the exact bug). This planner MEASURES the region and emits:
 *   - generateAspect: the Kling aspect closest to the region (least crop)
 *   - shotType + direction: a framing rule (wider shot + headroom) so the subject survives
 * Deterministic (measure + rule) — no LLM agent. Feeds the prompt engine + the generation aspect.
 */

export type GenAspect = "9:16" | "1:1" | "16:9";

export interface FramingSpec {
  regionAspect: number;      // region width/height
  generateAspect: GenAspect; // the Kling aspect to GENERATE at (least crop into the region)
  shotType: string;          // medium / waist-up / full-body — wider as the region flattens
  direction: string;         // prompt fragment: framing + headroom guidance (authoritative)
  reason: string;
}

const ASPECTS: Record<GenAspect, number> = { "9:16": 9 / 16, "1:1": 1, "16:9": 16 / 9 };

/** The generation aspect whose ratio is closest (log-distance) to the region's. */
export function closestAspect(regionAspect: number): GenAspect {
  let best: GenAspect = "1:1";
  let bestD = Infinity;
  for (const k of Object.keys(ASPECTS) as GenAspect[]) {
    const d = Math.abs(Math.log(regionAspect / ASPECTS[k]));
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/**
 * Plan the framing for a B-roll region of `regionW`×`regionH`. `person` true → a human
 * subject (the head-cut risk); false → object/scene (just compose for the aspect).
 */
export function planFraming(regionW: number, regionH: number, opts?: { person?: boolean }): FramingSpec {
  const ar = regionW / regionH;
  const generateAspect = closestAspect(ar);
  const person = opts?.person ?? true;

  // The flatter/wider the region, the WIDER the shot must be so any residual crop can't
  // reach the head. (Tall region ≈ 9:16 → portrait is fine.)
  let shotType: string;
  if (!person) shotType = "well-composed shot";
  else if (ar <= 0.85) shotType = "medium shot";
  else if (ar < 1.25) shotType = "medium / waist-up shot";
  else shotType = "full-body or wide medium shot";

  const aspectLabel = generateAspect === "1:1" ? "square" : generateAspect === "16:9" ? "horizontal" : "vertical";
  const direction = person
    ? `FRAMING (fit the on-screen region — overrides other framing): ${shotType}, the subject CENTERED with clear headroom above the head and space around them, composed for a ${aspectLabel} ${generateAspect} frame. Do NOT use a tight close-up or portrait crop — the head must not be cut.`
    : `FRAMING: composed for a ${aspectLabel} ${generateAspect} frame, the key subject centered with margin on all sides.`;

  return {
    regionAspect: Math.round(ar * 100) / 100,
    generateAspect,
    shotType,
    direction,
    reason: `region ${regionW}×${regionH} (AR ${ar.toFixed(2)}) → generate ${generateAspect}, ${shotType}`,
  };
}

/** Region shape from a layout's B-roll box: `{ width, height }` or `{ w, h }`. */
export function framingForRegion(region: { width?: number; height?: number; w?: number; h?: number } | undefined, person = true): FramingSpec {
  const w = region?.width ?? region?.w ?? 1080;
  const h = region?.height ?? region?.h ?? 1080;
  return planFraming(w, h, { person });
}
