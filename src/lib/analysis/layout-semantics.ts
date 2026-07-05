/**
 * layout-semantics.ts — Stage 7: the VLM (Gemini) SEMANTIC layer of the Layout Analyzer.
 *
 * The deterministic CV core (layout_analyzer.py) measures GEOMETRY — where the A-roll/B-roll
 * regions are, the shot cuts, camera motion, transition types. It cannot read TEXT or name
 * CONTENT. Per the [D]/[V] discipline (docs/style-cloning-principles.md): geometry = CV,
 * semantics = VLM. This module is the VLM half.
 *
 * It is AUTHORITATIVE for:
 *   - captions (present? position, style, animation, sample text) — CV only gives a rough band
 *   - per-shot CONTENT + narrative ROLE (what each B-roll shot shows, why it's there)
 *   - graphic OVERLAYS (lower-thirds, stickers, emojis, PIP insets) that aren't pure geometry
 *   - style KEYWORDS (maps onto style-library.ts) + a one-line summary
 *
 * Non-blocking: returns null on any failure (missing key, upload error, parse error) so the
 * deterministic layout is never gated on the VLM. One Gemini Flash call per reference.
 */
import { uploadToGemini, waitForFileProcessing } from "@/lib/gemini/fileUpload";
import { geminiFlash } from "@/lib/gemini/client";
import type { LayoutSemantics } from "./layout-analyzer";

export interface SemanticsInput {
  /** Shot boundaries from the CV core, so Gemini labels content per ACTUAL shot. */
  segments: Array<{ start: number; end: number }>;
  /** Measured layout so Gemini knows which region is A-roll vs B-roll (avoids it guessing). */
  arollSide?: "top" | "bottom";
  dividerFraction?: number;
}

function buildPrompt(input: SemanticsInput): string {
  const shotLines = input.segments
    .map((s, i) => `  shot ${i}: ${s.start.toFixed(2)}s – ${s.end.toFixed(2)}s`)
    .join("\n");
  const layoutHint =
    input.arollSide && input.dividerFraction != null
      ? `This reference is a TOP/BOTTOM SPLIT. The talking-head A-roll is on the ${input.arollSide.toUpperCase()} ` +
        `(below ${(input.dividerFraction * 100).toFixed(0)}% if bottom, above if top); the B-roll fills the other region. ` +
        `Analyze the B-roll region for shot content; analyze the whole frame for captions/overlays.`
      : `Analyze the layout, captions, per-shot content, overlays, and style.`;

  return `You are a senior video editor reverse-engineering the EDITING STYLE of a short vertical (9:16) reference reel so it can be reproduced on different footage. ${layoutHint}

The deterministic CV pass already measured these shot boundaries (trust them; describe what's in each):
${shotLines}

Return STRICT JSON (no markdown fence, no prose) with this exact shape:
{
  "captions": {
    "present": <true|false>,
    "position": "<one of: lower-third | below-divider | centered | top | over-broll | none>",
    "style": "<font weight, color, case, background/stroke — e.g. 'bold white uppercase sans, thin black stroke'>",
    "animation": "<one of: word-pop-in | word-by-word-highlight | fade-up | typewriter | karaoke | static | none>",
    "sampleText": "<a few words of caption text you can read, or empty string>"
  },
  "shots": [
    { "start": <number>, "end": <number>, "content": "<what the B-roll shows in this shot>", "role": "<hook|context|proof|product|emotion|cta|transition>" }
  ],
  "overlays": [
    { "kind": "<sticker|emoji|lower-third|logo|progress-bar|pip-inset|arrow|highlight>", "description": "<what + roughly where>" }
  ],
  "styleKeywords": ["<3-7 visual-style keywords: e.g. realistic_vlog, fast-cut, warm-grade, ugc, screen-recording>"],
  "summary": "<one sentence: the editing style in a nutshell>"
}

Rules:
- "shots" MUST have exactly one entry per shot boundary above, in order, with the same start/end.
- For captions, report what you actually SEE; if there are no burned-in captions, present=false and the rest "none"/"".
- Be concrete and faithful — this drives reproduction, not marketing copy.`;
}

function coerce(parsed: unknown, segments: SemanticsInput["segments"]): LayoutSemantics {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const capRaw = p.captions as Record<string, unknown> | undefined;
  const captions =
    capRaw && capRaw.present
      ? {
          present: true,
          position: String(capRaw.position ?? "unknown"),
          style: String(capRaw.style ?? "unknown"),
          animation: String(capRaw.animation ?? "unknown"),
          sampleText: capRaw.sampleText ? String(capRaw.sampleText) : undefined,
        }
      : { present: false, position: "none", style: "none", animation: "none" };

  const shotsRaw = Array.isArray(p.shots) ? (p.shots as Array<Record<string, unknown>>) : [];
  const shots = segments.map((s, i) => {
    const r = shotsRaw[i] ?? {};
    return {
      start: s.start,
      end: s.end,
      content: String(r.content ?? "unlabeled"),
      role: String(r.role ?? "context"),
    };
  });

  const overlays = (Array.isArray(p.overlays) ? (p.overlays as Array<Record<string, unknown>>) : []).map((o) => ({
    kind: String(o.kind ?? "unknown"),
    description: String(o.description ?? ""),
  }));

  const styleKeywords = (Array.isArray(p.styleKeywords) ? p.styleKeywords : []).map(String).slice(0, 8);
  return { captions, shots, overlays, styleKeywords, summary: String(p.summary ?? "") };
}

/** Run the VLM semantic pass over a reference. Returns null on any failure (non-blocking). */
export async function analyzeLayoutSemantics(
  videoPath: string,
  input: SemanticsInput
): Promise<LayoutSemantics | null> {
  if (!process.env.GEMINI_API_KEY) {
    console.warn("[layout-semantics] no GEMINI_API_KEY — skipping VLM stage");
    return null;
  }
  try {
    const uploaded = await uploadToGemini(videoPath, "video/mp4", "layout-semantics-ref");
    const ready = await waitForFileProcessing(uploaded.name);
    const result = await geminiFlash.generateContent([
      { text: buildPrompt(input) },
      { fileData: { mimeType: ready.mimeType, fileUri: ready.uri } },
    ]);
    const raw = result.response.text().trim();
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return coerce(parsed, input.segments);
  } catch (e) {
    console.error("[layout-semantics] failed (non-blocking):", (e as Error).message?.slice(0, 200));
    return null;
  }
}
