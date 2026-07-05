/**
 * layout-regions.ts — VLM-DRIVEN MULTI-REGION layout decode.
 *
 * The deterministic layout_analyzer.py handles a 2-region A-roll/B-roll SPLIT (and fullscreen /
 * broll-only). It cannot decode a STACKED COMPOSITE — e.g. a title bar + a B-roll window + a
 * screen-recording strip + a talking head. That is a very common short-form style, and the CV
 * collapses it to "fullscreen" (verified: it misread a 4-layer Grok reel as fullscreen, 3 shots).
 *
 * A VLM (Gemini) DOES understand that structure. This module asks Gemini to decompose the reel
 * into stacked horizontal BANDS (role + vertical extent + persistent-vs-changing), which the CV
 * then refines (snap band edges to measured seams) and measures per band. The VLM proposes the
 * STRUCTURE; the CV measures the PIXELS — the same [V]-structure / [D]-geometry discipline.
 *
 * Non-blocking: returns null on any failure. One Gemini Flash call per reference.
 */
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";
import { geminiFlash } from "@/lib/gemini/client";

export type BandRole =
  | "header_title" | "broll" | "screen_recording" | "aroll"
  | "caption_band" | "graphic_overlay" | "footer" | "pip_inset";

/** Content class of what a band shows during a time window. */
export type BandContentClass = "broll" | "diagram_graphic" | "screen_recording" | "product" | "other";

export interface BandContentWindow {
  start: number;   // seconds
  end: number;     // seconds
  content: BandContentClass | string;
}

export interface RegionBand {
  role: BandRole | string;
  yStart: number;          // 0..1 fraction of frame height (top)
  yEnd: number;            // 0..1
  xStart: number;          // 0..1 fraction of frame width (left edge). Full-width band = 0.
  xEnd: number;            // 0..1 (right edge). Full-width band = 1.
  persistent: boolean;     // true = same across the whole reel (header/A-roll); false = content changes per shot (B-roll)
  shape: string;           // rectangle | rounded_rect | circle
  description: string;
  /** For bands whose CONTENT CLASS changes over time (e.g. B-roll → diagram → screen-rec). Coarse windows in seconds. */
  contentTimeline?: BandContentWindow[];
}

export interface StructureWindow {
  start: number;   // seconds
  end: number;     // seconds
  bands: RegionBand[];
}

export interface RegionLayout {
  layoutClass: string;     // single_fullscreen | two_region_split | multi_region_stack | circle_pip | side_by_side
  bands: RegionBand[];     // contiguous, top→bottom (= structureTimeline[0].bands when a timeline exists)
  arollBandIndex: number;  // index of the talking-head band, or -1
  summary: string;
  /** Only present when the BAND STRUCTURE itself changes over time (rare). Stable structure = one window. */
  structureTimeline?: StructureWindow[];
}

