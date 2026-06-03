/**
 * contract.mjs — the STABLE CONTRACT for the content-aware B-roll system.
 *
 * This is the ONLY thing the rest of the pipeline (orchestrator, cleanliness gate,
 * relevance gate, renderer) depends on. Strategies (product/service/tutorial/…) are
 * swapped/improved behind this contract WITHOUT touching any downstream consumer —
 * that is the isolation guarantee. See docs/broll-generation.md.
 *
 * Exports:
 *   CONTENT_TYPES, BEAT_KINDS, PRODUCT_MODES   — enums
 *   HOUSE_RULES                                — shared prompt fragment (all strategies)
 *   normalizeBeat, normalizeDirective, validateDirective
 *
 * @typedef {Object} Beat
 * @property {number} order
 * @property {"generated"|"image_sequence"|"screen_recording"|"stock"} kind  // only "generated" implemented now
 * @property {number} durationSec
 * @property {"kling3_0"|"seedance_2_0"} [model]   // generated
 * @property {string} [prompt]                     // generated: one renderable paragraph
 * @property {string} [concept]
 * @property {string} [cameraMotion]
 * @property {string} [continuityNote]
 * @property {string} [asset]                      // future (image_sequence/screen_recording/stock)
 * @property {string} [animation]                  // future
 *
 * @typedef {Object} BRollDirective
 * @property {number} segId
 * @property {"product"|"service"|"tutorial"|"lifestyle"|"social_proof"|"other"} contentType
 * @property {"variety"|"identity"|"none"} [productMode]
 * @property {string} strategy
 * @property {string[]} [entities]
 * @property {string} [reframeNote]
 * @property {Beat[]} beats
 */

export const CONTENT_TYPES = ["product", "service", "tutorial", "lifestyle", "social_proof", "other"];
export const BEAT_KINDS = ["generated", "image_sequence", "screen_recording", "stock"];
export const PRODUCT_MODES = ["variety", "identity", "none"];
export const GEN_MODELS = ["kling3_0", "seedance_2_0"];

/**
 * HOUSE_RULES — the shared cinematic-director rules every GENERATED-beat strategy
 * injects into its Gemini system prompt. The canonical, fuller spec is
 * docs/broll-generation.md; this is the operational core.
 */
export const HOUSE_RULES = `You produce B-ROLL for a VERTICAL 9:16 reel. The b-roll plays BEHIND a circular talking-head inset (top-right) and is cut to the narration. Process EVERY shot through these NON-NEGOTIABLE house rules:

1. NO fabricated UIs or readable text. Generation models render text as gibberish. Generate REAL-WORLD scenes only (people, hands, products, lifestyle, environments). When the narration mentions phones, apps, scrolling, feeds, links, forms, posts, dashboards, or text, REFRAME the meaning into a real-world visual that needs no readable text (e.g. "link in profile / contact us" -> a warm inviting gesture or a handshake; "send your product photos" -> hands placing a product into a softbox). If a screen must appear, keep it OUT OF FOCUS so no text is legible.

2. SINGLE-SHOT BEATS. Each beat is ONE uninterrupted shot of ~2.5-3.5s showing ONE clean scene. We concatenate beats ourselves; you do NOT ask the model to cut. Use 1 beat if the segment is <= ~3.5s; otherwise 2-3 beats with progression. Beat durations should sum to AT LEAST the segment's needed duration.

3. TEXT-FREE, PIP-AWARE framing. Every beat forbids on-screen text, captions, logos, watermarks, UI. Keep the subject CENTERED in the LOWER TWO-THIRDS and leave clean negative space in the TOP-RIGHT.

4. MODEL ROUTING per beat: "seedance_2_0" for product / identity / e-commerce hero / image-driven shots (strong identity hold); "kling3_0" for human motion, hands, lifestyle, dynamic real-world action.

Each beat's "prompt" is ONE flowing renderable paragraph covering: subject, ONE clear action, environment, ONE motivated camera move (handheld close-up / slow dolly-in / low-angle tracking / over-the-shoulder / macro insert / slow orbit / gimbal follow), realistic cinematic lighting, readable emotion, natural physics. Grounded and renderable — not poetic, not dense, no contradictions, no impossible camera moves, no stacked simultaneous actions. End every prompt with: "No on-screen text, no captions, no logos, no watermarks, no UI." Maintain continuity across beats (wardrobe, lighting, screen direction); give each beat a short continuityNote.`;

