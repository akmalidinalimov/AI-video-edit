/**
 * Step 1.3 — Screenshot Coordinate Extraction
 *
 * Sends batches of extracted frames to Gemini Vision to get pixel-accurate
 * coordinates for every visual element. This is the KEY UPGRADE from v1
 * where coordinates were guessed.
 *
 * Approach: batch 4 frames per Gemini call with inline image data.
 */

import fs from "fs";
import path from "path";
import { geminiFlash, geminiPro, geminiFallback } from "@/lib/gemini/client";
import {
  buildScreenshotCoordinatesPrompt,
  buildFaceDetectionPrompt,
  buildBRollContentTaggingPrompt,
} from "@/lib/gemini/prompts/screenshotCoordinates";
import type {
  ExtractedFrame,
  FrameCoordinates,
  BoundingBox,
  FaceFrame,
  BRollFrameContent,
  VideoSegment,
} from "@/lib/types/blueprint";

// ── Utilities ──

function readImageAsBase64(imagePath: string): string {
  const buffer = fs.readFileSync(imagePath);
  return buffer.toString("base64");
}

function getMimeType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

/** Chunk array into groups of N */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Delay between API calls to respect rate limits */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Core: Extract coordinates from frames ──

/**
 * Send a batch of frames to Gemini Vision and extract element coordinates.
 * Returns coordinates for each frame in the batch.
 */
async function extractBatchCoordinates(
  frames: ExtractedFrame[],
  canvasWidth: number,
  canvasHeight: number
): Promise<FrameCoordinates[]> {
  const timestamps = frames.map((f) => f.timestamp);
  const prompt = buildScreenshotCoordinatesPrompt(timestamps, canvasWidth, canvasHeight);

  // Build multi-image content parts
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  // Add prompt text first
  parts.push({ text: prompt });

  // Add each frame as inline image
  for (const frame of frames) {
    const mimeType = getMimeType(frame.path);
    const base64 = readImageAsBase64(frame.path);
    parts.push({
      inlineData: { mimeType, data: base64 },
    });
  }

  // Try Flash → Pro → Fallback with retry
  let responseText: string;
  try {
    const result = await geminiFlash.generateContent(parts);
    responseText = result.response.text();
  } catch (flashErr) {
    console.warn("[ScreenshotAnalyzer] Flash failed, trying Pro:", flashErr);
    try {
      const result = await geminiPro.generateContent(parts);
      responseText = result.response.text();
    } catch (proErr) {
      console.warn("[ScreenshotAnalyzer] Pro failed, trying fallback:", proErr);
      try {
        const result = await geminiFallback.generateContent(parts);
        responseText = result.response.text();
      } catch (fallbackErr) {
        console.error("[ScreenshotAnalyzer] All models failed:", fallbackErr);
        throw fallbackErr;
      }
    }
  }

  // Parse JSON response
  let parsed: { frames: Array<{
    timestamp: number;
    layout: string;
    elements: {
      aroll?: {
        boundingBox: BoundingBox;
        shape: "circle" | "rectangle";
        hasBorder: boolean;
        borderColor?: string;
        isCropped: boolean;
      } | null;
      broll?: {
        boundingBox: BoundingBox;
        contentType: string;
        isCropped: boolean;
        hasScrollMotion: boolean;
      } | null;
      texts: Array<{
        text: string;
        boundingBox: BoundingBox;
        isHeadline: boolean;
        estimatedFontSize: number;
        color: string;
        backgroundColor: string | null;
        fontWeight: "normal" | "bold";
      }>;
      blackRegions: Array<{
        boundingBox: BoundingBox;
        purpose: "header" | "footer" | "spacer" | "background";
      }>;
    };
  }> };

  try {
    // Clean response — Gemini sometimes wraps in markdown code blocks
    const cleaned = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("[ScreenshotAnalyzer] Failed to parse response:", responseText.substring(0, 500));
    throw new Error(`Failed to parse Gemini Vision response: ${parseErr}`);
  }

  // Map to FrameCoordinates
  return parsed.frames.map((f, idx) => ({
    timestamp: f.timestamp,
    framePath: frames[idx]?.path ?? "",
    segmentId: "", // Will be filled by cross-validator
    layout: f.layout as FrameCoordinates["layout"],
    elements: {
      aroll: f.elements.aroll ? {
        boundingBox: f.elements.aroll.boundingBox,
        shape: f.elements.aroll.shape,
        hasBorder: f.elements.aroll.hasBorder,
        borderColor: f.elements.aroll.borderColor,
        isCropped: f.elements.aroll.isCropped,
      } : undefined,
      broll: f.elements.broll ? {
        boundingBox: f.elements.broll.boundingBox,
        contentType: f.elements.broll.contentType as BRollFrameContent["contentTags"][number] extends string ? string : string,
        isCropped: f.elements.broll.isCropped,
        hasScrollMotion: f.elements.broll.hasScrollMotion,
      } as FrameCoordinates["elements"]["broll"] : undefined,
      texts: f.elements.texts ?? [],
      blackRegions: f.elements.blackRegions ?? [],
    },
  }));
}

