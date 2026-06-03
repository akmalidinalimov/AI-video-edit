/**
 * tutorial.mjs — STUB strategy for "tutorial / step-by-step / tool walkthrough".
 * Currently delegates to the default real-world reframe.
 *
 * TODO (future, edit ONLY this file): this is the natural home for NON-GENERATED B-roll
 * kinds — emit Beats with kind:"screen_recording" (a real screen capture of the tool) or
 * kind:"image_sequence" (the reference's "storyboard frames highlighted one-by-one" style:
 * an ordered set of provided images, each held/zoomed for its step). The contract already
 * declares those kinds; the renderer/orchestrator gain a small consumer when we build it.
 */
import { plan as defaultPlan } from "./default.mjs";
export const plan = (segment, cls, opts) => defaultPlan(segment, cls, opts, "tutorial(stub→default)");
