/**
 * Diagnostic script: reproduces the exact API pipeline data flow
 * to inspect what FFmpeg filter would be generated.
 *
 * Mimics: route.ts → getCached() → extractFaceInfo() → generateTemplate() → buildEditingPlan() → buildFilterComplex()
 */

import fs from 'fs';
import path from 'path';

// Load the cached blueprint (simulating getCached which unwraps .data)
const bpRaw = JSON.parse(fs.readFileSync('public/analysis/.cache/278b7f948b1f1d35-visual_blueprint.json', 'utf8'));
const blueprint = bpRaw.data; // getCached returns .data

console.log("════════════════════════════════════════");
console.log("DIAGNOSTIC: Tracing API Pipeline Data");
console.log("════════════════════════════════════════\n");

// === STEP 1: Extract face info (same as route.ts lines 308-314) ===
console.log("1. FACE INFO EXTRACTION");
console.log("   blueprint.aroll exists:", !!blueprint.aroll);
console.log("   blueprint.aroll.recommendedCrop:", JSON.stringify(blueprint.aroll?.recommendedCrop));
console.log("   blueprint.aroll.resolution:", JSON.stringify(blueprint.aroll?.resolution));
console.log("   blueprint.aroll.faceFrames count:", blueprint.aroll?.faceFrames?.length);

// Simulate extractFaceInfo
let faceInfo;
if (blueprint.aroll) {
  const rc = blueprint.aroll.recommendedCrop;
  if (rc?.circle) {
    faceInfo = {
      center: { x: rc.circle.centerX, y: rc.circle.centerY },
      sourceResolution: blueprint.aroll.resolution ?? { width: 1920, height: 1080 },
    };
  }
}
console.log("   → faceInfo:", JSON.stringify(faceInfo));

// === STEP 2: Simulate template generation face center ===
console.log("\n2. TEMPLATE faceCropCenter");
const faceCropCenter = faceInfo
  ? { x: faceInfo.center.x, y: faceInfo.center.y }
  : { x: Math.round(1080 / 2), y: Math.round(1920 * 0.3) };
console.log("   → faceCropCenter:", JSON.stringify(faceCropCenter));

// === STEP 3: Load the API-generated template (or reconstruct) ===
// Since the test script overwrote sp-temp, let's reconstruct what the API would generate
// by looking at blueprint segments
console.log("\n3. BLUEPRINT SEGMENTS");
const segments = blueprint.reference.segments;
for (const seg of segments) {
  console.log(`   ${seg.id}: ${seg.start}-${seg.end}s, aroll region:`,
    JSON.stringify(seg.arollRegion?.boundingBox || 'none'),
    'shape:', seg.arollRegion?.shape || 'none');
}

// === STEP 4: Now let's compute what computeFaceCrop produces ===
console.log("\n4. computeFaceCrop CALCULATIONS");

function computeFaceCrop(targetW, targetH, faceCenterX, faceCenterY, sourceW, sourceH) {
  const scaleW = targetW / sourceW;
  const scaleH = targetH / sourceH;
  const baseScale = Math.max(scaleW, scaleH);

  const faceFractionX = faceCenterX / sourceW;
  const faceFractionY = faceCenterY / sourceH;

  let faceScale = baseScale;

  const fxClamped = Math.max(0.1, Math.min(0.9, faceFractionX));
  const fyClamped = Math.max(0.1, Math.min(0.9, faceFractionY));

  const neededScaleForX = targetW / (2 * Math.min(fxClamped, 1 - fxClamped) * sourceW);
  const neededScaleForY = targetH / (2 * Math.min(fyClamped, 1 - fyClamped) * sourceH);

  faceScale = Math.min(
    baseScale * 2,
    Math.max(baseScale, neededScaleForX, neededScaleForY)
  );

  const scaledW = Math.round(sourceW * faceScale);
  const scaledH = Math.round(sourceH * faceScale);
  const evenScaledW = scaledW + (scaledW % 2);
  const evenScaledH = scaledH + (scaledH % 2);

  const faceX = Math.round(faceCenterX * faceScale);
  const faceY = Math.round(faceCenterY * faceScale);

  const cropX = Math.max(0, Math.min(faceX - Math.round(targetW / 2), evenScaledW - targetW));
  const cropY = Math.max(0, Math.min(faceY - Math.round(targetH / 2), evenScaledH - targetH));

  return { scaledW: evenScaledW, scaledH: evenScaledH, cropX, cropY,
           _debug: { baseScale, faceScale, neededScaleForX, neededScaleForY,
                     faceFractionX, faceFractionY, faceX, faceY } };
}

const sourceW = 1920, sourceH = 1080;
const fcX = faceCropCenter.x, fcY = faceCropCenter.y;

