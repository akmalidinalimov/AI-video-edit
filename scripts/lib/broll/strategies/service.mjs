/**
 * service.mjs — STUB strategy for "service" content (agencies/offerings/people doing
 * work for the viewer). Currently delegates to the default real-world reframe.
 *
 * TODO (future, edit ONLY this file): bespoke service beats — team at work, the
 * process/workflow, the result delivered to a happy client.
 */
import { plan as defaultPlan } from "./default.mjs";
export const plan = (segment, cls, opts) => defaultPlan(segment, cls, opts, "service(stub→default)");
