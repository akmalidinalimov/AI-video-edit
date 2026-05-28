#!/usr/bin/env npx tsx
/**
 * V3 Test: B-Roll Content Matching
 *
 * Validates the B-roll scene matching pipeline end-to-end.
 * Run with: npx tsx scripts/test-v3-broll-matching.ts
 */

import { buildEditingPlan, type BRollScene } from "../src/lib/pipeline/plan-builder.ts";
import { buildFilterComplex } from "../src/lib/pipeline/plan-renderer.ts";
import { generateTemplate } from "../src/lib/pipeline/template-generator.ts";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const TEMP_DIR = path.join(ROOT, "public", "exports", "sp-temp");
const BLUEPRINT_PATH = path.join(ROOT, "public", "analysis", ".cache", "278b7f948b1f1d35-visual_blueprint.json");

console.log("═══════════════════════════════════════════════════════════");
console.log("  V3 TEST: B-ROLL CONTENT MATCHING");
console.log("═══════════════════════════════════════════════════════════\n");

if (!fs.existsSync(BLUEPRINT_PATH)) {
  console.error("❌ No cached blueprint found. Run test-dynamic-pipeline.mjs first.");
  process.exit(1);
}

const rawBlueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, "utf-8"));
// Cache envelope: { timestamp, sourceFile, category, data }
const blueprint = rawBlueprint.data ?? rawBlueprint;
console.log(`  Blueprint: ${blueprint.reference.segments.length} segments\n`);

// Generate template
const template = generateTemplate({
  canvas: blueprint.canvas,
  fps: blueprint.reference.fps,
  segments: blueprint.reference.segments,
  aspectRatio: "9:16",
});
console.log(`  Template: ${template.id} — ${Object.keys(template.layouts).length} layouts\n`);

// ── Shared paths ──
const arollPath = path.join(ROOT, "public", "uploads", "aroll.MOV");
const brollPath = path.join(ROOT, "public", "uploads", "broll.MOV");

// ── Test helpers ──
let passCount = 0;
let failCount = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passCount++;
  } else {
    console.log(`  ✗ ${label}`);
    failCount++;
  }
}

// ════════════════════════════════════════════════════════════
// TEST 1: Semantic matching with B-roll scenes
// ════════════════════════════════════════════════════════════
console.log("\n[1] SEMANTIC MATCHING WITH B-ROLL SCENES");
console.log("────────────────────────────────────────");

const brollScenes: BRollScene[] = [
  { start: 0, end: 5, contentTags: ["intro", "hook", "branding"], description: "Opening" },
  { start: 5, end: 12, contentTags: ["app_demo", "tutorial_step"], description: "Demo" },
  { start: 12, end: 18, contentTags: ["product_feature", "ui_element"], description: "Feature" },
  { start: 18, end: 25, contentTags: ["social_media", "marketing", "results"], description: "Results" },
];

const transcriptionWithTags = {
  words: [] as Array<{ word: string; start: number; end: number }>,
  sentences: [
    { text: "Intro hook", start: 0.5, end: 3.7, semantic_tags: ["intro", "hook"] },
    { text: "Demo step", start: 4.0, end: 8.5, semantic_tags: ["app_demo", "tutorial_step"] },
    { text: "Feature show", start: 9.0, end: 14.0, semantic_tags: ["product_feature"] },
    { text: "Social results", start: 14.5, end: 18.0, semantic_tags: ["social_media", "results"] },
    { text: "CTA", start: 18.5, end: 21.0, semantic_tags: ["marketing", "cta"] },
  ],
};

const plan1 = buildEditingPlan({
  blueprintSegments: blueprint.reference.segments,
  transcription: transcriptionWithTags,
  templateId: template.id,
  template,
  sources: { aroll: arollPath, broll: brollPath },
  brollScenes,
  brollDuration: 25,
});

assert(plan1.validated && plan1.validationErrors.length === 0, "Plan validates successfully");
assert(plan1.layoutRanges.every(r => r.brollOffset !== undefined), "All ranges have brollOffset");
assert(plan1.layoutRanges.every(r => r.brollSourceIndex !== undefined), "All ranges have brollSourceIndex");
assert(plan1.layoutRanges.every(r => (r.brollOffset ?? 0) >= 0 && (r.brollOffset ?? 0) < 25), "All offsets within B-roll bounds");

console.log("\n  Matching results:");
for (const r of plan1.layoutRanges) {
  const tags = r.semanticTags?.join(", ") || "(none)";
  console.log(`    ${r.id}: offset=${r.brollOffset?.toFixed(2)}s | tags=[${tags}]`);
}

// ════════════════════════════════════════════════════════════
// TEST 2: Proportional fallback (no semantic tags)
// ════════════════════════════════════════════════════════════
console.log("\n[2] PROPORTIONAL FALLBACK (NO TAGS)");
console.log("────────────────────────────────────────");

