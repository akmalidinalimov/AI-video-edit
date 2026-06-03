/**
 * default.mjs — fallback strategy: turn the narration's meaning into grounded real-world
 * cinematic beats (the original generic behavior). Used directly for content types we
 * haven't specialised yet, and as the delegate target for the stub strategies.
 */
import { callDirector, BEAT_SCHEMA, beatHint } from "./_shared.mjs";

export async function plan(segment, cls, opts, strategyName = "default") {
  const nBeats = beatHint(segment.neededDur);
  const systemExtra = `REAL-WORLD REFRAME (content type: ${cls.contentType}): turn the narration's MEANING into ${nBeats} grounded real-world cinematic beat(s) (people, hands, environments, objects, lifestyle). If it implies screens/apps/links/forms/text, reframe to a real-world metaphor that needs NO readable text.`;
  const user = `SEGMENT — b-roll behind a circular talking-head inset (top-right). Content type: ${cls.contentType}.
Narrative role: ${segment.role}; needed duration ${segment.neededDur.toFixed(2)}s (plan about ${nBeats} beat(s); durations sum >= this).
Detected entities: ${cls.entities.join(", ") || "(none)"}.
Speaker says (may be Uzbek): "${segment.text}"
${BEAT_SCHEMA}`;
  const out = await callDirector(systemExtra, user, opts);
  return {
    contentType: cls.contentType,
    productMode: "none",
    strategy: strategyName,
    reframeNote: out.reframeNote || "",
    entities: cls.entities,
    beats: out.beats || [],
  };
}
