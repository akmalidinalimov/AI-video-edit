/** Verify the framing planner: region → matching aspect + headroom rule; + engine injection. */
import { planFraming, framingForRegion, closestAspect } from "../src/lib/pipeline/broll-framing.ts";
import { buildComponentInstruction } from "../src/lib/pipeline/broll-prompt-engine.ts";

let fails = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${JSON.stringify(got)})`}`); if (!c) fails++; };

console.log("=== closest aspect ===");
ok("square region (1.0) -> 1:1", closestAspect(1.0) === "1:1");
ok("tall region (0.56) -> 9:16", closestAspect(0.56) === "9:16");
ok("wide region (1.55) -> 16:9", closestAspect(1.55) === "16:9");

console.log("\n=== our real B-roll regions ===");
const square = framingForRegion({ width: 1080, height: 1080 });   // rect_pip_bottom — the bug case
const wide = framingForRegion({ width: 1080, height: 697 });       // fullscreen_aroll
const band = framingForRegion({ width: 1080, height: 835 });       // rect_pip_top
console.log(`  1080x1080 -> ${square.generateAspect}, ${square.shotType}`);
console.log(`  1080x697  -> ${wide.generateAspect}, ${wide.shotType}`);
console.log(`  1080x835  -> ${band.generateAspect}, ${band.shotType}`);
ok("SQUARE B-roll region -> generate 1:1 (was the 9:16 head-cut bug)", square.generateAspect === "1:1");
ok("SQUARE region -> waist-up/wider shot (not close-up)", /waist-up|full-body|medium/.test(square.shotType));
ok("WIDE region (1.55) -> generate 16:9 + full-body", wide.generateAspect === "16:9" && /full-body|wide/.test(wide.shotType));
ok("framing direction forbids head-cut", square.direction.includes("head must not be cut") || square.direction.toLowerCase().includes("headroom"));

console.log("\n=== tall region keeps portrait ===");
const tall = planFraming(1080, 1700);
ok("tall region -> 9:16 + medium shot ok", tall.generateAspect === "9:16" && tall.shotType === "medium shot", tall);

console.log("\n=== engine injects the framing direction ===");
const instr = buildComponentInstruction({ concept: "person succeeding", style: "realistic_person", framing: square });
ok("instruction carries the FRAMING line", instr.includes("FRAMING") && instr.toLowerCase().includes("headroom"));
ok("instruction tells the model the square aspect", instr.includes("square") && instr.includes("1:1"));

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
