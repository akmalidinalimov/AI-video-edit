/**
 * broll-prompt-clauses.ts — the physics/geometry CLAUSE LIBRARY for AI-video B-roll
 * prompts. The lever that makes "the laptop looks right, the screen doesn't flip"
 * non-optional: whenever a real object appears in a shot, the prompt MUST carry its
 * correct-geometry clause. The prompt-writer injects these; the prompt-critic
 * rejects a prompt that's missing one for an object it mentions.
 *
 * This is a maintained, growing library (the "failure-mode library" from the B-roll
 * plan, Pillar B4): each entry encodes a known failure + the phrasing that prevents
 * it. Append entries as the video-critic discovers new failure classes.
 */

export interface GeometryClause {
  /** stable id */
  id: string;
  /** keywords in the shot description that mean this object/risk is present */
  triggers: string[];
  /** the positive correct-geometry phrasing to weave into the prompt */
  clause: string;
  /** the failure class it prevents (for the critic's rationale) */
  prevents: string;
  /** short negative-prompt terms for models that accept them */
  negatives: string[];
}

export const GEOMETRY_CLAUSES: GeometryClause[] = [
  {
    id: "laptop",
    triggers: ["laptop", "macbook", "notebook computer"],
    clause:
      "an open laptop with its screen raised upright above the keyboard and clearly facing the person, hinge at the back, the keyboard deck toward the viewer",
    prevents: "screenless / flipped / backwards / detached laptop screen",
    negatives: ["screenless laptop", "backwards screen", "reversed laptop", "detached screen"],
  },
  {
    id: "single-device",
    triggers: ["laptop", "phone", "screen", "tablet", "monitor", "device"],
    clause: "only ONE glowing device in frame (no competing second screen)",
    prevents: "two-device spatial ambiguity — the root cause of flipped/warped screens",
    negatives: ["second screen", "extra device", "multiple phones"],
  },
  {
    id: "phone",
    triggers: ["phone", "smartphone", "mobile"],
    clause: "a single smartphone held naturally in one hand, its screen angled toward the person",
    prevents: "warped / duplicated phones, impossible grip",
    negatives: ["two phones", "warped phone", "floating phone"],
  },
  {
    id: "screen-ui",
    triggers: ["screen", "dashboard", "interface", "app", "ui", "chart", "notification"],
    clause: "the screen shows a soft, simple glowing interface (an implied chart/UI), NOT small readable text",
    prevents: "garbled / nonsense on-screen text",
    negatives: ["readable text", "garbled text", "tiny numbers", "currency symbols"],
  },
  {
    id: "hands",
    triggers: ["typing", "hands", "holding", "keyboard", "writing", "pointing", "gesture"],
    clause: "hands with relaxed, correctly-shaped fingers (five per hand), resting naturally on the surface",
    prevents: "melting / extra / fused fingers (the #1 AI artifact)",
    negatives: ["extra fingers", "melting hands", "distorted hands", "fused fingers"],
  },
  {
    id: "face",
    triggers: ["person", "man", "woman", "face", "portrait", "student", "people"],
    clause: "a single, clearly-framed face with symmetric, natural features and a steady gaze",
    prevents: "warped / asymmetric / duplicated faces",
    negatives: ["warped face", "deformed face", "extra faces", "asymmetric eyes"],
  },
  {
    id: "reflection",
    triggers: ["mirror", "window", "glass", "reflection", "screen"],
    clause: "reflections/shadows that match the light source and the real objects",
    prevents: "impossible reflections / mismatched shadows",
    negatives: ["impossible reflection", "wrong shadow"],
  },
  {
    id: "product-in-hand",
    triggers: ["product", "holding a", "package", "box", "bottle", "showing"],
    clause: "the product held the right way up, label facing the viewer, in a natural grip",
    prevents: "upside-down / morphing / floating product",
    negatives: ["floating product", "morphing object", "upside down label"],
  },
];

/** Always-on physics principles appended to every realistic shot. */
export const PHYSICS_PRINCIPLES =
  "Physically consistent: gravity, correct occlusion and perspective, objects keep their shape and count for the whole shot; nothing morphs, melts, or drifts out of frame.";

/** Return the clauses whose triggers appear in a shot description. */
export function physicsClausesFor(shotText: string): GeometryClause[] {
  const t = shotText.toLowerCase();
  const hits = GEOMETRY_CLAUSES.filter((c) => c.triggers.some((k) => t.includes(k)));
  // de-dup by id, keep order
  const seen = new Set<string>();
  return hits.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Assemble the geometry addendum to weave into a prompt (positive phrasing). */
export function geometryAddendum(shotText: string): string {
  const clauses = physicsClausesFor(shotText);
  if (!clauses.length) return PHYSICS_PRINCIPLES;
  return clauses.map((c) => c.clause).join("; ") + ". " + PHYSICS_PRINCIPLES;
}

/** Collected negative terms for the present objects (for models that accept them). */
export function negativeTermsFor(shotText: string): string[] {
  const out = new Set<string>();
  for (const c of physicsClausesFor(shotText)) c.negatives.forEach((n) => out.add(n));
  return [...out];
}

/** Which object-clauses a prompt is REQUIRED to satisfy (for the critic's gate). */
export function requiredClauseIds(shotText: string): string[] {
  return physicsClausesFor(shotText).map((c) => c.id);
}
