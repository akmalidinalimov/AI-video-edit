/**
 * product.mjs — the PRODUCT strategy (fully implemented).
 *
 *  - GENERIC product mention  -> VARIETY mode: each beat a DIFFERENT product/category,
 *    clean attention-grabbing hero shots → represents "any product".
 *  - SPECIFIC product/type    -> IDENTITY mode + creative SCENE variation: the SAME
 *    product held consistent across beats, but in varied scenes/lighting/angles/usage.
 */
import { callDirector, BEAT_SCHEMA, beatHint } from "./_shared.mjs";

export async function plan(segment, cls, opts) {
  const nBeats = beatHint(segment.neededDur);
  const variety = cls.productSpecificity !== "specific"; // generic OR none → variety

  const systemExtra = variety
    ? `PRODUCT DEPICTION — VARIETY MODE: the narration talks about products GENERICALLY (no specific product named). Across the beats show a NUMBER OF DIFFERENT products — each beat a DISTINCT category (e.g. a cosmetic/skincare item, footwear, a handbag, a watch/gadget, a food/drink) presented as a clean, vibrant, ATTENTION-GRABBING hero product shot on a tasteful set. Represent "ANY product": be creative and VARIED, never repeat one product. You MAY contrast a dull look vs a beautifully-styled look ACROSS the variety. Route clean product hero shots to seedance_2_0; route any human-holding/in-use moment to kling3_0. Keep a consistent premium lighting/grade so the variety still feels like one brand.`
    : `PRODUCT DEPICTION — IDENTITY MODE: a SPECIFIC product/type is named (${cls.entities.join(", ") || "the named product"}). Keep the SAME product visually CONSISTENT across ALL beats, but vary the SCENES creatively — different settings, lighting, angles, and usage moments — so it is not a static repeat. Use seedance_2_0 to hold the product identity, and CARRY an explicit, identical physical description of the product inside EVERY beat's prompt so it stays the same object.`;

  const user = `SEGMENT — product B-roll behind a circular talking-head inset (top-right).
Narrative role: ${segment.role}; needed duration ${segment.neededDur.toFixed(2)}s (plan about ${nBeats} beat(s); durations sum >= this).
Detected entities: ${cls.entities.join(", ") || "(none)"}.
Speaker says (may be Uzbek): "${segment.text}"
Plan ${variety ? "VARIETY" : "IDENTITY"} product beats. ${BEAT_SCHEMA}`;

  const out = await callDirector(systemExtra, user, opts);
  return {
    contentType: "product",
    productMode: variety ? "variety" : "identity",
    strategy: "product",
    reframeNote: out.reframeNote || "",
    entities: cls.entities,
    beats: out.beats || [],
  };
}
