/**
 * Steps 1.4 & 1.5 — Material Analysis
 *
 * Analyzes uploaded A-roll and B-roll materials:
 * - A-roll: face detection, smart crop, transcription verification
 * - B-roll: content tagging per frame, scene segmentation
 */

import path from "path";
import fs from "fs";
import { extractFrames, detectSilence, getVideoMetadata } from "./frameExtractor";
import { detectFacesInFrames, tagBRollFrames } from "./screenshotAnalyzer";
import { withCache } from "./analysisCache";
import type {
  ARollMaterialAnalysis,
  BRollMaterialAnalysis,
  BRollInternalScene,
  FaceFrame,
  BoundingBox,
  Transcription,
} from "@/lib/types/blueprint";

// ── A-roll Material Analysis (Step 1.4) ──

/**
 * Analyze A-roll material: face positions, smart crop, silence regions.
 *
 * @param videoPath - Absolute path to A-roll video
 * @param existingTranscription - Transcription from existing Gemini analysis (optional)
 */
export async function analyzeARollMaterial(
  videoPath: string,
  existingTranscription?: Transcription
): Promise<ARollMaterialAnalysis> {
  return withCache(videoPath, "aroll_material", async () => {
    console.log("[MaterialAnalyzer] Analyzing A-roll:", path.basename(videoPath));

    // 1. Get video metadata
    const meta = await getVideoMetadata(videoPath);

    // 2. Extract frames at 1s intervals for face detection
    const frames = await extractFrames(videoPath, {
      intervalSeconds: 1.0,
      includeSceneChanges: false, // A-roll is usually continuous
      category: "aroll",
      maxFrames: 60, // Max 60 frames (1 per second for up to 60s video)
    });

    // 3. Detect silence regions
    const silenceRegions = meta.hasAudio
      ? await detectSilence(videoPath, -30, 0.3)
      : [];

    // 4. Face detection via Gemini Vision
    const faceFrames = await detectFacesInFrames(frames, 6, 500);

    // 5. Calculate recommended crop from face positions
    const recommendedCrop = calculateSmartCrop(faceFrames, meta.resolution);

    // 6. Build edit points from silence boundaries
    const editPoints = silenceRegions.flatMap((sr) => [
      { timestamp: sr.start, type: "silence_start" },
      { timestamp: sr.end, type: "silence_end" },
    ]);

    // 7. Calculate speech ratio
    const totalSilence = silenceRegions.reduce((sum, sr) => sum + sr.duration, 0);
    const speechRatio = meta.duration > 0 ? 1 - totalSilence / meta.duration : 1;

    return {
      videoPath,
      duration: meta.duration,
      resolution: meta.resolution,
      transcription: existingTranscription ?? {
        full_text: "",
        language: "unknown",
        words: [],
        sentences: [],
      },
      faceFrames,
      recommendedCrop,
      silenceRegions,
      editPoints,
      speechRatio,
    };
  });
}

/**
 * Calculate smart crop center from face positions.
 * Uses median face position to be robust against outliers.
 */
function calculateSmartCrop(
  faceFrames: FaceFrame[],
  resolution: { width: number; height: number }
): ARollMaterialAnalysis["recommendedCrop"] {
  if (faceFrames.length === 0) {
    // Default: center of frame
    const cx = Math.round(resolution.width / 2);
    const cy = Math.round(resolution.height / 2);
    const radius = Math.round(Math.min(resolution.width, resolution.height) * 0.3);
    return {
      circle: { centerX: cx, centerY: cy, radius },
      rectangle: {
        x: cx - radius,
        y: cy - radius,
        width: radius * 2,
        height: radius * 2,
      },
    };
  }

  // Use median for robustness
  const centerXs = faceFrames.map((f) => f.faceCenter.x).sort((a, b) => a - b);
  const centerYs = faceFrames.map((f) => f.faceCenter.y).sort((a, b) => a - b);
  const widths = faceFrames.map((f) => f.faceBoundingBox.width).sort((a, b) => a - b);
  const heights = faceFrames.map((f) => f.faceBoundingBox.height).sort((a, b) => a - b);

  const medianIdx = Math.floor(faceFrames.length / 2);
  const medianCX = centerXs[medianIdx];
  const medianCY = centerYs[medianIdx];
  const medianW = widths[medianIdx];
  const medianH = heights[medianIdx];

  // Circle: use the larger of width/height as diameter, with some margin
  const circleRadius = Math.round(Math.max(medianW, medianH) * 0.8);

  // Rectangle: slightly wider than face bounding box
  const rectW = Math.round(medianW * 1.6);
  const rectH = Math.round(medianH * 1.4);

  return {
    circle: {
      centerX: Math.round(medianCX),
      centerY: Math.round(medianCY),
      radius: circleRadius,
    },
    rectangle: {
      x: Math.round(medianCX - rectW / 2),
      y: Math.round(medianCY - rectH / 2),
      width: rectW,
      height: rectH,
    },
  };
}

// ── B-roll Material Analysis (Step 1.5) ──

