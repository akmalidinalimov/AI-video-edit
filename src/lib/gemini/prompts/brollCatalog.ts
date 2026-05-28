export const BROLL_CATALOG_PROMPT = `Analyze this B-roll asset (image or video) for use in a short-form video edit.

The output video will be 1080×1920 (9:16 vertical).

Analyze:
1. CONTENT: What does this show? Describe in detail.
2. CLASSIFICATION: Categorize as: "product_shot"|"screenshot"|"app_demo"|"lifestyle"|"text_graphic"|"illustration"|"stock_footage"|"behind_scenes"|"other"
3. QUALITY: Score 0-100 based on resolution, clarity, composition, lighting
4. TEXT/OCR: Read any visible text
5. COLORS: Dominant color palette (for matching)
6. FOR VIDEOS:
   - Duration
   - Usable segments (trim start/end if there are dead spots)
   - Camera motion type
7. CROP RECOMMENDATION: How should this be cropped/scaled to fit 1080×1920?
   - If there's an iOS recording bar at the top, note it
   - Recommend crop coordinates

Respond in JSON:
{
  "type": "image"|"video",
  "content_summary": "detailed description",
  "classification": "product_shot"|"screenshot"|"app_demo"|"lifestyle"|"text_graphic"|"illustration"|"stock_footage"|"behind_scenes"|"other",
  "quality_score": 0-100,
  "visible_text": ["text found via OCR"],
  "dominant_colors": ["#hex1", "#hex2", "#hex3"],
  "duration": seconds_or_null,
  "usable_segments": [ { "start": sec, "end": sec, "description": "..." } ],
  "camera_motion": "static"|"pan"|"zoom"|"handheld"|null,
  "crop_recommendation": {
    "strategy": "scale_to_fill"|"scale_to_fit"|"crop_center"|"crop_custom",
    "crop": { "x": px, "y": px, "width": px, "height": px },
    "notes": "e.g., iOS recording bar detected at top 80px"
  },
  "semantic_tags": ["tag1", "tag2", "tag3"],
  "best_use": "background_scroll"|"full_screen"|"split_screen"|"overlay"
}`;
