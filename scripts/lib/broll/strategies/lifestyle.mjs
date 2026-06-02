/**
 * lifestyle.mjs — STUB strategy for "lifestyle / mood / aspirational story" content.
 * Currently delegates to the default real-world reframe.
 *
 * TODO (future, edit ONLY this file): bespoke aspirational lifestyle beats — relatable
 * people, atmosphere, emotional through-line matching the speaker's story.
 */
import { plan as defaultPlan } from "./default.mjs";
export const plan = (segment, cls, opts) => defaultPlan(segment, cls, opts, "lifestyle(stub→default)");
