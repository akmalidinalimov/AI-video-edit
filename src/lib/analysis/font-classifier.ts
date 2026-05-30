/**
 * Font Classifier — uses Gemini Vision to classify the typeface STYLE of a
 * cropped text image, so the renderer can pick a matching local font.
 *
 * We classify style (not exact font name, which is unreliable): category,
 * italic, weight. The font-registry maps that to the nearest available file.
 */

import fs from "fs";
import { genAI } from "@/lib/gemini/client";
import type { FontStyle, FontCategory, FontWeight } from "@/lib/pipeline/font-registry";

const CLASSIFY_PROMPT = `You are a typography expert. Look at the text in this image and classify its FONT STYLE.

Return ONLY JSON:
{
  "category": "serif" | "display" | "sans" | "rounded" | "script" | "mono",
  "italic": true | false,
  "weight": "light" | "regular" | "bold" | "black"
}

Definitions:
- "display": a high-contrast HEADLINE serif with strong thick/thin stroke contrast (Didot/Bodoni style), often elegant/fashion-like.
- "serif": a normal serif with modest stroke contrast (Times/Georgia style).
- "rounded": a geometric sans-serif with ROUNDED, soft terminals (Quicksand/Baloo/Nunito style).
- "sans": a plain/neutral sans-serif (Arial/Helvetica style), sharp terminals.
- "script": cursive/handwritten connected letters.
- "mono": fixed-width.

"italic": true if the letters are slanted/cursive.
"weight": how heavy the strokes are.

Judge ONLY the letterform style, ignore color and background.`;

const MODELS = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro-preview"];

function coerceStyle(raw: unknown): FontStyle | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const cat = String(o.category ?? "").toLowerCase();
  const validCats: FontCategory[] = ["serif", "display", "sans", "rounded", "script", "mono"];
  const category = (validCats.includes(cat as FontCategory) ? cat : "sans") as FontCategory;
  const w = String(o.weight ?? "regular").toLowerCase();
  const validW: FontWeight[] = ["light", "regular", "bold", "black"];
  const weight = (validW.includes(w as FontWeight) ? w : "regular") as FontWeight;
  return { category, italic: !!o.italic, weight };
}

/**
 * Classify the font style of a cropped text image. Returns null on failure
 * (caller should fall back to a heuristic).
 */
export async function classifyFontStyle(imagePath: string): Promise<FontStyle | null> {
  if (!fs.existsSync(imagePath)) return null;
  const base64 = fs.readFileSync(imagePath).toString("base64");
  const parts = [
    { text: CLASSIFY_PROMPT },
    { inlineData: { mimeType: "image/jpeg", data: base64 } },
  ];

  for (const modelName of MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      });
      const result = await model.generateContent(parts);
      const text = result.response.text();
      const parsed = coerceStyle(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // try next model
    }
  }
  return null;
}
