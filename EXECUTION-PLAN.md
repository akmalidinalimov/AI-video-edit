# StyleClone v2 — Execution Plan

## Goal
Transform the StyleClone pipeline from "Gemini-guesses-coordinates" to "screenshot-measured-coordinates" with closed-loop visual verification, producing export-ready videos that pixel-match the reference editing style.

---

## Phase 1: Analysis Engine (the "Eyes")

### Step 1.1 — FFmpeg Frame & Scene Infrastructure
**What**: Build a utility module that extracts frames and detects scene changes from any video file using FFmpeg.

**Input**: Video file path (e.g. `/public/uploads/IMG_6018.MOV`)

**Output**: 
```typescript
interface FrameExtractionResult {
  videoPath: string;
  duration: number;
  fps: number;
  resolution: { width: number; height: number };
  sceneChanges: { timestamp: number; score: number }[];
  frames: {
    timestamp: number;
    path: string;           // e.g. /public/analysis/ref/frame-001.jpg
    isSceneChange: boolean;
  }[];
  silenceRegions: { start: number; end: number; duration: number }[]; // A-roll only
}
```

**Build order**:
1. `src/lib/analysis/frameExtractor.ts` — Core FFmpeg wrapper
   - `extractSceneChanges(videoPath)` — Uses `select='gt(scene,0.3)',showinfo` filter
   - `extractFrames(videoPath, opts)` — Extracts at scene changes + fixed intervals
   - `detectSilence(videoPath)` — Uses `silencedetect=n=-30dB:d=0.3`
   - `getVideoMetadata(videoPath)` — Duration, fps, resolution via ffprobe
2. Frame storage: `/public/analysis/{ref|aroll|broll}/{filename}/frame-{NNN}.jpg`

**Validation**: 
- For the reference video (25s), expect ~6 scene changes and ~50 frames at 0.5s intervals
- Scene change timestamps should align with visible cuts in the video
- Silence regions should align with pauses in speech

**API choice**: FFmpeg only (already installed, free, deterministic, <5s runtime)

**Dependencies**: None (first step)

---

### Step 1.2 — Gemini Video Analysis (Consolidated)
**What**: Merge current Pass 1 (structure) + Pass 3 (transcription) into a single Gemini call. Keep Pass 4 (style fingerprint) separate.

**Input**: Video file uploaded to Gemini Files API

**Output**: 
```typescript
interface VideoAnalysisResult {
  // From current Pass 1
  segments: {
    id: string;
    start: number;
    end: number;
    layout: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side";
    transition_in: string;
    description: string;
  }[];
  editing_rhythm: { avg_segment_duration: number; cut_style: string; pacing: string };
  // From current Pass 3
  transcription: {
    full_text: string;
    language: string;
    words: { word: string; start: number; end: number }[];
    sentences: { text: string; start: number; end: number; semantic_tags: string[] }[];
  };
  visual_events: { timestamp: number; event: string; description: string }[];
  sync_map: { speech_start: number; speech_end: number; speech_text: string; visual_segment: string }[];
}
```

**Validation**:
- Segment count should roughly match scene change count from Step 1.1
- If segment count differs by >2 from scene changes, flag for review and prefer scene change boundaries
- Word timestamps should be monotonically increasing
- Sentence boundaries should roughly align with silence regions from Step 1.1

**API choice**: Gemini 2.5 Flash (fast, cheap, structured JSON output). Fallback to Gemini 2.5 Pro.

**Dependencies**: Can run in parallel with Step 1.1

---

### Step 1.3 — Screenshot Coordinate Extraction (NEW — the key upgrade)
**What**: Send batches of extracted frames to Gemini Vision to get pixel-accurate coordinates for every visual element.

**Input**: 
- Extracted frames from Step 1.1
- Segment boundaries from Step 1.2 (to group frames by segment)

