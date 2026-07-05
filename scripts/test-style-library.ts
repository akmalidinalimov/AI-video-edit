/** Verify the style library: integrity + selector + base/modifier compose + engine injection. */
import { STYLE_LIBRARY, baseStyles, modifierStyles, getStyle, defaultStyleFor, composeStyleKeywords, FALLBACK_STYLE, type StyleCategory } from "../src/lib/pipeline/style-library.ts";
import { buildComponentInstruction } from "../src/lib/pipeline/broll-prompt-engine.ts";

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

console.log(`=== library: ${STYLE_LIBRARY.length} entries (${baseStyles().length} styles + ${modifierStyles().length} modifiers) ===`);
const cats = [...new Set(STYLE_LIBRARY.map((s) => s.category))];
console.log(`categories: ${cats.join(", ")}\n`);

// integrity
const ids = STYLE_LIBRARY.map((s) => s.id);
ok("all ids unique", new Set(ids).size === ids.length);
ok("every entry has keywords + description + whenToUse", STYLE_LIBRARY.every((s) => s.keywords.length > 10 && s.description.length > 5 && s.whenToUse.length > 5));
ok("mood_grade entries are modifiers; the rest are styles", STYLE_LIBRARY.every((s) => (s.category === "mood_grade") === (s.kind === "modifier")));
ok("reliability is valid", STYLE_LIBRARY.every((s) => ["high", "medium", "low"].includes(s.reliability)));
ok("library is reasonably comprehensive (>=50)", STYLE_LIBRARY.length >= 50, STYLE_LIBRARY.length);

// selector (stage 1)
console.log("\n=== selector defaults ===");
ok("realistic_person -> naturalistic_handheld", defaultStyleFor("realistic_person").id === "naturalistic_handheld", defaultStyleFor("realistic_person").id);
ok("product -> blender_product_3d", defaultStyleFor("product").id === "blender_product_3d", defaultStyleFor("product").id);
ok("cartoon_animation -> pixar_3d", defaultStyleFor("cartoon_animation").id === "pixar_3d", defaultStyleFor("cartoon_animation").id);
ok("unknown/undefined -> fallback", defaultStyleFor(undefined).id === FALLBACK_STYLE && defaultStyleFor("nonsense").id === FALLBACK_STYLE);

// base + modifier compose
console.log("\n=== compose ===");
const composed = composeStyleKeywords("naturalistic_handheld", "golden_warm");
ok("base+modifier merges both keyword sets", composed.includes("naturalistic handheld") && composed.includes("golden hour grade"), composed.slice(0, 80));
ok("base alone (no modifier) works", composeStyleKeywords("film_noir").includes("black and white"));

// engine injection — classification OR direct id both resolve
console.log("\n=== engine STYLE injection ===");
const i1 = buildComponentInstruction({ concept: "person succeeding", style: "realistic_person" });
ok("classification resolves -> Naturalistic Handheld keywords injected", i1.includes("Naturalistic Handheld") && i1.includes("naturalistic handheld"));
const i2 = buildComponentInstruction({ concept: "mystery scene", style: "film_noir" });
ok("direct style id -> Classic Film Noir keywords injected", i2.includes("Classic Film Noir") && i2.includes("black and white"));
const i3 = buildComponentInstruction({ concept: "warm story", style: "naturalistic_handheld", styleModifier: "golden_warm" });
ok("modifier layers onto base in the instruction", i3.includes("naturalistic handheld") && i3.includes("golden hour grade"));

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
