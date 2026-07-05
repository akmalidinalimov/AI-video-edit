/** Verify the cadence planner: reference-derived rhythm + backward-compat with the legacy 1.5s/2.4s math. */
import { planCadence, estimateShots } from "../src/lib/pipeline/cadence-planner.ts";

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) fails++;
};

console.log("=== planCadence ===");
const ref = planCadence({ avg_segment_duration: 2.5, pacing: "moderate" });
console.log("  reference 2.5s ->", ref);
ok("reference avg drives targetShotSec", ref.targetShotSec === 2.5 && ref.source === "reference", ref);
ok("minSubdivide = 1.6x shot", ref.minSubdivideSec === 4.0, ref.minSubdivideSec);

const fastClamp = planCadence({ avg_segment_duration: 0.8 });
ok("too-fast clamps up to 1.0", fastClamp.targetShotSec === 1.0, fastClamp);
const slowClamp = planCadence({ avg_segment_duration: 7 });
ok("too-slow clamps down to 5.0", slowClamp.targetShotSec === 5.0, slowClamp);

const byPacing = planCadence({ pacing: "fast" });
ok("no avg -> pacing fast = 1.2", byPacing.targetShotSec === 1.2 && byPacing.source === "pacing", byPacing);
const slowPacing = planCadence({ pacing: "slow" });
ok("no avg -> pacing slow = 3.0", slowPacing.targetShotSec === 3.0, slowPacing);

const def = planCadence(null);
console.log("  default (no data) ->", def);
ok("no data -> legacy 1.5s", def.targetShotSec === 1.5 && def.source === "default", def);
ok("no data -> legacy 2.4s minSubdivide (BACKWARD-SAFE)", def.minSubdivideSec === 2.4, def.minSubdivideSec);

console.log("\n=== estimateShots (must mirror legacy round(dur/shot), only if >= minSubdivide) ===");
ok("6s @ default -> 4 shots (legacy example)", estimateShots(6, def) === 4, estimateShots(6, def));
ok("10s @ default -> 7 shots (legacy example)", estimateShots(10, def) === 7, estimateShots(10, def));
ok("2s @ default -> 1 shot (below 2.4)", estimateShots(2, def) === 1, estimateShots(2, def));
ok("6s @ calm 2.5s ref -> 2 shots (slower!)", estimateShots(6, ref) === 2, estimateShots(6, ref));
ok("3s @ calm 2.5s ref -> 1 shot (below 4.0)", estimateShots(3, ref) === 1, estimateShots(3, ref));

console.log("\n=== demo: same 27s output, different references ===");
for (const r of [{ pacing: "fast" }, { avg_segment_duration: 2.5 }, { pacing: "slow" }]) {
  const p = planCadence(r);
  // total shots across a 27s timeline if it were one long range:
  const shots = estimateShots(27, p);
  console.log(`  ${JSON.stringify(r).padEnd(34)} -> shot=${p.targetShotSec}s, ~${shots} B-roll cuts over 27s`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