**Output**:
```typescript
interface FrameCoordinates {
  timestamp: number;
  framePath: string;
  segmentId: string;
  layout: "full_screen" | "vertical_split" | "pip_overlay" | "side_by_side";
  elements: {
    aroll?: {
      boundingBox: { x: number; y: number; width: number; height: number };
      shape: "circle" | "rectangle";
      hasBorder: boolean;
      borderColor?: string;
      isCropped: boolean;
      cropRegion?: { top: number; bottom: number; left: number; right: number }; // % cropped
    };
    broll?: {
      boundingBox: { x: number; y: number; width: number; height: number };
      contentType: "screen_recording" | "video" | "image" | "animation" | "text_document";
      isCropped: boolean;
      hasScrollMotion: boolean;
    };
    texts: {
      text: string;
      boundingBox: { x: number; y: number; width: number; height: number };
      isHeadline: boolean;
      estimatedFontSize: number;
      color: string;
      backgroundColor: string | null;
      fontWeight: "normal" | "bold";
    }[];
    blackRegions: {
      boundingBox: { x: number; y: number; width: number; height: number };
      purpose: "header" | "footer" | "spacer" | "background";
    }[];
  };
}
```

**Prompt strategy**: Batch 4 frames per Gemini call with this structured prompt:
```
You are measuring pixel positions on a 1080x1920 (9:16) video canvas.
For each frame image, extract ALL visible elements with their bounding boxes.
Coordinates: (0,0) = top-left, (1080,1920) = bottom-right.

For each frame, return:
- A-roll (talking head / primary footage): bounding box, shape (circle/rectangle), border
- B-roll (background / secondary footage): bounding box, content type, cropping
- Text elements: exact text, bounding box, styling (font size, color, background)
- Black/empty regions: bounding box, purpose

Frame 1 is at timestamp {t1}s, Frame 2 at {t2}s, Frame 3 at {t3}s, Frame 4 at {t4}s.
```

**Validation**:
- All bounding boxes must be within [0,0] to [1080,1920]
- A-roll and B-roll shouldn't have identical bounding boxes (they're different elements)
- For `vertical_split` layout: A-roll.y + A-roll.height should be < B-roll.y (A-roll is above B-roll)
- For `pip_overlay` layout: A-roll bounding box should be smaller than B-roll
- Text positions should be within visible areas (not under other elements)
- Cross-check with Gemini video analysis (Step 1.2): layout types should match

**API choice**: Gemini 2.5 Flash with image inputs (cheapest vision model with structured JSON)
- ~50 frames / 4 per batch = ~13 API calls for reference video
- Cost: ~$0.002 per call = ~$0.03 total

**Dependencies**: Steps 1.1 (frames) + 1.2 (segment boundaries)

---

### Step 1.4 — A-roll Material Analysis
**What**: Analyze uploaded A-roll video — face detection, smart crop calculation, transcription verification.

**Input**: A-roll video file

**Output**:
```typescript
interface ARollMaterialAnalysis {
  videoPath: string;
  duration: number;
  resolution: { width: number; height: number };
  // From existing Gemini analysis (keep as-is)
  transcription: { /* word-level timestamps */ };
  // NEW: Face detection per frame
  faceFrames: {
    timestamp: number;
    faceBoundingBox: { x: number; y: number; width: number; height: number };
    faceCenter: { x: number; y: number };
  }[];
  // NEW: Smart crop for PIP
  recommendedCrop: {
    circle: { centerX: number; centerY: number; radius: number }; // For circle PIP
    rectangle: { x: number; y: number; width: number; height: number }; // For rect PIP
  };
  // From existing analysis
  silenceRegions: { start: number; end: number }[];
  editPoints: { timestamp: number; type: string }[];
  speechRatio: number;
}
```