function buildPrompt(): string {
  return `You are a senior short-form video editor reverse-engineering the LAYOUT of a vertical (9:16) reel so it can be reproduced. Modern reels STACK several horizontal regions top-to-bottom — commonly: a TITLE/HEADER bar, one or more B-roll/content windows, a SCREEN-RECORDING or app-UI strip, and the TALKING-HEAD (A-roll). Decompose THIS reel into its stacked horizontal BANDS.

Also common: a persistent PICTURE-IN-PICTURE (PIP) talking-head panel that does NOT span the full width (e.g. a centered rounded-rect bubble ~60% of the frame width) floating over a full-frame background whose content changes over time.

Return STRICT JSON (no markdown, no prose):
{
  "layoutClass": "<single_fullscreen | two_region_split | multi_region_stack | circle_pip | side_by_side>",
  "bands": [
    {
      "role": "<header_title | broll | screen_recording | aroll | caption_band | graphic_overlay | footer | pip_inset>",
      "yStart": <0..1 fraction from the TOP of the frame>,
      "yEnd": <0..1>,
      "xStart": <0..1 fraction from the LEFT of the frame. A band spanning the full width = 0.0>,
      "xEnd": <0..1. Full width = 1.0. A CENTERED PIP that is ~60% of the frame width = e.g. 0.20/0.80 — report its REAL horizontal extent, not 0/1>,
      "persistent": <true if this band stays visually the SAME across the whole video (a fixed title bar, the talking head); false if its CONTENT changes shot-to-shot (a B-roll window, a screen recording)>,
      "shape": "<rectangle | rounded_rect | circle>",
      "description": "<what is in this band>",
      "contentTimeline": [ { "start": <seconds>, "end": <seconds>, "content": "<broll | diagram_graphic | screen_recording | product | other>" } ]
    }
  ],
  "arollBandIndex": <0-based index of the talking-head band in "bands", or -1 if there is no on-screen speaker>,
  "summary": "<one sentence: the layout in a nutshell>",
  "structureTimeline": [ { "start": <seconds>, "end": <seconds>, "bands": [ ...same band objects... ] } ]
}

Rules:
- Order bands TOP→BOTTOM. Make them vertically contiguous: each band's yEnd equals the next band's yStart; together they cover 0.0 to 1.0. Absorb thin gaps into the neighbouring band. (A floating PIP panel is the exception: give its true y and x extents.)
- yStart/yEnd/xStart/xEnd are FRACTIONS 0..1 of frame height/width — never pixels.
- xStart/xEnd: most stacked bands span the full width → 0.0/1.0. Only a panel that is visibly narrower (a PIP bubble, an inset window) gets a tighter x extent — measure it.
- "shape": use "rounded_rect" for panels with visibly rounded corners (very common for PIP bubbles and inset strips).
- "contentTimeline": ONLY for bands whose CONTENT CLASS changes over time — give coarse windows covering the band's on-screen life, one entry per content-class stretch (e.g. product footage 0-20, then a white diagram 20-40, then a screen recording 40-67). Do NOT list every cut — only when the KIND of content switches. "content" MUST be one of exactly: broll, diagram_graphic, screen_recording, product, other. Omit (or []) for persistent bands.
- ALL "start"/"end" times are in SECONDS of video time (a 60-second video ends at 60, NOT at 1.0). Never use fractions of the duration for times.
- "structureTimeline": ONLY include if the BAND STRUCTURE itself changes for a SUSTAINED stretch (several seconds — bands appear/disappear/rearrange). A brief transition or momentary zoom is NOT a structure change. If the structure is stable for the whole video, OMIT this field entirely (this is the common case).
- A plain single talking head with no other regions → layoutClass "single_fullscreen" and ONE band (role aroll).
- A simple 2-way top/bottom split → "two_region_split", two bands.
- The Grok-style stack (title + B-roll + app strip + head) → "multi_region_stack" with 4 bands.
- Look carefully for THIN STRIPS: if a distinct app-UI / timeline / screen-recording strip sits between the main content window and the talking head, report it as its OWN "screen_recording" band with its own y extent — NEVER merge it into the content window above it.
- A persistent PIP speaker over a changing full-frame background → layoutClass "circle_pip" (or "multi_region_stack" if there are also stacked bands): the background is one full-frame band (0..1 both axes) with a contentTimeline; the speaker is an "aroll" band with its real x/y extents and shape.
- Report what you SEE; be precise with the fractions. Output STRICT JSON only.`;
}

function coerceContentTimeline(raw: unknown): BandContentWindow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const windows = (raw as Array<Record<string, unknown>>)
    .map((w) => ({ start: Number(w?.start), end: Number(w?.end), content: String(w?.content ?? "other") }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);
  // Guard: if every time is ≤ 1.5 the model answered in DURATION FRACTIONS, not seconds
  // (observed on R2: windows like 0-0.475 "s"). Unusable — drop rather than mislead.
  if (windows.length && Math.max(...windows.map((w) => w.end)) <= 1.5) return undefined;
  return windows.length ? windows : undefined;
}

