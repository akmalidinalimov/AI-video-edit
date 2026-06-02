/**
 * registry.mjs — the pluggable STRATEGY REGISTRY + the system's public entry point.
 *
 * planDirective(segment, opts):  classify → pick strategy (by contentType) → strategy
 * produces beats → normalize + validate against the CONTRACT. This is the ONLY function
 * the orchestrator calls; adding/improving a content type = add/edit one strategy file
 * and (if new) one line here — nothing downstream changes.
 */
import { classifySegment } from "./classifier.mjs";
import { normalizeDirective, validateDirective } from "./contract.mjs";
import * as product from "./strategies/product.mjs";
import * as service from "./strategies/service.mjs";
import * as tutorial from "./strategies/tutorial.mjs";
import * as lifestyle from "./strategies/lifestyle.mjs";
import * as deflt from "./strategies/default.mjs";

// contentType → strategy module. Unmapped types fall back to default.
const STRATEGIES = { product, service, tutorial, lifestyle, social_proof: deflt, other: deflt };

export async function planDirective(segment, opts) {
  const classification = await classifySegment(segment, opts);
  // Product depiction is CROSS-CUTTING: if products are the visual subject (a product is
  // named, or products are referenced generically) we use the PRODUCT strategy even inside
  // a service/other pitch — because the user wants products shown when products are
  // mentioned (generic → variety of products; specific → that product across scenes).
  const productSubject = classification.productSpecificity === "specific" || classification.productSpecificity === "generic";
  const strat = productSubject ? product : (STRATEGIES[classification.contentType] || deflt);
  const raw = await strat.plan(segment, classification, opts);
  const dir = normalizeDirective(
    { ...raw, contentType: raw.contentType || classification.contentType, entities: raw.entities || classification.entities },
    segment.seg, segment.neededDur
  );
  dir.classification = classification; // for transparency in the manifest
  const v = validateDirective(dir);
  if (!v.ok) throw new Error(`directive invalid for seg${segment.seg}: ${v.errors.join("; ")}`);
  return dir;
}

export { STRATEGIES };