/**
 * Analyze B-roll material: content tagging, scene segmentation.
 *
 * @param videoPath - Absolute path to B-roll video
 */
export async function analyzeBRollMaterial(
  videoPath: string
): Promise<BRollMaterialAnalysis> {
  return withCache(videoPath, "broll_material", async () => {
    console.log("[MaterialAnalyzer] Analyzing B-roll:", path.basename(videoPath));

    // 1. Get video metadata
    const meta = await getVideoMetadata(videoPath);

    // 2. Extract frames at 1s intervals + scene changes
    const frames = await extractFrames(videoPath, {
      intervalSeconds: 1.0,
      includeSceneChanges: true,
      sceneThreshold: 0.3,
      category: "broll",
      maxFrames: 120,
    });

    // 3. Content tag each frame via Gemini Vision
    const frameContent = await tagBRollFrames(frames, 6, 500);

    // 4. Group frames into internal scenes based on content similarity
    const internalScenes = groupIntoScenes(frameContent);

    // 5. Determine overall content type and motion
    const contentType = inferContentType(frameContent);
    const motionType = inferMotionType(frameContent);

    return {
      videoPath,
      duration: meta.duration,
      resolution: meta.resolution,
      contentType,
      motionType,
      frameContent,
      internalScenes,
    };
  });
}

/**
 * Group consecutive frames with similar content tags into scenes.
 */
function groupIntoScenes(
  frameContent: { timestamp: number; contentTags: string[]; visibleText?: string[]; uiElements?: string[]; topicMatch: string }[]
): BRollInternalScene[] {
  if (frameContent.length === 0) return [];

  const scenes: BRollInternalScene[] = [];
  let currentScene: BRollInternalScene = {
    start: frameContent[0].timestamp,
    end: frameContent[0].timestamp,
    description: frameContent[0].topicMatch,
    contentTags: [...frameContent[0].contentTags],
    visibleText: [...(frameContent[0].visibleText ?? [])],
    uiElements: [...(frameContent[0].uiElements ?? [])],
  };

  for (let i = 1; i < frameContent.length; i++) {
    const frame = frameContent[i];
    const prevFrame = frameContent[i - 1];

    // Check content similarity: if >50% of tags match, same scene
    const commonTags = frame.contentTags.filter((t) =>
      prevFrame.contentTags.includes(t)
    );
    const similarity =
      prevFrame.contentTags.length > 0
        ? commonTags.length / Math.max(prevFrame.contentTags.length, 1)
        : 0;

    if (similarity >= 0.5) {
      // Same scene — extend
      currentScene.end = frame.timestamp;
      // Add new unique tags
      for (const tag of frame.contentTags) {
        if (!currentScene.contentTags.includes(tag)) {
          currentScene.contentTags.push(tag);
        }
      }
      // Accumulate OCR text (deduplicated)
      for (const text of (frame.visibleText ?? [])) {
        if (!currentScene.visibleText!.includes(text)) {
          currentScene.visibleText!.push(text);
        }
      }
      // Accumulate UI elements (deduplicated)
      for (const ui of (frame.uiElements ?? [])) {
        if (!currentScene.uiElements!.includes(ui)) {
          currentScene.uiElements!.push(ui);
        }
      }
    } else {
      // New scene — save current and start new
      if (currentScene.end - currentScene.start >= 0.5) {
        scenes.push(currentScene);
      }
      currentScene = {
        start: frame.timestamp,
        end: frame.timestamp,
        description: frame.topicMatch,
        contentTags: [...frame.contentTags],
        visibleText: [...(frame.visibleText ?? [])],
        uiElements: [...(frame.uiElements ?? [])],
      };
    }
  }

  // Save last scene
  if (currentScene.end - currentScene.start >= 0.5 || scenes.length === 0) {
    scenes.push(currentScene);
  }

  return scenes;
}

/**
 * Infer overall content type from frame tags.
 */
function inferContentType(
  frameContent: { contentTags: string[]; uiElements: string[] }[]
): BRollMaterialAnalysis["contentType"] {
  const allTags = frameContent.flatMap((f) => f.contentTags);
  const allUI = frameContent.flatMap((f) => f.uiElements);

  // Count UI elements — high UI count suggests screen recording
  const uiCount = allUI.length;
  const frameCount = frameContent.length;

  if (uiCount > frameCount * 2) return "screen_recording";

  const tagStr = allTags.join(" ").toLowerCase();
  if (tagStr.includes("animation") || tagStr.includes("motion_graphics")) return "animation";
  if (tagStr.includes("photo") || tagStr.includes("still")) return "image";

  return "video";
}

/**
 * Infer motion type from frame content.
 */
function inferMotionType(
  frameContent: { contentTags: string[] }[]
): string {
  const allTags = frameContent.flatMap((f) => f.contentTags).join(" ").toLowerCase();

  if (allTags.includes("scroll")) return "scroll";
  if (allTags.includes("pan")) return "pan";
  if (allTags.includes("zoom")) return "zoom";
  if (allTags.includes("static") || allTags.includes("still")) return "static";

  return "mixed";
}