**Build order**:
1. Run existing Gemini A-roll analysis (keep current prompt — it's good)
2. Extract A-roll frames at 1s intervals (Step 1.1 utility)
3. Run FFmpeg silence detection (Step 1.1 utility)
4. Send frames to Gemini Vision for face bounding boxes (batch 6 per call)
5. Calculate median face position → recommended crop center

**Validation**:
- Face bounding box should be consistent across frames (speaker doesn't teleport)
- Face center should be within the middle 60% of the frame
- Silence regions from FFmpeg should roughly match Gemini's `silence_regions`
- If silence regions differ by >0.5s, use FFmpeg as ground truth (deterministic)

**API choice**: 
- Gemini 2.5 Flash for video analysis (existing)
- Gemini 2.5 Flash for face detection from frames (new)
- FFmpeg for silence detection (new, free)

**Dependencies**: Step 1.1 (frame extraction utility)

---

### Step 1.5 — B-roll Material Analysis
**What**: Analyze uploaded B-roll videos — content tagging per frame, screen recording detection, text/UI detection.

**Input**: B-roll video file(s)

**Output**:
```typescript
interface BRollMaterialAnalysis {
  videoPath: string;
  duration: number;
  resolution: { width: number; height: number };
  // From existing Gemini analysis (keep as-is)
  contentType: "screen_recording" | "video" | "image" | "animation";
  motionType: string;
  // NEW: Per-frame content tags
  frameContent: {
    timestamp: number;
    contentTags: string[];        // e.g. ["app_sidebar", "menu_navigation"]
    visibleText: string[];         // Text readable in the frame
    uiElements: string[];          // e.g. ["button", "list", "header"]
    topicMatch: string;            // Brief description for speech matching
  }[];
  // NEW: Scene segments within the B-roll
  internalScenes: {
    start: number;
    end: number;
    description: string;
    contentTags: string[];
  }[];
}
```

**Build order**:
1. Run existing Gemini B-roll analysis (keep current prompt)
2. Extract B-roll frames at 1s intervals + scene changes (Step 1.1)
3. Send frames to Gemini Vision in batches for content tagging
4. Group tagged frames into internal scenes (consecutive frames with similar tags)

**Validation**:
- Content type from video analysis should match what's visible in frames
- For screen recordings: most frames should have `uiElements.length > 0`
- Internal scenes should have >0.5s duration (no micro-scenes)
- Content tags should be consistent within a scene

**API choice**: Gemini 2.5 Flash for both video and vision analysis

**Dependencies**: Step 1.1 (frame extraction utility)

---

### Step 1.6 — Cross-Validation & Blueprint Assembly
**What**: Merge all analysis results, resolve conflicts, produce the final VisualBlueprint.

**Input**: Results from Steps 1.2, 1.3, 1.4, 1.5

**Output**:
```typescript
interface VisualBlueprint {
  // Canvas spec
  canvas: { width: 1080; height: 1920 };
  
  // Reference video analysis
  reference: {
    duration: number;
    fps: number;
    segments: {
      id: string;
      start: number;          // From FFmpeg scene detection (ground truth)
      end: number;
      layout: string;          // From screenshot analysis (ground truth)
      aroll: {                 // From screenshot analysis (ground truth)
        boundingBox: { x: number; y: number; width: number; height: number };
        shape: "circle" | "rectangle";
        border?: { color: string; width: number };
        isCropped: boolean;
      } | null;
      broll: {
        boundingBox: { x: number; y: number; width: number; height: number };
        contentType: string;
        isCropped: boolean;
        scrollDirection?: string;
      };
      texts: {
        text: string;
        boundingBox: { x: number; y: number; width: number; height: number };
        isHeadline: boolean;
        style: { fontSize: number; color: string; background: string | null; fontWeight: string };
      }[];
      blackRegions: { boundingBox: { x: number; y: number; width: number; height: number } }[];
    }[];
    transcription: { /* from Step 1.2 */ };
    syncMap: { /* speech-to-visual mapping */ };
    styleFingerprint: { /* from Gemini Pass 4 */ };
  };
  
  // Material analysis
  aroll: ARollMaterialAnalysis;
  broll: BRollMaterialAnalysis[];
  
  // Confidence scores
  confidence: {
    segmentBoundaries: number;    // How well FFmpeg + Gemini agree
    coordinates: number;          // How consistent screenshot measurements are
    transcription: number;        // Word timestamp reliability
    overall: number;
  };
  
  // Conflicts detected
  conflicts: {
    description: string;
    resolution: string;
    source: "gemini_video" | "gemini_vision" | "ffmpeg";
  }[];
}
```

**Conflict resolution rules**:
1. **Segment boundaries**: FFmpeg scene detection wins (deterministic pixel analysis)
2. **Layout type**: Screenshot analysis wins (visual proof)
3. **Element coordinates**: Screenshot analysis wins (measured, not guessed)
4. **Transcription timing**: FFmpeg silence detection as anchor, Gemini words within those boundaries
5. **Content classification**: Gemini video analysis + screenshot tags must agree; if not, use screenshot

**Validation**:
- Confidence scores should be >0.7 for all dimensions
- If any confidence <0.5, log warning and suggest manual review
- No segment should have layout="pip_overlay" with A-roll bounding box > 50% of canvas (that's not PIP)
- For vertical_split: black region should exist at top, A-roll in middle, B-roll at bottom
- Total segment durations should sum to within 0.5s of video duration

**Dependencies**: Steps 1.2, 1.3, 1.4, 1.5 (all must complete)

---

### Step 1.7 — Analysis Cache Layer
**What**: Cache analysis results by file hash to avoid redundant API calls.

**Input**: File path
**Output**: Cached VisualBlueprint or null (cache miss)

**Implementation**:
- Hash file with first 1MB + file size + last modified timestamp
- Store in `/public/analysis/.cache/{hash}.json`
- Store extracted frames in `/public/analysis/{hash}/frames/`
- On cache hit: return stored result, skip all API calls
- Cache invalidation: manual clear or file content change

**Dependencies**: None (can be built anytime, but should wrap all analysis calls)

---

## Phase 2: Render Engine (the "Hands")

### Step 2.1 — Segment-Aware FFmpeg Render
**What**: Rewrite the render route to process each timeline segment independently with its correct layout, then concatenate.

**Input**: TimelineDefinition + VisualBlueprint

**Output**: MP4 file at `/public/exports/styleclone-{timestamp}.mp4`

**Per-segment render approach**:
```
For each segment:
  1. Determine layout from timeline
  2. Extract B-roll portion (startFrom → startFrom + duration) 
  3. Extract A-roll portion (startFrom → startFrom + duration)
  4. Build layout-specific filter_complex:
     - vertical_split: black canvas → A-roll region → B-roll region → text overlays
     - pip_overlay: B-roll fullscreen → circle/rect PIP overlay → text overlays
     - full_screen: B-roll only → text overlays
  5. Render segment to temp file
  
Then concatenate all segments via FFmpeg concat demuxer
```

**Layout-specific filter_complex templates**:

**vertical_split**:
```
color=black:s=1080x1920:d={duration}[canvas];
[0:v]scale={broll_w}:{broll_h},crop=...[broll];
[1:v]scale={aroll_w}:{aroll_h},crop=...[aroll];
[canvas][aroll]overlay={aroll_x}:{aroll_y}[step1];
[step1][broll]overlay={broll_x}:{broll_y}[step2];
[step2]drawtext=text='{headline}':x={text_x}:y={text_y}:fontsize={size}:fontcolor={color}[out]
```

**pip_overlay (circle)**:
```
[0:v]scale=1080:1920,crop=1080:1920[bg];
[1:v]scale={pip_w}:{pip_h},crop={pip_w}:{pip_h}[pip_raw];
[pip_raw]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(pow(X-{cx},2)+pow(Y-{cy},2),pow({r},2)),255,0)'[pip];
[bg][pip]overlay={pip_x}:{pip_y}:format=auto[out]
```

**pip_overlay (rectangle)**:
```
[0:v]scale=1080:1920,crop=1080:1920[bg];
[1:v]scale={pip_w}:{pip_h},crop={pip_w}:{pip_h}[pip];
[bg][pip]overlay={pip_x}:{pip_y}[out]
```

**Text rendering**: FFmpeg `drawtext` filter with font file path, or render text as PNG overlay using Node canvas/sharp.

**Validation**:
- Extract frame at 1s into each rendered segment → compare with reference frame at same relative position
- Circle PIP: verify the PIP region is actually circular (check alpha mask)
- Vertical split: verify black region exists at top
- All text should be readable (not cut off by canvas bounds)

**Dependencies**: Phase 1 complete (needs VisualBlueprint coordinates)

---

### Step 2.2 — Text Overlay Rendering
**What**: Render headline text and captions onto the video using FFmpeg drawtext or image overlays.

**Two approaches to evaluate**:

**Option A: FFmpeg drawtext**
- Pros: Single FFmpeg pipeline, no extra dependencies
- Cons: Limited font styling, no background shapes, positioning can be tricky
- Use for: Simple text (headlines, captions)

**Option B: Node.js canvas → PNG → FFmpeg overlay**
- Pros: Full CSS-like text styling, backgrounds, rounded corners, multiple fonts
- Cons: Extra step (generate PNG per text frame)
- Use for: Styled text with backgrounds (like the pink "mutaxassis kerak emas!" banner)

**Recommendation**: Option B for styled headlines, Option A for simple captions

**Dependencies**: Step 2.1 (integrated into segment render pipeline)

---

### Step 2.3 — Audio Mixing
**What**: Correctly map A-roll audio to the final video, handling per-segment audio timing.

**Current issue**: The render route maps `1:a?` globally, which only works when there's a single continuous A-roll. With per-segment rendering, each segment needs its correct audio portion.

**Approach**:
1. Extract full A-roll audio track: `ffmpeg -i aroll.mov -vn -c:a aac audio.m4a`
2. For each segment, calculate the audio offset (globalStart from timeline)
3. Mix into final video during concatenation step

**Dependencies**: Step 2.1

---

## Phase 3: Verification Loop (the "Quality Gate")

### Step 3.1 — Post-Render Frame Extraction
**What**: After export, extract frames from the output video at the same timestamps as the reference frames.

**Input**: Exported MP4 + reference frame timestamps from Phase 1

**Output**: Paired frame sets: `{ refFrame: path, outputFrame: path, timestamp: number }[]`

**Dependencies**: Phase 2 complete

---

### Step 3.2 — Visual Comparison Scoring
**What**: Compare output frames with reference frames using SSIM + Gemini Vision.

**Two-tier comparison**:
1. **SSIM (local, instant)**: Structural similarity score 0-1 per frame pair
   - Install `sharp` npm package (already has SSIM capability) or use FFmpeg ssim filter
   - Score > 0.7 = good structural match
   - Score < 0.5 = significant layout difference
   
2. **Gemini Vision (API, detailed)**: For frames where SSIM < 0.7, send both frames to Gemini:
   ```
   Compare these two frames. Frame 1 is the REFERENCE. Frame 2 is the OUTPUT.
   Identify specific differences:
   - Layout match (same type? elements in same positions?)
   - A-roll position/size/shape match
   - B-roll content appropriate?
   - Text present where expected?
   - Color/mood similar?
   Return a score 0-100 and list of specific issues to fix.
   ```

**Output**:
```typescript
interface VisualComparisonReport {
  overallScore: number;          // 0-100
  frameComparisons: {
    timestamp: number;
    ssimScore: number;
    geminiScore?: number;        // Only for SSIM < 0.7
    issues: string[];
    suggestions: string[];
  }[];
  layoutAccuracy: number;        // 0-100
  coordinateAccuracy: number;    // 0-100
  textPresence: number;          // 0-100
  pipShapeCorrect: boolean;
  overallVerdict: "pass" | "needs_fixes" | "redo_from_scratch";
}
```

**Dependencies**: Step 3.1

---

### Step 3.3 — Auto-Fix or Re-render Decision
**What**: Based on comparison report, decide whether to:
- A) Apply targeted fixes to timeline and re-render specific segments
- B) Adjust coordinates in blueprint and re-render entire video
- C) Flag for manual review

