/**
 * Font Registry — maps a classified font STYLE to the closest available
 * font file, so overlay text in the edit visually matches the reference's
 * typeface (not just its position/size).
 *
 * The reference's exact font is rarely installed, so we classify each text's
 * style (category / italic / weight) and resolve the nearest local font.
 * Catalog below targets the Windows font set; extend per platform via the
 * same directory resolution as fonts.ts.
 */

import { platform } from "os";

export type FontCategory =
  | "serif"
  | "display" // high-contrast didone/headline serif (Bodoni/Didot-like)
  | "sans"
  | "rounded" // rounded geometric sans (Quicksand/Baloo-like)
  | "script"
  | "mono";

export type FontWeight = "light" | "regular" | "bold" | "black";

export interface FontStyle {
  category: FontCategory;
  italic?: boolean;
  weight?: FontWeight;
}

// ── Directory resolution (mirrors fonts.ts, FFmpeg-escaped on Windows) ──
function getFontDir(): string {
  const envDir = process.env.FONT_DIR;
  if (envDir) return envDir.includes(":\\") ? envDir.replace(":", "\\:") : envDir;
  switch (platform()) {
    case "win32":
      return "C\\:/Windows/Fonts";
    case "darwin":
      return "/Library/Fonts";
    default:
      return "/usr/share/fonts/truetype/msttcorefonts";
  }
}

const DIR = getFontDir();
const f = (name: string) => `${DIR}/${name}`;

/**
 * Catalog of known-available font files, grouped by visual family.
 * Windows filenames; on other platforms set FONT_DIR and adjust as needed.
 */
const CATALOG = {
  // High-contrast didone serif (Bodoni MT) — the elegant headline serif look
  bodoni: {
    regular: f("BOD_R.TTF"),
    bold: f("BOD_B.TTF"),
    italic: f("BOD_I.TTF"),
    boldItalic: f("BOD_BI.TTF"),
  },
  // Sturdy transitional serif (Georgia)
  georgia: {
    regular: f("georgia.ttf"),
    bold: f("georgiab.ttf"),
    italic: f("georgiai.ttf"),
    boldItalic: f("georgiaz.ttf"),
  },
  times: {
    regular: f("times.ttf"),
    bold: f("timesbd.ttf"),
    italic: f("timesi.ttf"),
    boldItalic: f("timesbi.ttf"),
  },
  // Humanist sans with soft, slightly-rounded terminals — closest local match
  // to a rounded geometric sans (Quicksand/Baloo) which Windows lacks.
  trebuchet: {
    regular: f("trebuc.ttf"),
    bold: f("trebucbd.ttf"),
    italic: f("trebucit.ttf"),
    boldItalic: f("trebucbi.ttf"),
  },
  arial: {
    regular: f("arial.ttf"),
    bold: f("arialbd.ttf"),
    italic: f("ariali.ttf"),
    boldItalic: f("arialbi.ttf"),
  },
  comic: {
    regular: f("comic.ttf"),
    bold: f("comicbd.ttf"),
    italic: f("comici.ttf"),
    boldItalic: f("comicz.ttf"),
  },
} as const;

type FamilyKey = keyof typeof CATALOG;

function variant(
  family: FamilyKey,
  italic: boolean,
  bold: boolean
): string {
  const fam = CATALOG[family];
  if (italic && bold) return fam.boldItalic;
  if (italic) return fam.italic;
  if (bold) return fam.bold;
  return fam.regular;
}

/**
 * Resolve the best available font file (FFmpeg drawtext path) for a style.
 */
export function resolveFontForStyle(style: FontStyle): string {
  const italic = !!style.italic;
  const bold = style.weight === "bold" || style.weight === "black";

  switch (style.category) {
    case "display":
      // High-contrast headline serif → Bodoni MT
      return variant("bodoni", italic, bold);
    case "serif":
      // Italic serif headlines in this content style are usually didone →
      // Bodoni reads closer than Georgia; upright serifs → Georgia.
      return italic ? variant("bodoni", true, bold) : variant("georgia", false, bold);
    case "rounded":
      // No true rounded-geometric on Windows; Trebuchet is the softest match.
      return variant("trebuchet", italic, bold);
    case "script":
      return variant("bodoni", true, bold);
    case "mono":
    case "sans":
    default:
      // Trebuchet for a friendlier sans, Arial as the neutral default.
      return variant("arial", italic, bold);
  }
}

/**
 * Heuristic fallback when no classification is available: infer a style from
 * color/weight hints (gold headline → display italic), else plain sans.
 */
export function inferStyleFromHints(hints: {
  fontColor?: string;
  bold?: boolean;
  isHeadline?: boolean;
}): FontStyle {
  const c = (hints.fontColor ?? "").toUpperCase();
  const goldish =
    c.includes("FDD835") || c.includes("FFD700") || c.includes("FFEB3B") || c.includes("FFC");
  if (goldish || hints.isHeadline) {
    return { category: "display", italic: true, weight: hints.bold ? "bold" : "regular" };
  }
  return { category: "sans", italic: false, weight: hints.bold ? "bold" : "regular" };
}
