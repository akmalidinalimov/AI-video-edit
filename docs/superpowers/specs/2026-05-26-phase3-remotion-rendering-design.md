# Phase 3: Remotion Rendering Pipeline — Design Spec

## Overview

Build the video rendering engine that transforms `TimelineDefinition` (from Phase 2) into playable preview and exportable MP4. Uses Remotion 4.x with layer-based composition matching the 4-track timeline model.

**Output**: 1080x1920 @ 30fps vertical video for Instagram Reels / TikTok / YouTube Shorts.

## Architecture

Layer-based composition — each timeline track maps to a Remotion layer. Components are stacked with absolute positioning inside a 1080x1920 frame.

### Component Tree

```
StyleCloneComposition (Root)
├── SpeedRamp (time remapping wrapper)
│   ├── ColorGradeFilter + Vignette + FilmGrain
│   │   ├── SegmentSequence (maps timeline segments)
│   │   │   ├── TransitionWrapper (fade/slide/dissolve)
│   │   │   │   ├── BRollLayer / ParallaxLayer (media + motion keyframes)
│   │   │   │   └── ARollPIP + DynamicSpeakerZoom (speaker overlay)
│   │   │   └── TextOverlays (positioned text elements)
│   │   ├── CaptionRenderer (word-by-word highlight track)
│   │   └── HookOverlay (engagement hook animation)
│   └── ProgressBar (thin animated bar)
├── AudioMixer (voice tracks with ducking)
├── SFXLayer (whoosh/pop/ding synced to events)
└── EndScreen (CTA at final frames)
```

### Data Flow

```
TimelineDefinition (Phase 2 output)
  → StyleCloneVideo receives as inputProps
  → beatDetector analyzes BGM → beat timestamps
  → audioDucker computes volume envelope from voice timing
  → speedRampPlanner computes time remapping from emphasis data
  → Each segment renders: TransitionWrapper > BRollLayer + ARollPIP
  → CaptionTrack renders word-by-word overlaid across segments
  → AudioTrack[] feeds AudioMixer with ducking envelope
  → EngagementHook renders as timed overlay
  → ProgressBar animates across full duration
  → EndScreen renders final CTA frames
  → ColorGrade + Vignette + FilmGrain apply as visual filters
```

## Components

### Core Rendering (8 components)

**BRollLayer** — Renders B-roll media (video/image) with motion keyframe interpolation. Consumes `BRollMotion` from timeline. Handles: scroll (screen recordings), ken_burns (images), pan, zoom_in, zoom_out, static. Uses Remotion's `interpolate()` between keyframe positions.

**ARollPIP** — Speaker picture-in-picture overlay. Circle or rectangle shape with configurable border, shadow, position, size. Uses `<OffthreadVideo>` for the speaker feed cropped to shape via CSS clip-path.

**CaptionRenderer** — Word-by-word caption display with active word highlighting. Reads `CaptionTrack` from timeline. Groups words into lines (6 words max). Active word gets `highlightColor` background. Position and style from `CaptionStyle`.

**HookOverlay** — Engagement hook animation at video start. Supports 4 animation types: pop (scale spring), slide_up (translateY), typewriter (character reveal), fade_in (opacity). Timed by `duration_frames`.

**TransitionWrapper** — Wraps each segment with enter/exit transitions. Types: fade (opacity), slide_left/right (translateX), dissolve (cross-fade), zoom (scale). Duration from `transition_in.duration_frames`.

**TextOverlay** — Positioned text elements with optional animation. Reads from `text_overlays[]` on each segment. Absolute positioning in 1080x1920 space.

**ColorGradeFilter** — CSS filter wrapper applying color temperature, saturation, contrast, brightness from `ColorGrade`. Temperature maps to hue-rotate, warmth to sepia blend.

**AudioMixer** — Renders `<Audio>` components for each track. Voice tracks get per-segment volume. Applies fade_in/fade_out envelopes. Background music gets ducking envelope (computed by audioDucker).

### Enhancement Features (8 components)

**SpeedRamp** — Time remapping wrapper. Accelerates during low-emphasis segments, decelerates at emphasis points and B-roll reveals. Reads emphasis data from transcription. Maps logical time to rendered time using Remotion's `<Freeze>` and playback rate manipulation.

**ProgressBar** — Thin (3px) animated bar at top or bottom of frame. Color from style profile accent or white. Linear progress from 0% to 100% over video duration.

**FilmGrain** — SVG noise filter overlay at low opacity (0.03-0.08). Animated grain pattern using `feTurbulence` with seed cycling per frame. Blended via `mix-blend-mode: overlay`.

**Vignette** — Radial gradient overlay darkening edges. CSS `radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)`. Intensity configurable.