// For rectangle layout (from blueprint seg_1)
const seg1 = segments[0];
const rectRegion = seg1.arollRegion?.boundingBox;
if (rectRegion) {
  console.log("   Rectangle region from blueprint seg_1:", JSON.stringify(rectRegion));
  let targetW = rectRegion.width;
  let targetH = rectRegion.height;

  // V5.1 aspect ratio fix
  if (targetW >= 1080 * 0.9) {
    const sourceAspect = sourceW / sourceH;
    const aspectCorrectH = Math.round(targetW / sourceAspect);
    targetH = aspectCorrectH + (aspectCorrectH % 2);
    console.log(`   V5.1 fix: targetH ${rectRegion.height} → ${targetH} (preserving ${sourceW}/${sourceH} aspect)`);
  }

  const result = computeFaceCrop(targetW, targetH, fcX, fcY, sourceW, sourceH);
  console.log(`   computeFaceCrop(${targetW}, ${targetH}, ${fcX}, ${fcY}, ${sourceW}, ${sourceH}):`);
  console.log(`   → scale=${result.scaledW}:${result.scaledH}, crop=${targetW}:${targetH}:${result.cropX}:${result.cropY}`);
  console.log(`   → debug:`, JSON.stringify(result._debug, null, 2));

  // Where is the face in the cropped output?
  const faceInCropX = result._debug.faceX - result.cropX;
  const faceInCropY = result._debug.faceY - result.cropY;
  console.log(`   → Face position in crop: (${faceInCropX}, ${faceInCropY}) out of ${targetW}×${targetH}`);
  console.log(`   → Face % position: (${(faceInCropX/targetW*100).toFixed(1)}%, ${(faceInCropY/targetH*100).toFixed(1)}%)`);
}

// For circle PIP layout (from blueprint seg_2+)
const seg2 = segments[1];
const circleRegion = seg2.arollRegion?.boundingBox;
if (circleRegion) {
  console.log("\n   Circle region from blueprint seg_2:", JSON.stringify(circleRegion));
  const targetW = circleRegion.width;
  const targetH = circleRegion.height;

  const result = computeFaceCrop(targetW, targetH, fcX, fcY, sourceW, sourceH);
  console.log(`   computeFaceCrop(${targetW}, ${targetH}, ${fcX}, ${fcY}, ${sourceW}, ${sourceH}):`);
  console.log(`   → scale=${result.scaledW}:${result.scaledH}, crop=${targetW}:${targetH}:${result.cropX}:${result.cropY}`);
  console.log(`   → debug:`, JSON.stringify(result._debug, null, 2));

  const faceInCropX = result._debug.faceX - result.cropX;
  const faceInCropY = result._debug.faceY - result.cropY;
  console.log(`   → Face position in crop: (${faceInCropX}, ${faceInCropY}) out of ${targetW}×${targetH}`);
  console.log(`   → Face % position: (${(faceInCropX/targetW*100).toFixed(1)}%, ${(faceInCropY/targetH*100).toFixed(1)}%)`);
}

// === STEP 5: What the actual generated template regions would be ===
// The template generator clusters segments and uses MEDIAN coordinates.
// Let me check what the template generator would compute for each layout.
console.log("\n5. TEMPLATE REGION COMPUTATION");
console.log("   (This requires running generateTemplate, let's trace what the saved video used)");

// The video was rendered at 2:06 PM. The sp-temp files were overwritten by test at 2:08 PM.
// So we can't see the API's template directly.
// But we CAN reconstruct it from the blueprint segments.

// seg_1: fullscreen_aroll type
// seg_2-5: circle_pip type
console.log("\n   Seg_1 A-roll BBox (will become fullscreen_aroll region):");
console.log("   ", JSON.stringify(segments[0].arollRegion?.boundingBox));
console.log("\n   Seg_2+ A-roll BBoxes (will become circle_pip region, uses median):");
for (let i = 1; i < segments.length; i++) {
  console.log(`   seg_${i+1}:`, JSON.stringify(segments[i].arollRegion?.boundingBox));
}

// Also check what B-roll regions would be
console.log("\n   B-roll regions:");
for (const seg of segments) {
  console.log(`   ${seg.id}: broll region:`, JSON.stringify(seg.brollRegion?.boundingBox || 'none'),
    'isBackground:', seg.brollRegion?.isBackground);
}

// === STEP 6: Check what arollMeta.resolution the API gets ===
console.log("\n6. A-ROLL SOURCE DIMENSIONS");
console.log("   The API calls getVideoMetadata(arollPath) → arollMeta.resolution");
console.log("   A-roll source video: public/uploads/IMG_6108.MOV");
console.log("   Expected: 1920×1080 (from blueprint.aroll.resolution)");
console.log("   This is what gets passed as arollSourceDimensions to buildRenderArgsWithScript()");

console.log("\n═══════════════════════════════════════════════════");
console.log("CRITICAL: The sp-temp template was from the TEST SCRIPT,");
console.log("not the API. The API's template had faceCropCenter (650,425),");
console.log("NOT (940,350). Math must be traced with (650,425).");
console.log("═══════════════════════════════════════════════════");