**Decision matrix**:
| Overall Score | Action |
|---|---|
| >= 85 | Pass. Minor fixes optional. |
| 70-84 | Fix timeline coordinates from comparison data, re-render changed segments only |
| 50-69 | Re-render entire video with corrected blueprint |
| < 50 | Flag for manual review — analysis may be wrong |

**My recommendation to your question**: 
- Score >= 70: Apply fixes on top of the existing render (faster)
- Score < 70: Re-render from scratch with corrected blueprint (cleaner result)
- Never patch on top more than once — if first fix doesn't bring score above 85, re-render clean

**Dependencies**: Step 3.2

---

## Phase Execution Order & Timeline

```
Phase 1 (Analysis):
  Step 1.1 [FFmpeg utilities]     ← BUILD FIRST (no dependencies, enables everything)
  Step 1.7 [Cache layer]          ← BUILD SECOND (wraps all subsequent steps)
  Step 1.2 [Gemini video]         ← Can run in PARALLEL with 1.4, 1.5
  Step 1.4 [A-roll material]      ← Can run in PARALLEL with 1.2, 1.5
  Step 1.5 [B-roll material]      ← Can run in PARALLEL with 1.2, 1.4
  Step 1.3 [Screenshot coords]    ← Needs 1.1 + 1.2 complete
  Step 1.6 [Cross-validation]     ← Needs 1.2, 1.3, 1.4, 1.5 complete

Phase 2 (Render):
  Step 2.1 [Segment render]       ← Needs Phase 1 complete
  Step 2.2 [Text overlays]        ← Part of 2.1
  Step 2.3 [Audio mixing]         ← Part of 2.1

Phase 3 (Verification):
  Step 3.1 [Extract output frames] ← Needs Phase 2 complete
  Step 3.2 [Visual comparison]     ← Needs 3.1
  Step 3.3 [Fix decision]          ← Needs 3.2
```

