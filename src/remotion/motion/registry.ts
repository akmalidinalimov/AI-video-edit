/**
 * Motion-Graphics registry — the single source of truth the Composer queries.
 * Add each new component here. Only `production` components are auto-eligible.
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2.6
 */
import { barChart } from "./components/data-viz/BarChart";
import { counter } from "./components/data-viz/Counter";
import { donutRing } from "./components/data-viz/DonutRing";
import { statBar } from "./components/data-viz/StatBar";
import { comparison } from "./components/data-viz/Comparison";
import { kineticCaption } from "./components/caption/KineticCaption";
import { lowerThird } from "./components/lower-third/LowerThird";
import { kenBurns } from "./components/media/KenBurns";
import type { GraphicType, MotionComponent } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MG_REGISTRY: MotionComponent<any>[] = [
  barChart,
  counter,
  donutRing,
  statBar,
  comparison,
  kineticCaption,
  lowerThird,
  kenBurns,
];

export function getComponent(id: string): MotionComponent | undefined {
  return MG_REGISTRY.find((c) => c.id === id);
}

/** Production components for a graphic category (what the Composer is allowed to use). */
export function resolveByCategory(category: GraphicType): MotionComponent[] {
  return MG_REGISTRY.filter((c) => c.category === category && c.status === "production");
}

/** Coverage report — feeds the learning loop's GAP-CHECK. */
export function coverage(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of MG_REGISTRY) {
    if (c.status === "production") out[c.category] = (out[c.category] ?? 0) + 1;
  }
  return out;
}
