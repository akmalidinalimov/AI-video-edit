/**
 * Step 1.3 — Screenshot Coordinate Extraction Prompt
 *
 * Sends batches of extracted frames to Gemini Vision to get pixel-accurate
 * coordinates for every visual element (A-roll, B-roll, text, black regions).
 */

export function buildScreenshotCoordinatesPrompt(
  frameTimestamps: number[],
  canvasWidth: number,
  canvasHeight: number
): string {
  const frameList = frameTimestamps
    .map((t, i) => `  Frame ${i + 1}: timestamp = ${t.toFixed(2)}s`)
    .join("\n");

  return `You are a precision measurement tool analyzing frames from a ${canvasWidth}x${canvasHeight} (9:16 portrait) video.

For each frame image provided, extract ALL visible elements with their EXACT pixel bounding boxes.

## Coordinate System
- Origin (0,0) = top-left corner
- Maximum (${canvasWidth},${canvasHeight}) = bottom-right corner
- All values are in pixels
- Bounding boxes: { x, y, width, height } where (x,y) is top-left of the element

## Elements to Detect

### A-roll (talking head / primary footage):
- The person's video feed (could be circle PIP, rectangle overlay, or taking up a section of the screen)
- Report: bounding box, shape ("circle" if rounded/circular, "rectangle" if straight edges)
- Report: hasBorder (true if visible border/outline around it), borderColor if applicable
- Report: isCropped (true if the person appears cut off or zoomed in tightly)

### B-roll (background / secondary footage):
- The secondary content — could be screen recording, tutorial, app demo, etc.
- Report: bounding box, contentType ("screen_recording" | "video" | "image" | "animation" | "text_document")
- Report: isCropped, hasScrollMotion (true if content appears to be scrolling)

### Text elements:
- ALL visible text overlays (headlines, captions, labels)
- Report: exact text content, bounding box
- Report: isHeadline (true if it's a prominent title/headline, false for captions/labels)
- Report: estimatedFontSize (in pixels), color (hex), backgroundColor (hex or null)
- Report: fontWeight ("normal" | "bold")

### Black/empty regions:
- Solid black or empty areas that are clearly part of the layout design
- Report: bounding box, purpose ("header" = top area, "footer" = bottom area, "spacer" = between elements, "background" = behind content)

## Rules
1. Measure bounding boxes as tightly as possible around each element
2. For circular A-roll, report the square bounding box that contains the circle
3. If A-roll and B-roll overlap (PIP layout), report BOTH with their correct positions
4. Text must include the EXACT readable characters
5. If an element is partially visible (cut off by screen edge), still report it with the visible portion
6. All coordinates must be within [0, ${canvasWidth}] x [0, ${canvasHeight}]

## Frame Timestamps
${frameList}

Respond ONLY in this JSON format:
{
  "frames": [
    {
      "timestamp": number,
      "layout": "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side",
      "elements": {
        "aroll": {
          "boundingBox": { "x": number, "y": number, "width": number, "height": number },
          "shape": "circle" | "rectangle",
          "hasBorder": boolean,
          "borderColor": "hex string or null",
          "isCropped": boolean
        } | null,
        "broll": {
          "boundingBox": { "x": number, "y": number, "width": number, "height": number },
          "contentType": "screen_recording" | "video" | "image" | "animation" | "text_document",
          "isCropped": boolean,
          "hasScrollMotion": boolean
        } | null,
        "texts": [
          {
            "text": "exact text content",
            "boundingBox": { "x": number, "y": number, "width": number, "height": number },
            "isHeadline": boolean,
            "estimatedFontSize": number,
            "color": "#hex",
            "backgroundColor": "#hex or null",
            "fontWeight": "normal" | "bold"
          }
        ],
        "blackRegions": [
          {
            "boundingBox": { "x": number, "y": number, "width": number, "height": number },
            "purpose": "header" | "footer" | "spacer" | "background"
          }
        ]
      }
    }
  ]
}`;
}

/**
 * Prompt for face detection in A-roll frames (for Step 1.4)
 */
export function buildFaceDetectionPrompt(frameTimestamps: number[]): string {
  const frameList = frameTimestamps
    .map((t, i) => `  Frame ${i + 1}: timestamp = ${t.toFixed(2)}s`)
    .join("\n");

  return `You are analyzing frames from a talking-head video to detect the speaker's face position.

For each frame, find the speaker's face and report:
1. Face bounding box (the area containing the face from forehead to chin, including a small margin)
2. Face center point (center of the bounding box)

If no face is visible in a frame, set face to null.

## Frame Timestamps
${frameList}

Respond in JSON:
{
  "frames": [
    {
      "timestamp": number,
      "face": {
        "boundingBox": { "x": number, "y": number, "width": number, "height": number },
        "center": { "x": number, "y": number }
      } | null
    }
  ]
}`;
}

/**
 * Prompt for B-roll content tagging (for Step 1.5)
 */
export function buildBRollContentTaggingPrompt(frameTimestamps: number[]): string {
  const frameList = frameTimestamps
    .map((t, i) => `  Frame ${i + 1}: timestamp = ${t.toFixed(2)}s`)
    .join("\n");

  return `You are analyzing frames from a B-roll video to tag their content for matching with speech.

For each frame, extract:
1. Content tags: descriptive labels for what's shown (e.g., "app_sidebar", "code_editor", "dashboard")
2. Visible text: any readable text in the frame
3. UI elements: types of UI components visible (e.g., "button", "sidebar", "navigation")
4. Topic match: a brief phrase describing what topic/subject this frame relates to

## Frame Timestamps
${frameList}

Respond in JSON:
{
  "frames": [
    {
      "timestamp": number,
      "contentTags": ["tag1", "tag2"],
      "visibleText": ["text1", "text2"],
      "uiElements": ["element1", "element2"],
      "topicMatch": "brief description for matching with speech content"
    }
  ]
}`;
}