const transcriptionNoTags = {
  words: [] as Array<{ word: string; start: number; end: number }>,
  sentences: [
    { text: "S1", start: 0.5, end: 3.7 },
    { text: "S2", start: 4.0, end: 8.5 },
    { text: "S3", start: 9.0, end: 14.0 },
    { text: "S4", start: 14.5, end: 18.0 },
    { text: "S5", start: 18.5, end: 21.0 },
  ],
};

const scenesNoTags: BRollScene[] = [
  { start: 0, end: 8, contentTags: [] },
  { start: 8, end: 16, contentTags: [] },
  { start: 16, end: 25, contentTags: [] },
];

const plan2 = buildEditingPlan({
  blueprintSegments: blueprint.reference.segments,
  transcription: transcriptionNoTags,
  templateId: template.id,
  template,
  sources: { aroll: arollPath, broll: brollPath },
  brollScenes: scenesNoTags,
  brollDuration: 25,
});

assert(plan2.layoutRanges.every(r => r.brollOffset !== undefined), "Proportional fallback: all ranges have brollOffset");
console.log("  Offsets:", plan2.layoutRanges.map(r => r.brollOffset?.toFixed(2)).join(", "));

// ════════════════════════════════════════════════════════════
// TEST 3: Backward compatibility (no B-roll data)
// ════════════════════════════════════════════════════════════
console.log("\n[3] BACKWARD COMPATIBILITY (NO B-ROLL DATA)");
console.log("────────────────────────────────────────");

const plan3 = buildEditingPlan({
  blueprintSegments: blueprint.reference.segments,
  transcription: transcriptionNoTags,
  templateId: template.id,
  template,
  sources: { aroll: arollPath, broll: brollPath },
});

assert(plan3.layoutRanges.every(r => r.brollOffset === undefined), "No B-roll data → no offsets (backward compat)");

// ════════════════════════════════════════════════════════════
// TEST 4: FFmpeg filter with per-range B-roll offsets
// ════════════════════════════════════════════════════════════
console.log("\n[4] FFMPEG FILTER WITH PER-RANGE OFFSETS");
console.log("────────────────────────────────────────");

const { filterComplex: filter1 } = buildFilterComplex(plan1, template, { width: 1920, height: 1080 });
const rangeCount = plan1.layoutRanges.length;

assert(filter1.includes(`split=${rangeCount}`) || rangeCount === 1, `B-roll split into ${rangeCount} streams`);
assert((filter1.match(/trim=start=/g) || []).length === rangeCount, `${rangeCount} trim filters (one per range)`);
assert(!filter1.includes("concat"), "No concat filter (single-pass preserved)");
assert(filter1.includes("[bg]"), "[bg] label present");
assert(plan1.layoutRanges.every(r => filter1.includes(r.enableExpr)), "All per-range enable expressions in filter");

// ════════════════════════════════════════════════════════════
// TEST 5: FFmpeg filter without offsets → original behavior
// ════════════════════════════════════════════════════════════
console.log("\n[5] FFMPEG FILTER WITHOUT OFFSETS (ORIGINAL)");
console.log("────────────────────────────────────────");

const { filterComplex: filter3 } = buildFilterComplex(plan3, template, { width: 1920, height: 1080 });

assert((filter3.match(/trim=start=/g) || []).length === 0, "No trim filters without offsets");
assert(filter3.includes("[bg]"), "[bg] label present (compat path)");
assert(!filter3.includes("concat"), "No concat filter (single-pass preserved)");

// ════════════════════════════════════════════════════════════
// TEST 6: Plan JSON serialization
// ════════════════════════════════════════════════════════════
console.log("\n[6] PLAN JSON EXPORT");
console.log("────────────────────────────────────────");

const parsed = JSON.parse(JSON.stringify(plan1));
assert(parsed.layoutRanges[0].brollOffset !== undefined, "brollOffset survives JSON serialization");
assert(parsed.layoutRanges[0].brollSourceIndex !== undefined, "brollSourceIndex survives JSON serialization");

// Save artifacts
fs.writeFileSync(path.join(TEMP_DIR, "v3-plan-with-broll.json"), JSON.stringify(plan1, null, 2));
fs.writeFileSync(path.join(TEMP_DIR, "v3-filter-with-offsets.txt"), filter1);
console.log("  Saved: v3-plan-with-broll.json, v3-filter-with-offsets.txt");

// ════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════════");
console.log(`  RESULT: ${failCount === 0 ? "PASS" : "FAIL"}`);
console.log(`  Tests: ${passCount} passed, ${failCount} failed`);
console.log("═══════════════════════════════════════════════════════════");

process.exit(failCount === 0 ? 0 : 1);
