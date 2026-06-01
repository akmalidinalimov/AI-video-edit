# Multi-A-Roll Pipeline Specification

## Overview

This pipeline takes multiple portrait A-roll video clips and a landscape B-roll, assembles them into a single vertical (1080x1920) video with a circle PIP overlay showing the speaker, and B-roll as background. Transitions between A-roll clips must be seamless — no blank frames, no audio gaps, no mid-sentence cuts.

## Architecture

### Single-Pass FFmpeg Rendering (MANDATORY)

The entire video is rendered in ONE FFmpeg command. Layout switching uses `enable='between(t,start,end)'` on overlay filters. Audio maps directly from trimmed source clips via filter_complex. NEVER render segments separately and concatenate — concatenation always creates boundary artifacts.

### Pipeline Stages

```
Stage 1: Source Analysis
  ├── Face detection (per clip) → face position data
  ├── Audio analysis → silence detection, speech boundaries
  └── Media info → resolution, duration, codec

Stage 2: Timeline Assembly
  ├── Gemini transcription → sentence boundaries + semantic tags
  ├── Narrative ordering → segment sequence by role
  ├── Trim point validation → snap to speech boundaries
  └── Clean timeline output → segments with source offsets

Stage 3: Filter Design
  ├── Crop calculations → per-clip face positioning
  ├── Circle mask generation → YUVA geq alpha mask
  ├── Pad calculation → transparent preamble for timed overlays
  └── Enable expressions → frame-aligned boundaries

Stage 4: Render + Verify
  ├── FFmpeg single-pass render
  ├── Transition frame check → no blank circles
  ├── Audio continuity check → no gaps > 33ms
  ├── Sentence boundary check → no mid-sentence cuts
  └── Quality gate → pass/fail with diagnostics
```

## Critical Rules

### 1. Frame-Aligned Boundaries

ALL timing boundaries must be frame-aligned: `t = round(t * FPS) / FPS`. Enable expressions use EXACT frame boundaries — no half-frame offsets. Adjacent enables share the boundary frame (the later segment wins at that frame due to filter chain ordering).

### 2. Pad-Enable Synchronization

For timed circle PIP overlays, a transparent pad (`color=black@0.0`) is prepended so the overlay stream starts at PTS=0 and outputs transparent frames until the enable window opens. **The pad duration MUST equal the enable start time** — any mismatch creates blank-circle frames at transitions.

```
Pad duration = enableStart (frame-aligned)
Enable start = alignedStart of segment
```

### 3. Sentence-Boundary Transitions

ALL A-roll transitions must snap to sentence boundaries:
- Trim the source AFTER the last word's end (+ natural tail ~50ms)
- Never cut audio mid-word or mid-sentence
- Validate trim points by running silence detection on source clips

### 4. Zero-Delay Audio Transitions

When one A-roll segment ends, the next begins immediately:
- No intentional gaps between segments
- Use audio concat (not crossfade) for zero-delay
- Source trims must be precise — trim at the exact speech boundary
- If there's natural trailing silence in the source, TRIM IT before assembly

### 5. Circle PIP Continuity

The circle PIP must show continuous face content across segment transitions:
- At the transition frame, the NEW segment's face must be immediately visible
- The border ring and circle content must appear/disappear at the SAME frame
- Use `eof_action=pass` on all circle overlays for robustness

## Filter Graph Structure

```
[B-roll] → scale/crop to 1080x1920 → [bg]

Per A-roll clip:
  [clip:v] → setpts → [split if reused]

Per segment (i):
  [src] → trim → crop square → scale 428x428 → circle mask → [circ_content_i]
  
  If not first segment:
    color=black@0.0 (duration=enableStart) → [circ_pad_i]
    [circ_pad_i][circ_content_i] → concat → [circ_i]
  Else:
    [circ_content_i] → copy → [circ_i]
  
  color=white@0.6 (ring mask) → [border_i]
  
  [prev][border_i] → overlay (enable=between(t,start,end)) → [step_n]
  [step_n][circ_i] → overlay (enable=between(t,start,end)) → [step_n+1]

Audio:
  Per segment: [clip:a] → atrim(start, duration) → asetpts → [a_i]
  [a0][a1]...[aN] → concat (not crossfade) → [aout]

Output:
  -map [vout] -map [aout]
```

## Trim Validation Protocol

Before assembling the final video, each trim must be validated:

1. **Extract trimmed audio** for each segment independently
2. **Run silence detection** on each extracted audio
3. **Verify**: First word starts within 50ms of trim start
4. **Verify**: Last word ends within 50ms of trim end (no trailing silence > 100ms)
5. **Verify**: No mid-word cuts (energy doesn't drop sharply at boundaries)

If validation fails, adjust trim points to nearest silence boundary.

## Verification Checks (Post-Render)

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| Blank circle | Extract frames at each transition ±2 frames | No frame has border ring without face content |
| Audio gap | silencedetect on output | No silence > 100ms between segments |
| Sentence cut | Compare waveform at boundaries | Audio energy doesn't drop mid-word |
| Duration | ffprobe output duration | Within 1 frame of expected total |
| Motion | Frame-diff at segment midpoints | Non-zero pixel change (video playing) |
| Black frames | Brightness check | No frames with mean brightness < 10 |

## Agentic Workflow (Future)

```
Orchestrator Agent
├── Trim Agent
│   ├── Analyze source audio (silence detection)
│   ├── Validate sentence boundaries
│   ├── Produce precise trim points
│   └── Output: validated-trims.json
├── Assembly Agent
│   ├── Read validated trims
│   ├── Build filter graph (pad + enable + mask)
│   ├── Calculate crop positions from face data
│   └── Output: filter-complex.txt
├── Render Agent
│   ├── Execute FFmpeg with filter
│   ├── Monitor progress
│   └── Output: rendered video
└── QA Agent
    ├── Extract transition frames
    ├── Run audio checks
    ├── Compare against spec
    └── Output: pass/fail + diagnostics
```

## Constants

```javascript
CANVAS_W = 1080
CANVAS_H = 1920
FPS = 30
CIRCLE_REGION = { x: 567, y: 190, w: 428, h: 428 }
BORDER_WIDTH = 4
CIRCLE_RADIUS = 214
```

## File Locations (Windows)

```
C:\Users\akmal\styleclone\
├── scripts\
│   ├── multi-aroll-stage3-4.mjs  (main render script)
│   └── multi-aroll-verify.mjs    (verification script)
├── public\exports\multi-aroll\
│   ├── stage1\  (face data, clip analysis)
│   ├── stage2\  (clean-timeline.json)
│   ├── stage3\  (method designs)
│   └── stage4\  (rendered outputs, filters, frames)
└── docs\
    └── multi-aroll-spec.md (this file)
```
