/**
 * broll-director.mjs — COMPAT SHIM.
 *
 * The B-roll director was refactored into the content-aware module `scripts/lib/broll/`
 * (classifier + pluggable strategy registry + stable contract). This file stays as a
 * thin re-export so existing imports keep working. New code should import from
 * `./broll/registry.mjs` and `./broll/contract.mjs` directly.
 */
export { planDirective } from "./broll/registry.mjs";
export { HOUSE_RULES, HOUSE_RULES as SYSTEM_PROMPT } from "./broll/contract.mjs";

/**
 * planBeats — legacy signature. Returns { strategy, productMode, contentType, reframeNote, beats }.
 * Delegates to the content-aware registry (classify → strategy → contract).
 */
import { planDirective } from "./broll/registry.mjs";
export async function planBeats(segment, opts) {
  const d = await planDirective(segment, opts);
  return { strategy: d.strategy, productMode: d.productMode, contentType: d.contentType, reframeNote: d.reframeNote, beats: d.beats };
}