const clampDur = (d) => Math.min(4.0, Math.max(2.0, +(d || 3)));

/** Normalize one beat from a strategy's raw output. */
export function normalizeBeat(b, i) {
  const kind = BEAT_KINDS.includes(b?.kind) ? b.kind : "generated";
  const beat = {
    order: Number.isFinite(b?.order) ? b.order : i,
    kind,
    durationSec: clampDur(b?.durationSec),
    concept: (b?.concept || `beat ${i}`).toString(),
  };
  if (kind === "generated") {
    beat.model = b?.model === "seedance_2_0" ? "seedance_2_0" : "kling3_0";
    beat.cameraMotion = (b?.cameraMotion || "slow dolly-in").toString();
    beat.continuityNote = (b?.continuityNote || "").toString();
    beat.prompt = (b?.prompt || "").toString().trim();
  } else {
    // future kinds — carry through asset/animation untouched
    if (b?.asset) beat.asset = b.asset;
    if (b?.animation) beat.animation = b.animation;
  }
  return beat;
}

/**
 * Normalize a strategy's raw output into a valid BRollDirective. Also ensures the beat
 * durations cover `neededDur` (pads the last beat; the renderer trims to exact anyway).
 */
export function normalizeDirective(raw, segId, neededDur) {
  const contentType = CONTENT_TYPES.includes(raw?.contentType) ? raw.contentType : "other";
  const productMode = PRODUCT_MODES.includes(raw?.productMode) ? raw.productMode : undefined;
  let beats = (Array.isArray(raw?.beats) ? raw.beats : []).map(normalizeBeat).sort((a, b) => a.order - b.order);
  beats = beats.map((b, i) => ({ ...b, order: i })); // re-index contiguously
  if (beats.length && neededDur) {
    const sum = beats.reduce((a, b) => a + b.durationSec, 0);
    if (sum < neededDur) beats[beats.length - 1].durationSec = +(beats[beats.length - 1].durationSec + (neededDur - sum) + 0.3).toFixed(2);
  }
  return {
    segId,
    contentType,
    productMode,
    strategy: (raw?.strategy || contentType).toString(),
    entities: Array.isArray(raw?.entities) ? raw.entities.map(String) : [],
    reframeNote: (raw?.reframeNote || "").toString(),
    beats,
  };
}

/** Validate a directive against the contract. Returns { ok, errors[] }. */
export function validateDirective(d) {
  const errors = [];
  if (!d || typeof d !== "object") return { ok: false, errors: ["directive not an object"] };
  if (!CONTENT_TYPES.includes(d.contentType)) errors.push(`bad contentType ${d.contentType}`);
  if (!Array.isArray(d.beats) || !d.beats.length) errors.push("no beats");
  (d.beats || []).forEach((b, i) => {
    if (!Number.isFinite(b.order)) errors.push(`beat ${i} missing order`);
    if (!BEAT_KINDS.includes(b.kind)) errors.push(`beat ${i} bad kind ${b.kind}`);
    if (!(b.durationSec > 0)) errors.push(`beat ${i} bad durationSec`);
    if (b.kind === "generated") {
      if (!GEN_MODELS.includes(b.model)) errors.push(`beat ${i} bad model ${b.model}`);
      if (!b.prompt) errors.push(`beat ${i} empty prompt`);
    }
  });
  return { ok: errors.length === 0, errors };
}
