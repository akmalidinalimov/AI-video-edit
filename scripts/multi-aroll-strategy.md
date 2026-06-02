# Multi A-Roll Pipeline — Strategy & Specification

## Inventory

| File | Resolution | Duration | Orientation |
|------|-----------|----------|-------------|
| IMG_6751.MOV | 1072x1920 | 17.95s | Portrait 9:16 |
| IMG_6752.MOV | 1072x1920 | 25.33s | Portrait 9:16 |
| IMG_6753.MOV | 1072x1920 | 21.37s | Portrait 9:16 |
| IMG_6754.MOV | 1072x1920 | 12.43s | Portrait 9:16 |
| **Total raw** | | **77.08s** | |
| **Reference** | 1072x1904 | 24.13s | Portrait |

Reference style: rectangle fullscreen (seg1) + circle PIP over B-roll (seg2-5).

---

## Pipeline Stages

### STAGE 1: Transcription & Visual Analysis
**Agent:** Transcription Agent
**Input:** 4 A-roll video files
**Process:**
1. Extract audio from each clip via FFmpeg
2. Send each audio to Gemini 2.5 Flash for word-level transcription
3. Extract keyframes (1fps) from each clip for face position detection
4. Detect speaker face bounding box in each clip using sharp pixel analysis

**Output per clip:**
- `clip_N_transcription.json` — words with timestamps, sentences with timestamps, semantic_tags
- `clip_N_face.json` — face center (x,y), face bounding box per-second
- Console log of all sentences with timestamps

**Verification:** Every clip has ≥1 sentence, timestamps are monotonically increasing within each clip, face detected in ≥80% of frames.

---

### STAGE 2: Duplicate Detection & Clean Sequence
**Agent:** Narrative Intelligence Agent
**Input:** All 4 transcription JSONs
**Process:**
1. Concatenate all sentences across clips
2. Detect duplicates/restarts using Gemini:
   - Incomplete sentence followed by complete version → keep complete, mark incomplete for removal
   - Exact or near-exact repetition → keep first, remove second
   - Stutters/false starts within a clip → mark trim points
3. Determine narrative order (may differ from file order) using existing `aroll-narrative-orderer.ts` logic
4. Build a "clean timeline" — ordered list of usable segments with:
   - Source clip index
   - In-point (start time within source clip)
   - Out-point (end time within source clip)
   - Sentence text
   - Why this segment was chosen (vs its duplicate)

**Output:**
- `clean-timeline.json` — ordered usable segments
- `duplicate-report.json` — what was removed and why
- Console log showing before/after sentence count

**Verification:** No duplicate content in clean timeline. Total clean duration is ≤ sum of clip durations. Every sentence in clean timeline maps to a valid time range in its source clip.

---

### STAGE 3: Research & Method Design
**Agent:** Research Agent
**Input:** Reference video analysis, clean timeline, style-cloning-principles.md
**Process:**
1. Analyze reference video structure (which segments are rectangle vs circle)
2. Study the face positions across all 4 A-roll clips
3. Determine the cropping challenge: 1072x1920 portrait → circle PIP (428x428) and rectangle (1080x627)
4. Design 3 distinct methods (see below)

**Three Methods:**

#### Method 1: Face-Anchored Center Crop
- Detect face center in each frame
- For circle: crop 1:1 square centered on face, scale to 428x428, apply geq circle mask
- For rectangle: scale full portrait frame to fit 1080-wide, crop height from face center
- Face is always dead-center in the circle
- Simple, predictable, minimal head space

#### Method 2: Head-Space Composition Crop
- Detect face + measure head-to-top distance
- For circle: crop 1:1 square with face in lower 60-65% of frame, preserving cinematic head room
- For rectangle: crop with rule-of-thirds positioning (eyes at upper 1/3 line)
- More professional/cinematic look with intentional negative space above speaker
- Uses the user's suggested approach: "crop 9:16 to 1:1 square so person is centered and covers 90% of frame"

#### Method 3: Smart Reframe (Aspect-Adaptive)
- Analyze the reference video's actual face positioning in each segment type
- For circle: measure where the face sits in the reference circle PIP, replicate that exact positioning ratio
- For rectangle: measure the reference's face position within its rectangle, match it
- Data-driven: copies the reference's own composition choices rather than applying generic rules
- Most accurate to reference but requires good CV measurement of reference face position

**Output:**
- Method descriptions with FFmpeg filter strings
- Face position analysis for all clips

---

### STAGE 4: Multi-Source FFmpeg Render (x3)
**Agent:** Render Agent (runs 3 times)
**Input:** Clean timeline, template, plan, method-specific crop parameters
**Process per method:**
1. Build a single FFmpeg command with ALL 4 A-roll clips as inputs (plus B-roll)
2. Use `enable='between(t,...)'` to switch between clips at the right times
3. Apply method-specific cropping for circle and rectangle segments
4. Continuous audio from the stitched A-roll clips
5. Single-pass render — NO concatenation

**Output per method:**
- `method-N-rendered.mp4` — full rendered video
- `method-N-filter.txt` — the FFmpeg filter graph used
- `method-N-frames/` — extracted keyframes at transition points

**Verification:**
- Video duration matches clean timeline total
- No black frames at transitions
- Audio is continuous (no pops/gaps)
- Circle PIP position consistent across segments

---

### STAGE 5: Comparison & Scoring
**Agent:** Comparison Agent
**Input:** 3 rendered videos + reference video
**Process:**
1. Extract frames from each method at matching timestamps
2. Extract same-timestamp frames from reference
3. Create side-by-side comparison images (reference | method)
4. Score each method on:
   - **Circle composition** (40pts): Face position, head room, circle fill %
   - **Rectangle composition** (20pts): Framing match to reference
   - **Transition smoothness** (20pts): No jumps, no black frames
   - **Audio continuity** (20pts): Clean cuts, no pops

**Output:**
- `comparison/method_N_seg_M.jpg` — side-by-side frames per segment
- `comparison/3way_seg_M.jpg` — all 3 methods side by side
- `scoring.json` — detailed scores per method
- Winner recommendation

**Verification:** All 3 videos render successfully, all comparison images generated, scores are internally consistent.

---

## File Structure

```
public/exports/multi-aroll/
├── stage1/
│   ├── clip_0_transcription.json
│   ├── clip_1_transcription.json
│   ├── clip_2_transcription.json
│   ├── clip_3_transcription.json
│   └── clip_N_face.json (x4)
├── stage2/
│   ├── clean-timeline.json
│   └── duplicate-report.json
├── stage3/
│   └── method-designs.json
├── stage4/
│   ├── method-1-rendered.mp4
│   ├── method-1-filter.txt
│   ├── method-2-rendered.mp4
│   ├── method-2-filter.txt
│   ├── method-3-rendered.mp4
│   └── method-3-filter.txt
└── stage5/
    ├── comparison/
    │   ├── method_1_seg_1.jpg ... method_3_seg_5.jpg
    │   └── 3way_seg_1.jpg ... 3way_seg_5.jpg
    └── scoring.json
```