// ── Public API ──

/**
 * Extract pixel-accurate coordinates from all frames of a video.
 *
 * @param frames - Extracted frame files from frameExtractor
 * @param canvasWidth - Target canvas width (default 1080)
 * @param canvasHeight - Target canvas height (default 1920)
 * @param batchSize - Frames per Gemini call (default 4)
 * @param delayMs - Delay between API calls in ms (default 500)
 */
export async function extractAllCoordinates(
  frames: ExtractedFrame[],
  canvasWidth = 1080,
  canvasHeight = 1920,
  batchSize = 4,
  delayMs = 500
): Promise<FrameCoordinates[]> {
  const batches = chunk(frames, batchSize);
  const allCoordinates: FrameCoordinates[] = [];

  console.log(`[ScreenshotAnalyzer] Processing ${frames.length} frames in ${batches.length} batches of ${batchSize}`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[ScreenshotAnalyzer] Batch ${i + 1}/${batches.length} (${batch.length} frames)`);

    try {
      const coordinates = await extractBatchCoordinates(batch, canvasWidth, canvasHeight);
      allCoordinates.push(...coordinates);
    } catch (err) {
      console.error(`[ScreenshotAnalyzer] Batch ${i + 1} failed:`, err);
      // Add empty results for failed frames rather than failing the whole pipeline
      for (const frame of batch) {
        allCoordinates.push({
          timestamp: frame.timestamp,
          framePath: frame.path,
          segmentId: "",
          layout: "full_screen",
          elements: { texts: [], blackRegions: [] },
        });
      }
    }

    // Rate limit delay (skip after last batch)
    if (i < batches.length - 1) {
      await delay(delayMs);
    }
  }

  return allCoordinates;
}

/**
 * Assign segment IDs to frame coordinates based on segment boundaries.
 */
export function assignSegmentIds(
  coordinates: FrameCoordinates[],
  segments: VideoSegment[]
): FrameCoordinates[] {
  return coordinates.map((coord) => {
    // Find which segment this frame belongs to
    const seg = segments.find(
      (s) => coord.timestamp >= s.start && coord.timestamp < s.end
    );
    return {
      ...coord,
      segmentId: seg?.id ?? "unknown",
    };
  });
}

/**
 * Compute consensus coordinates for each segment by averaging across all
 * frames in that segment. This gives more reliable positions than a single frame.
 */
export function computeSegmentConsensus(
  coordinates: FrameCoordinates[],
  segments: VideoSegment[]
): Map<string, FrameCoordinates> {
  const consensus = new Map<string, FrameCoordinates>();

  for (const seg of segments) {
    const segFrames = coordinates.filter((c) => c.segmentId === seg.id);
    if (segFrames.length === 0) continue;

    // Use the most common layout type
    const layoutCounts = new Map<string, number>();
    for (const f of segFrames) {
      layoutCounts.set(f.layout, (layoutCounts.get(f.layout) ?? 0) + 1);
    }
    const consensusLayout = [...layoutCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0][0] as FrameCoordinates["layout"];

    // Average bounding boxes for consistent elements
    const arollFrames = segFrames.filter((f) => f.elements.aroll);
    const brollFrames = segFrames.filter((f) => f.elements.broll);
    const textFrames = segFrames.filter((f) => f.elements.texts.length > 0);

    const avgBBox = (frames: FrameCoordinates[], getter: (f: FrameCoordinates) => BoundingBox | undefined): BoundingBox | undefined => {
      const boxes = frames.map(getter).filter((b): b is BoundingBox => !!b);
      if (boxes.length === 0) return undefined;
      return {
        x: Math.round(boxes.reduce((s, b) => s + b.x, 0) / boxes.length),
        y: Math.round(boxes.reduce((s, b) => s + b.y, 0) / boxes.length),
        width: Math.round(boxes.reduce((s, b) => s + b.width, 0) / boxes.length),
        height: Math.round(boxes.reduce((s, b) => s + b.height, 0) / boxes.length),
      };
    };

    const arollBBox = avgBBox(arollFrames, (f) => f.elements.aroll?.boundingBox);
    const brollBBox = avgBBox(brollFrames, (f) => f.elements.broll?.boundingBox);

    // Pick the first frame's shape/type as representative
    const firstAroll = arollFrames[0]?.elements.aroll;
    const firstBroll = brollFrames[0]?.elements.broll;

    // Collect all unique texts from all frames in this segment
    const allTexts = new Map<string, (typeof segFrames[0])["elements"]["texts"][0]>();
    for (const f of textFrames) {
      for (const t of f.elements.texts) {
        // De-duplicate by text content
        if (!allTexts.has(t.text)) {
          allTexts.set(t.text, t);
        }
      }
    }

    // Collect black regions from most representative frame
    const blackRegions = segFrames[0]?.elements.blackRegions ?? [];

    consensus.set(seg.id, {
      timestamp: seg.start,
      framePath: segFrames[0].framePath,
      segmentId: seg.id,
      layout: consensusLayout,
      elements: {
        aroll: firstAroll && arollBBox ? {
          ...firstAroll,
          boundingBox: arollBBox,
        } : undefined,
        broll: firstBroll && brollBBox ? {
          ...firstBroll,
          boundingBox: brollBBox,
        } : undefined,
        texts: Array.from(allTexts.values()),
        blackRegions,
      },
    });
  }

  return consensus;
}

// ── Face detection for A-roll (Step 1.4 helper) ──

export async function detectFacesInFrames(
  frames: ExtractedFrame[],
  batchSize = 6,
  delayMs = 500
): Promise<FaceFrame[]> {
  const batches = chunk(frames, batchSize);
  const allFaces: FaceFrame[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const timestamps = batch.map((f) => f.timestamp);
    const prompt = buildFaceDetectionPrompt(timestamps);

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: prompt },
    ];
    for (const frame of batch) {
      parts.push({
        inlineData: {
          mimeType: getMimeType(frame.path),
          data: readImageAsBase64(frame.path),
        },
      });
    }

    try {
      const result = await geminiFlash.generateContent(parts);
      const text = result.response.text();
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned) as {
        frames: Array<{
          timestamp: number;
          face: { boundingBox: BoundingBox; center: { x: number; y: number } } | null;
        }>;
      };

      for (const f of parsed.frames) {
        if (f.face) {
          allFaces.push({
            timestamp: f.timestamp,
            faceBoundingBox: f.face.boundingBox,
            faceCenter: f.face.center,
          });
        }
      }
    } catch (err) {
      console.error(`[ScreenshotAnalyzer] Face detection batch ${i + 1} failed:`, err);
    }

    if (i < batches.length - 1) await delay(delayMs);
  }

  return allFaces;
}

// ── B-roll content tagging (Step 1.5 helper) ──

export async function tagBRollFrames(
  frames: ExtractedFrame[],
  batchSize = 6,
  delayMs = 500
): Promise<BRollFrameContent[]> {
  const batches = chunk(frames, batchSize);
  const allContent: BRollFrameContent[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const timestamps = batch.map((f) => f.timestamp);
    const prompt = buildBRollContentTaggingPrompt(timestamps);

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: prompt },
    ];
    for (const frame of batch) {
      parts.push({
        inlineData: {
          mimeType: getMimeType(frame.path),
          data: readImageAsBase64(frame.path),
        },
      });
    }

    try {
      const result = await geminiFlash.generateContent(parts);
      const text = result.response.text();
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned) as {
        frames: Array<{
          timestamp: number;
          contentTags: string[];
          visibleText: string[];
          uiElements: string[];
          topicMatch: string;
        }>;
      };

      allContent.push(...parsed.frames);
    } catch (err) {
      console.error(`[ScreenshotAnalyzer] B-roll tagging batch ${i + 1} failed:`, err);
    }

    if (i < batches.length - 1) await delay(delayMs);
  }

  return allContent;
}
