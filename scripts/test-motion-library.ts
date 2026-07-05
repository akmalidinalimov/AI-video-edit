/** Verify the motion-design library: integrity + motion tokens + selector + MGCS mapping. */
import { MOTION_DESIGN_LIBRARY, SPRING_PRESETS, EASING_PRESETS, MOTION_TIMING, getMotionStyle, defaultMotionStyleFor, motionStyleToTokens, FALLBACK_MOTION_STYLE } from "../src/lib/pipeline/motion-design-library.ts";

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

const cats = [...new Set(MOTION_DESIGN_LIBRARY.map((s) => s.category))];
console.log(`=== motion library: ${MOTION_DESIGN_LIBRARY.length} styles | categories: ${cats.join(", ")} ===\n`);

// integrity
const ids = MOTION_DESIGN_LIBRARY.map((s) => s.id);
ok("all ids unique", new Set(ids).size === ids.length);
ok("comprehensive (>=15 styles)", MOTION_DESIGN_LIBRARY.length >= 15, MOTION_DESIGN_LIBRARY.length);
ok("every style has full design+motion tokens", MOTION_DESIGN_LIBRARY.every((s) => s.tokens.bg && s.tokens.text && s.tokens.accent && s.tokens.palette.length >= 3 && s.tokens.fontFamily.length > 3 && s.tokens.transition.length > 5));
ok("every spring name is a valid preset", MOTION_DESIGN_LIBRARY.every((s) => s.tokens.spring in SPRING_PRESETS), MOTION_DESIGN_LIBRARY.filter((s) => !(s.tokens.spring in SPRING_PRESETS)).map((s) => s.id));
ok("every mgcsFamily is valid", MOTION_DESIGN_LIBRARY.every((s) => ["glass", "dark", "paper", "warm", "forbidden"].includes(s.mgcsFamily)));
ok("energy values valid", MOTION_DESIGN_LIBRARY.every((s) => ["low", "medium", "high"].includes(s.tokens.energy)));

// motion tokens (the craft layer)
console.log("\n=== motion tokens ===");
ok("7 spring presets with damping/stiffness/mass", Object.keys(SPRING_PRESETS).length === 7 && Object.values(SPRING_PRESETS).every((s) => s.damping > 0 && s.stiffness > 0 && s.mass > 0));
ok("9 easing presets as 4-tuples", Object.keys(EASING_PRESETS).length === 9 && Object.values(EASING_PRESETS).every((e) => e.length === 4));
ok("timing has frame values", MOTION_TIMING.medium === 10 && MOTION_TIMING.staggerStep === 3 && MOTION_TIMING.holdAfterSettle === 15);

// selector
console.log("\n=== selector ===");
ok("realistic_person -> bold_kinetic", defaultMotionStyleFor("realistic_person").id === "bold_kinetic", defaultMotionStyleFor("realistic_person").id);
ok("product -> corporate_clean", defaultMotionStyleFor("product").id === "corporate_clean", defaultMotionStyleFor("product").id);
ok("unknown -> fallback", defaultMotionStyleFor("nonsense").id === FALLBACK_MOTION_STYLE && defaultMotionStyleFor(undefined).id === FALLBACK_MOTION_STYLE);

// MGCS mapping — resolves the named spring into concrete damping/stiffness
console.log("\n=== MGCS token mapping ===");
const bk = motionStyleToTokens("bold_kinetic");
ok("bold_kinetic -> bouncy spring resolved (damping 9 / stiffness 130)", bk.spring.damping === SPRING_PRESETS.bouncy.damping && bk.spring.stiffness === SPRING_PRESETS.bouncy.stiffness, bk.spring);
ok("mapping returns the MGCS shape (bg/text/accent/palette/fontFamily/spring/radius)", !!bk.bg && !!bk.text && !!bk.accent && bk.palette.length > 0 && !!bk.fontFamily && typeof bk.radius === "number");
const cc = motionStyleToTokens("corporate_clean");
ok("corporate_clean -> smooth spring (damping 26 / stiffness 170)", cc.spring.damping === 26 && cc.spring.stiffness === 170, cc.spring);

console.log("\nsample selections:");
for (const id of ["bold_kinetic", "corporate_clean", "liquid_glass", "dataviz_clean"]) {
  const s = getMotionStyle(id)!;
  console.log(`  ${id.padEnd(18)} ${s.tokens.spring.padEnd(10)} energy=${s.tokens.energy.padEnd(6)} accent=${s.tokens.accent} -> ${s.mgcsFamily}`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