function coerceBands(rawBands: Array<Record<string, unknown>>): RegionBand[] {
  const bands: RegionBand[] = rawBands.map((b) => {
    const xStart = clamp01(Number(b.xStart ?? 0));
    const xEnd = clamp01(Number(b.xEnd ?? 1));
    return {
      role: String(b.role ?? "broll"),
      yStart: clamp01(Number(b.yStart ?? 0)),
      yEnd: clamp01(Number(b.yEnd ?? 1)),
      // Default full width; recover from a swapped/degenerate x extent rather than dropping the band.
      xStart: xEnd > xStart ? xStart : 0,
      xEnd: xEnd > xStart ? xEnd : 1,
      persistent: Boolean(b.persistent ?? false),
      shape: String(b.shape ?? "rectangle"),
      description: String(b.description ?? ""),
      contentTimeline: coerceContentTimeline(b.contentTimeline),
    };
  }).filter((b) => b.yEnd > b.yStart);
  // Sort top→bottom.
  bands.sort((a, b) => a.yStart - b.yStart);
  // A band is a floating OVERLAY (e.g. a PIP bubble over a full-frame background) if another band
  // fully covers its y-range. Overlays keep their true y/x extents; only the STACKED bands get the
  // contiguity snap (snapping an overlay would zero it out against the full-frame band beneath).
  const isOverlay = (b: RegionBand) =>
    bands.some((other) => other !== b &&
      other.yStart <= b.yStart + 0.02 && other.yEnd >= b.yEnd - 0.02 &&
      (other.yEnd - other.yStart) > (b.yEnd - b.yStart) + 0.02);
  const stack = bands.filter((b) => !isOverlay(b));
  // Make the stacked bands contiguous in y (snap each yStart to the previous yEnd). Do NOT snap x.
  for (let i = 1; i < stack.length; i++) stack[i].yStart = stack[i - 1].yEnd;
  if (stack.length) { stack[0].yStart = 0; stack[stack.length - 1].yEnd = 1; }
  return bands;
}

function coerce(parsed: unknown): RegionLayout {
  const p = (parsed ?? {}) as Record<string, unknown>;

  // structureTimeline (rare): band structure changes over time. Window 0's bands become the
  // backward-compatible `bands` view.
  let structureTimeline: StructureWindow[] | undefined;
  if (Array.isArray(p.structureTimeline)) {
    structureTimeline = (p.structureTimeline as Array<Record<string, unknown>>)
      .map((w) => ({
        start: Number(w?.start),
        end: Number(w?.end),
        bands: coerceBands(Array.isArray(w?.bands) ? (w.bands as Array<Record<string, unknown>>) : []),
      }))
      .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.bands.length > 0)
      .sort((a, b) => a.start - b.start);
    // Same fraction-times guard as contentTimeline: an all-≤1.5s structure timeline is fractions.
    if (structureTimeline.length && Math.max(...structureTimeline.map((w) => w.end)) <= 1.5) structureTimeline = undefined;
    if (!structureTimeline?.length) structureTimeline = undefined;
  }

  const bands: RegionBand[] = structureTimeline
    ? structureTimeline[0].bands
    : coerceBands(Array.isArray(p.bands) ? (p.bands as Array<Record<string, unknown>>) : []);

  // arollBandIndex MUST be recomputed after the filter/sort above — the VLM's index refers to
  // its ORIGINAL array order, which no longer holds once empty bands are dropped or bands are
  // re-sorted (audit fix: stale-index bug). Role lookup is the only stable reference.
  let arollIdx = bands.findIndex((b) => b.role === "aroll");
  if (arollIdx < 0 && typeof p.arollBandIndex === "number" && p.arollBandIndex >= 0 && p.arollBandIndex < bands.length) {
    arollIdx = p.arollBandIndex; // fallback only when no band carries the role
  }
  return {
    layoutClass: String(p.layoutClass ?? (bands.length <= 1 ? "single_fullscreen" : bands.length === 2 ? "two_region_split" : "multi_region_stack")),
    bands,
    arollBandIndex: arollIdx,
    summary: String(p.summary ?? ""),
    ...(structureTimeline ? { structureTimeline } : {}),
  };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** Decompose a reel into stacked horizontal bands (VLM). Returns null on failure (non-blocking). */
export async function analyzeLayoutRegions(videoPath: string): Promise<RegionLayout | null> {
  if (!process.env.GEMINI_API_KEY) { console.warn("[layout-regions] no GEMINI_API_KEY"); return null; }
  try {
    const uploaded = await uploadToGemini(videoPath, "video/mp4", "layout-regions-ref");
    const ready = await waitForFileProcessing(uploaded.name);
    const result = await geminiFlash.generateContent([
      { text: buildPrompt() },
      { fileData: { mimeType: ready.mimeType, fileUri: ready.uri } },
    ]);
    const raw = result.response.text().trim();
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return coerce(JSON.parse(cleaned));
  } catch (e) {
    console.error("[layout-regions] failed (non-blocking):", (e as Error).message?.slice(0, 200));
    return null;
  }
}
