/**
 * classifier.mjs — the CONTEXT-AWARENESS layer.
 *
 * Detects WHAT a segment's narration is about so the registry can pick the right
 * B-roll strategy. Grounded by the segment's existing `role` + `semanticTags`
 * (from clean-timeline) PLUS the speech, via Gemini.
 *
 *   classifySegment(segment, { apiKey }) ->
 *     { contentType, productSpecificity, entities[], confidence, note }
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { CONTENT_TYPES } from "./contract.mjs";

const SYSTEM = `You classify what a short-form reel SEGMENT's narration is about, so an editor can choose fitting B-roll. Be decisive and literal.
contentType is ONE of: product (promoting/among physical or digital products), service (an offering/agency/people doing work for the viewer), tutorial (teaching steps / how-to / showing a tool being used step-by-step), lifestyle (mood/aspiration/personal story with no specific offer), social_proof (results/testimonials/numbers/before-after of others), other.
productSpecificity is ONE of: specific (a particular named product or a specific product TYPE is named, e.g. "our vitamin C serum", "this watch"), generic (products in general, e.g. "your products", "your product photos"), none (not about a product).
entities = the concrete nouns the B-roll should depict (product types, tools, actions, people).`;

export async function classifySegment(segment, { apiKey, model = "gemini-2.5-flash" } = {}) {
  const gen = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model, systemInstruction: SYSTEM,
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  });
  const tags = Array.isArray(segment.semanticTags) ? segment.semanticTags.join(", ") : "";
  const user = `Segment narrative role: ${segment.role || "?"}
Existing semantic tags (hints): ${tags || "(none)"}
Speech (may be Uzbek): "${segment.text}"
Return ONLY JSON: {"contentType":"...","productSpecificity":"specific|generic|none","entities":["..."],"confidence":0..1,"note":"<one line>"}`;

  let parsed = null;
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    try { parsed = JSON.parse((await gen.generateContent(user)).response.text()); } catch {}
  }
  if (!parsed) parsed = {};
  const contentType = CONTENT_TYPES.includes(parsed.contentType) ? parsed.contentType : "other";
  const productSpecificity = ["specific", "generic", "none"].includes(parsed.productSpecificity)
    ? parsed.productSpecificity : (contentType === "product" ? "generic" : "none");
  return {
    contentType,
    productSpecificity,
    entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    note: (parsed.note || "").toString(),
  };
}