**EndScreen** — CTA card rendered in final 2-3 seconds. Text from user config or auto-generated ("Follow for more"). Styled to match reference text overlay style. Fade-in animation.

**ParallaxLayer** — For static images, splits into foreground/background virtual layers with slight offset movement. Creates perceived depth. Foreground moves 1.5x the base pan, background 0.5x.

**SFXLayer** — Sound effect trigger system. Maps event types to audio files: transition → whoosh, text_appear → pop, caption_highlight → subtle click, hook → ding. Small bundled SFX library.

**DynamicSpeakerZoom** — Monitors speech emphasis (from semantic tags / transcription). When emphasis detected, applies subtle scale pulse (1.0 → 1.08 → 1.0) on ARollPIP over 15 frames. Spring animation.

### Analysis Utilities (3 files)

**beatDetector.ts** — Analyzes background music audio for BPM and beat timestamps. Uses Web Audio API `AnalyserNode` for onset detection. Returns `{ bpm: number, beats: number[] }` (timestamps in seconds). Segment cut points can snap to nearest beat.

**audioDucker.ts** — Computes volume envelope for background music. Input: voice track timing (start/end per segment). Output: volume keyframes — 1.0 during silence, 0.3 during speech, with 10-frame ramps. Returns `{ frame: number, volume: number }[]`.

**thumbnailScorer.ts** — Scores candidate frames for thumbnail suitability. Criteria: has visible face (from A-roll PIP), clear text overlay visible, high color contrast, B-roll quality score. Returns top 3 frame numbers with scores.

**speedRampPlanner.ts** — Plans speed changes from transcription emphasis. Input: content segments with semantic tags. Output: `{ frame: number, speed: number }[]`. Normal speech = 1.0x, emphasis = 0.85x (slight slow-mo), filler = 1.3x (speed up).

## File Structure

```
src/remotion/
├── Root.tsx                         — registerRoot + composition registration
├── compositions/
│   └── StyleCloneVideo.tsx          — main composition
├── components/
│   ├── BRollLayer.tsx
│   ├── ARollPIP.tsx
│   ├── CaptionRenderer.tsx
│   ├── HookOverlay.tsx
│   ├── TransitionWrapper.tsx
│   ├── TextOverlay.tsx
│   ├── ColorGradeFilter.tsx
│   ├── AudioMixer.tsx
│   ├── SpeedRamp.tsx
│   ├── ProgressBar.tsx
│   ├── FilmGrain.tsx
│   ├── Vignette.tsx
│   ├── EndScreen.tsx
│   ├── ParallaxLayer.tsx
│   ├── SFXLayer.tsx
│   └── DynamicSpeakerZoom.tsx
├── utils/
│   ├── vdim.ts                      — (exists) video dimensions
│   └── interpolation.ts             — (exists) animation helpers

src/lib/analysis/
├── beatDetector.ts
├── audioDucker.ts
└── thumbnailScorer.ts

src/lib/matching/
└── speedRampPlanner.ts

src/lib/types/
└── render.ts                        — RenderConfig, ExportFormat, SFXMap

src/components/workspace/
└── PreviewCanvas.tsx                — REWRITE: Remotion Player integration

src/app/api/render/
├── route.ts                         — POST: render timeline → MP4
└── thumbnail/route.ts               — POST: generate thumbnail candidates
```

## Preview Player

Replace current PreviewCanvas placeholder with `@remotion/player`:
- Interactive scrubbing, play/pause, volume
- Real-time preview at reduced resolution (540x960)
- Same composition as render — WYSIWYG
- Responds to timeline changes instantly

## Render API

**POST `/api/render`**
- Input: `{ timeline: TimelineDefinition, format: "9:16" | "1:1" | "16:9" }`
- Uses `@remotion/renderer` `renderMedia()`
- SSE progress updates (same pattern as reference analysis)
- Output: `{ url: string, duration: number, fileSize: number }`
- Default codec: H.264 MP4
- Multi-format: re-render with adjusted composition dimensions

**POST `/api/render/thumbnail`**
- Input: `{ timeline: TimelineDefinition }`
- Uses `renderStill()` at scored frame positions
- Output: `{ thumbnails: { frame: number, url: string, score: number }[] }`

## Multi-Format Export

Same timeline, different compositions:
- **9:16** (1080x1920) — default, full layout
- **1:1** (1080x1080) — center-crop, reposition PIP to corner, captions higher
- **16:9** (1920x1080) — split view: B-roll left, PIP right, captions bottom

Each format adjusts element positions but uses same media and timing.

## Dependencies

Already installed: `remotion`, `@remotion/cli`, `@remotion/player`
May need: `@remotion/renderer` (server-side rendering)