---

## API Choices Summary

| Task | Chosen API | Why | Cost |
|---|---|---|---|
| Scene detection | FFmpeg `select` filter | Free, deterministic, <2s | $0 |
| Frame extraction | FFmpeg | Free, <3s for 50 frames | $0 |
| Silence detection | FFmpeg `silencedetect` | Free, deterministic, <1s | $0 |
| Video analysis | Gemini 2.5 Flash | Already integrated, structured JSON, fast | ~$0.01/video |
| Screenshot coordinates | Gemini 2.5 Flash (vision) | Cheapest vision with JSON output, batch 4 frames | ~$0.03/video |
| Face detection | Gemini 2.5 Flash (vision) | Reuse same API, batch with other frame analysis | ~$0.01/video |
| B-roll content tags | Gemini 2.5 Flash (vision) | Reuse same API | ~$0.01/video |
| Style fingerprint | Gemini 2.5 Flash | Existing Pass 4, keep as-is | ~$0.01/video |
| Frame comparison (SSIM) | FFmpeg `ssim` filter or sharp | Free, instant, no API needed | $0 |
| Visual verification | Gemini 2.5 Flash (vision) | Only for low-SSIM frames | ~$0.01/video |
| Transcription | Gemini 2.5 Flash | Already integrated, Uzbek support | ~$0.01/video |
| Text rendering | Node.js canvas or sharp | Free, local, full styling control | $0 |
| **Total per video** | | | **~$0.10** |

