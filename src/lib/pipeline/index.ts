/**
 * AIvo Pipeline — Core modules
 *
 * Phase 1: Ingest & Analyze (existing: analysis/, gemini/)
 * Phase 2: Plan (this module: plan-builder + VCS templates)
 * Phase 3: Render (single-pass FFmpeg renderer)
 * Phase 4: Verify (regression checklist)
 * Phase 5: Iterate (modify plan, re-render)
 */

// VCS Templates — canonical coordinate system
export {
  VCS_VERTICAL_9x16,
  VCS_HORIZONTAL_16x9,
  VCS_TEMPLATES,
  getVCSTemplate,
  getLayout,
} from "./vcs-templates";
export type {
  VCSTemplate,
  LayoutVariant,
  Rect,
  CircleDef,
  BorderDef,
  TextSlot,
} from "./vcs-templates";

// Editing Plan — structured intermediate format
export {
  alignToFrame,
  frameMidpoint,
  buildEnableExprForRange,
  combineEnableExprs,
  validateEditingPlan,
  printEditingPlan,
} from "./editing-plan";
export type {
  EditingPlan,
  LayoutRange,
  TransitionPoint,
  SentenceInfo,
  TextOverlay,
  TimeRange,
  SourceFiles,
  ValidationResult,
} from "./editing-plan";

// Plan Builder — Phase 2 orchestrator
export { buildEditingPlan } from "./plan-builder";
export type {
  PlanBuilderInput,
  BlueprintSegment,
  Transcription,
} from "./plan-builder";

// Dynamic Template Generator — auto-generate templates from any reference
export { generateTemplate, extractFaceInfo } from "./template-generator";

// Plan Renderer — layout-agnostic single-pass FFmpeg filter builder
export {
  buildFilterComplex,
  buildRenderArgs,
  buildRenderArgsWithScript,
  logRenderPlan,
} from "./plan-renderer";
export type { RenderInput, RenderOutput, EncodingOptions } from "./plan-renderer";
