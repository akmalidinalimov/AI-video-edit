/**
 * Centralized Font Path Resolution
 *
 * Platform-aware font paths for FFmpeg drawtext filters.
 * Replaces hardcoded Windows paths across 4 files.
 *
 * FFmpeg on Windows requires escaped colons in paths: C\:/Windows/Fonts/...
 * FFmpeg on Linux uses standard paths: /usr/share/fonts/...
 *
 * Override with FONT_DIR environment variable for custom font locations.
 */

import { platform } from "os";

// ════════════════════════════════════════════════════════════
// FONT FILE NAMES (same across platforms)
// ════════════════════════════════════════════════════════════

const FONT_FILES = {
  regular: "arial.ttf",
  bold: "arialbd.ttf",
  headline: "GeorgiaPro-BoldItalic.ttf",
} as const;

// ════════════════════════════════════════════════════════════
// PLATFORM-AWARE DIRECTORY RESOLUTION
// ════════════════════════════════════════════════════════════

/**
 * Get the font directory for the current platform.
 * Uses FONT_DIR env var if set, otherwise platform defaults.
 *
 * Returns the path in FFmpeg-compatible format (escaped colons on Windows).
 */
function getFontDir(): string {
  // Environment override takes precedence
  const envDir = process.env.FONT_DIR;
  if (envDir) {
    // If user provides Windows path, escape the colon for FFmpeg
    if (envDir.includes(":\\")) {
      return envDir.replace(":", "\\:");
    }
    return envDir;
  }

  const os = platform();

  switch (os) {
    case "win32":
      return "C\\:/Windows/Fonts";

    case "linux":
      // Common Linux font directories:
      // - /usr/share/fonts/truetype/msttcorefonts/ (apt: ttf-mscorefonts-installer)
      // - /usr/share/fonts/truetype/ (generic)
      // - /usr/local/share/fonts/ (user-installed)
      // Default to the msttcorefonts location; override with FONT_DIR if different.
      return "/usr/share/fonts/truetype/msttcorefonts";

    case "darwin":
      return "/Library/Fonts";

    default:
      // Fallback to Linux default
      return "/usr/share/fonts/truetype/msttcorefonts";
  }
}

// ════════════════════════════════════════════════════════════
// EXPORTED FONT PATHS
// ════════════════════════════════════════════════════════════

/**
 * Resolved font paths for FFmpeg drawtext filters.
 *
 * Usage:
 *   import { FONTS } from "./fonts";
 *   // FONTS.regular  → "C\:/Windows/Fonts/arial.ttf" (Windows)
 *   // FONTS.regular  → "/usr/share/fonts/truetype/msttcorefonts/arial.ttf" (Linux)
 *   // FONTS.bold     → platform-aware arialbd.ttf
 *   // FONTS.headline → platform-aware GeorgiaPro-BoldItalic.ttf
 */
export const FONTS = (() => {
  const dir = getFontDir();
  const sep = dir.endsWith("/") ? "" : "/";
  return {
    regular: `${dir}${sep}${FONT_FILES.regular}`,
    bold: `${dir}${sep}${FONT_FILES.bold}`,
    headline: `${dir}${sep}${FONT_FILES.headline}`,
  };
})();

/**
 * Alias map for backward compatibility and semantic use:
 *
 *   FONT_ALIASES.arial          → FONTS.regular
 *   FONT_ALIASES.arialBold      → FONTS.bold
 *   FONT_ALIASES.georgiaProBoldItalic → FONTS.headline
 *   FONT_ALIASES.normal         → FONTS.regular
 *   FONT_ALIASES.italic_bold    → FONTS.headline
 */
export const FONT_ALIASES = {
  // Names used in vcs-templates.ts
  arial: FONTS.regular,
  arialBold: FONTS.bold,
  georgiaProBoldItalic: FONTS.headline,

  // Names used in template-generator.ts
  normal: FONTS.regular,
  italic_bold: FONTS.headline,
} as const;