---

## New Dependencies to Install

| Package | Purpose | Size |
|---|---|---|
| `sharp` | Image processing (SSIM comparison, text-to-PNG overlay) | ~25MB |
| `@napi-rs/canvas` | Alternative: Node.js canvas for styled text rendering | ~15MB |

Both are optional — can use FFmpeg drawtext for basic text and FFmpeg ssim filter for comparison if we want zero new dependencies.

---

## Files to Create/Modify

### New files:
- `src/lib/analysis/frameExtractor.ts` — FFmpeg frame/scene/silence utilities
- `src/lib/analysis/screenshotAnalyzer.ts` — Gemini Vision coordinate extraction
- `src/lib/analysis/crossValidator.ts` — Merge & validate all analysis results  
- `src/lib/analysis/analysisCache.ts` — File hash caching layer
- `src/lib/analysis/materialAnalyzer.ts` — A-roll face detection, B-roll content tags
- `src/lib/types/blueprint.ts` — VisualBlueprint, FrameCoordinates types
- `src/lib/render/segmentRenderer.ts` — Per-segment FFmpeg render
- `src/lib/render/textRenderer.ts` — Text overlay PNG generation
- `src/lib/render/videoAssembler.ts` — Concat segments + audio mixing
- `src/lib/verification/visualComparator.ts` — SSIM + Gemini frame comparison
- `src/app/api/analyze/frames/route.ts` — New API endpoint for frame extraction
- `src/lib/gemini/prompts/screenshotCoordinates.ts` — New prompt for vision analysis
- `src/lib/gemini/prompts/referenceConsolidated.ts` — Merged Pass 1+3 prompt

### Modified files:
- `src/app/api/analyze/reference/route.ts` — Use consolidated prompt, add screenshot step
- `src/app/api/analyze/aroll/route.ts` — Add face detection from frames
- `src/app/api/analyze/broll/route.ts` — Add content tagging from frames
- `src/app/api/match/route.ts` — Use VisualBlueprint for coordinate mapping
- `src/app/api/render/route.ts` — Complete rewrite for segment-aware rendering
- `src/lib/matching/timelineBuilder.ts` — Use blueprint coordinates directly
- `src/lib/verification/verifier.ts` — Add visual comparison dimension
- `src/lib/verification/coordinateMap.ts` — Read from VisualBlueprint instead of guessing
- `src/lib/verification/verificationLoop.ts` — Add post-render visual verification step

### Removed/deprecated:
- `src/lib/gemini/prompts/referencePass1.ts` — Merged into consolidated prompt
- `src/lib/gemini/prompts/referencePass3.ts` — Merged into consolidated prompt

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Gemini Vision returns wrong coordinates | Medium | High | Cross-validate with scene detection + use median of multiple frames per segment |
| FFmpeg drawtext can't match reference text styling | High | Medium | Use canvas/sharp for styled text PNGs as overlay images |
| Circle PIP geq filter too slow for long videos | Low | Medium | Pre-render PIP as separate file, then overlay (faster) |
| Gemini API rate limits during batch analysis | Medium | Medium | Add 500ms delay between calls, retry with exponential backoff |
| SSIM gives false positives (high score but wrong layout) | Low | Medium | Always run Gemini Vision on 1 frame per segment regardless of SSIM |
| Large videos (>2min) cause memory issues | Medium | High | Process in 30s chunks, never hold full video in memory |
| A-roll/B-roll audio sync drift after per-segment render | Medium | High | Use precise FFmpeg seek with `-ss` before `-i` for frame accuracy |

---

## Success Criteria

Phase 1 is complete when:
- [ ] Reference video produces a VisualBlueprint with measured coordinates for every element
- [ ] Blueprint coordinates match visual inspection (spot-check 3 frames manually)
- [ ] A-roll face position is accurately detected (within 50px)
- [ ] B-roll content tags correctly describe visible content
- [ ] Scene change timestamps match actual cuts (within 0.3s)
- [ ] Analysis completes in <60 seconds for a 25s video
- [ ] Cache hit returns in <100ms

Phase 2 is complete when:
- [ ] Exported video has correct layout per segment (vertical_split vs pip_overlay)
- [ ] Circle PIP is actually circular (not rectangular)
- [ ] Headlines/text overlays appear at correct positions
- [ ] B-roll changes at speech boundaries
- [ ] Audio is continuous and synced with video
- [ ] Export completes in <60 seconds for a 25s video

Phase 3 is complete when:
- [ ] SSIM comparison produces meaningful 0-1 scores per frame
- [ ] Visual comparison identifies actual layout mismatches
- [ ] Fix-or-redo decision correctly routes to the right action
- [ ] After one fix iteration, score improves by measurable amount
- [ ] Full verify loop completes in <90 seconds
